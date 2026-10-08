/**
 * UI tests for the "Isolated" badge in the task detail dialog header.
 *
 * Feature intent (per-column session isolation):
 *   When a task's current column is configured for an isolated session
 *   (swimlane.session_target === 'isolated'), the task detail header shows a
 *   text-only "Isolated" badge (data-testid="task-detail-isolated-badge")
 *   next to the title. Tasks in normal (session_target === 'main') columns
 *   show NO badge.
 *
 * The task detail body embeds a single terminal with no session-tab bar, so the
 * header badge is the only isolated signal inside the dialog.
 *
 * Test approach: pre-configure the mock with one swimlane overridden to
 * session_target 'isolated' and one left as 'main', a running-session task in
 * each, then open each task's dialog and assert badge presence/absence. The
 * running session opens the dialog in non-editing mode (TaskDetailHeader
 * rendered), mirroring task-detail-changes-panel.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-detail-isolated-badge';
const ISO_TASK_ID = 'task-detail-iso';
const MAIN_TASK_ID = 'task-detail-main';
const ISO_SESSION_ID = 'sess-detail-iso';
const MAIN_SESSION_ID = 'sess-detail-main';

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Detail Isolated Badge Test',
      path: '/mock/detail-isolated-badge-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      var lane = Object.assign({}, s, { id: id, position: i, created_at: ts });
      // Override Code Review to run an isolated session; the rest stay 'main'.
      if (s.name === 'Code Review') lane.session_target = 'isolated';
      state.swimlanes.push(lane);
    });

    // Running sessions so each dialog opens in non-editing mode and the header renders.
    state.sessions.push({
      id: '${ISO_SESSION_ID}',
      taskId: '${ISO_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 7001,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/detail-isolated-badge-test',
      startedAt: ts,
      exitCode: null,
      isolatedSwimlaneId: laneIds['Code Review'],
    });
    state.sessions.push({
      id: '${MAIN_SESSION_ID}',
      taskId: '${MAIN_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 7002,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/detail-isolated-badge-test',
      startedAt: ts,
      exitCode: null,
      isolatedSwimlaneId: null,
    });

    // Task in the isolated column.
    state.tasks.push({
      id: '${ISO_TASK_ID}',
      title: 'Isolated Detail Task',
      description: 'Task in an isolated-session column',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${ISO_SESSION_ID}',
      worktree_path: '/mock/worktrees/detail-iso',
      branch_name: 'feature/detail-iso',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Task in a normal (main) column.
    state.tasks.push({
      id: '${MAIN_TASK_ID}',
      title: 'Main Detail Task',
      description: 'Task in a normal main-session column',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${MAIN_SESSION_ID}',
      worktree_path: '/mock/worktrees/detail-main',
      branch_name: 'feature/detail-main',
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

test.describe('Task Detail: isolated session badge', () => {
  test('isolated-column task shows the isolated badge in the header', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
      await page
        .locator('[data-swimlane-name="Code Review"]')
        .locator('text=Isolated Detail Task')
        .first()
        .click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      const badge = page.locator('[data-testid="task-detail-isolated-badge"]');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toContainText('Isolated');
    } finally {
      await browser.close();
    }
  });

  test('main-column task does NOT show the isolated badge', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
      await page
        .locator('[data-swimlane-name="Executing"]')
        .locator('text=Main Detail Task')
        .first()
        .click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Header has rendered (dialog visible); the badge must be absent for a main column.
      await expect(page.locator('[data-testid="task-detail-isolated-badge"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
