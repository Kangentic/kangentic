/**
 * Regression test for the To Do reset leaving a ghost `running` session.
 *
 * Mechanism (kangentic.com #80):
 *   - `moveTask` evicts a task's session rows optimistically the instant a
 *     move targets a todo-role column (`withoutSessionsForTasks` in
 *     task-slice.ts), well before the main-process teardown (kill the PTY,
 *     await its exit, remove the worktree) has even started.
 *   - If a `session-changed` status push for that session lands during the
 *     main-side teardown window, `upsertSession` re-adds the row with no
 *     guard against the eviction that already ran.
 *   - `SessionManager.remove()` used to delete the registry row and emit
 *     nothing, and the renderer's SESSION_EXIT handler deliberately ignores
 *     an intentional exit (App.tsx) - so nothing corrected a row resurrected
 *     this way. The card kept painting a spinner and a panel tab for an
 *     agent that was already gone everywhere in main.
 *
 * The fix (session-manager.ts `remove()`) emits a status push with
 * `status: 'exited'` immediately before the registry row is deleted, so
 * `withSessionUpserted` makes it the task's only row and the ghost clears.
 *
 * This spec does NOT exercise `remove()` itself - it simulates main's push
 * via `window.__mockFireStatus` and checks only the renderer's reaction to
 * it, so it passes even with the `remove()` emit reverted. The emit itself
 * (that it fires, exactly once, with the right shape, before the registry
 * row is deleted) is pinned separately by
 * `tests/unit/session-manager-remove-emit.test.ts`.
 *
 * UI-tier because the whole mechanism is renderer-store behavior driven by
 * simulated IPC pushes (`window.__mockFireStatus`) - no real PTY needed.
 * Modelled on spawn-progress-clear-on-todo-move.spec.ts (direct board-store
 * calls) and unarchive-to-todo-no-paused-row.spec.ts (the sibling ghost-row
 * regression, and its session-store-state assertions alongside the pixels).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-todo-reset-ghost';
const TASK_ID = 'task-todo-reset-ghost';
const TASK_TITLE = 'Todo Reset Ghost Probe';
const SESSION_ID = 'session-todo-reset-ghost';

interface BoardWindow {
  __zustandStores: {
    board: { getState: () => { moveTask: (input: { taskId: string; targetSwimlaneId: string; targetPosition: number }, skip?: boolean) => Promise<unknown> } };
    session: { getState: () => { sessions: Array<{ id: string; taskId: string; status: string; pid: number | null }> } };
  };
  __mockFireStatus: (sessionId: string, session: Record<string, unknown>) => void;
}

async function launch(): Promise<{ browser: Browser; page: Page; laneIds: { todo: string; planning: string } }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Todo Reset Ghost Test',
        path: '/mock/todo-reset-ghost-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var laneId = 'lane-trg-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = laneId;
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: laneId,
          position: index,
          created_at: timestamp,
        }));
      });
      // Task already running in an auto-spawn column, exactly the state right
      // before the user drags it back to To Do mid-boot.
      state.tasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Simulates a task dragged back to To Do while its agent was still booting',
        swimlane_id: laneIds['Planning'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/todo-reset-ghost-test/.kangentic/worktrees/ghost',
        branch_name: 'todo-reset-ghost',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/todo-reset-ghost-test/.kangentic/worktrees/ghost',
        startedAt: timestamp,
        exitCode: null,
        resuming: false,
        agentSessionId: 'agent-session-todo-reset-ghost',
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  const laneIds: { todo: string; planning: string } = await page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    const todoLane = lanes.find((swimlane: { role: string }) => swimlane.role === 'todo');
    const planningLane = lanes.find((swimlane: { name: string }) => swimlane.name === 'Planning');
    return { todo: todoLane?.id ?? '', planning: planningLane?.id ?? '' };
  });
  expect(laneIds.todo).toBeTruthy();
  expect(laneIds.planning).toBeTruthy();

  return { browser, page, laneIds };
}

async function sessionCountForTask(page: Page, taskId: string): Promise<number> {
  return page.evaluate((targetTaskId) => {
    const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
    return state.sessions.filter((session) => session.taskId === targetTaskId).length;
  }, taskId);
}

async function runningSessionCountForTask(page: Page, taskId: string): Promise<number> {
  return page.evaluate((targetTaskId) => {
    const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
    return state.sessions.filter((session) => session.taskId === targetTaskId && session.status === 'running').length;
  }, taskId);
}

test.describe('To Do reset does not leave a ghost running session', () => {
  test('a status push landing after the todo-role eviction is corrected by the removal push', async () => {
    const { browser, page, laneIds } = await launch();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });

      // Precondition: the running session really is in the renderer store, and
      // the card in Planning shows it, so a green result cannot come from the
      // fixture never being wired up.
      const planningCard = page.locator('[data-swimlane-name="Planning"]').locator(`[data-task-id="${TASK_ID}"]`);
      await expect(planningCard).toBeVisible({ timeout: 5000 });
      await expect(planningCard.locator('[data-mark]')).toHaveCount(1);
      expect(await runningSessionCountForTask(page, TASK_ID)).toBe(1);

      // Drag back to To Do, the same store action a real drag funnels through.
      // This runs the optimistic eviction (task-slice.ts) synchronously, before
      // the mocked IPC round-trip even resolves.
      await page.evaluate(
        async ({ taskId, targetId }) => {
          await (window as unknown as BoardWindow).__zustandStores.board.getState().moveTask(
            { taskId, targetSwimlaneId: targetId, targetPosition: 0 },
            true,
          );
        },
        { taskId: TASK_ID, targetId: laneIds.todo },
      );

      // The eviction has landed: no session row for this task, and the card in
      // To Do carries no activity mark.
      const todoCard = page.locator('[data-swimlane-name="To Do"]').locator(`[data-task-id="${TASK_ID}"]`);
      await expect(todoCard).toBeVisible({ timeout: 5000 });
      await expect.poll(async () => sessionCountForTask(page, TASK_ID), { timeout: 3000 }).toBe(0);
      await expect(todoCard.locator('[data-mark]')).toHaveCount(0);

      // The race: a status push for the same session id lands during what
      // would be the main-side kill grace, resurrecting the row exactly as
      // `upsertSession` (no guard against the eviction) would.
      await page.evaluate(
        ({ sessionId, taskId, projectId }) => {
          (window as unknown as BoardWindow).__mockFireStatus(sessionId, {
            id: sessionId,
            taskId,
            projectId,
            pid: null,
            status: 'running',
            shell: 'bash',
            cwd: '/mock/todo-reset-ghost-test/.kangentic/worktrees/ghost',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            agentSessionId: 'agent-session-todo-reset-ghost',
          });
        },
        { sessionId: SESSION_ID, taskId: TASK_ID, projectId: PROJECT_ID },
      );

      // The ghost: the card in To Do now shows an activity mark for a task that
      // was fully reset. This proves the setup is meaningful - the assertions
      // below cannot pass vacuously because the row was never re-added.
      await expect.poll(async () => runningSessionCountForTask(page, TASK_ID), { timeout: 3000 }).toBe(1);
      await expect(todoCard.locator('[data-mark]')).toHaveCount(1);
      await expect(page.locator(`[data-testid="terminal-session-tab"][data-session-id="${SESSION_ID}"]`)).toHaveCount(1);

      // The fix: the removal push SessionManager.remove() now emits.
      await page.evaluate(
        ({ sessionId, taskId, projectId }) => {
          (window as unknown as BoardWindow).__mockFireStatus(sessionId, {
            id: sessionId,
            taskId,
            projectId,
            pid: null,
            status: 'exited',
            shell: 'bash',
            cwd: '/mock/todo-reset-ghost-test/.kangentic/worktrees/ghost',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            agentSessionId: 'agent-session-todo-reset-ghost',
          });
        },
        { sessionId: SESSION_ID, taskId: TASK_ID, projectId: PROJECT_ID },
      );

      // The card stops lying, and the panel tab goes - because the session is
      // gone (`status: 'exited'`), not because the row was hidden some other way.
      await expect.poll(async () => runningSessionCountForTask(page, TASK_ID), { timeout: 3000 }).toBe(0);
      await expect(todoCard.locator('[data-mark]')).toHaveCount(0);
      await expect(page.locator(`[data-testid="terminal-session-tab"][data-session-id="${SESSION_ID}"]`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
