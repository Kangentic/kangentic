/**
 * UI test for scoped, recoverable lazy loading of the Changes panel at the
 * STANDALONE TaskChangesDialog wiring site (opened via a task card's "Changes"
 * context-menu entry), mirroring tests/ui/changes-panel-lazy-retry.spec.ts,
 * which covers the same PanelErrorBoundary wrapper at the TaskDetailBody
 * (task-detail dialog) site.
 *
 * The wrapper is byte-identical at both sites (`<PanelErrorBoundary
 * label="Changes panel"><Suspense>...<ChangesPanel /></Suspense></PanelErrorBoundary>`),
 * but the surrounding dialog differs (TaskChangesDialog vs TaskDetailBody), so
 * this pins that the boundary catches a chunk-load failure and offers Reload
 * at THIS site's own mount point too, without a root crash.
 *
 * Same abort/reload technique: aborting the ChangesPanel module fetch forces a
 * dynamic-import failure on first open; healing the network and reloading lets
 * a fresh module map load the panel on next open.
 *
 * Note: this spec deliberately breaks the network, so an aborted module fetch
 * surfaces a console resource error and a React error-boundary console.error.
 * Those are expected and handled by the boundary, so `collectPageErrors` is
 * intentionally NOT used here (same rationale as changes-panel-lazy-retry.spec.ts).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, waitForBoard } from './helpers';

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

const PROJECT_ID = 'proj-changes-dialog-lazy-retry';
const TASK_ID = 'task-changes-dialog-lazy-retry';

// A task with a worktree_path is required for the context menu's "Changes"
// entry to render at all (see tests/ui/task-changes-dialog.spec.ts, which
// pins the entry HIDDEN for a task with no worktree). No session is needed:
// TaskChangesDialog does not read session state.
const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Changes Dialog Lazy Retry Test',
      path: '/mock/changes-dialog-lazy-retry-test',
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

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Changes Dialog Lazy Retry Task',
      description: 'Task used for the standalone TaskChangesDialog lazy-retry test',
      swimlane_id: laneIds['To Do'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: '/mock/worktrees/changes-dialog-lazy-retry',
      branch_name: 'feature/changes-dialog-lazy-retry',
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
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

function taskCard(): ReturnType<Page['locator']> {
  return page.locator('[data-swimlane-name="To Do"]').locator('text=Changes Dialog Lazy Retry Task').first();
}

async function openChangesDialogViaContextMenu(): Promise<void> {
  await taskCard().click({ button: 'right' });
  await page.locator('[data-testid="context-show-changes"]').click();
  await page.locator('[data-testid="task-changes-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Standalone Changes dialog: lazy-import failure is scoped and recoverable', () => {
  test('a chunk failure shows a panel-scoped error, not a root crash, and reload recovers', async () => {
    // Abort the ChangesPanel module fetch BEFORE anything imports it. This
    // page's context has a cold module map (fresh browser context per spec
    // file), so the abort deterministically hits a fresh dynamic import.
    await page.route('**/ChangesPanel.tsx*', (route) => route.abort());

    await openChangesDialogViaContextMenu();

    // The lazy import fails and the SCOPED boundary catches it.
    const boundary = page.locator('[data-testid="panel-error-boundary"]');
    await expect(boundary).toBeVisible({ timeout: 10000 });

    // Blast radius stayed scoped to the panel: the app did not fall to the
    // root "Something went wrong" page, and the dialog is still open.
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('[data-testid="task-changes-dialog"]')).toBeVisible();

    // A chunk-load failure cannot be healed by a remount (the module URL is
    // poisoned in the module map), so the boundary offers Reload, not Retry.
    const action = page.locator('[data-testid="panel-error-retry"]');
    await expect(action).toHaveText(/Reload/);

    // Heal the network, then reload. A fresh document has a fresh module map,
    // so the panel loads on the next open.
    await page.unroute('**/ChangesPanel.tsx*');
    await action.click();

    // The app comes back up cleanly (no root crash).
    await page.waitForLoadState('load');
    await waitForBoard(page);
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();

    // Reopen the Changes dialog: it now loads for real. The mock's diffFiles
    // returns an empty file list by default, and TaskChangesDialog passes
    // emptyMessage="No changes on this branch", so that text is the
    // definitive "the real ChangesPanel module loaded, not the boundary"
    // signal here (TaskChangesDialog does not pass panelMode/onExpand, so
    // the split-only "changes-expand" testid never renders at this site).
    await openChangesDialogViaContextMenu();
    await expect(page.locator('text=No changes on this branch')).toBeVisible({ timeout: 10000 });
    await expect(boundary).not.toBeVisible();

    // Close the dialog so state does not leak to other tests in this file.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="task-changes-dialog"]')).not.toBeVisible({ timeout: 8000 });
  });
});
