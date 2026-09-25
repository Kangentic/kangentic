/**
 * E2E coverage: an agent's key never lands outside the Browser pane (task #720).
 *
 * Chromium delivers a CDP key to whatever holds keyboard focus in the WINDOW,
 * not to the guest it was sent to. With the user's terminal focused, an agent's
 * `kangentic_browser_keypress Escape` reached that terminal and interrupted the
 * agent itself. The fix reads `hostWebContents.focusedFrame` before every key
 * event (`src/main/browser/cdp/keyboard-focus.ts`) and refuses with
 * `pane-not-focused` when focus is in the host.
 *
 * The unit tier pins that predicate over FAKE frames. Whether the real
 * `focusedFrame` agrees with where Chromium routes the key is Chromium behavior,
 * and only a live `<webview>` can show it. That was measured on Windows; this
 * spec is what checks it on CI's Linux, on every push, through the real MCP
 * tools and the real pane:
 *
 *  1. Host focused: a selector-less keypress is refused, and neither the host
 *     document nor the page receives the key.
 *  2. With a selector: the click focuses the page and the key lands in the
 *     page's input, not the host.
 *  3. Focus handed back to the terminal after the drive: a selector-less type
 *     is refused again.
 *
 * A second test pins the key ENCODING the same way: text on the keyDown, so a
 * newline submits a form and a keydown handler that cancels a key keeps it out
 * of the field (`typeText` in `cdp.ts`).
 *
 * Network-free: the pane loads about:blank and the test writes the page's DOM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from './shared-app';
import { createTask, waitForRunningSession, getTaskIdByTitle } from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const runId = Date.now();

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 10, cardBox.y, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** Run an expression inside the guest webContents (not the host renderer). */
async function evalInGuest(electronApp: ElectronApplication, expression: string): Promise<unknown> {
  return electronApp.evaluate(async ({ webContents }, source: string) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
    if (!guest) throw new Error('no webview guest attached');
    return guest.executeJavaScript(source, true);
  }, expression);
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
  const client = new Client({ name: 'e2e-agent-key-focus', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ');
  return { isError: result.isError === true, text };
}

const TERMINAL_TEXTAREA = '[data-testid="task-detail-dialog"] .xterm-helper-textarea';

async function terminalHoldsFocus(page: Page): Promise<boolean> {
  return page.evaluate((selector) => document.activeElement === document.querySelector(selector), TERMINAL_TEXTAREA);
}

/**
 * Put the user in the task's terminal, and let the terminal finish ARRIVING
 * first. A just-opened task window's terminal takes focus when its scrollback
 * replay completes, which main delays 150-400ms by design
 * (`.claude/rules/terminal-arrival-focus.md`). Driving before that lets the
 * arrival focus land between the agent's click and its first key, which pulls
 * focus back to the terminal mid-call: the key is then refused (before #720 it
 * was typed into the terminal). Real agents call seconds after a window opens,
 * so the test waits the replay out rather than racing it: the replay veil
 * lifts when the replay settles, which is when arrival focus is decided.
 */
async function focusTerminalAndSettle(page: Page): Promise<void> {
  await page.locator(TERMINAL_TEXTAREA).waitFor({ state: 'attached', timeout: 10000 });
  await expect(
    page.locator('[data-testid="task-detail-dialog"] [data-testid="terminal-replay-veil"]'),
  ).toHaveCount(0, { timeout: 10000 });
  await page.locator(TERMINAL_TEXTAREA).focus();
  await expect.poll(() => terminalHoldsFocus(page)).toBe(true);
}

/**
 * Give a new task a running session and an open Browser pane, then write the
 * page. `pageSetup` runs inside the guest after `bodyHtml` is in place, since
 * scripts in `innerHTML` never run.
 */
async function openPaneWithPage(
  page: Page,
  electronApp: ElectronApplication,
  title: string,
  bodyHtml: string,
  pageSetup: string,
): Promise<void> {
  await createTask(page, title, 'agent keys');
  await dragTaskToColumn(page, title, 'Code Review');
  await waitForRunningSession(page);

  const taskId = await getTaskIdByTitle(page, title);
  // Rewritten to about:blank by will-attach-webview; the test writes the DOM.
  await page.evaluate(async (id: string) => {
    await window.electronAPI.browser.setTaskUrl(id, 'data:text/html,<h1>agent-keys</h1>');
  }, taskId);
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="browser-toggle"]').click();
  await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });
  // The guest is attached once the <webview> reports its webContents id. Read
  // from the host DOM with a SYNC predicate: polling `electronApp.evaluate`
  // here intermittently failed with "Resulting promise was garbage collected".
  await page.waitForFunction(() => {
    const webview = document.querySelector('[data-testid="browser-pane"] webview') as
      (Element & { getWebContentsId?: () => number }) | null;
    try {
      return Boolean(webview?.getWebContentsId && webview.getWebContentsId() > 0);
    } catch {
      return false;
    }
  }, undefined, { timeout: 10000 });

  await evalInGuest(electronApp, `(() => {
    document.body.innerHTML = ${JSON.stringify(bodyHtml)};
    ${pageSetup}
    return true;
  })()`);
}

test.describe('Agent keys and Browser pane focus', () => {
  test('a key the pane would not receive is refused, and a selector delivers it to the page', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    const { page, tmpDir } = freshProject;
    await openPaneWithPage(
      page,
      electronApp,
      `Agent Key Focus ${runId}`,
      '<input id="field" style="width:300px">',
      "window.__keys = []; document.addEventListener('keydown', (event) => { window.__keys.push(event.key); }, true);",
    );
    await page.evaluate(() => {
      const scope = window as unknown as { __hostKeys: string[] };
      scope.__hostKeys = [];
      document.addEventListener('keydown', (event) => { scope.__hostKeys.push(event.key); }, true);
    });
    const hostKeys = () => page.evaluate(() => (window as unknown as { __hostKeys: string[] }).__hostKeys.slice());
    const guestKeys = async () => (await evalInGuest(electronApp, 'window.__keys.slice()')) as string[];
    const guestField = async () => (await evalInGuest(electronApp, "document.getElementById('field').value")) as string;

    // The user is typing in the task's terminal.
    await focusTerminalAndSettle(page);

    const client = await connectMcp(tmpDir);
    try {
      // 1. Refused, and delivered nowhere. The host check comes first because
      //    it is the harm: without the guard the key lands in the terminal.
      const refused = await callTool(client, 'kangentic_browser_keypress', { keys: 'x' });
      expect(await hostKeys(), 'the agent key reached the host document').not.toContain('x');
      expect(await guestKeys()).toEqual([]);
      expect(refused.isError, refused.text).toBe(true);
      expect(refused.text).toContain('pane-not-focused');

      // 2. The click focuses the page, and the key lands in its input.
      const delivered = await callTool(client, 'kangentic_browser_keypress', { keys: 'x', selector: '#field' });
      expect(delivered.isError, delivered.text).toBe(false);
      await expect.poll(guestField).toBe('x');
      expect(await hostKeys()).not.toContain('x');

      // 3. The pane hands focus back to the terminal once the drive ends, and a
      //    selector-less type is refused again rather than typed into it.
      await expect.poll(() => terminalHoldsFocus(page), { timeout: 5000 }).toBe(true);
      const refusedType = await callTool(client, 'kangentic_browser_type', { text: 'yz' });
      expect(refusedType.isError, refusedType.text).toBe(true);
      expect(refusedType.text).toContain('pane-not-focused');
      expect(await hostKeys()).not.toContain('y');
      expect(await guestField()).toBe('x');
    } finally {
      await client.close();
    }
  });

  test('typing behaves like a keyboard: a newline submits, and a cancelled keydown inserts nothing', async ({ freshProject, sharedApp }) => {
    // The text rides the keyDown, not a separate `char` event. With the split
    // encoding, measured on a live guest: `"query\n"` submitted no form, and a
    // field whose keydown handler cancelled letters received them anyway. That
    // second shape is also why xterm.js pages got every character twice.
    const electronApp = sharedApp.app;
    const { page, tmpDir } = freshProject;
    await openPaneWithPage(
      page,
      electronApp,
      `Agent Typing ${runId}`,
      '<form id="form"><input id="query" style="width:300px"></form>'
        + '<input id="filtered" style="width:300px">',
      "window.__submits = 0;"
        + " document.getElementById('form').addEventListener('submit', (event) => { event.preventDefault(); window.__submits += 1; });"
        + " document.getElementById('filtered').addEventListener('keydown', (event) => { if (/^[a-z]$/.test(event.key)) event.preventDefault(); });",
    );
    const readGuest = async (expression: string) => evalInGuest(electronApp, expression);
    await focusTerminalAndSettle(page);

    const client = await connectMcp(tmpDir);
    try {
      const submitted = await callTool(client, 'kangentic_browser_type', { selector: '#query', text: 'query\n' });
      expect(submitted.isError, submitted.text).toBe(false);
      await expect.poll(() => readGuest("document.getElementById('query').value")).toBe('query');
      await expect.poll(() => readGuest('window.__submits')).toBe(1);

      const filtered = await callTool(client, 'kangentic_browser_type', { selector: '#filtered', text: 'a1b2' });
      expect(filtered.isError, filtered.text).toBe(false);
      await expect.poll(() => readGuest("document.getElementById('filtered').value")).toBe('12');
    } finally {
      await client.close();
    }
  });
});
