/**
 * The marks a stopped Browser pane page turns red outside the task window
 * (task #1226): a Command Terminal's Running row globe and Browser pill, and the
 * Agent Monitor card's globe for a task row and for a Command Terminal row.
 *
 * Main pushes one map of owner key to 'out-of-memory' | 'crashed', which the
 * mock fires through `emitCrashedSurfaces`. The task window's own pill, card
 * globe and pane cover are covered in browser-pane-crashed.spec.ts. What this
 * file pins is the KEY each reader looks up: a task is keyed by its id and a
 * Command Terminal by its slot's owner key, never by its synthetic task id.
 *
 * Each test owns its browser and page, so the file fans out across the workers.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-crash-marks';
const PROJECT_PATH = '/mock/crash-marks';
const SLOT = 'slot-1';
const OWNER_KEY = `command-terminal::${PROJECT_ID}::${SLOT}`;
const TERMINAL_TASK_ID = 'transient-crash-1';
const GUEST_ID = 4344;

const TERMINAL_OOM_TIP = /The page in this terminal's browser ran out of memory\. Open the terminal to reload it\./;

let browser: Browser;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await browser?.close();
});

const PROJECT_SEED = `
  var timestamp = new Date().toISOString();
  state.projects.push({ id: '${PROJECT_ID}', name: 'Crash Marks', path: '${PROJECT_PATH}', github_url: null,
    default_agent: 'claude', last_opened: timestamp, created_at: timestamp });
  state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };
  state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
    state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-cm-' + index, position: index, created_at: timestamp }));
  });
`;

async function openPage(preConfigBody: string, extraInitScript = ''): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      ${PROJECT_SEED}
      ${preConfigBody}
      return { currentProjectId: '${PROJECT_ID}' };
    });
    ${extraInitScript}
  `);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return page;
}

/** Fire main's stopped-page push: the whole map, as main sends it. */
async function crashedSurfaces(page: Page, surfaces: Record<string, 'out-of-memory' | 'crashed'>): Promise<void> {
  await page.evaluate((map) => window.__mockBrowser?.emitCrashedSurfaces(map), surfaces);
}

test('a Command Terminal turns its Running row globe and Browser pill red from its slot key', async () => {
  const page = await openPage('', `window.__mockBrowser.seedTaskUrl('${OWNER_KEY}', 'http://localhost:5173/');`);
  try {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.keyboard.press('Control+Shift+P');
    await expect(page.getByTestId('command-terminal-window')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('command-bar-browser-toggle').click();

    // Fake the guest attaching, so the terminal has a live page to mark.
    await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate((webContentsId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]');
      if (!element) throw new Error('browser-webview element not found');
      const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
      stub.getWebContentsId = () => webContentsId;
      stub.getURL = () => 'http://localhost:5173/';
      element.dispatchEvent(new Event('dom-ready'));
    }, GUEST_ID);

    const runningGlobe = page.getByTestId('command-terminal-running-browser');
    const pillBadge = page.getByTestId('command-bar-browser-toggle-alive');
    await expect(runningGlobe).toBeVisible({ timeout: 5000 });
    await expect(pillBadge).toHaveAttribute('data-badge', 'running');
    await expect(runningGlobe).not.toHaveAttribute('data-crash-kind', /.+/);

    await test.step('an out-of-memory push on the slot key marks both', async () => {
      await crashedSurfaces(page, { [OWNER_KEY]: 'out-of-memory' });
      await expect(runningGlobe).toHaveAttribute('data-crash-kind', 'out-of-memory');
      await expect(runningGlobe).toHaveAccessibleDescription(TERMINAL_OOM_TIP);
      await expect(pillBadge).toHaveAttribute('data-badge', 'problems');
      await expect(page.getByTestId('command-bar-browser-toggle')).toHaveAccessibleDescription(/Page ran out of memory/);
    });

    await test.step('another key marks nothing: the lookup is by this slot', async () => {
      await crashedSurfaces(page, { [`command-terminal::${PROJECT_ID}::slot-9`]: 'crashed' });
      await expect(runningGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
      await expect(pillBadge).toHaveAttribute('data-badge', 'running');
    });

    await test.step('an empty map returns the running marks', async () => {
      await crashedSurfaces(page, { [OWNER_KEY]: 'out-of-memory' });
      await expect(pillBadge).toHaveAttribute('data-badge', 'problems');
      await crashedSurfaces(page, {});
      await expect(runningGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
      await expect(pillBadge).toHaveAttribute('data-badge', 'running');
    });
  } finally {
    await page.context().close();
  }
});

test('the Agent Monitor card marks a task by its id and a Command Terminal by its slot key', async () => {
  const rowBase = `
    projectId: '${PROJECT_ID}', projectName: 'Crash Marks', outputPeek: [], priority: 0, labels: [],
    prUrl: null, prNumber: null, prState: null, agentName: 'claude', modelDisplayName: 'Opus 5',
    effort: null, permissionMode: null, startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
    status: 'running', activity: 'thinking', activityReason: null, lastEvent: null,
    contextPercent: null, isolated: false, browserRunning: true,
  `;
  const page = await openPage(`
    var seededAt = new Date().toISOString();
    state.tasks.push({ id: 'task-crash-a', title: 'Crash task', description: '', display_id: 31,
      swimlane_id: 'lane-cm-0', position: 0, labels: [], priority: 0, run_mode: 'agent',
      archived_at: null, created_at: seededAt, updated_at: seededAt });
    state.sessions.push({ id: 'sess-crash-a', taskId: 'task-crash-a', projectId: '${PROJECT_ID}', pid: 4301,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: seededAt, exitCode: null });
    state.sessions.push({ id: 'sess-crash-ct', taskId: '${TERMINAL_TASK_ID}', projectId: '${PROJECT_ID}', pid: 4302,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: seededAt, exitCode: null,
      resuming: false, transient: true, commandTerminalSlot: '${SLOT}', commandTerminalBranch: 'main',
      commandTerminalLabel: null });
  `, `
    window.__mockMonitorRows = [
      { sessionId: 'sess-crash-a', taskId: 'task-crash-a', taskTitle: 'Crash task', displayId: 31,
        columnName: 'To Do', commandTerminalBranch: null, isCommandTerminal: false, ${rowBase} },
      { sessionId: 'sess-crash-ct', taskId: '${TERMINAL_TASK_ID}', taskTitle: 'Command Terminal 1', displayId: null,
        columnName: '', commandTerminalBranch: 'main', isCommandTerminal: true, ${rowBase} },
    ];
    // Main's map before this window loaded (a reload, or a page that stopped while it was
    // closed): with no subscriber yet this only seeds what the mount-time read returns.
    window.__mockBrowser.emitCrashedSurfaces({ 'task-crash-a': 'crashed' });
  `);
  try {
    await page.locator('[data-testid="agent-monitor-button"]').click();
    await page.locator('[data-testid="monitor-grid"]').waitFor({ state: 'visible', timeout: 10000 });
    const taskGlobe = page.locator('[data-session-id="sess-crash-a"] [data-testid="monitor-card-browser-alive"]');
    const terminalGlobe = page.locator('[data-session-id="sess-crash-ct"] [data-testid="monitor-card-browser-alive"]');
    await expect(taskGlobe).toBeVisible();
    await expect(terminalGlobe).toBeVisible();

    await test.step('a page that stopped before the window loaded is red from the mount-time read, with no push', async () => {
      await expect(taskGlobe).toHaveAttribute('data-crash-kind', 'crashed');
      await expect(terminalGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
    });

    await test.step('a task row turns on its task id, with the task-worded tip', async () => {
      await crashedSurfaces(page, { 'task-crash-a': 'crashed' });
      await expect(taskGlobe).toHaveAttribute('data-crash-kind', 'crashed');
      await expect(taskGlobe).toHaveAccessibleDescription(/crashed\. Open the task to reload it\./);
      await expect(terminalGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
    });

    await test.step('a Command Terminal row ignores its synthetic task id', async () => {
      await crashedSurfaces(page, { [TERMINAL_TASK_ID]: 'crashed' });
      await expect(terminalGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
      await expect(taskGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
    });

    await test.step('a Command Terminal row turns on its slot owner key, with the terminal-worded tip', async () => {
      await crashedSurfaces(page, { [OWNER_KEY]: 'out-of-memory' });
      await expect(terminalGlobe).toHaveAttribute('data-crash-kind', 'out-of-memory');
      await expect(terminalGlobe).toHaveAccessibleDescription(TERMINAL_OOM_TIP);
      await expect(taskGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
    });

    await test.step('an empty map clears both cards', async () => {
      await crashedSurfaces(page, {});
      await expect(terminalGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
      await expect(taskGlobe).not.toHaveAttribute('data-crash-kind', /.+/);
    });
  } finally {
    await page.context().close();
  }
});
