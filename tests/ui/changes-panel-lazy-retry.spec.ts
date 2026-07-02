/**
 * UI test for scoped, recoverable lazy loading of the Changes panel.
 *
 * Regression guard for the bug where a transient dynamic-import failure of the
 * code-split ChangesPanel module crashed the ENTIRE app to the root error page,
 * and "Try again" could never recover.
 *
 * The fix: each lazy site is wrapped in a scoped PanelErrorBoundary. A chunk-load
 * failure is caught there (not at the root), so the rest of the app survives. The
 * browser caches a failed module URL in its module map for the document's
 * lifetime, so recovery from a chunk-load failure requires a full window reload
 * (a fresh module map); the boundary surfaces a Reload action for exactly that.
 *
 * This test aborts the ChangesPanel module fetch, opens the panel, and asserts
 * (a) the failure stays scoped to the panel (the app and dialog survive) and
 * (b) after healing the network, reloading recovers (the panel then loads).
 *
 * Note: this spec deliberately breaks the network, so an aborted module fetch
 * surfaces a console resource error and a React error-boundary console.error.
 * Those are expected and handled by the boundary, so `collectPageErrors` is
 * intentionally NOT used here.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-lazy-retry';
const TASK_ID = 'task-lazy-retry';
const SESSION_ID = 'sess-lazy-retry';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Lazy Retry Test',
      path: '/mock/lazy-retry-test',
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

    // Running session so the dialog opens in non-editing mode and the Changes
    // pill is rendered.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/lazy-retry-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Lazy Retry Task',
      description: 'Task used for the Changes-panel lazy-retry test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/lazy-retry',
      branch_name: 'feature/lazy-retry',
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

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

async function openTaskAndChanges(): Promise<void> {
  const card = page
    .locator('[data-swimlane-name="Code Review"]')
    .locator('text=Lazy Retry Task')
    .first();
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="changes-toggle"]').click();
}

test.describe('Changes panel: lazy-import failure is scoped and recoverable', () => {
  test('a chunk failure shows a panel-scoped error, not a root crash, and reload recovers', async () => {
    // Abort the ChangesPanel module fetch BEFORE anything imports it. The panel
    // is only imported the first time the Changes pill is clicked (no static
    // import exists), and this page's context has a cold module map, so the
    // abort deterministically hits a fresh dynamic import. The trailing `*`
    // matches Vite's optional `?t=` invalidation query.
    await page.route('**/ChangesPanel.tsx*', (route) => route.abort());

    await openTaskAndChanges();

    // The lazy import fails and the SCOPED boundary catches it.
    const boundary = page.locator('[data-testid="panel-error-boundary"]');
    await expect(boundary).toBeVisible({ timeout: 10000 });

    // Blast radius stayed scoped to the panel: the app did not fall to the root
    // "Something went wrong" page, and the dialog is still open.
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible();

    // A chunk-load failure cannot be healed by a remount (the module URL is
    // poisoned in the module map), so the boundary offers Reload, not Retry.
    const action = page.locator('[data-testid="panel-error-retry"]');
    await expect(action).toHaveText(/Reload/);

    // Heal the network, then reload. A fresh document has a fresh module map, so
    // the panel loads on the next open.
    await page.unroute('**/ChangesPanel.tsx*');
    await action.click();

    // The app comes back up cleanly (no root crash).
    await page.waitForLoadState('load');
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();

    // Reopen the task and the Changes panel: it now loads (changes-expand renders
    // inside the lazy ChangesPanel module, proving the module loaded this time).
    await openTaskAndChanges();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible({ timeout: 10000 });
    await expect(boundary).not.toBeVisible();

    // Close the panel and dialog so state does not leak to other tests.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
  });
});
