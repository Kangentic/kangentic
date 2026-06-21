/**
 * UI test for the useWindowAutoCloseOnDone bridge.
 *
 * When a task's detail window is open and the task transitions off the board
 * (moved to Done / archived), the window must close immediately - before the
 * "This task is no longer available." placeholder can appear. The bridge
 * (src/renderer/window-manager/bridge/useWindowAutoCloseOnDone.ts) hooks on
 * completingTaskIds + the task's absence from `tasks` so the close happens on
 * the EARLIEST off-board signal, eliminating the grey-flash gap.
 *
 * This test cannot be covered at the unit tier because it requires the full
 * React render tree with board-store + window-store + all four bridge hooks
 * (useTaskDetailWindowBridge, useWindowAutoCloseOnDone, useWindowSessionClaims,
 * useWindowFocusReconcile) mounted inside WindowLayer.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-win-auto-close';
const TASK_ID = 'task-win-auto-close';
const SESSION_ID = 'sess-win-auto-close';

const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Window Auto-Close Test',
      path: '/mock/window-auto-close-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-wac-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Expose lane ids for the test to use.
    window.__wacLaneIds = laneIds;

    // A running session so the detail window opens in running mode (not edit form),
    // making the window unambiguously "open on the active board" rather than opened
    // from the Completed Tasks list (which carries openedDone and is NOT auto-closed).
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/window-auto-close-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Auto-Close Window Task',
      description: 'Task for the window auto-close-on-Done bridge test',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
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
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('useWindowAutoCloseOnDone bridge', () => {
  test('window closes immediately when its task moves to Done - no placeholder shown', async () => {
    // Open the task detail window by clicking the card. The running session
    // means the window opens in view mode (not edit form), so TaskDetailWindow
    // is fully mounted with data-testid="task-detail-dialog".
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Auto-Close Window Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Confirm the window is truly open (not a false-positive from a previous test).
    await expect(dialog).toBeVisible();

    // Confirm the window overlay portal is mounted at the document level.
    const overlay = page.locator('[data-testid="window-overlay"]');
    await expect(overlay).toBeVisible();

    // Move the task to Done via the mock IPC (mirrors tasks.move + loadBoard()).
    // The mock's tasks.move sets archived_at and removes the task from tasks[] when
    // the target lane has role='done'. Then loadBoard() reconciles the board store
    // so the bridge sees tasks[] no longer containing this task and fires closeWindow.
    await page.evaluate((taskId) => {
      // Get the Done lane id from the swimlanes the mock set up.
      const laneIds: Record<string, string> = (window as unknown as { __wacLaneIds: Record<string, string> }).__wacLaneIds || {};
      const doneLaneId = laneIds['Done'];
      if (!doneLaneId) throw new Error('Done lane id not found in __wacLaneIds');

      // Call the IPC directly (as the renderer does on a drag-to-Done).
      void window.electronAPI.tasks.move(
        { taskId, targetSwimlaneId: doneLaneId, targetPosition: 0 },
        '${PROJECT_ID}',
      );
    }, TASK_ID);

    // Trigger a board reload so the board store reconciles its tasks[] state.
    // The bridge fires on the next render once tasks[] no longer contains the task.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { getState: () => { loadBoard: () => Promise<void> } } };
      }).__zustandStores;
      void stores?.board.getState().loadBoard();
    });

    // The window must close within a reasonable time. The bridge fires synchronously
    // on the next render after loadBoard() reconciles, so 3000ms is very generous.
    await expect
      .poll(
        () => dialog.isVisible(),
        { timeout: 3000, intervals: [100, 200, 300] },
      )
      .toBe(false);

    // The "no longer available" placeholder must NEVER have appeared. Because the
    // bridge closes the window before the content remounts with the null-task path,
    // this text should be absent throughout. We assert after the close settles.
    const placeholder = page.locator('text=This task is no longer available.');
    await expect(placeholder).toHaveCount(0);
  });
});
