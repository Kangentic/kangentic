/**
 * UI tests for the optimistic unarchiveTask() rewrite in
 * src/renderer/stores/board-store/archived-tasks-slice.ts.
 *
 * Three scenarios tested (all UI-tier - no real PTY, no real Electron):
 *
 * Gap 1 - Optimistic card presence during IPC window
 *   Immediately after calling unarchiveTask() but before the IPC resolves,
 *   the task must be in state.tasks (with archived_at: null and the target
 *   swimlane_id) and absent from state.archivedTasks.
 *
 * Gap 2 - Failure path rollback
 *   When tasks.unarchive rejects, state.tasks and state.archivedTasks revert
 *   to their pre-call snapshots, loadBoard() fires (observable via the error
 *   toast being added), and an error toast starting "Failed to restore task:"
 *   is shown.
 *
 * Gap 3 - spawnProgress lifecycle
 *   When the target lane has auto_spawn=true, sessionStore.spawnProgress[taskId]
 *   equals 'Resuming agent...' during the deferred IPC window. After the IPC
 *   resolves (success or failure), the finally block clears it to null.
 *
 * Mock hooks added to mock-electron-api.js:
 *   window.__mockTaskUnarchiveDeferred = true  -> next unarchive() hangs until
 *     window.__mockTaskUnarchiveResolve() is called.
 *   window.__mockTaskUnarchiveThrow = 'msg'    -> next unarchive() rejects.
 *
 * Pattern: call boardStore.unarchiveTask() directly via __zustandStores,
 * matching task-move-revert-on-spawn-failure.spec.ts and
 * spawn-progress-clear-on-todo-move.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-unarchive-optimistic';
const TASK_ID = 'task-unarchive-optimistic';

// -----------------------------------------------------------------------
// Shared launch helper
// Starts the page with a project that has all default swimlanes plus one
// archived task. The "Planning" lane has auto_spawn=true (default).
// -----------------------------------------------------------------------
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
        id: '${PROJECT_ID}',
        name: 'Unarchive Optimistic Test',
        path: '/mock/unarchive-optimistic-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Build swimlanes with stable IDs
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-uo-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      // Resolve plan_exit_target_id: Planning -> Executing
      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // One archived task (lives in Done / archivedTasks)
      state.archivedTasks.push({
        id: '${TASK_ID}',
        title: 'Archived Task For Optimistic Test',
        description: 'Was in Done, now being restored',
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

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// -----------------------------------------------------------------------
// Store probe helpers
// -----------------------------------------------------------------------

/** Read the task's presence in tasks[] and archivedTasks[] from the board store. */
async function readTaskLists(page: Page, taskId: string): Promise<{
  inTasks: boolean;
  inArchivedTasks: boolean;
  taskSwimlaneId: string | null;
  taskArchivedAt: string | null;
}> {
  return page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{ id: string; swimlane_id: string; archived_at: string | null }>;
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
      taskArchivedAt: activeTask?.archived_at ?? null,
    };
  }, taskId);
}

/** Read spawnProgress for a given task from the session store. */
async function readSpawnProgress(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: {
          getState: () => {
            spawnProgress: Record<string, string | null>;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.session) return null;
    return stores.session.getState().spawnProgress[tid] ?? null;
  }, taskId);
}

/**
 * Wait for and return a toast element matching a text pattern.
 * Toasts are rendered with data-testid="toast" by the ToastContainer.
 * Uses DOM polling rather than the toast store (which is not exposed on
 * __zustandStores - only board/backlog/config/project/session are).
 */
async function waitForToast(
  page: Page,
  textPattern: RegExp | string,
  timeoutMs = 5000,
): Promise<void> {
  await expect(
    page.locator('[data-testid="toast"]').filter({ hasText: textPattern }),
  ).toBeVisible({ timeout: timeoutMs });
}

/** Resolve the ID of a named swimlane from the mock. */
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
 * Invoke unarchiveTask() on the board store directly.
 * Does NOT await the settled result intentionally - the caller controls
 * timing by manipulating __mockTaskUnarchiveDeferred / __mockTaskUnarchiveResolve.
 * For the success path, await the returned promise after releasing the deferred.
 */
function startUnarchiveTask(
  page: Page,
  taskId: string,
  targetSwimlaneId: string,
): Promise<void> {
  return page.evaluate(
    async ({ tid, targetId }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          board: {
            getState: () => {
              unarchiveTask: (input: { id: string; targetSwimlaneId: string }) => Promise<void>;
            };
          };
        };
      }).__zustandStores;
      if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
      await stores.board.getState().unarchiveTask({ id: tid, targetSwimlaneId: targetId });
    },
    { tid: taskId, targetId: targetSwimlaneId },
  );
}

// -----------------------------------------------------------------------
// Gap 1: Optimistic card presence during IPC window
// -----------------------------------------------------------------------
test.describe('unarchiveTask - optimistic card presence', () => {
  test('task appears in tasks[] with archived_at:null before IPC resolves', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const planningLaneId = await resolveLaneId(page, 'Planning');

      // Verify starting state: task is archived, not in active tasks
      const initialState = await readTaskLists(page, TASK_ID);
      expect(initialState.inArchivedTasks).toBe(true);
      expect(initialState.inTasks).toBe(false);

      // Arm the deferred hook so tasks.unarchive() hangs
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUnarchiveDeferred?: boolean }).__mockTaskUnarchiveDeferred = true;
      });

      // Start the unarchive -- do NOT await it; we need to probe intermediate state
      const unarchivePromise = startUnarchiveTask(page, TASK_ID, planningLaneId);

      // Poll until the optimistic update has landed in the store.
      // The set() in unarchiveTask fires synchronously before the await, so
      // it should appear within the first few polls (microtask scheduling gap).
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      // Assert the full optimistic state before IPC resolves
      const optimisticState = await readTaskLists(page, TASK_ID);
      expect(optimisticState.inTasks).toBe(true);
      expect(optimisticState.inArchivedTasks).toBe(false);
      expect(optimisticState.taskArchivedAt).toBeNull();
      expect(optimisticState.taskSwimlaneId).toBe(planningLaneId);

      // Release the deferred IPC call to let the async work complete
      await page.evaluate(() => {
        const win = window as unknown as { __mockTaskUnarchiveResolve?: () => void };
        win.__mockTaskUnarchiveResolve?.();
      });

      await unarchivePromise;

      // After IPC settles, task should still be in tasks[] (success path)
      const finalState = await readTaskLists(page, TASK_ID);
      expect(finalState.inTasks).toBe(true);
      expect(finalState.inArchivedTasks).toBe(false);
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Gap 2: Failure path rollback
// -----------------------------------------------------------------------
test.describe('unarchiveTask - failure path rollback', () => {
  test('IPC rejection reverts tasks and archivedTasks, shows error toast', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const planningLaneId = await resolveLaneId(page, 'Planning');

      // Capture pre-call snapshots for verification
      const beforeState = await readTaskLists(page, TASK_ID);
      expect(beforeState.inArchivedTasks).toBe(true);
      expect(beforeState.inTasks).toBe(false);

      // Arm the error hook
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUnarchiveThrow?: string }).__mockTaskUnarchiveThrow =
          'Worktree locked by another process';
      });

      // Run the operation and allow it to settle (the catch block runs synchronously
      // relative to the IPC rejection)
      await startUnarchiveTask(page, TASK_ID, planningLaneId);

      // After rejection: task should revert to archivedTasks, not in active tasks
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inArchivedTasks && !state.inTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      const afterState = await readTaskLists(page, TASK_ID);
      expect(afterState.inTasks).toBe(false);
      expect(afterState.inArchivedTasks).toBe(true);

      // Error toast must be visible (the catch block calls addToast).
      // loadBoard() fires in the catch block before addToast, so the toast
      // being visible implies loadBoard() also completed.
      await waitForToast(page, 'Failed to restore task:');
      await waitForToast(page, 'Worktree locked by another process');

      // spawnProgress must be cleared (finally block)
      const spawnProgress = await readSpawnProgress(page, TASK_ID);
      expect(spawnProgress).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('subsequent successful unarchive works after a failed one', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const todoLaneId = await resolveLaneId(page, 'To Do');

      // First call fails
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUnarchiveThrow?: string }).__mockTaskUnarchiveThrow = 'first failure';
      });
      await startUnarchiveTask(page, TASK_ID, todoLaneId);

      // Task reverts back to archived
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inArchivedTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      // Second call succeeds (hook cleared itself on first call)
      await startUnarchiveTask(page, TASK_ID, todoLaneId);

      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inTasks && !state.inArchivedTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      const finalState = await readTaskLists(page, TASK_ID);
      expect(finalState.inTasks).toBe(true);
      expect(finalState.inArchivedTasks).toBe(false);
      expect(finalState.taskSwimlaneId).toBe(todoLaneId);
    } finally {
      await browser.close();
    }
  });
});

// -----------------------------------------------------------------------
// Gap 3: spawnProgress lifecycle
// -----------------------------------------------------------------------
test.describe('unarchiveTask - spawnProgress lifecycle', () => {
  test('spawnProgress is set to "Resuming agent..." during IPC window for auto_spawn lane', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Planning lane has auto_spawn=true in DEFAULT_SWIMLANES
      const planningLaneId = await resolveLaneId(page, 'Planning');

      // Confirm no spawn progress yet
      const initialProgress = await readSpawnProgress(page, TASK_ID);
      expect(initialProgress).toBeNull();

      // Arm the deferred hook
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUnarchiveDeferred?: boolean }).__mockTaskUnarchiveDeferred = true;
      });

      const unarchivePromise = startUnarchiveTask(page, TASK_ID, planningLaneId);

      // Poll until spawnProgress appears (set synchronously before the await in unarchiveTask)
      await expect.poll(async () => {
        return readSpawnProgress(page, TASK_ID);
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe('Resuming agent...');

      // Verify the optimistic state simultaneously: task in tasks[], not in archived
      const midState = await readTaskLists(page, TASK_ID);
      expect(midState.inTasks).toBe(true);
      expect(midState.inArchivedTasks).toBe(false);

      // Release the IPC and let the success path complete
      await page.evaluate(() => {
        const win = window as unknown as { __mockTaskUnarchiveResolve?: () => void };
        win.__mockTaskUnarchiveResolve?.();
      });
      await unarchivePromise;

      // finally block must clear spawnProgress
      await expect.poll(async () => {
        return readSpawnProgress(page, TASK_ID);
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBeNull();

      const clearedProgress = await readSpawnProgress(page, TASK_ID);
      expect(clearedProgress).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('spawnProgress is NOT set when target lane has auto_spawn=false', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // To Do lane has auto_spawn=false in DEFAULT_SWIMLANES
      const todoLaneId = await resolveLaneId(page, 'To Do');

      // Arm the deferred hook
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUnarchiveDeferred?: boolean }).__mockTaskUnarchiveDeferred = true;
      });

      const unarchivePromise = startUnarchiveTask(page, TASK_ID, todoLaneId);

      // Wait for optimistic state (task moves to tasks[])
      await expect.poll(async () => {
        const state = await readTaskLists(page, TASK_ID);
        return state.inTasks;
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBe(true);

      // Intentional fixed wait: we cannot poll for non-occurrence of spawnProgress.
      // Give any latent setSpawnProgress() a 400ms budget - this is the negative
      // assertion budget for a synchronous store set that would fire immediately.
      await page.waitForTimeout(400);

      const progressDuringIpc = await readSpawnProgress(page, TASK_ID);
      expect(progressDuringIpc).toBeNull();

      // Release
      await page.evaluate(() => {
        const win = window as unknown as { __mockTaskUnarchiveResolve?: () => void };
        win.__mockTaskUnarchiveResolve?.();
      });
      await unarchivePromise;

      const finalProgress = await readSpawnProgress(page, TASK_ID);
      expect(finalProgress).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('spawnProgress is cleared after failure path (finally block covers rejection)', async () => {
    const { browser, page } = await launchWithArchivedTask();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const planningLaneId = await resolveLaneId(page, 'Planning');

      // Arm both: deferred first so we can observe "Resuming agent..." during the IPC window,
      // then throw so the finally block is exercised on the failure path.
      // We use __mockTaskUnarchiveThrow directly (no deferred) since we only need to
      // confirm the finally block clears progress after a rejection - the deferred test
      // above already confirmed "Resuming agent..." appears before IPC.
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUnarchiveThrow?: string }).__mockTaskUnarchiveThrow =
          'Spawn rejected for test';
      });

      await startUnarchiveTask(page, TASK_ID, planningLaneId);

      // After rejection, finally block must clear spawnProgress
      await expect.poll(async () => {
        return readSpawnProgress(page, TASK_ID);
      }, { timeout: 5000, intervals: [50, 100, 200, 300] }).toBeNull();

      const finalProgress = await readSpawnProgress(page, TASK_ID);
      expect(finalProgress).toBeNull();
    } finally {
      await browser.close();
    }
  });
});
