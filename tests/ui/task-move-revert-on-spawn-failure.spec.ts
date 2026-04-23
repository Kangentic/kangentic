/**
 * UI test asserting that when a task move into an auto-spawn column fails
 * in the main process (e.g. "Cannot switch to branch 'main': you have
 * uncommitted changes..." on a non-worktree task), the card visually
 * returns to its source column and the real error message is shown as a
 * toast.
 *
 * The renderer is the half under test here. The main-process revert logic
 * (task-move.ts outer catch) undoes the forward `tasks.move()` in the DB
 * before re-throwing; on the renderer the IPC rejection triggers
 * `loadBoard()` which re-reads the (now reverted) task state. The mock
 * electronAPI exposes `window.__mockTaskMoveThrow` to simulate the
 * rejection while leaving the in-memory tasks array unchanged, which
 * mirrors the post-revert DB state.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-move-revert';
const TASK_ID = 'task-move-revert';

async function launchWithTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Move Revert Test',
        path: '/mock/move-revert-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var id = 'lane-mr-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[lane.name] = id;
        state.swimlanes.push(Object.assign({}, lane, {
          id: id,
          position: index,
          created_at: ts,
        }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Task To Revert',
        description: 'Starts in To Do, spawn attempt into Planning fails',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function resolveLaneIds(page: Page): Promise<{ todo: string; planning: string }> {
  return page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    const todoLane = lanes.find((lane: { role: string }) => lane.role === 'todo');
    const planningLane = lanes.find((lane: { name: string }) => lane.name === 'Planning');
    return { todo: todoLane?.id ?? '', planning: planningLane?.id ?? '' };
  });
}

async function moveBoardTask(page: Page, taskId: string, targetSwimlaneId: string): Promise<void> {
  await page.evaluate(
    async ({ tid, targetId }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          board: { getState: () => { moveTask: (input: object, skip?: boolean) => Promise<void> } };
        };
      }).__zustandStores;
      if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
      await stores.board.getState().moveTask(
        { taskId: tid, targetSwimlaneId: targetId, targetPosition: 0 },
        true,
      );
    },
    { tid: taskId, targetId: targetSwimlaneId },
  );
}

async function readTaskSwimlane(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: { getState: () => { tasks: Array<{ id: string; swimlane_id: string }> } };
      };
    }).__zustandStores;
    if (!stores?.board) return null;
    const task = stores.board.getState().tasks.find((item) => item.id === tid);
    return task?.swimlane_id ?? null;
  }, taskId);
}

test.describe('task move revert on spawn failure', () => {
  test('move into auto-spawn column reverts when main process throws, and toast shows the error', async () => {
    const { browser, page } = await launchWithTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });

      const laneIds = await resolveLaneIds(page);
      expect(laneIds.todo).toBeTruthy();
      expect(laneIds.planning).toBeTruthy();

      const todoColumn = page.locator('[data-swimlane-name="To Do"]');
      await expect(todoColumn.locator('text=Task To Revert')).toBeVisible({ timeout: 5000 });

      const errorMessage = "Cannot switch to branch 'main': you have uncommitted changes. "
        + 'Commit or stash your changes, or enable worktree mode for this task.';

      await page.evaluate((msg) => {
        (window as unknown as { __mockTaskMoveThrow?: string }).__mockTaskMoveThrow = msg;
      }, errorMessage);

      await moveBoardTask(page, TASK_ID, laneIds.planning);

      // The renderer's catch block re-reads the (unchanged) mock DB via
      // loadBoard(), so the task snaps back to its original swimlane.
      await expect.poll(
        () => readTaskSwimlane(page, TASK_ID),
        { timeout: 3000, intervals: [50, 100, 200, 300] },
      ).toBe(laneIds.todo);

      // Card should be visible in To Do again and NOT in Planning.
      await expect(page.locator('[data-swimlane-name="To Do"]').locator('text=Task To Revert'))
        .toBeVisible({ timeout: 3000 });
      await expect(page.locator('[data-swimlane-name="Planning"]').locator('text=Task To Revert'))
        .toHaveCount(0);

      // Toast shows the real failure reason from the main process - both
      // the "Failed to move task:" prefix (renderer-added) and the actual
      // underlying error text must appear in the same toast element.
      await expect(
        page.locator('text=/Failed to move task:.*uncommitted changes/').first(),
      ).toBeVisible({ timeout: 3000 });
    } finally {
      await browser.close();
    }
  });

  test('subsequent successful move still works after a failed move', async () => {
    const { browser, page } = await launchWithTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const laneIds = await resolveLaneIds(page);

      // First move fails
      await page.evaluate(() => {
        (window as unknown as { __mockTaskMoveThrow?: string }).__mockTaskMoveThrow = 'boom';
      });
      await moveBoardTask(page, TASK_ID, laneIds.planning);
      await expect.poll(
        () => readTaskSwimlane(page, TASK_ID),
        { timeout: 3000, intervals: [50, 100, 200, 300] },
      ).toBe(laneIds.todo);

      // Second move (hook cleared itself) should succeed
      await moveBoardTask(page, TASK_ID, laneIds.planning);
      await expect.poll(
        () => readTaskSwimlane(page, TASK_ID),
        { timeout: 3000, intervals: [50, 100, 200, 300] },
      ).toBe(laneIds.planning);
    } finally {
      await browser.close();
    }
  });
});
