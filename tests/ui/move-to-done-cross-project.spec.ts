/**
 * Cross-project Done-drop race regression tests, run in the UI tier so the
 * Zustand stores have their real browser environment (import.meta.hot,
 * window.electronAPI mock).
 *
 * Covers the three composing defects fixed for the cross-project Done-drop race
 * (see .claude/rules/project-scoped-ipc.md):
 *
 *   A. The projectId captured on drop (CompletingTask.projectId) is the one the
 *      move IPC routes to, even if the user switches projects before the gated
 *      persist runs. Proves the fix for the ambient-projectId root cause.
 *   B. A failed move surfaces failure and does NOT fire the false
 *      "completed and archived" success (recentlyArchivedId stays null).
 *   C. A move that succeeds while the user has switched away does NOT set the
 *      board-global recentlyArchivedId (which would mis-highlight a foreign
 *      board), but still routes to the correct source project.
 *   D. Same-project happy path still sets recentlyArchivedId (no regression).
 *
 * All assertions are made via page.evaluate against the exposed Zustand stores;
 * the gated completion is driven through the store (setCompletingTask gated +
 * finalizeCompletion) so the move fires deterministically after the simulated
 * project switch, with no real drag needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'proj-cross-a';
const PROJECT_B_ID = 'proj-cross-b';
const TASK_ID = 'task-cross-a';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Cross Project A',
        path: '/mock/cross-a',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Cross Project B',
        path: '/mock/cross-b',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-cross-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Cross Alpha',
        description: 'Cross-project race test task',
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
      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/**
 * Mount a GATED completion for the task, stamping `projectId` on the
 * CompletingTask exactly as the drop handler does. Gated so persistence waits
 * for finalizeCompletion (fired after the simulated project switch).
 */
async function startGatedCompletion(page: Page, projectId: string): Promise<void> {
  await page.evaluate(({ taskIdentifier, stampedProjectId }) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{ id: string; swimlane_id: string }>;
            swimlanes: Array<{ id: string; role: string | null }>;
            setCompletingTask: (
              task: {
                taskId: string;
                targetSwimlaneId: string;
                targetPosition: number;
                originSwimlaneId: string;
                task: object;
                startRect: { left: number; top: number; width: number; height: number };
                projectId: string | null;
              },
              opts?: { gated?: boolean },
            ) => void;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    const task = state.tasks.find((candidate) => candidate.id === taskIdentifier);
    if (!task) throw new Error('Task not found in store: ' + taskIdentifier);
    const doneLane = state.swimlanes.find((lane) => lane.role === 'done');
    if (!doneLane) throw new Error('Done lane not found');
    state.setCompletingTask(
      {
        taskId: taskIdentifier,
        targetSwimlaneId: doneLane.id,
        targetPosition: 0,
        originSwimlaneId: task.swimlane_id,
        task,
        startRect: { left: 100, top: 100, width: 200, height: 80 },
        projectId: stampedProjectId,
      },
      { gated: true },
    );
  }, { taskIdentifier: TASK_ID, stampedProjectId: projectId });
}

/** Simulate switching the active project by setting the project store directly. */
async function switchToProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate((targetId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        project: {
          getState: () => {
            projects: Array<{ id: string }>;
            setState?: unknown;
          };
          setState: (partial: object) => void;
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const target = stores.project.getState().projects.find((p) => p.id === targetId);
    if (!target) throw new Error('Project not found in store: ' + targetId);
    stores.project.setState({ currentProject: target });
  }, projectId);
}

/** Force the gated completion to persist now (joins animationDone + approved). */
async function finalizeCompletion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: { getState: () => { finalizeCompletion: () => Promise<void> } };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    void stores.board.getState().finalizeCompletion();
  });
}

async function readBoard(page: Page): Promise<{ completingTaskIds: string[]; recentlyArchivedId: string | null }> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            completingTaskIds: Set<string>;
            recentlyArchivedId: string | null;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    return {
      completingTaskIds: Array.from(state.completingTaskIds),
      recentlyArchivedId: state.recentlyArchivedId,
    };
  });
}

async function waitForCompletionSettled(page: Page): Promise<void> {
  await expect.poll(async () => (await readBoard(page)).completingTaskIds.length, { timeout: 8000 }).toBe(0);
}

test.describe('cross-project Done-drop race', () => {
  // A. The drop-time projectId wins over the (switched) current project.
  test('the move routes to the projectId captured on drop, not the current project', async () => {
    const { browser, page } = await launch();
    try {
      await startGatedCompletion(page, PROJECT_A_ID);
      // User clicks over to another project while the card is "in flight".
      await switchToProject(page, PROJECT_B_ID);
      // Now persist. The gate stashed projectId = A; the move must use A.
      await finalizeCompletion(page);
      await waitForCompletionSettled(page);

      const lastMoveProjectId = await page.evaluate(
        () => (window as unknown as { __mockLastMoveProjectId?: string | null }).__mockLastMoveProjectId,
      );
      expect(lastMoveProjectId).toBe(PROJECT_A_ID);
    } finally {
      await browser.close();
    }
  });

  // B. A failed move must not report success.
  test('a failed move fires no false "completed and archived" success', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate(() => {
        (window as unknown as { __mockTaskMoveThrow?: string }).__mockTaskMoveThrow = 'simulated move failure';
      });
      await startGatedCompletion(page, PROJECT_A_ID);
      await finalizeCompletion(page);
      await waitForCompletionSettled(page);

      const board = await readBoard(page);
      // The original bug set recentlyArchivedId AND fired the success toast even
      // though the move threw. recentlyArchivedId must stay null on failure.
      expect(board.recentlyArchivedId).toBeNull();
      // The error must surface and the success toast must never appear.
      await expect(page.getByText(/Failed to move task/)).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/completed and archived/)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // C. Success while switched away must not set the board-global recentlyArchivedId.
  test('a success while switched away does not flag recentlyArchivedId on the foreign board', async () => {
    const { browser, page } = await launch();
    try {
      await startGatedCompletion(page, PROJECT_A_ID);
      await switchToProject(page, PROJECT_B_ID);
      await finalizeCompletion(page);
      await waitForCompletionSettled(page);

      const board = await readBoard(page);
      // Move targeted A (correct), but the user is now viewing B, so the global
      // recentlyArchivedId must not be set for A's task.
      expect(board.recentlyArchivedId).toBeNull();
      const lastMoveProjectId = await page.evaluate(
        () => (window as unknown as { __mockLastMoveProjectId?: string | null }).__mockLastMoveProjectId,
      );
      expect(lastMoveProjectId).toBe(PROJECT_A_ID);
    } finally {
      await browser.close();
    }
  });

  // D. Same-project happy path still flags recentlyArchivedId (no regression).
  test('a same-project completion still sets recentlyArchivedId', async () => {
    const { browser, page } = await launch();
    try {
      await startGatedCompletion(page, PROJECT_A_ID);
      await finalizeCompletion(page);
      await waitForCompletionSettled(page);

      const board = await readBoard(page);
      expect(board.recentlyArchivedId).toBe(TASK_ID);
    } finally {
      await browser.close();
    }
  });
});
