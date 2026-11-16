/**
 * E2E coverage for GitHub #820: a selector that names two visible elements is
 * refused rather than acted on, and every way out the refusal offers works.
 *
 * The page is the reported shape. An open modal sits over a form, and each
 * holds a "Save" button. A click at the centre of the form's button lands on
 * the modal's backdrop, and a backdrop click closes the modal, which is how
 * the agent in #820 lost its dialog without being told.
 *
 * The real wiring no mock can stand in for is the page itself: which matches
 * are laid out, which a backdrop covers (`elementFromPoint`), and whether a
 * node id from `DOM.requestNode` is the element that was counted. The unit
 * tier runs the counting expression against a fake document
 * (`browser-actionable-matches.test.ts`) and cannot prove any of that.
 *
 * Network-free: the page comes from a local http server on an ephemeral port.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from './shared-app';
import { createTask, waitForRunningSession, getTaskIdByTitle, moveTaskIpc } from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Swimlane } from '../../src/shared/types';

const runId = Date.now();

const MODAL_PAGE = `<!doctype html><html><head><title>strict-selector</title><style>
  #backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); }
  #modal { position: fixed; top: 120px; left: 120px; width: 320px; padding: 16px; background: #fff; }
</style></head><body>
  <form id="background-form"><button type="button" onclick="window.clicks.push('form-save')">Save</button></form>
  <div id="backdrop" onclick="window.clicks.push('backdrop'); document.getElementById('backdrop').remove(); document.getElementById('modal').remove();"></div>
  <div id="modal" role="dialog" aria-modal="true">
    <h2>Edit task</h2>
    <button type="button" onclick="window.clicks.push('modal-save')">Save</button>
    <button type="button" onclick="window.clicks.push('confirm')">Confirm</button>
    <button type="button" style="display: none" onclick="window.clicks.push('hidden-delete')">Delete</button>
    <button type="button" onclick="window.clicks.push('delete')">Delete</button>
  </div>
  <script>window.clicks = [];</script>
</body></html>`;

function startFixtureServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(MODAL_PAGE);
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
  const client = new Client({ name: 'e2e-strict-selector', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return { isError: result.isError === true, text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ') };
}

async function openPane(page: Page, title: string): Promise<void> {
  await createTask(page, title, 'strict selector');
  const taskId = await getTaskIdByTitle(page, title);
  const codeReviewId = await page.evaluate(async () => {
    const swimlanes: Swimlane[] = await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === 'Code Review')?.id ?? null;
  });
  if (!codeReviewId) throw new Error('No "Code Review" column on the default board');
  await moveTaskIpc(page, taskId, codeReviewId);
  await waitForRunningSession(page);
  await page.evaluate(async (id: string) => {
    await window.electronAPI.browser.setTaskUrl(id, 'data:text/html,<h1>strict</h1>');
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

interface AmbiguousEnvelope {
  kind: string;
  total: number;
  candidates: Array<{ text: string; inDialog: boolean; topmost: boolean | null; selector: string }>;
}

test.describe('A selector that names two visible elements', () => {
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

  test('is refused with its candidates, and each way out lands on the element meant', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    const { page, tmpDir } = freshProject;
    await openPane(page, `Strict selector ${runId}`);

    const client = await connectMcp(tmpDir);
    try {
      await expect
        .poll(async () => (await callTool(client, 'kangentic_browser_list_panes', {})).text, { timeout: 15_000, intervals: [100, 250, 500] })
        .toMatch(/"driveable":\s*true/);
      const loaded = await callTool(client, 'kangentic_browser_navigate', { url: origin });
      expect(loaded.isError, loaded.text).toBe(false);
      await expect.poll(() => evalInGuest(electronApp, 'Array.isArray(window.clicks)')).toBe(true);
      const clicks = () => evalInGuest(electronApp, 'window.clicks.slice()');

      // The #820 call. Refused, nothing clicked, and the modal is still open.
      const ambiguous = await callTool(client, 'kangentic_browser_click', { selector: 'text="Save"' });
      expect(ambiguous.isError, ambiguous.text).toBe(true);
      const envelope = JSON.parse(ambiguous.text) as AmbiguousEnvelope;
      expect(envelope.kind).toBe('ambiguous-selector');
      expect(envelope.total).toBe(2);
      // The backdrop covers the form's button, and the candidates say so.
      const topmost = envelope.candidates.filter((candidate) => candidate.topmost === true);
      expect(topmost).toHaveLength(1);
      expect(topmost[0].inDialog).toBe(true);
      expect(await clicks()).toEqual([]);
      expect(await evalInGuest(electronApp, 'Boolean(document.getElementById("modal"))')).toBe(true);

      // Way out one: retry with the candidate's own selector.
      const byCandidate = await callTool(client, 'kangentic_browser_click', { selector: topmost[0].selector });
      expect(byCandidate.isError, byCandidate.text).toBe(false);
      expect(await clicks()).toEqual(['modal-save']);

      // Way out two: scope the text to the dialog. Its CSS used to be dropped.
      const scoped = await callTool(client, 'kangentic_browser_click', { selector: '[role=dialog] button:has-text("Save")' });
      expect(scoped.isError, scoped.text).toBe(false);
      expect(await clicks()).toEqual(['modal-save', 'modal-save']);

      // A dialog whose text includes "Confirm" is not a second match for its own button.
      const contained = await callTool(client, 'kangentic_browser_click', { selector: 'text*="Confirm"' });
      expect(contained.isError, contained.text).toBe(false);
      expect(await clicks()).toEqual(['modal-save', 'modal-save', 'confirm']);

      // A hidden duplicate does not count, even when it comes first.
      const besideHidden = await callTool(client, 'kangentic_browser_click', { selector: 'text="Delete"' });
      expect(besideHidden.isError, besideHidden.text).toBe(false);
      expect(await clicks()).toEqual(['modal-save', 'modal-save', 'confirm', 'delete']);

      // strict: false is the old reading: the first match, which is the form's
      // button under the backdrop. The click lands on the backdrop and closes
      // the modal, which is the failure #820 reported.
      const loose = await callTool(client, 'kangentic_browser_click', { selector: 'text="Save"', strict: false });
      expect(loose.isError, loose.text).toBe(false);
      expect(await clicks()).toEqual(['modal-save', 'modal-save', 'confirm', 'delete', 'backdrop']);
      expect(await evalInGuest(electronApp, 'Boolean(document.getElementById("modal"))')).toBe(false);
    } finally {
      await client.close();
    }
  });
});
