/**
 * UI tests for the Task Detail Changes panel expand / collapse controls.
 *
 * Opens a dialog on a task with an active session (so TaskDetailBody renders,
 * not the edit form) and exercises the split / expanded view-mode controls that
 * live in the changes pane (the panel has no close button: the header Changes
 * pill owns closing).
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

const PROJECT_ID = 'proj-changes-panel';
const TASK_ID = 'task-changes-panel';
const SESSION_ID = 'sess-changes-panel';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Changes Panel Test',
      path: '/mock/changes-panel-test',
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

    // Running session so displayState.kind === 'running' -> dialog opens in
    // non-editing mode and TaskDetailHeader (with Changes pill) is rendered.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/changes-panel-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Changes Panel Task',
      description: 'Task used for Changes panel controls test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/changes-panel',
      branch_name: 'feature/changes-panel',
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

test.describe('Task Detail Changes panel: expand / collapse', () => {
  test('controls toggle between split and expanded; the pill closes the panel', async () => {
    // Open the task detail dialog
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Changes Panel Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Changes toggle pill is visible (task is in Code Review, has a running session)
    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await expect(changesPill).toBeVisible();

    // Panel not yet open -> no panel controls rendered
    await expect(page.locator('[data-testid="changes-expand"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="changes-collapse"]')).not.toBeVisible();

    // The colliding panel-local close X is gone: closing is owned by the pill.
    await expect(page.locator('[data-testid="changes-close"]')).toHaveCount(0);

    // Open Changes -> defaults to split view: expand control appears.
    // On CI Linux the React re-render after the pill click can take >5s; give
    // the state update a full 10s budget before failing.
    await changesPill.click();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="changes-collapse"]')).not.toBeVisible({ timeout: 10000 });
    // No panel-local close even while the panel is open.
    await expect(page.locator('[data-testid="changes-close"]')).toHaveCount(0);

    // Expand -> collapse control replaces expand
    await page.locator('[data-testid="changes-expand"]').click();
    await expect(page.locator('[data-testid="changes-collapse"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-expand"]')).not.toBeVisible();

    // Collapse -> back to split view
    await page.locator('[data-testid="changes-collapse"]').click();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-collapse"]')).not.toBeVisible();

    // The pill closes the Changes panel entirely; controls disappear, pill stays.
    await changesPill.click();
    await expect(page.locator('[data-testid="changes-expand"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="changes-collapse"]')).not.toBeVisible();
    await expect(changesPill).toBeVisible();

    // Re-opening Changes after close always returns to split (not expanded)
    await changesPill.click();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-collapse"]')).not.toBeVisible();

    // Close the panel and dialog so state does not leak to other tests.
    // Use Control+Shift+W (capture-phase) rather than Escape: the task-detail
    // window has a running session, so Escape via the bubble-phase listener can
    // be intercepted on CI Linux after panel interactions move focus.
    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
