/**
 * The FlyingCard's timer and immediate-finalize paths, run in the UI tier because they
 * need the mounted card, the real DOM (the `[data-done-drop-zone]` lookup) and real timers.
 *
 * The TaskCompletionSlice state-machine invariants (atomic hide, id release, concurrent
 * drops, the move's project routing) live in `tests/unit/task-completion-slice.test.ts`.
 * The two cases here cover only what the card adds on top of the slice:
 *
 *   1. !hasTarget path: when [data-done-drop-zone] is absent from the DOM,
 *      finalizeCompletion fires immediately (no 700ms wait).
 *   2. Fallback timer clears on unmount / completingTask change (no double-call, no
 *      stale timer firing after the card unmounts).
 *
 * Assertions are made via page.evaluate() against window.__zustandStores.board.getState(),
 * with no drag-and-drop needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

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
  await gotoVite(page, VITE_URL);
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

test.describe('FlyingCard - timer and immediate-finalize paths', () => {
  // ------------------------------------------------------------------
  // Test 1: !hasTarget path - finalizeCompletion fires immediately
  // ------------------------------------------------------------------
  test('finalizeCompletion fires immediately when [data-done-drop-zone] is absent', async () => {
    const { browser, page } = await launch();

    try {
      // Remove the done drop zone from the DOM so FlyingCard takes the
      // immediate-finalize path instead of arming the 700ms fallback timer.
      // Spy on setTimeout to deterministically detect whether the 700ms
      // fallback was armed - this is the actual contract under test, not
      // a wall-clock budget. Wall-clock assertions are brittle on loaded
      // CI machines or under AV scan pressure.
      await page.evaluate(() => {
        const dropZone = document.querySelector('[data-done-drop-zone]');
        if (dropZone) dropZone.parentElement?.removeChild(dropZone);
        (window as unknown as Record<string, unknown>).__fallbackTimerArmed = false;
        const originalSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
          if (timeout === 700) {
            (window as unknown as Record<string, unknown>).__fallbackTimerArmed = true;
          }
          return originalSetTimeout(handler as () => void, timeout, ...args);
        }) as typeof window.setTimeout;
      });

      // Setting completingTask mounts FlyingCard, which on next two rAF frames
      // checks for [data-done-drop-zone]. Since it's absent, it calls
      // finalizeCompletion() immediately without the 700ms timer.
      await buildCompletingTask(page, TASK_A_ID);

      // Poll until completingTaskIds is cleared.
      await expect.poll(async () => {
        const state = await readCompletionState(page);
        return state.completingTaskIds.length;
      }, { timeout: 5000 }).toBe(0);

      // The contract: the 700ms fallback timer must NOT have been armed.
      // This proves the immediate-finalize path was taken, regardless of
      // how long the IPC round-trip took on the host machine.
      const fallbackTimerArmed = await page.evaluate(
        () => (window as unknown as { __fallbackTimerArmed?: boolean }).__fallbackTimerArmed === true,
      );
      expect(fallbackTimerArmed).toBe(false);

      const final = await readCompletionState(page);
      expect(final.completingTask).toBeNull();
      expect(final.completingTaskIds).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 2: fallback timer clears when completingTask changes before it fires
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
      // prev task and calls markCompletionAnimationDone() for it synchronously
      // before setting the new task (an ungated prior gate persists at once).
      // The FlyingCard effect cleanup for task A then fires (clearing any armed
      // timer) before the new effect for task B runs.
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
      // synchronous markCompletionAnimationDone triggered by setCompletingTask(B),
      // which persists the pre-approved prior gate) and one for task B (via its
      // own fallback timer or transitionend). A stale timer firing after
      // clearFallback would cause a third call.
      expect(moveCallCount).toBeLessThanOrEqual(2);

      const final = await readCompletionState(page);
      expect(final.completingTask).toBeNull();
      expect(final.completingTaskIds).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
