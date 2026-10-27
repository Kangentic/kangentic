/**
 * Settings > MCP Server's MCP connection row, and the toast an agent session's
 * start raises when its MCP tools cannot connect (#286, signed-off design).
 *
 * The row is Connected, or Failed with the error the check hit as selectable
 * text, and nothing more. It checks on every visit; Test connection checks
 * again as an explicit request, which may start a stopped WSL distro. While a
 * check runs only the button changes. The toast is persistent, titled
 * "Couldn't reach the MCP server", carries the same error, and its Open
 * settings lands on the MCP Server tab.
 *
 * Tier: UI (headless Chromium) over mock-electron-api.js: `__mockMcpConnection`
 * is what the check answers, `__mockFireMcpConnectionFailed` sends the push.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

let browser: Browser | null = null;

test.afterEach(async () => {
  await browser?.close();
  browser = null;
});

async function launch(): Promise<Page> {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return page;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
}

async function openMcpServerTab(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByTestId('settings-tab-mcpServer').click();
}

/** The arrival and Test connection checks the mock has answered so far, oldest first. */
async function mcpCheckCalls(page: Page): Promise<Array<{ explicit?: boolean }>> {
  return page.evaluate(() => window.__mockMcpConnectionCalls);
}

/**
 * Two animation frames: React has committed what the last step rendered and run
 * its effects. The mock records a check synchronously when the effect asks, so a
 * check the row was going to start is in the calls by now. Used before asserting
 * that NO check started, which no poll can wait for.
 */
async function flushRenderedEffects(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test('reads Connected on arrival, from a check that does not start a stopped distro', async () => {
  const page = await launch();
  await openMcpServerTab(page);

  const row = page.getByTestId('setting-row-mcpServer.connection');
  await expect(row).toContainText('MCP connection');
  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Connected');
  await expect(page.getByTestId('mcp-connection-error')).toHaveCount(0);
  // Dev's StrictMode runs the mount effect twice; every arrival check is passive.
  const calls = await page.evaluate(() => window.__mockMcpConnectionCalls);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call.explicit === false)).toBe(true);
});

test('shows Failed with the error the check hit, as selectable text', async () => {
  const page = await launch();
  await page.evaluate(() => {
    window.__mockMcpConnection = { connected: false, error: 'From Ubuntu: fetch failed: connect ECONNREFUSED 127.0.0.1:4100' };
  });
  await openMcpServerTab(page);

  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Failed');
  const error = page.getByTestId('mcp-connection-error');
  await expect(error).toHaveText('From Ubuntu: fetch failed: connect ECONNREFUSED 127.0.0.1:4100');
  expect(await error.evaluate((element) => getComputedStyle(element).userSelect)).not.toBe('none');
});

// Red-green: blanking the status while a check runs fails the held-status
// assertion; a Test connection that asks like the arrival check fails the
// explicit one.
test('Test connection asks explicitly, and only the button changes while it runs', async () => {
  const page = await launch();
  await openMcpServerTab(page);
  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Connected');

  await page.evaluate(() => {
    window.__mockMcpConnection = () => new Promise((resolve) => {
      window.__releaseMcpCheck = () => resolve({ connected: false, error: 'HTTP 401 from http://127.0.0.1:4100/mcp/project-1' });
    });
  });
  const button = page.getByTestId('mcp-connection-test');
  await button.click();

  await expect(button).toBeDisabled();
  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Connected');
  await page.evaluate(() => window.__releaseMcpCheck?.());
  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Failed');
  await expect(button).toBeEnabled();
  const calls = await page.evaluate(() => window.__mockMcpConnectionCalls);
  expect(calls.at(-1)).toEqual({ explicit: true });
  expect(calls.slice(0, -1).every((call) => call.explicit === false)).toBe(true);
});

// The arrival check runs only while the row shows. A settings search that
// matches the MCP server switch but not the connection row mounts the row
// hidden (the card is there, the row renders nothing), and a check there would
// start a `wsl.exe` and a bridge round trip for a row nobody can see. The
// query "create task" is a keyword of the MCP server switch alone, so the MCP
// tab is the only one it matches; "mcp connection" is the row's own label.
//
// Red-green: the old effect (no visibility gate, dependency list empty) checks
// as the hidden row mounts, so the first no-check assertion fails; a gate that
// keeps the empty dependency list never checks again when the search brings the
// row back, so the Connected assertion times out.
test('a search that filters the row out starts no check, and refining it to show the row runs one', async () => {
  const page = await launch();
  await openSettings(page);
  const row = page.getByTestId('setting-row-mcpServer.connection');
  // The panel did not open on the MCP tab, so no check has run yet.
  await expect(row).toHaveCount(0);
  expect(await mcpCheckCalls(page)).toEqual([]);

  const search = page.getByTestId('settings-search');
  await search.fill('create task');
  // The card is up with its body mounted (a tool group beside the row is drawn),
  // and the row inside it is hidden. Without the body the test would pass vacuously.
  await expect(page.getByTestId('settings-card-mcpServer.enabled')).toBeVisible();
  await expect(page.getByTestId('mcp-tool-group-tasks')).toBeVisible();
  await expect(row).toHaveCount(0);
  await flushRenderedEffects(page);
  expect(await mcpCheckCalls(page)).toEqual([]);

  // A single fill, not typed keys: a typed prefix would pass through queries
  // that match the row and start a check on the way.
  await search.fill('mcp connection');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Connected');
  // The row stayed mounted, so this is the visibility change alone (a mount would
  // run the effect twice under StrictMode), and it is the passive arrival check.
  expect(await mcpCheckCalls(page)).toEqual([{ explicit: false }]);

  // Hiding it again starts nothing.
  await search.fill('create task');
  await expect(row).toHaveCount(0);
  await flushRenderedEffects(page);
  expect(await mcpCheckCalls(page)).toEqual([{ explicit: false }]);
});

// Red-green: the first no-check assertion fails against the old effect, as
// above. Against a gate that suppresses the check for good once the row mounted
// hidden, the Connected assertion times out.
test('clearing a search that filtered the row out shows it and runs the arrival check', async () => {
  const page = await launch();
  await openSettings(page);

  const search = page.getByTestId('settings-search');
  await search.fill('create task');
  await expect(page.getByTestId('settings-card-mcpServer.enabled')).toBeVisible();
  await expect(page.getByTestId('mcp-tool-group-tasks')).toBeVisible();
  await expect(page.getByTestId('setting-row-mcpServer.connection')).toHaveCount(0);
  await flushRenderedEffects(page);
  expect(await mcpCheckCalls(page)).toEqual([]);

  // The MCP tab was the only match, so clearing the search lands on it.
  await search.fill('');
  await expect(page.getByTestId('setting-row-mcpServer.connection')).toBeVisible();
  await expect(page.getByTestId('mcp-connection-status')).toHaveText('Connected');
  const calls = await mcpCheckCalls(page);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call.explicit === false)).toBe(true);
});

test('a failed check at a session start raises one persistent toast whose Open settings lands on the row', async () => {
  const page = await launch();
  await page.evaluate(() => window.__mockFireMcpConnectionFailed('From Ubuntu: wsl.exe gave no answer in 30 s.'));

  const toast = page.getByTestId('toast');
  await expect(toast.getByTestId('toast-title')).toHaveText("Couldn't reach the MCP server");
  await expect(toast.getByTestId('toast-body')).toHaveText('From Ubuntu: wsl.exe gave no answer in 30 s.');
  await expect(toast.getByTestId('toast-countdown')).toHaveCount(0);

  await toast.getByTestId('toast-action').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await expect(page.getByTestId('setting-row-mcpServer.connection')).toBeVisible();
});

declare global {
  interface Window {
    __mockMcpConnection: unknown;
    __mockMcpConnectionCalls: Array<{ explicit?: boolean }>;
    __mockFireMcpConnectionFailed: (error: string) => void;
    __releaseMcpCheck?: () => void;
  }
}
