/**
 * E2E coverage: a navigation a page's `beforeunload` refuses says so, and the way
 * through it works.
 *
 * The real wiring no mock can stand in for is Electron's own handling of
 * `beforeunload`, which runs beside the CDP answer. Measured against this spec's
 * page before the fix:
 *
 *  - The driver's default dismiss kept the page, and `loadURL` rejected with a
 *    bare `ERR_FAILED (-2)`. An agent's next `wait` and `eval` then ran against
 *    the old page and passed.
 *  - With accept armed through CDP alone the page left, and `loadURL` still
 *    rejected with `ERR_ABORTED (-3)`, so a navigation that worked read as failed.
 *
 * Chromium shows the dialog only after a user activation, so the spec clicks the
 * page first. Without the click no dialog opens and the load simply goes through.
 *
 * Network-free: pages come from a local http server on an ephemeral port.
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
const STAY_TITLE = 'beforeunload-stay';
const NEXT_TITLE = 'beforeunload-next';

function startFixtureServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (pathname === '/stay') {
      response.end(`<!doctype html><html><head><title>${STAY_TITLE}</title><script>
        addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });
      </script></head><body><button id="touch">touch</button></body></html>`);
      return;
    }
    response.end(`<!doctype html><html><head><title>${NEXT_TITLE}</title></head><body>next</body></html>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function evalInGuest(electronApp: ElectronApplication, expression: string): Promise<unknown> {
  return electronApp.evaluate(async ({ webContents }, source: string) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
    if (!guest) throw new Error('no webview guest attached');
    return guest.executeJavaScript(source, true);
  }, expression);
}

async function connectMcp(projectDir: string): Promise<Client> {
  const configPath = path.join(projectDir, '.kangentic', 'mcp-config.json');
  await expect.poll(() => fs.existsSync(configPath), { timeout: 10000 }).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    mcpServers: { kangentic: { url: string; headers: Record<string, string> } };
  };
  const server = config.mcpServers.kangentic;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  const client = new Client({ name: 'e2e-beforeunload', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return { isError: result.isError === true, text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ') };
}

async function openPane(page: Page, title: string): Promise<void> {
  await createTask(page, title, 'beforeunload');
  const taskId = await getTaskIdByTitle(page, title);
  const codeReviewId = await page.evaluate(async () => {
    const swimlanes: Swimlane[] = await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === 'Code Review')?.id ?? null;
  });
  if (!codeReviewId) throw new Error('No "Code Review" column on the default board');
  await moveTaskIpc(page, taskId, codeReviewId);
  await waitForRunningSession(page);
  await page.evaluate(async (id: string) => {
    await window.electronAPI.browser.setTaskUrl(id, 'data:text/html,<h1>beforeunload</h1>');
  }, taskId);
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="browser-toggle"]').click();
  await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });
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

test.describe('A navigation the page refuses', () => {
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

  test('names the beforeunload, and arming accept gets through with a clean result', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    const { page, tmpDir } = freshProject;
    await openPane(page, `Beforeunload ${runId}`);
    // Playwright's own CDP connection sees the guest's dialog too, and with no
    // listener it answers, racing the app's driver (browser-cdp-navigation.spec.ts).
    const leaveDialogToTheApp = (_dialog: Dialog): void => {};
    electronApp.context().on('dialog', leaveDialogToTheApp);

    const client = await connectMcp(tmpDir);
    try {
      await expect
        .poll(async () => (await callTool(client, 'kangentic_browser_list_panes', {})).text, { timeout: 15_000, intervals: [100, 250, 500] })
        .toMatch(/"driveable":\s*true/);

      const toStay = await callTool(client, 'kangentic_browser_navigate', { url: `${origin}/stay` });
      expect(toStay.isError, toStay.text).toBe(false);
      const clicked = await callTool(client, 'kangentic_browser_click', { selector: '#touch' });
      expect(clicked.isError, clicked.text).toBe(false);

      // Refused, in words that say why and what to do, and the page is unchanged.
      const refused = await callTool(client, 'kangentic_browser_navigate', { url: `${origin}/next` });
      expect(refused.isError, refused.text).toBe(true);
      expect(refused.text).toContain('navigation-refused-by-page');
      expect(refused.text).toContain('beforeunload');
      expect(refused.text).toContain('kangentic_browser_handle_dialog');
      expect(await evalInGuest(electronApp, 'document.title')).toBe(STAY_TITLE);

      // What the error says to do works, and reports that it worked.
      const armed = await callTool(client, 'kangentic_browser_handle_dialog', { accept: true });
      expect(armed.isError, armed.text).toBe(false);
      const retried = await callTool(client, 'kangentic_browser_navigate', { url: `${origin}/next` });
      expect(retried.isError, retried.text).toBe(false);
      await expect.poll(() => evalInGuest(electronApp, 'document.title')).toBe(NEXT_TITLE);
    } finally {
      await client.close();
      electronApp.context().off('dialog', leaveDialogToTheApp);
    }
  });
});
