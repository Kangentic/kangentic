/**
 * UI tests asserting that moving a task to the To Do column immediately
 * clears `spawnProgress` and `pendingCommandLabel` from the session store.
 *
 * Bug guarded: dragging a task back to To Do while the session was still
 * "Initializing..." left a stale spawn-progress indicator on the card.
 * The fix in board-store/task-slice.ts L181-188 does an optimistic
 * setState that removes both keys before the IPC call completes.
 *
 * These tests are UI-tier (headless Chromium + mock API) because the
 * behavior is entirely in the renderer store -- no real PTY, IPC, or
 * Electron main process involvement.
 *
 * Pattern: call boardStore.moveTask() directly via __zustandStores (exposed
 * in DEV mode by App.tsx) rather than window.electronAPI.tasks.move(), which
 * bypasses the renderer store and would never exercise the clearance logic.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-spawn-progress-clear';
const TASK_ID = 'task-spawn-progress-clear';

/**
 * Launch a headless page with a project and task pre-seeded.
 * The task starts in the Planning column (auto_spawn=true) with no active
 * session -- matching the state just after a spawn was initiated but before
 * the session became visible (the "Initializing..." window).
 */
async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Spawn Progress Clear Test',
        path: '/mock/spawn-progress-clear-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Build swimlanes with stable IDs
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-spc-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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

      // Task in Planning with no active session -- simulates in-flight spawn
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Task In Spawn Window',
        description: 'Simulates a task whose session is still initializing',
        swimlane_id: laneIds['Planning'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
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

/**
 * Seed spawnProgress and pendingCommandLabel on the session store directly.
 * These entries are normally pushed by the main process via IPC; here we
 * set them directly to simulate the "Initializing..." state mid-spawn.
 */
async function seedSpawnProgress(page: Page, taskId: string): Promise<void> {
  await page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: {
          getState: () => {
            setSpawnProgress: (id: string, label: string | null) => void;
            setPendingCommandLabel: (id: string, label: string) => void;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setSpawnProgress(tid, 'Initializing...');
    stores.session.getState().setPendingCommandLabel(tid, '/my-auto-command');
  }, taskId);
}

/**
 * Read the current spawnProgress and pendingCommandLabel for a given task ID.
 */
async function readSpawnState(page: Page, taskId: string): Promise<{
  spawnProgress: string | null;
  pendingCommandLabel: string | null;
}> {
  return page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: {
          getState: () => {
            spawnProgress: Record<string, string>;
            pendingCommandLabel: Record<string, string>;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.session) return { spawnProgress: null, pendingCommandLabel: null };
    const state = stores.session.getState();
    return {
      spawnProgress: state.spawnProgress[tid] ?? null,
      pendingCommandLabel: state.pendingCommandLabel[tid] ?? null,
    };
  }, taskId);
}

/**
 * Invoke the board store's moveTask() directly.
 * This exercises the same code path as drag-and-drop (the store method
 * contains the clearance logic) without the fragility of mouse events.
 * skipConfirmation=true bypasses the pending-changes git check so no
 * extra async work is introduced.
 */
async function moveBoardTask(
  page: Page,
  taskId: string,
  targetSwimlaneId: string,
): Promise<void> {
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
        true, // skipConfirmation - no pending-changes check needed in this test
      );
    },
    { tid: taskId, targetId: targetSwimlaneId },
  );
}

test.describe('spawn-progress cleared on To Do move', () => {
  test('moving a task with spawnProgress to To Do clears spawnProgress and pendingCommandLabel', async () => {
    const { browser, page } = await launchWithState();

    try {
      // Wait for board to render
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });

      // Verify the task is visible in Planning
      const planningColumn = page.locator('[data-swimlane-name="Planning"]');
      await expect(planningColumn.locator('text=Task In Spawn Window')).toBeVisible({ timeout: 5000 });

      // Seed the "Initializing..." state that would have been set by an
      // in-flight spawn when the task was moved from To Do to Planning.
      await seedSpawnProgress(page, TASK_ID);

      // Confirm state was seeded correctly.
      const seededState = await readSpawnState(page, TASK_ID);
      expect(seededState.spawnProgress).toBe('Initializing...');
      expect(seededState.pendingCommandLabel).toBe('/my-auto-command');

      // Resolve the To Do swimlane ID
      const todoSwimlaneId: string = await page.evaluate(async () => {
        const lanes = await window.electronAPI.swimlanes.list();
        const lane = lanes.find((s: { role: string }) => s.role === 'todo');
        return lane?.id ?? '';
      });
      expect(todoSwimlaneId).toBeTruthy();

      // Move the task via the board store (exercises the clearance logic in
      // task-slice.ts - the same code path as drag-and-drop).
      await moveBoardTask(page, TASK_ID, todoSwimlaneId);

      // The optimistic setState in task-slice.ts fires synchronously during
      // moveTask(), before the IPC awaits. We use expect.poll to absorb any
      // microtask scheduling gap between the store setState and the next
      // page.evaluate read.
      await expect.poll(async () => {
        const state = await readSpawnState(page, TASK_ID);
        return state.spawnProgress === null && state.pendingCommandLabel === null;
      }, { timeout: 3000, intervals: [50, 100, 200, 300] }).toBe(true);

      // Final sanity check: both keys are absent from the store
      const finalState = await readSpawnState(page, TASK_ID);
      expect(finalState.spawnProgress).toBeNull();
      expect(finalState.pendingCommandLabel).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('task moved from Planning to To Do twice in sequence ends with no spawn indicators', async () => {
    const { browser, page } = await launchWithState();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Resolve lane IDs
      const laneIds: { todo: string; planning: string } = await page.evaluate(async () => {
        const lanes = await window.electronAPI.swimlanes.list();
        const todoLane = lanes.find((s: { role: string }) => s.role === 'todo');
        const planningLane = lanes.find((s: { name: string }) => s.name === 'Planning');
        return { todo: todoLane?.id ?? '', planning: planningLane?.id ?? '' };
      });
      expect(laneIds.todo).toBeTruthy();
      expect(laneIds.planning).toBeTruthy();

      // Seed spawn progress (simulates task being moved to Planning and
      // the "Initializing..." push arriving from the main process).
      await seedSpawnProgress(page, TASK_ID);

      // Round 1: Planning -> To Do while spawn is "Initializing..."
      await moveBoardTask(page, TASK_ID, laneIds.todo);

      await expect.poll(async () => {
        const state = await readSpawnState(page, TASK_ID);
        return state.spawnProgress === null && state.pendingCommandLabel === null;
      }, { timeout: 3000, intervals: [50, 100, 200, 300] }).toBe(true);

      // Move To Do -> Planning (a new spawn would start here in production)
      await moveBoardTask(page, TASK_ID, laneIds.planning);

      // Simulate a second "Initializing..." push arriving from the main process
      await seedSpawnProgress(page, TASK_ID);

      const midState = await readSpawnState(page, TASK_ID);
      expect(midState.spawnProgress).toBe('Initializing...');

      // Round 2: Planning -> To Do again
      await moveBoardTask(page, TASK_ID, laneIds.todo);

      // Indicators must be cleared on the second round as well
      await expect.poll(async () => {
        const state = await readSpawnState(page, TASK_ID);
        return state.spawnProgress === null && state.pendingCommandLabel === null;
      }, { timeout: 3000, intervals: [50, 100, 200, 300] }).toBe(true);

      const finalState = await readSpawnState(page, TASK_ID);
      expect(finalState.spawnProgress).toBeNull();
      expect(finalState.pendingCommandLabel).toBeNull();
    } finally {
      await browser.close();
    }
  });
});
