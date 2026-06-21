/**
 * UI tests for the BrowserEmptyState component.
 *
 * Drives the component through the real app surface: opens a task with an
 * active session, toggles the Browser pill, and exercises the empty-state
 * UI that renders when no project default and no task override are set.
 *
 * The actual <webview> intrinsic only renders when an effectiveUrl exists,
 * so the empty-state path stays inside React land and is fully testable
 * under headless Chromium.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-empty';
const TASK_ID = 'task-browser-empty';
const SESSION_ID = 'sess-browser-empty';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Empty State Test',
      path: '/mock/browser-empty-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/browser-empty-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Empty Browser Task',
      description: 'Used to drive BrowserEmptyState',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithPlatform(platform: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript((p: 'win32' | 'darwin' | 'linux') => {
    window.__mockPlatform = p;
  }, platform as 'win32' | 'darwin' | 'linux');
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

async function openBrowserPane(page: Page): Promise<void> {
  // Reset any seeded task URL between tests so the empty state always renders.
  await page.evaluate(() => window.__mockBrowser?.reset());

  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Empty Browser Task').first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  // The browserOpen flag is sticky per-task across dialog opens (Zustand
  // store keyed on task.id), so toggling blindly can flip it OFF when a
  // previous test left it on. Only toggle when the pane isn't already showing.
  const emptyState = page.locator('[data-testid="browser-empty-state"]');
  if (!(await emptyState.isVisible().catch(() => false))) {
    // The browser-toggle pill can overflow the modeless window's header, so open
    // the browser pane via its keyboard shortcut instead (the window has focus
    // right after it opens, and the shortcut does not depend on the pill being
    // un-overflowed). The keybinding resolves Mod from the MOCKED platform, so
    // the darwin block must press Meta and the win32 block Control.
    const isMac = await page.evaluate(() => window.__mockPlatform === 'darwin');
    await page.keyboard.press(isMac ? 'Meta+Shift+B' : 'Control+Shift+B');
  }
  await emptyState.waitFor({ state: 'visible', timeout: 5000 });
}

async function closeDialog(page: Page): Promise<void> {
  await page.locator('[data-testid="task-detail-close"]').click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
}

test.describe('BrowserEmptyState (Windows platform)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithPlatform('win32');
    browser = result.browser;
    page = result.page;
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await openBrowserPane(page);
  });

  test.afterEach(async () => {
    await closeDialog(page);
  });

  test('renders all four quick picks with the expected labels', async () => {
    for (const label of ['localhost:3000', 'localhost:5173', 'localhost:4321', 'localhost:8080']) {
      await expect(page.locator(`[data-testid="browser-quick-pick-${label}"]`)).toBeVisible();
    }
  });

  test('quick pick click seeds the task URL and dismisses the empty state', async () => {
    await page.locator('[data-testid="browser-quick-pick-localhost:5173"]').click();

    // useBrowserUrl.recordNavigation is fired by the empty-state submit and
    // calls browser.setTaskUrl. Once that lands, BrowserPane re-renders into
    // the active branch (with URL bar) and the empty state goes away.
    await expect(page.locator('[data-testid="browser-empty-state"]')).toBeHidden({ timeout: 3000 });

    const seeded = await page.evaluate(async () => {
      const result = await window.electronAPI.browser.getUrls('task-browser-empty');
      return result.taskOverride;
    });
    // normalizeUrl runs the URL through `new URL().toString()`, which
    // canonicalizes URLs without a path to include a trailing slash.
    expect(seeded).toBe('http://localhost:5173/');
  });

  test('typing a URL and pressing Open submits the normalized value', async () => {
    const input = page.locator('[data-testid="browser-empty-state-input"]');
    await input.fill('example.com');
    await page.locator('[data-testid="browser-empty-state-open"]').click();

    await expect(page.locator('[data-testid="browser-empty-state"]')).toBeHidden({ timeout: 3000 });

    const seeded = await page.evaluate(async () => {
      const result = await window.electronAPI.browser.getUrls('task-browser-empty');
      return result.taskOverride;
    });
    // normalizeUrl runs the URL through `new URL().toString()`, which
    // canonicalizes example.com to example.com/.
    expect(seeded).toBe('http://example.com/');
  });

  test('blank input surfaces an error and does not seed a URL', async () => {
    const input = page.locator('[data-testid="browser-empty-state-input"]');
    await input.fill('   ');
    await page.locator('[data-testid="browser-empty-state-open"]').click();

    await expect(page.getByText('Enter a valid http:// or https:// URL.')).toBeVisible();

    const seeded = await page.evaluate(async () => {
      const result = await window.electronAPI.browser.getUrls('task-browser-empty');
      return result.taskOverride;
    });
    expect(seeded).toBeNull();

    // Empty state still showing.
    await expect(page.locator('[data-testid="browser-empty-state"]')).toBeVisible();
  });

  test('WSL hint renders when platform === win32', async () => {
    await expect(page.getByText('On Windows: if your dev server runs in WSL')).toBeVisible();
  });
});

test.describe('BrowserEmptyState (macOS platform)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithPlatform('darwin');
    browser = result.browser;
    page = result.page;
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('WSL hint is hidden when platform !== win32', async () => {
    await openBrowserPane(page);
    await expect(page.getByText('On Windows: if your dev server runs in WSL')).toBeHidden();
    await closeDialog(page);
  });
});
