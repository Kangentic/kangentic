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

async function openMcpServerTab(page: Page): Promise<void> {
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await page.getByTestId('settings-tab-mcpServer').click();
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
