/**
 * E2E coverage: the Browser pane's CDP session keeps intercepting dialogs and
 * capturing network requests across real navigations.
 *
 * Since Chromium 148 (Electron 42), RenderDocument swaps the main frame's
 * RenderFrameHost on every cross-document navigation. In Electron 42 that swap
 * made `webContents.debugger` disconnect and reconnect, dropping notifications
 * queued in between; electron/electron#51964 (Electron 43) fixed it. Kangentic
 * went from Electron 41 straight to 44, so it never ran a broken release, but
 * the pane's CDP session now crosses an RFH swap on EVERY navigation. Two things
 * ride that session and nothing else can recover either:
 *
 *  - `Page.javascriptDialogOpening`. A dialog the driver never hears about is
 *    never answered, and an unanswered dialog blocks the renderer with nothing
 *    on screen to dismiss: the pane is wedged (`cdp.ts`, `Page.enable`).
 *  - The network ring (`Network.enable`), which `kangentic_browser_network`
 *    reads to tell an agent whether its API call fired.
 *
 * So this spec attaches CDP, navigates the pane twice through the real MCP
 * tools to a local http server, and then checks both still work: a `confirm()`
 * the agent armed to accept returns true and is recorded, and a fetch shows up
 * in the network ring with its status.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from './shared-app';
import { createTask, waitForRunningSession, getTaskIdByTitle, moveTaskIpc } from './helpers';
import type { Dialog, ElectronApplication, Page } from '@playwright/test';
import type { Swimlane } from '../../src/shared/types';

const runId = Date.now();
const DIALOG_MESSAGE = 'cdp-dialog-probe';
const PAGE_A_TITLE = 'cdp-navigation-page-a';
const PAGE_B_TITLE = 'cdp-navigation-page-b';

/** A dev server stand-in: two pages and one JSON endpoint, on an ephemeral loopback port. */
function startFixtureServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/a' || pathname === '/b') {
      const title = pathname === '/a' ? PAGE_A_TITLE : PAGE_B_TITLE;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
      return;
    }
    if (pathname === '/api/ping') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ pong: true }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

/**
 * Run an expression inside the guest webContents (not the host renderer), bounded so a
 * dialog nobody answers fails this assertion by name instead of hanging the test until its
 * timeout. The bound is the point of the spec: an unanswered dialog never resolves.
 */
async function evalInGuest(electronApp: ElectronApplication, expression: string, timeoutMs = 10000): Promise<unknown> {
  const outcome = await electronApp.evaluate(async ({ webContents }, { source, boundMs }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
    if (!guest) throw new Error('no webview guest attached');
    const timedOut = Symbol('timed-out');
    const raced = await Promise.race([
      guest.executeJavaScript(source, true),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timedOut), boundMs)),
    ]);
    return raced === timedOut ? { timedOut: true as const } : { timedOut: false as const, value: raced as unknown };
  }, { source: expression, boundMs: timeoutMs });
  if (outcome.timedOut) {
    throw new Error(`Guest script did not finish within ${timeoutMs}ms (an unanswered dialog blocks it): ${expression}`);
  }
  return outcome.value;
}

/** Connect to the app's own MCP server the way an external client does. */
async function connectMcp(projectDir: string): Promise<Client> {
  const configPath = path.join(projectDir, '.kangentic', 'mcp-config.json');
  await expect.poll(() => fs.existsSync(configPath), { timeout: 10000 }).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    mcpServers: { kangentic: { url: string; headers: Record<string, string> } };
  };
  const server = config.mcpServers.kangentic;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  });
  const client = new Client({ name: 'e2e-cdp-navigation', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ');
  return { isError: result.isError === true, text };
}

interface SeenDialog {
  type: string;
  message: string;
  accepted: boolean;
}

interface CapturedRequest {
  method: string;
  url: string;
  status: number | null;
  errorText: string | null;
}

/**
 * Give a new task a running session and an open Browser pane. The task moves by IPC rather
 * than a drag, so nothing here waits on a fixed delay; the column's auto-spawn starts the
 * session either way.
 */
async function openPane(page: Page, title: string): Promise<void> {
  await createTask(page, title, 'cdp navigation');
  const taskId = await getTaskIdByTitle(page, title);
  const codeReviewId = await page.evaluate(async () => {
    const swimlanes: Swimlane[] = await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === 'Code Review')?.id ?? null;
  });
  if (!codeReviewId) throw new Error('No "Code Review" column on the default board');
  await moveTaskIpc(page, taskId, codeReviewId);
  await waitForRunningSession(page);

  // Rewritten to about:blank by will-attach-webview; the agent navigates from there.
  await page.evaluate(async (id: string) => {
    await window.electronAPI.browser.setTaskUrl(id, 'data:text/html,<h1>cdp-navigation</h1>');
  }, taskId);
  // Any column: the IPC move does not wait for the board to repaint, and which column the
  // card shows in is not what this spec is about.
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="browser-toggle"]').click();
  await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });
  // Attached once the <webview> reports its webContents id. A SYNC host-DOM predicate:
  // polling `electronApp.evaluate` here intermittently failed with "Resulting promise was
  // garbage collected" (browser-agent-key-focus.spec.ts).
  await page.waitForFunction(() => {
    const webview = document.querySelector('[data-testid="browser-pane"] webview') as
      (Element & { getWebContentsId?: () => number }) | null;
    try {
      return Boolean(webview?.getWebContentsId && webview.getWebContentsId() > 0);
    } catch {
      return false;
    }
  }, undefined, { timeout: 10000 });
}

test.describe('Browser pane CDP across navigations', () => {
  let fixtureServer: http.Server | null = null;
  let origin = '';

  test.beforeAll(async () => {
    const started = await startFixtureServer();
    fixtureServer = started.server;
    origin = started.origin;
  });

  test.afterAll(async () => {
    const server = fixtureServer;
    fixtureServer = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a dialog is still answered and a request still captured after the main frame swaps', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    const { page, tmpDir } = freshProject;
    await openPane(page, `CDP Navigation ${runId}`);

    const client = await connectMcp(tmpDir);
    try {
      // Arming the answer is a driving call, so it is also what attaches CDP (attach is lazy):
      // Page.enable and Network.enable go out here, on the frame the pane loaded first.
      const armed = await callTool(client, 'kangentic_browser_handle_dialog', { accept: true, persist: true });
      expect(armed.isError, armed.text).toBe(false);

      // Two real cross-document loads, so the main frame's RenderFrameHost is swapped twice
      // under the attached debugger.
      const toPageA = await callTool(client, 'kangentic_browser_navigate', { url: `${origin}/a` });
      expect(toPageA.isError, toPageA.text).toBe(false);
      await expect.poll(() => evalInGuest(electronApp, 'document.title')).toBe(PAGE_A_TITLE);

      const toPageB = await callTool(client, 'kangentic_browser_navigate', { url: `${origin}/b` });
      expect(toPageB.isError, toPageB.text).toBe(false);
      await expect.poll(() => evalInGuest(electronApp, 'document.title')).toBe(PAGE_B_TITLE);

      // The dialog reaches the driver and gets the armed answer. If the notification were
      // lost in the swap, confirm() would block the page and the bounded eval would throw.
      //
      // Playwright's own CDP connection sees the guest's dialog too, and with no listener it
      // DISMISSES it, racing the app's driver: whichever answers first wins, and the loser's
      // `Page.handleJavaScriptDialog` fails with "No dialog is showing" as an unhandled error
      // in this worker. A listener that answers nothing leaves the dialog to the app alone, so
      // the value confirm() returns is the driver's answer and only the driver's. If the
      // driver stopped answering, nothing would, and the bounded eval below would fail.
      //
      // The listener must outlive Playwright's copy of the event, not just the confirm() call.
      // The app's debugger runs inside the browser process and answers at once, so confirm()
      // can return before Playwright, on its own pipe, has processed the opening event. Remove
      // the listener in that gap and Playwright finds no handler, dismisses a dialog that is
      // already gone, and throws the same "No dialog is showing" from a promise nothing
      // catches. So it stays until Playwright has reported this dialog.
      let playwrightSawDialog = false;
      const leaveDialogToTheApp = (dialog: Dialog): void => {
        if (dialog.message() === DIALOG_MESSAGE) playwrightSawDialog = true;
      };
      electronApp.context().on('dialog', leaveDialogToTheApp);
      try {
        expect(await evalInGuest(electronApp, `confirm(${JSON.stringify(DIALOG_MESSAGE)})`)).toBe(true);
        await expect.poll(() => playwrightSawDialog).toBe(true);
      } finally {
        electronApp.context().off('dialog', leaveDialogToTheApp);
      }

      expect(await evalInGuest(electronApp, "fetch('/api/ping', { cache: 'no-store' }).then((response) => response.status)")).toBe(200);

      await expect.poll(async () => {
        const network = await callTool(client, 'kangentic_browser_network', { urlContains: '/api/ping' });
        if (network.isError) return `error: ${network.text}`;
        const requests = (JSON.parse(network.text) as { requests: CapturedRequest[] }).requests;
        return requests.some((request) => request.url === `${origin}/api/ping` && request.status === 200);
      }, { timeout: 10000 }).toBe(true);

      await expect.poll(async () => {
        const dialogs = await callTool(client, 'kangentic_browser_handle_dialog', { accept: true, persist: true });
        if (dialogs.isError) return `error: ${dialogs.text}`;
        const seen = (JSON.parse(dialogs.text) as { seen: SeenDialog[] }).seen;
        return seen.some((dialog) => dialog.type === 'confirm' && dialog.message === DIALOG_MESSAGE && dialog.accepted);
      }, { timeout: 10000 }).toBe(true);
    } finally {
      await client.close();
    }
  });
});
