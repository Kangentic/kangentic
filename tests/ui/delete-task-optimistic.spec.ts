/**
 * UI tests for the optimistic deleteTask() in
 * src/renderer/stores/board-store/task-slice.ts.
 *
 * Six scenarios tested (all UI-tier - no real PTY, no real Electron):
 *
 * Gap 1 - Optimistic removal during IPC window
 *   Immediately after calling deleteTask() but before the IPC resolves,
 *   the task must be absent from state.tasks (and state.archivedTasks).
 *
 * Gap 2 - Failure path rollback
 *   When tasks.delete rejects, state.tasks reverts to the pre-call snapshot
 *   (task back in its original swimlane and position) and an error toast
 *   starting "Failed to delete task:" is shown. The promise rejects so
 *   callers can skip their own success toasts.
 *
 * Gap 3 - Rapid double-delete is consistent
 *   Two rapid deleteTask() calls for the same task settle without producing
 *   ghost cards, error toasts, or duplicates. The store filter is a no-op
 *   on the second call; backend withTaskLock serializes the IPCs.
 *
 * Gap 4 - TaskCard.handleContextDelete survives re-throw (caller-layer)
 *   Right-click context menu delete, armed with __mockTaskDeleteThrow:
 *   (a) the card reappears in its original slot, (b) the error toast is
 *   visible, (c) the confirm dialog has closed. Proves re-throw does not
 *   crash the async event handler in TaskCard.
 *
 * Gap 5 - useTaskActions.handleDelete skips success toast on failure
 *   Opening the task detail dialog and clicking Delete while
 *   __mockTaskDeleteThrow is armed must produce only the error toast
 *   and NOT a "Deleted task ..." info toast. Covers the re-throw
 *   path in useTaskActions.ts:346-358.
 *
 * Gap 6 - deleteTask() handles archivedTasks as the primary hit
 *   Seeding the task in archivedTasks (not tasks[]) and calling
 *   deleteTask() removes it from archivedTasks; tasks[] is unaffected.
 *
 * Mock hooks added to mock-electron-api.js:
 *   window.__mockTaskDeleteDeferred = true  -> next delete() hangs until
 *     window.__mockTaskDeleteResolve() is called.
 *   window.__mockTaskDeleteThrow = 'msg'    -> next delete() rejects.
 *   window.__mockTaskDeleteCallCount[id]    -> per-id IPC call counter.
 *
 * Pattern: invoke board-store deleteTask() directly via __zustandStores,
 * matching unarchive-task-optimistic.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-delete-optimistic';
const TASK_ID = 'task-delete-optimistic';

async function launchWithActiveTask(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Delete Optimistic Test',
        path: '/mock/delete-optimistic-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-do-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // One active task in the To Do lane at position 0
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Active Task For Delete Test',
        description: 'Will be deleted optimistically',
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

async function readTaskLists(page: Page, taskId: string): Promise<{
  inTasks: boolean;
  inArchivedTasks: boolean;
  taskSwimlaneId: string | null;
  taskPosition: number | null;
}> {
  return page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{ id: string; swimlane_id: string; position: number }>;
            archivedTasks: Array<{ id: string }>;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
    const state = stores.board.getState();
    const activeTask = state.tasks.find((t) => t.id === tid) ?? null;
    const archivedTask = state.archivedTasks.find((t) => t.id === tid) ?? null;
    return {
      inTasks: activeTask !== null,
      inArchivedTasks: archivedTask !== null,
      taskSwimlaneId: activeTask?.swimlane_id ?? null,
      taskPosition: activeTask?.position ?? null,
    };
  }, taskId);
}

async function waitForToast(
  page: Page,
  textPattern: RegExp | string,
  timeoutMs = 5000,
): Promise<void> {
  await expect(
    page.locator('[data-testid="toast"]').filter({ hasText: textPattern }),
  ).toBeVisible({ timeout: timeoutMs });
}

async function resolveLaneId(page: Page, laneName: string): Promise<string> {
  const id = await page.evaluate(async (name) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((lane: { name: string }) => lane.name === name);
    return lane?.id ?? null;
  }, laneName);
  if (!id) throw new Error(`No swimlane found with name: ${laneName}`);
  return id;
}

/**
 * Invoke deleteTask() on the board store directly. Returns the inner
 * promise so the test can observe whether it resolves or rejects (the
 * optimistic implementation re-throws on backend failure).
 */
function startDeleteTask(page: Page, taskId: string): Promise<{ ok: boolean; error: string | null }> {
  return page.evaluate(async (tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            deleteTask: (id: string) => Promise<void>;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
    try {
      await stores.board.getState().deleteTask(tid);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, taskId);
}

// -----------------------------------------------------------------------
// Gap 1: Optimistic removal during IPC window
// -----------------------------------------------------------------------
test.describe('deleteTask - optimistic removal', () => {
  test('task disappears from tasks[] before IPC resolves', async () => {
    const { browser, page } = await launchWithActiveTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const initialState = await readTaskLists(page, TASK_ID);
      expect(initialState.inTasks).toBe(true);
      expect(initialState.inArchivedTasks).toBe(false);

      // Arm the deferred hook so tasks.delete() hangs
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteDeferred?: boolean }).__mockTaskDeleteDeferred = true;
      });

      // Start the delete - do NOT await; we need to probe the optimistic state
      const deletePromise = startDeleteTask(page, TASK_ID);

      // Poll until the optimistic removal lands in the store
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return !state.inTasks && !state.inArchivedTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      const optimisticState = await readTaskLists(page, TASK_ID);
      expect(optimisticState.inTasks).toBe(false);
      expect(optimisticState.inArchivedTasks).toBe(false);

      // Release the deferred IPC
      await page.evaluate(() => {
        const win = window as unknown as { __mockTaskDeleteResolve?: () => void };
        win.__mockTaskDeleteResolve?.();
      });

      const result = await deletePromise;
      expect(result.ok).toBe(true);

      // After settle, task is still gone (success path, no rollback)
      const finalState = await readTaskLists(page, TASK_ID);
      expect(finalState.inTasks).toBe(false);
      expect(finalState.inArchivedTasks).toBe(false);
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Gap 2: Failure path rollback
// -----------------------------------------------------------------------
test.describe('deleteTask - failure path rollback', () => {
  test('IPC rejection restores task to its original swimlane and position', async () => {
    const { browser, page } = await launchWithActiveTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const todoLaneId = await resolveLaneId(page, 'To Do');

      const beforeState = await readTaskLists(page, TASK_ID);
      expect(beforeState.inTasks).toBe(true);
      expect(beforeState.taskSwimlaneId).toBe(todoLaneId);
      expect(beforeState.taskPosition).toBe(0);

      // Arm the error hook
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteThrow?: string }).__mockTaskDeleteThrow =
          'Worktree cleanup failed';
      });

      const result = await startDeleteTask(page, TASK_ID);

      // Optimistic deleteTask re-throws so callers can skip their success toasts.
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Worktree cleanup failed');

      // Card must reappear in its original slot
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inTasks && state.taskSwimlaneId === todoLaneId && state.taskPosition === 0;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      const afterState = await readTaskLists(page, TASK_ID);
      expect(afterState.inTasks).toBe(true);
      expect(afterState.inArchivedTasks).toBe(false);
      expect(afterState.taskSwimlaneId).toBe(todoLaneId);
      expect(afterState.taskPosition).toBe(0);

      // Error toast must surface with the thrown message
      await waitForToast(page, 'Failed to delete task:');
      await waitForToast(page, 'Worktree cleanup failed');
    } finally {
      await browser.close();
    }
  });

  test('subsequent successful delete works after a failed one', async () => {
    const { browser, page } = await launchWithActiveTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // First call fails
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteThrow?: string }).__mockTaskDeleteThrow = 'first failure';
      });
      const firstResult = await startDeleteTask(page, TASK_ID);
      expect(firstResult.ok).toBe(false);

      // Task reverts back into tasks[]
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      // Second call succeeds (hook cleared itself on first call)
      const secondResult = await startDeleteTask(page, TASK_ID);
      expect(secondResult.ok).toBe(true);

      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return !state.inTasks && !state.inArchivedTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Shared constants for new caller-layer tests
// -----------------------------------------------------------------------

const CALLER_TASK_ID = 'task-caller-delete';
const ARCHIVED_TASK_ID = 'task-archived-delete';

/**
 * Launch with an active task seeded in the To Do lane (same as
 * launchWithActiveTask but uses CALLER_TASK_ID so the caller-layer tests
 * can run in parallel with the store-layer tests without ID collisions).
 */
async function launchWithCallerTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: 'proj-caller-delete',
        name: 'Caller Delete Test',
        path: '/mock/caller-delete-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-cd-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // One active task in the To Do lane
      state.tasks.push({
        id: '${CALLER_TASK_ID}',
        title: 'Caller Delete Test Task',
        description: 'For caller-layer delete tests',
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

      return { currentProjectId: 'proj-caller-delete' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Launch with a task seeded directly in archivedTasks (not tasks[]).
 * Used to exercise the archivedTasks filter branch of deleteTask().
 */
async function launchWithArchivedTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: 'proj-archived-delete',
        name: 'Archived Delete Test',
        path: '/mock/archived-delete-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-ad-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // One unrelated active task so the board renders (avoids empty-board edge cases)
      state.tasks.push({
        id: 'task-ad-active-unrelated',
        title: 'Unrelated Active Task',
        description: '',
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

      // Primary test subject lives only in archivedTasks
      state.archivedTasks.push({
        id: '${ARCHIVED_TASK_ID}',
        title: 'Archived Task For Delete Test',
        description: 'Was previously in Done lane',
        swimlane_id: laneIds['Done'],
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
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: 'proj-archived-delete' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// -----------------------------------------------------------------------
// Gap 3: Rapid double-delete settles cleanly
// -----------------------------------------------------------------------
test.describe('deleteTask - rapid double delete', () => {
  test('two rapid deletes for the same task settle without ghosts or error toasts', async () => {
    const { browser, page } = await launchWithActiveTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Reset the per-id IPC call counter so this test owns its observations
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteCallCount?: Record<string, number> }).__mockTaskDeleteCallCount = {};
      });

      // Arm deferred so the first IPC hangs. The hook self-clears on entry,
      // so the second call's IPC proceeds immediately to the synchronous
      // filter and resolves while the first is still suspended.
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteDeferred?: boolean }).__mockTaskDeleteDeferred = true;
      });

      // First call: do not await, will hang on the deferred hook
      const firstPromise = startDeleteTask(page, TASK_ID);

      // Wait for the optimistic removal to land, then fire the second call
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return !state.inTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      const secondPromise = startDeleteTask(page, TASK_ID);

      // Release the first deferred IPC
      await page.evaluate(() => {
        const win = window as unknown as { __mockTaskDeleteResolve?: () => void };
        win.__mockTaskDeleteResolve?.();
      });

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);

      // Both calls fired their IPCs. No in-flight dedup at the store layer;
      // the second IPC is a backend no-op (would be serialized by withTaskLock
      // in production, returns immediately in the mock).
      const callCount = await page.evaluate((tid) => {
        const counts = (window as unknown as {
          __mockTaskDeleteCallCount?: Record<string, number>;
        }).__mockTaskDeleteCallCount;
        return counts?.[tid] ?? 0;
      }, TASK_ID);
      expect(callCount).toBe(2);

      // Final state: task gone from both arrays, no duplicate inserts
      const finalState = await readTaskLists(page, TASK_ID);
      expect(finalState.inTasks).toBe(false);
      expect(finalState.inArchivedTasks).toBe(false);

      // No error toast was raised
      const errorToastCount = await page
        .locator('[data-testid="toast"]')
        .filter({ hasText: 'Failed to delete task:' })
        .count();
      expect(errorToastCount).toBe(0);
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Gap 4: TaskCard.handleContextDelete survives re-throw (caller-layer)
// -----------------------------------------------------------------------
test.describe('deleteTask - TaskCard context menu caller survives re-throw', () => {
  test('error toast shown, card reappears, confirm dialog closed after context-menu delete failure', async () => {
    const { browser, page } = await launchWithCallerTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Locate the task card. The To Do swimlane renders it.
      const card = page.locator(`[data-task-id="${CALLER_TASK_ID}"]`).first();
      await card.waitFor({ state: 'visible', timeout: 5000 });

      // Arm the error hook BEFORE triggering the delete so the IPC throws.
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteThrow?: string }).__mockTaskDeleteThrow =
          'forced delete failure';
      });

      // Right-click the card to open the context menu.
      await card.click({ button: 'right' });
      const contextDeleteButton = page.locator('[data-testid="context-delete-task"]');
      await contextDeleteButton.waitFor({ state: 'visible', timeout: 3000 });
      await contextDeleteButton.click();

      // skipDeleteConfirm is false by default, so a ConfirmDialog appears.
      // The dialog title is "Delete task" and the confirm button is "Delete".
      // We cannot use .fixed.inset-0 (anti-pattern 8). Use the confirm button
      // text scoped inside a dialog that contains "This will permanently delete".
      const confirmButton = page.locator('button', { hasText: 'Delete' }).filter({
        // The danger variant button; scoped by being inside a dialog with the
        // "This action cannot be undone." warning text.
        has: page.locator(':scope'),
      }).last();
      // Wait for the ConfirmDialog footer confirm button to appear.
      // The confirm button appears in the BaseDialog footer.
      await expect(
        page.locator('button', { hasText: 'Delete' }).last(),
      ).toBeVisible({ timeout: 3000 });

      // Click the red "Delete" confirm button (last "Delete" button on screen).
      await page.locator('button', { hasText: 'Delete' }).last().click();

      // (a) Error toast must appear - the re-throw propagates through handleContextDelete
      // which is an async event handler. The toast is fired inside deleteTask's catch block.
      await waitForToast(page, 'Failed to delete task:');
      await waitForToast(page, 'forced delete failure');

      // (b) Card must reappear in its original slot (rollback restored previousTasks).
      await expect.poll(async () => {
        const state = await readTaskLists(page, CALLER_TASK_ID);
        return state.inTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      // (c) The ConfirmDialog must be gone. Since handleContextDelete calls
      // setConfirmDelete(false) after the awaited deleteTask() call, the dialog
      // is closed regardless of whether deleteTask threw. We rely on the toast
      // already being visible as a proxy that the async path completed; then we
      // assert the confirm button is no longer present.
      //
      // Note: we cannot use strict `.toBeHidden()` on a .fixed.inset-0 locator
      // (anti-pattern 8). Instead check that no element with the exact text
      // "This action cannot be undone." remains visible - that text is unique to
      // the delete ConfirmDialog.
      await expect(
        page.locator('text=This action cannot be undone.'),
      ).toBeHidden({ timeout: 3000 });
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Gap 5: useTaskActions.handleDelete skips success toast on failure
// -----------------------------------------------------------------------
test.describe('deleteTask - TaskDetailDialog handleDelete skips success toast on failure', () => {
  test('error toast appears but no Deleted task info toast when IPC rejects', async () => {
    const { browser, page } = await launchWithCallerTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Click the task card to open the TaskDetailDialog. To Do tasks with no
      // session open in edit mode (initialEdit=true), so the Delete button is
      // visible in the footer immediately.
      const card = page.locator(`[data-task-id="${CALLER_TASK_ID}"]`).first();
      await card.waitFor({ state: 'visible', timeout: 5000 });
      await card.click();

      // Wait for the dialog to mount. Use data-testid="task-detail-dialog"
      // (set via testId prop on BaseDialog).
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // The dialog opens in edit mode for a To Do task with no session.
      // The footer Delete button is only present in edit mode when isInTodo is true.
      const footerDeleteButton = dialog.locator('button', { hasText: 'Delete' }).first();
      await footerDeleteButton.waitFor({ state: 'visible', timeout: 3000 });

      // Arm the error hook.
      await page.evaluate(() => {
        (window as unknown as { __mockTaskDeleteThrow?: string }).__mockTaskDeleteThrow =
          'forced delete failure';
      });

      // Click Delete in the dialog footer. Because skipDeleteConfirm=false, a
      // ConfirmDialog replaces the task detail dialog. We then confirm.
      await footerDeleteButton.click();

      // ConfirmDialog is now rendered. Wait for the danger "Delete" confirm button.
      // The ConfirmDialog renders above the TaskDetailDialog (z-[60]). The confirm
      // button text matches "Delete" and is the last such button in the DOM when
      // both dialogs overlap during the transition.
      await expect(
        page.locator('text=This action cannot be undone.'),
      ).toBeVisible({ timeout: 3000 });
      // Click the confirm button inside the ConfirmDialog footer.
      await page.locator('button', { hasText: 'Delete' }).last().click();

      // (a) Error toast must appear.
      await waitForToast(page, 'Failed to delete task:');
      await waitForToast(page, 'forced delete failure');

      // (b) NO "Deleted task" info toast must appear. The line
      // `addToast({ message: 'Deleted task "..."', variant: 'info' })` in
      // handleDelete comes AFTER the awaited deleteTask() call. With re-throw,
      // that line is never reached. Give a fixed budget for any latent toast
      // to materialize before asserting absence.
      // (intentional fixed wait - cannot poll for non-occurrence)
      await page.waitForTimeout(1500);
      const successToastCount = await page
        .locator('[data-testid="toast"]')
        .filter({ hasText: /^Deleted task/ })
        .count();
      expect(successToastCount).toBe(0);
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Gap 6: deleteTask() hits archivedTasks as the primary filter target
// -----------------------------------------------------------------------
test.describe('deleteTask - archivedTasks primary hit', () => {
  test('task seeded in archivedTasks is removed; tasks[] is unaffected', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Verify initial state: archived task is in archivedTasks[], not tasks[].
      const initialState = await readTaskLists(page, ARCHIVED_TASK_ID);
      expect(initialState.inTasks).toBe(false);
      expect(initialState.inArchivedTasks).toBe(true);

      // Capture the active tasks snapshot before deletion so we can verify it
      // remains unchanged after the call.
      const initialTaskCount = await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { getState: () => { tasks: Array<{ id: string }> } };
          };
        }).__zustandStores;
        if (!stores?.board) throw new Error('board store not exposed');
        return stores.board.getState().tasks.length;
      });

      // Invoke deleteTask() directly on the store - same pattern as the
      // existing store-layer tests.
      const result = await startDeleteTask(page, ARCHIVED_TASK_ID);
      expect(result.ok).toBe(true);

      // Archived task must be gone from archivedTasks[].
      await expect.poll(async () => {
        const state = await readTaskLists(page, ARCHIVED_TASK_ID);
        return !state.inArchivedTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      // tasks[] must be unchanged (the unrelated active task must still be there).
      const finalTaskCount = await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { getState: () => { tasks: Array<{ id: string }> } };
          };
        }).__zustandStores;
        if (!stores?.board) throw new Error('board store not exposed');
        return stores.board.getState().tasks.length;
      });
      expect(finalTaskCount).toBe(initialTaskCount);

      // No error toast was raised.
      const errorToastCount = await page
        .locator('[data-testid="toast"]')
        .filter({ hasText: 'Failed to delete task:' })
        .count();
      expect(errorToastCount).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
