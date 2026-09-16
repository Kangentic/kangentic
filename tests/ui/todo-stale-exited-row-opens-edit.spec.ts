/**
 * A To Do card opens the edit form whatever session row the store still
 * holds for it, and a move to To Do leaves the store holding nothing.
 *
 * kangentic.com #76 (#661): a task with a live agent was dragged back to To
 * Do. Main tore the session down completely, but its removal announcement
 * arrived on the status channel, whose only renderer handler is an upsert,
 * so the renderer kept an `exited` row for a PTY that no longer existed and
 * its `sessionUsage` entry with it. Clicking the card then opened VIEW mode
 * (the card decided edit-vs-view on `displayState.kind === 'none'`, which an
 * `exited` row fails) over a black terminal with a fully populated context
 * bar. The only way to the edit form was the header kebab.
 *
 * Two layers, each pinned here:
 *   1. The lane-aware surface classifier (task-progress.ts): in a todo-role
 *      lane nothing session-shaped is painted whatever the kind says, and
 *      the card decides edit mode through that same classifier. The first
 *      test seeds the exact stale state (an `exited` row plus a usage tick)
 *      and clicks the card.
 *   2. The removal push (`session:removed`) and its handler
 *      (`removeSession`): the mock's `tasks.move` mirrors main and fires it
 *      for a todo-role move after the renderer's own optimistic eviction has
 *      run, the measured ordering. The second test drives the real
 *      `moveTask` and asserts the store ends with no row and no usage entry.
 *
 * A third test (code review, #661 follow-up) closes a narrower gap in the
 * SAME classifier: TaskDetailBody.tsx calls `taskDetailSurfaceFor(displayKind,
 * laneRole)` at three sites (terminal, queued-placeholder, launch-overlay),
 * and only the terminal site is exercised above - it is protected twice over,
 * since `useTaskSessionState` already nulls a todo-lane task's session before
 * `displayKind` is even computed, so `sessionId` is always null there too. The
 * other two sites have no such backstop: `taskDetailSurfaceFor(...) ===
 * 'queued-placeholder'` / `'launch-overlay'` is the ONLY thing standing
 * between a todo-lane task and a spinner. A lingering `spawnProgress` label
 * (main's worktree-recreate window; #661's TTL sweep clears it after 120s,
 * but nothing in the renderer waits for that) reaches `displayKind: 'preparing'`
 * with no session at all, which is exactly the launch-overlay call site's
 * shape. `'queued'` cannot be produced the same way for a todo-lane task
 * (`useTaskSessionState` nulls the session, so `useTaskProgress`'s `sessionId`
 * argument is always undefined there, and its `taskSession` lookup - the only
 * source of a `'queued'` kind - always returns undefined); that call site is
 * source-pinned instead, in `tests/unit/session-display-state.test.ts`.
 *
 * UI-tier: renderer-store and window behavior over the headless mock, no PTY.
 * Fixture pattern from task-detail-maximize.spec.ts (the To Do edit-mode
 * click) and todo-reset-no-ghost-session.spec.ts (the move and the pushes).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser and page, so the file fans out safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-todo-stale-row';
const STALE_TASK_ID = 'task-todo-stale-row';
const STALE_SESSION_ID = 'session-todo-stale-row';
const LIVE_TASK_ID = 'task-todo-live-agent';
const LIVE_SESSION_ID = 'session-todo-live-agent';
const PREPARING_TASK_ID = 'task-todo-preparing-row';
const SPAWN_LABEL = 'Creating worktree...';

interface BoardWindow {
  __zustandStores: {
    board: { getState: () => { moveTask: (input: { taskId: string; targetSwimlaneId: string; targetPosition: number }, skip?: boolean) => Promise<unknown> } };
    session: {
      getState: () => {
        sessions: Array<{ id: string; taskId: string; status: string }>;
        sessionUsage: Record<string, unknown>;
        spawnProgress: Record<string, string>;
        setDetailTaskId: (id: string | null) => void;
      };
    };
    window: { getState: () => { windows: Record<string, { id: string; anchor: string }> } };
  };
  __mockFireUsage: (sessionId: string, usage: Record<string, unknown>, projectId: string) => void;
  __mockFireSpawnProgress: (taskId: string, label: string) => void;
}

// The digits from the report, so a populated context bar would be
// unmistakable if it ever painted.
const USAGE_FIXTURE = {
  model: { id: 'claude-opus-5', displayName: 'Opus 5' },
  contextWindow: {
    usedPercentage: 11,
    usedTokens: 113852,
    cacheTokens: 0,
    totalInputTokens: 111701,
    totalOutputTokens: 2151,
    contextWindowSize: 1000000,
  },
  cost: { totalCostUsd: 0.5, totalDurationMs: 18000 },
};

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Todo Stale Row Test',
      path: '/mock/todo-stale-row-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: timestamp,
      created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var laneId = 'lane-tsr-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = laneId;
      state.swimlanes.push(Object.assign({}, swimlane, {
        id: laneId,
        position: index,
        created_at: timestamp,
      }));
    });
    // The #661 state: a task back in To Do (main already cleared its
    // session_id) with an exited row the renderer never dropped.
    state.tasks.push({
      id: '${STALE_TASK_ID}',
      display_id: 76,
      title: 'Stale Row Task',
      description: 'Moved back to To Do while its agent was live',
      swimlane_id: laneIds['To Do'],
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
      created_at: timestamp,
      updated_at: timestamp,
    });
    state.sessions.push({
      id: '${STALE_SESSION_ID}',
      taskId: '${STALE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: null,
      status: 'exited',
      shell: 'bash',
      cwd: '/mock/todo-stale-row-test/.kangentic/worktrees/stale',
      startedAt: timestamp,
      exitCode: 1,
      resuming: false,
      agentSessionId: 'agent-session-todo-stale-row',
    });
    // A live agent in Planning, about to be dragged back to To Do.
    state.tasks.push({
      id: '${LIVE_TASK_ID}',
      display_id: 77,
      title: 'Live Agent Task',
      description: 'Running in Planning until the drag back to To Do',
      swimlane_id: laneIds['Planning'],
      position: 0,
      agent: 'claude',
      session_id: '${LIVE_SESSION_ID}',
      worktree_path: '/mock/todo-stale-row-test/.kangentic/worktrees/live',
      branch_name: 'live-agent-task',
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
      id: '${LIVE_SESSION_ID}',
      taskId: '${LIVE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 4242,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/todo-stale-row-test/.kangentic/worktrees/live',
      startedAt: timestamp,
      exitCode: null,
      resuming: false,
      agentSessionId: 'agent-session-todo-live-agent',
    });
    // A third stale shape: no session row at all, just a lingering spawn-
    // progress label. taskDetailSurfaceFor(displayKind, laneRole) is the ONLY
    // gate on the launch-overlay branch (unlike the terminal branch, it is
    // not also protected by a null sessionId), so this is the one state that
    // can tell a correct laneRole apart from a dropped one there.
    state.tasks.push({
      id: '${PREPARING_TASK_ID}',
      display_id: 78,
      title: 'Preparing Row Task',
      description: '',
      swimlane_id: laneIds['To Do'],
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
      created_at: timestamp,
      updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page; todoLaneId: string }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  const todoLaneId: string = await page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    return lanes.find((swimlane: { role: string | null }) => swimlane.role === 'todo')?.id ?? '';
  });
  expect(todoLaneId).toBeTruthy();

  return { browser, page, todoLaneId };
}

async function fireUsage(page: Page, sessionId: string): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as BoardWindow).__mockFireUsage === 'function');
  await page.evaluate(
    ({ targetSessionId, usage, projectId }) => {
      (window as unknown as BoardWindow).__mockFireUsage(targetSessionId, usage, projectId);
    },
    { targetSessionId: sessionId, usage: USAGE_FIXTURE, projectId: PROJECT_ID },
  );
}

async function sessionRowsForTask(page: Page, taskId: string): Promise<number> {
  return page.evaluate((targetTaskId) => {
    const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
    return state.sessions.filter((session) => session.taskId === targetTaskId).length;
  }, taskId);
}

async function usageHeldForSession(page: Page, sessionId: string): Promise<boolean> {
  return page.evaluate((targetSessionId) => {
    const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
    return targetSessionId in state.sessionUsage;
  }, sessionId);
}

async function fireSpawnProgress(page: Page, taskId: string, label: string): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as BoardWindow).__mockFireSpawnProgress === 'function');
  await page.evaluate(
    ({ targetTaskId, spawnLabel }) => {
      (window as unknown as BoardWindow).__mockFireSpawnProgress(targetTaskId, spawnLabel);
    },
    { targetTaskId: taskId, spawnLabel: label },
  );
}

async function spawnProgressLabelFor(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((targetTaskId) => {
    const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
    return state.spawnProgress[targetTaskId] ?? null;
  }, taskId);
}

/** Opens a task-detail window by driving the store directly (bypassing
 *  TaskCard's own `initialEdit` heuristic - see task-detail-update-from-base.spec.ts),
 *  so the window mounts in VIEW mode and TaskDetailBody actually renders,
 *  rather than TaskDetailEditForm. Returns the window id once it is mounted. */
async function openDetailWindowInViewMode(page: Page, taskId: string): Promise<string> {
  await page.evaluate((detailTaskId) => {
    (window as unknown as BoardWindow).__zustandStores.session.getState().setDetailTaskId(detailTaskId);
  }, taskId);

  let resolvedWindowId: string | null = null;
  await expect.poll(async () => {
    resolvedWindowId = await page.evaluate((anchorId) => {
      const windows = (window as unknown as BoardWindow).__zustandStores.window.getState().windows;
      return Object.values(windows).find((candidate) => candidate.anchor === anchorId)?.id ?? null;
    }, taskId);
    return resolvedWindowId;
  }, { timeout: 5000 }).not.toBeNull();
  return resolvedWindowId as string;
}

test.describe('A To Do task is sessionless in the renderer', () => {
  test('clicking a To Do card with a stale exited row opens the edit form, not a terminal', async () => {
    const { browser, page } = await launch();
    try {
      // Precondition: the stale state really is in the store, including the
      // usage that filled #661's context bar, so a green result cannot come
      // from the fixture never being wired up.
      expect(await sessionRowsForTask(page, STALE_TASK_ID)).toBe(1);
      await fireUsage(page, STALE_SESSION_ID);
      await expect.poll(async () => usageHeldForSession(page, STALE_SESSION_ID), { timeout: 3000 }).toBe(true);

      const card = page.locator('[data-swimlane-name="To Do"]').locator(`[data-task-id="${STALE_TASK_ID}"]`);
      await expect(card).toBeVisible({ timeout: 5000 });
      await card.click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      // Edit mode: the edit scroller and the title input are the edit form's
      // own discriminators.
      await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
      await expect(dialog.locator('input[placeholder="Task title"]')).toBeVisible();
      // No terminal, and no context bar under it.
      await expect(dialog.locator('[data-testid="terminal-tab-container"]')).toHaveCount(0);
      await expect(dialog.locator('[data-testid^="context-bar-"]')).toHaveCount(0);

      // Cancel on a card-opened edit of a sessionless task closes the window
      // (useTaskActions: `initialEdit && !session`), rather than dropping into
      // a view mode that would have shown the dead terminal.
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('moving a live agent back to To Do leaves no session row and no usage entry', async () => {
    const { browser, page, todoLaneId } = await launch();
    try {
      // Precondition: a running row with usage, painted on the Planning card.
      await fireUsage(page, LIVE_SESSION_ID);
      await expect.poll(async () => usageHeldForSession(page, LIVE_SESSION_ID), { timeout: 3000 }).toBe(true);
      const planningCard = page.locator('[data-swimlane-name="Planning"]').locator(`[data-task-id="${LIVE_TASK_ID}"]`);
      await expect(planningCard).toBeVisible({ timeout: 5000 });
      await expect(planningCard.locator('[data-mark]')).toHaveCount(1);

      // The same store action a real drag funnels through: the optimistic
      // eviction runs first, then the mock's tasks.move fires session:removed
      // for the row exactly as main's teardown does.
      await page.evaluate(
        async ({ taskId, targetId }) => {
          await (window as unknown as BoardWindow).__zustandStores.board.getState().moveTask(
            { taskId, targetSwimlaneId: targetId, targetPosition: 0 },
            true,
          );
        },
        { taskId: LIVE_TASK_ID, targetId: todoLaneId },
      );

      // Once the move and every push it generated have settled: nothing left.
      await expect.poll(async () => sessionRowsForTask(page, LIVE_TASK_ID), { timeout: 3000 }).toBe(0);
      await expect.poll(async () => usageHeldForSession(page, LIVE_SESSION_ID), { timeout: 3000 }).toBe(false);

      const todoCard = page.locator('[data-swimlane-name="To Do"]').locator(`[data-task-id="${LIVE_TASK_ID}"]`);
      await expect(todoCard).toBeVisible({ timeout: 5000 });
      await expect(todoCard.locator('[data-mark]')).toHaveCount(0);

      // And the card opens the edit form, whatever happened to the task before.
      await todoCard.click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
      await expect(dialog.locator('[data-testid="terminal-tab-container"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a To Do task with a lingering spawn-progress label shows no launch overlay', async () => {
    const { browser, page } = await launch();
    try {
      // Precondition: the label really lands in the store (displayKind becomes
      // 'preparing'), so a green result cannot come from the fixture never
      // being wired up.
      await fireSpawnProgress(page, PREPARING_TASK_ID, SPAWN_LABEL);
      await expect.poll(async () => spawnProgressLabelFor(page, PREPARING_TASK_ID), { timeout: 3000 }).toBe(SPAWN_LABEL);

      // Opened via the store directly, not a card click: TaskCard's own
      // initialEdit heuristic would route straight to TaskDetailEditForm
      // (which never calls taskDetailSurfaceFor at all), so the window has to
      // mount in VIEW mode for TaskDetailBody's launch-overlay branch to be
      // reachable either way.
      const windowId = await openDetailWindowInViewMode(page, PREPARING_TASK_ID);
      const dialog = page.locator(`[data-testid="window-frame-${windowId}"]`).locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // No launch overlay (the spawn spinner + label), and no queued
      // placeholder either - neither surface belongs to a todo-role lane.
      await expect(dialog.locator('[data-testid="launch-overlay"]')).toHaveCount(0);
      await expect(dialog.getByText(SPAWN_LABEL)).toHaveCount(0);
      await expect(dialog.getByText('Waiting in queue')).toHaveCount(0);
      // The inert fallback: no description, no attachments, no session-shaped
      // surface. This is the positive discriminator - it can only paint once
      // the launch-overlay branch above has already returned false.
      await expect(dialog.getByText('No active session. Drag this task into a column that starts an agent.')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
