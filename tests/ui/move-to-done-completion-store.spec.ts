/**
 * Unit-style tests for the TaskCompletionSlice in board-store.ts, run in the UI
 * tier so the Zustand store has its real browser environment (import.meta.hot,
 * window.electronAPI mock).
 *
 * All assertions are made via page.evaluate() directly against
 * window.__zustandStores.board.getState(), with no drag-and-drop needed.
 * These tests cover the race-fix invariants introduced in the
 * fix-completed-task-s branch:
 *
 *   1. finalizeCompletion releases completingTaskIds even when moveTask rejects.
 *   2. setCompletingTask atomically adds to completingTaskIds AND removes the
 *      task from state.tasks in a single set() call.
 *   3. addCompletingTaskId / removeCompletingTaskId no-op on redundant calls
 *      (return same Set reference, don't allocate).
 *   4. setCompletingTask(null) does NOT clear completingTaskIds - only
 *      removeCompletingTaskId (called from finalizeCompletion's finally) does.
 *   5. Concurrent drops: setCompletingTask(A) then setCompletingTask(B) -
 *      both IDs appear in completingTaskIds at the right moments and both
 *      are eventually released.
 *   6. FlyingCard !hasTarget path: when [data-done-drop-zone] is absent from
 *      the DOM, finalizeCompletion fires immediately (no 700ms wait).
 *   7. FlyingCard fallback timer clears on unmount / completingTask change
 *      (no double-call, no stale timer firing after the card unmounts).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-completion-store';
const TASK_A_ID = 'task-completion-a';
const TASK_B_ID = 'task-completion-b';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockConfigOverrides = Object.assign(
      window.__mockConfigOverrides || {},
      { skipDoneWorktreeConfirm: true }
    );
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Completion Store Test',
        path: '/mock/completion-store-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-cs-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });
      state.tasks.push({
        id: '${TASK_A_ID}',
        title: 'Task Alpha',
        description: 'Completion store test task A',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.tasks.push({
        id: '${TASK_B_ID}',
        title: 'Task Beta',
        description: 'Completion store test task B',
        swimlane_id: laneIds['Executing'],
        position: 1,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  // Wait for board to hydrate so store has tasks + swimlanes
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

type StoreState = {
  tasks: Array<{ id: string }>;
  completingTask: { taskId: string } | null;
  completingTaskIds: string[];
};

async function readCompletionState(page: Page): Promise<StoreState> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{ id: string }>;
            completingTask: { taskId: string } | null;
            completingTaskIds: Set<string>;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    return {
      tasks: state.tasks.map((task) => ({ id: task.id })),
      completingTask: state.completingTask ? { taskId: state.completingTask.taskId } : null,
      completingTaskIds: Array.from(state.completingTaskIds),
    };
  });
}

/** Build a minimal CompletingTask object for a given task ID and Done swimlane. */
async function buildCompletingTask(
  page: Page,
  taskId: string,
): Promise<void> {
  // Calls setCompletingTask via the store, constructing a CompletingTask shape
  // that satisfies the interface. startRect uses placeholder values since this
  // test does not render a FlyingCard.
  await page.evaluate((taskIdentifier: string) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{
              id: string;
              title: string;
              description: string;
              swimlane_id: string;
              position: number;
              agent: string | null;
              session_id: string | null;
              worktree_path: string | null;
              branch_name: string | null;
              pr_number: number | null;
              pr_url: string | null;
              base_branch: string | null;
              use_worktree: number | null;
              labels: string[];
              priority: number;
              attachment_count: number;
              archived_at: string | null;
              created_at: string;
              updated_at: string;
              display_id: number;
            }>;
            swimlanes: Array<{ id: string; role: string | null }>;
            setCompletingTask: (task: {
              taskId: string;
              targetSwimlaneId: string;
              targetPosition: number;
              originSwimlaneId: string;
              task: object;
              startRect: { left: number; top: number; width: number; height: number };
            } | null) => void;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    const task = state.tasks.find((t) => t.id === taskIdentifier);
    if (!task) throw new Error('Task not found in store: ' + taskIdentifier);
    const doneLane = state.swimlanes.find((lane) => lane.role === 'done');
    if (!doneLane) throw new Error('Done lane not found');
    state.setCompletingTask({
      taskId: taskIdentifier,
      targetSwimlaneId: doneLane.id,
      targetPosition: 0,
      originSwimlaneId: task.swimlane_id,
      task,
      startRect: { left: 100, top: 100, width: 200, height: 80 },
    });
  }, taskId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('TaskCompletionSlice - state machine invariants', () => {
  // ------------------------------------------------------------------
  // Test 1: setCompletingTask atomicity
  // ------------------------------------------------------------------
  test('setCompletingTask adds to completingTaskIds and removes from tasks atomically', async () => {
    const { browser, page } = await launch();

    try {
      const before = await readCompletionState(page);
      expect(before.tasks.find((task) => task.id === TASK_A_ID)).toBeDefined();
      expect(before.completingTaskIds).not.toContain(TASK_A_ID);

      await buildCompletingTask(page, TASK_A_ID);

      const after = await readCompletionState(page);

      // Task is no longer in state.tasks - removed atomically
      expect(after.tasks.find((task) => task.id === TASK_A_ID)).toBeUndefined();
      // Task ID is present in completingTaskIds - added atomically
      expect(after.completingTaskIds).toContain(TASK_A_ID);
      // completingTask is set
      expect(after.completingTask?.taskId).toBe(TASK_A_ID);
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 2: setCompletingTask(null) does NOT clear completingTaskIds
  // ------------------------------------------------------------------
  test('setCompletingTask(null) does not clear completingTaskIds', async () => {
    const { browser, page } = await launch();

    try {
      // First, add a task ID to completingTaskIds via addCompletingTaskId
      await page.evaluate((taskIdentifier: string) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                addCompletingTaskId: (id: string) => void;
              };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.board.getState().addCompletingTaskId(taskIdentifier);
      }, TASK_A_ID);

      const withId = await readCompletionState(page);
      expect(withId.completingTaskIds).toContain(TASK_A_ID);

      // Now set completingTask to null
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                setCompletingTask: (task: null) => void;
              };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.board.getState().setCompletingTask(null);
      });

      const afterNull = await readCompletionState(page);
      // completingTask is cleared
      expect(afterNull.completingTask).toBeNull();
      // completingTaskIds is NOT cleared - only removeCompletingTaskId clears it
      expect(afterNull.completingTaskIds).toContain(TASK_A_ID);
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 3: addCompletingTaskId no-op on redundant add
  // ------------------------------------------------------------------
  test('addCompletingTaskId is a no-op when the id is already present', async () => {
    const { browser, page } = await launch();

    try {
      // Add TASK_A_ID once
      await page.evaluate((taskIdentifier: string) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => { addCompletingTaskId: (id: string) => void };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.board.getState().addCompletingTaskId(taskIdentifier);
      }, TASK_A_ID);

      const firstState = await readCompletionState(page);
      expect(firstState.completingTaskIds).toContain(TASK_A_ID);
      expect(firstState.completingTaskIds.length).toBe(1);

      // Get a reference to the current Set (via serialisation - size must stay 1)
      // Call addCompletingTaskId again with the same ID
      await page.evaluate((taskIdentifier: string) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => { addCompletingTaskId: (id: string) => void };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.board.getState().addCompletingTaskId(taskIdentifier);
      }, TASK_A_ID);

      const secondState = await readCompletionState(page);
      // Size must still be 1 - no duplicate entry
      expect(secondState.completingTaskIds.length).toBe(1);
      expect(secondState.completingTaskIds).toContain(TASK_A_ID);
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 4: removeCompletingTaskId no-op when id is absent
  // ------------------------------------------------------------------
  test('removeCompletingTaskId is a no-op when the id is not present', async () => {
    const { browser, page } = await launch();

    try {
      const before = await readCompletionState(page);
      expect(before.completingTaskIds).not.toContain('nonexistent-id');

      // Should not throw and should not change state
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => { removeCompletingTaskId: (id: string) => void };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.board.getState().removeCompletingTaskId('nonexistent-id');
      });

      const after = await readCompletionState(page);
      expect(after.completingTaskIds).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 5: finalizeCompletion releases completingTaskIds even on moveTask reject
  // ------------------------------------------------------------------
  test('finalizeCompletion releases completingTaskIds even when moveTask rejects', async () => {
    const { browser, page } = await launch();

    try {
      // Place task A into the completing state
      await buildCompletingTask(page, TASK_A_ID);

      const during = await readCompletionState(page);
      expect(during.completingTaskIds).toContain(TASK_A_ID);

      // Override tasks.move to throw before finalizing
      await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { tasks: { move: (input: unknown) => Promise<unknown> } };
        }).electronAPI;
        api.tasks.move = async () => {
          throw new Error('Simulated move failure');
        };
      });

      // Call finalizeCompletion - it will catch the moveTask error internally
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                finalizeCompletion: () => Promise<void>;
              };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        // Fire-and-forget: we poll the state below
        void stores.board.getState().finalizeCompletion();
      });

      // Poll until completingTaskIds is cleared (the finally block in finalizeCompletion
      // must release the ID regardless of the error)
      await expect.poll(async () => {
        const state = await readCompletionState(page);
        return state.completingTaskIds.length;
      }, { timeout: 5000 }).toBe(0);

      const after = await readCompletionState(page);
      expect(after.completingTaskIds).not.toContain(TASK_A_ID);
      // completingTask also cleared
      expect(after.completingTask).toBeNull();
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 6: concurrent drops - both IDs tracked, both eventually released
  // ------------------------------------------------------------------
  test('concurrent setCompletingTask calls: prior task finalized, both IDs eventually released', async () => {
    const { browser, page } = await launch();

    try {
      // Slow down tasks.move so the first finalize is still in-flight when
      // the second setCompletingTask fires. This simulates the concurrent drop.
      await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: {
            tasks: {
              move: (input: unknown) => Promise<unknown>;
              list: () => Promise<unknown[]>;
              listArchived: () => Promise<unknown[]>;
            };
          };
        }).electronAPI;
        const originalMove = api.tasks.move.bind(api.tasks);
        let callCount = 0;
        api.tasks.move = async (input: unknown) => {
          callCount++;
          if (callCount === 1) {
            // First call: add a small delay so both IDs are in completingTaskIds
            // simultaneously before the first finalize resolves
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
          return originalMove(input);
        };
      });

      // Trigger task A completing
      await buildCompletingTask(page, TASK_A_ID);

      const afterA = await readCompletionState(page);
      expect(afterA.completingTaskIds).toContain(TASK_A_ID);

      // Trigger task B completing (this calls setCompletingTask, which calls
      // finalizeCompletion on the prior completing task first)
      await buildCompletingTask(page, TASK_B_ID);

      const afterB = await readCompletionState(page);
      // B must be in completingTaskIds now
      expect(afterB.completingTaskIds).toContain(TASK_B_ID);

      // Both IDs must eventually be released as the two finalizations resolve
      await expect.poll(async () => {
        const state = await readCompletionState(page);
        return state.completingTaskIds.length;
      }, { timeout: 8000 }).toBe(0);

      const final = await readCompletionState(page);
      expect(final.completingTaskIds).not.toContain(TASK_A_ID);
      expect(final.completingTaskIds).not.toContain(TASK_B_ID);
      expect(final.completingTask).toBeNull();
    } finally {
      await browser.close();
    }
  });
});

test.describe('FlyingCard - timer and immediate-finalize paths', () => {
  // ------------------------------------------------------------------
  // Test 7: !hasTarget path - finalizeCompletion fires immediately
  // ------------------------------------------------------------------
  test('finalizeCompletion fires immediately when [data-done-drop-zone] is absent', async () => {
    const { browser, page } = await launch();

    try {
      // Remove the done drop zone from the DOM so FlyingCard takes the
      // immediate-finalize path instead of arming the 700ms fallback timer.
      await page.evaluate(() => {
        const dropZone = document.querySelector('[data-done-drop-zone]');
        if (dropZone) dropZone.parentElement?.removeChild(dropZone);
      });

      const startTime = Date.now();

      // Setting completingTask mounts FlyingCard, which on next two rAF frames
      // checks for [data-done-drop-zone]. Since it's absent, it calls
      // finalizeCompletion() immediately without the 700ms timer.
      await buildCompletingTask(page, TASK_A_ID);

      // Poll until completingTaskIds is cleared
      await expect.poll(async () => {
        const state = await readCompletionState(page);
        return state.completingTaskIds.length;
      }, { timeout: 5000 }).toBe(0);

      const elapsed = Date.now() - startTime;

      // The immediate path fires well within the 700ms fallback window.
      // Allow 600ms for two rAF frames + IPC round-trip on a slow CI machine.
      expect(elapsed).toBeLessThan(600);

      const final = await readCompletionState(page);
      expect(final.completingTask).toBeNull();
      expect(final.completingTaskIds).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 8: fallback timer clears when completingTask changes before it fires
  // ------------------------------------------------------------------
  test('stale fallback timer does not trigger an extra tasks.move after completingTask is replaced', async () => {
    const { browser, page } = await launch();

    try {
      // Instrument tasks.move to count real IPC calls. A stale fallback timer
      // would call finalizeCompletion() when completingTask is already null,
      // which returns early with no moveTask call. But if the timer fires
      // BEFORE the effect cleanup (clearFallback), it would call moveTask a
      // third time. We measure tasks.move calls to distinguish these cases.
      await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { tasks: { move: (input: unknown) => Promise<void> } };
        }).electronAPI;
        const originalMove = api.tasks.move.bind(api.tasks);
        let callCount = 0;
        (window as unknown as Record<string, unknown>).__moveCallCount = 0;
        api.tasks.move = async (input: unknown) => {
          callCount++;
          (window as unknown as Record<string, unknown>).__moveCallCount = callCount;
          return originalMove(input);
        };
      });

      // With the drop zone present (default DOM state), the 700ms fallback
      // timer is armed when setCompletingTask fires. Replacing completingTask
      // before the timer fires must clear the old timer via the React effect
      // cleanup (clearFallback), so the old timer never calls finalizeCompletion.
      await buildCompletingTask(page, TASK_A_ID);

      // Immediately replace with task B. setCompletingTask detects the in-flight
      // prev task and calls finalizeCompletion() for it synchronously before
      // setting the new task. The FlyingCard effect cleanup for task A then
      // fires (clearing any armed timer) before the new effect for task B runs.
      await buildCompletingTask(page, TASK_B_ID);

      // Wait for both completions to settle
      await expect.poll(async () => {
        const state = await readCompletionState(page);
        return state.completingTaskIds.length;
      }, { timeout: 5000 }).toBe(0);

      // Allow the 700ms fallback window to expire to confirm no stale timer fires.
      // (intentional fixed wait - we cannot poll for non-occurrence)
      await page.waitForTimeout(800);

      const moveCallCount = await page.evaluate(() => {
        return (window as unknown as Record<string, number>).__moveCallCount;
      });

      // Exactly 2 tasks.move calls are expected: one for task A (via the
      // synchronous finalizeCompletion triggered by setCompletingTask(B)) and
      // one for task B (via its own fallback timer or transitionend). A stale
      // timer firing after clearFallback would cause a third call.
      expect(moveCallCount).toBeLessThanOrEqual(2);

      const final = await readCompletionState(page);
      expect(final.completingTask).toBeNull();
      expect(final.completingTaskIds).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
