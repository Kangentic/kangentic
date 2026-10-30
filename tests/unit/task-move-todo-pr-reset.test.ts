/**
 * A move to To Do makes the task forget its PR, and the card hears about it.
 *
 * The To Do branch of `handleTaskMove` used to kill the session, remove the
 * worktree and delete the branch while leaving the PR link on the row, so the
 * To Do card kept "PR #574 merged" and the next run inherited that PR: a
 * merged `pr_state` short-circuits every non-force resolve, and a kept
 * `pushed_branch` lets Tier 5 find the old PR again.
 *
 * The tasks repository here is STATEFUL, and the mocked `cleanupTaskResources`
 * does what the real one does to the row (nulls the checkout, writes a captured
 * `head_sha`). The move clears twice: once in the tick that commits the To Do
 * lane, so a quit or crash during the cleanup cannot strand the link, and once
 * after the cleanup, for the `head_sha` it captured. A move that cleared only
 * before the cleanup fails the head_sha tests, and one that cleared only after
 * it fails the commit-point tests.
 *
 * Harness mirrors task-move-stale-branch-cleanup.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockCleanupTaskResources, mockCancelVerdictRepollsForTask, mockClearHeldMessages } = vi.hoisted(() => ({
  mockCleanupTaskResources: vi.fn(),
  mockCancelVerdictRepollsForTask: vi.fn(),
  mockClearHeldMessages: vi.fn(),
}));

vi.mock('../../src/main/held-messages/held-messages', () => ({
  clearHeldMessages: (...args: unknown[]) => mockClearHeldMessages(...args),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    updateGitStats = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {},
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {},
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
  setShuttingDown: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({ executeTransition: vi.fn(async () => ({})) })),
  reportAutomationFailures: vi.fn(),
  cleanupTaskResources: (...args: unknown[]) => mockCleanupTaskResources(...args),
  deleteTaskWorktree: vi.fn(async () => true),
  reapTaskLeftovers: vi.fn(async () => {}),
  scheduleDoneWorktreeRemovalRetry: vi.fn(),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
  cancelVerdictRepollsForTask: (...args: unknown[]) => mockCancelVerdictRepollsForTask(...args),
}));

const mockGetProjectRepos = vi.fn();

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-todo-pr-reset';
const TASK_ID = 'task-todo-pr-reset-0001';
const SOURCE_LANE_ID = 'lane-testing';
const TODO_LANE_ID = 'lane-todo';
/** The branch a resteered run pushed for a side fix, and the PR it opened and merged from it. */
const OLD_PUSHED_BRANCH = 'test/goto-vite-chrome-error-retry';
const OLD_PR_URL = 'https://github.com/owner/repo/pull/574';

const PR_IDENTITY_COLUMNS = ['pr_url', 'pr_number', 'pr_state', 'pr_merge_readiness', 'pushed_branch', 'head_sha'] as const;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 7,
    title: 'Cut the release',
    description: '',
    swimlane_id: SOURCE_LANE_ID,
    position: 0,
    agent: 'claude',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
    resolved_base_branch: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type TasksFake = {
  getById: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  setWorktreeSkipReason: ReturnType<typeof vi.fn>;
};

/** A one-row tasks repository whose writes land, so the test reads the row the move leaves. */
function makeStatefulTasks(initial: Task): { tasks: TasksFake; row: () => Task } {
  let current: Task = { ...initial };
  const tasks: TasksFake = {
    getById: vi.fn(() => ({ ...current })),
    move: vi.fn((input: { targetSwimlaneId: string; targetPosition: number }) => {
      current = { ...current, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
    }),
    update: vi.fn((patch: Partial<Task>) => {
      current = { ...current, ...patch };
      return { ...current };
    }),
    list: vi.fn(() => [{ ...current }]),
    archive: vi.fn(),
    setWorktreeSkipReason: vi.fn(),
  };
  return { tasks, row: () => current };
}

function makeContext() {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/todo-pr-reset-project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      removeByTaskId: vi.fn(),
      killByTaskId: vi.fn(),
      listSessions: vi.fn(() => []),
      suspend: vi.fn(async () => {}),
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      findLiveSessionByTaskId: vi.fn(() => null),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, name: 'Todo PR reset', default_agent: 'claude' })) },
  };
}

/**
 * Wires the repos and the context for a move to To Do without running it, so a
 * test can read the row after a move that rejects. `ambientProjectId` is the
 * context's `currentProjectId`; the move itself always names PROJECT_ID.
 */
function prepareMoveToTodo(task: Task, ambientProjectId: string = PROJECT_ID): {
  row: () => Task;
  tasks: TasksFake;
  context: ReturnType<typeof makeContext>;
  run: () => Promise<void>;
} {
  const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: null, auto_spawn: true });
  const todoLane = makeSwimlane(TODO_LANE_ID, { role: 'todo', auto_spawn: false });
  const { tasks, row } = makeStatefulTasks(task);

  mockGetProjectRepos.mockReturnValue({
    tasks,
    swimlanes: {
      getById: vi.fn((id: string) => {
        if (id === SOURCE_LANE_ID) return sourceLane;
        if (id === TODO_LANE_ID) return todoLane;
        return null;
      }),
      list: vi.fn(() => [todoLane, sourceLane]),
    },
    automations: {},
    automationRuns: {},
    attachments: { deleteByTaskId: vi.fn() },
  });

  const context = makeContext();
  context.currentProjectId = ambientProjectId;
  const run = (): Promise<void> => handleTaskMove(context as never, {
    taskId: task.id,
    targetSwimlaneId: TODO_LANE_ID,
    targetPosition: 0,
  }, 'renderer', PROJECT_ID, '/mock/todo-pr-reset-project');
  return { row, tasks, context, run };
}

async function moveToTodo(task: Task): Promise<{ row: () => Task; tasks: TasksFake; context: ReturnType<typeof makeContext> }> {
  const { row, tasks, context, run } = prepareMoveToTodo(task);
  await run();
  return { row, tasks, context };
}

function prLinkChangedPushes(context: ReturnType<typeof makeContext>): unknown[][] {
  return context.mainWindow.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === IPC.TASK_PR_LINK_CHANGED);
}

beforeEach(() => {
  vi.clearAllMocks();
  // What the real cleanupTaskResources does to the row when its worktree
  // removal succeeds: the checkout goes, the tip it read is captured.
  mockCleanupTaskResources.mockImplementation(async (
    _context: unknown,
    task: { id: string; worktree_path: string | null },
    tasks: TasksFake,
  ) => {
    if (!task.worktree_path) return;
    tasks.update({
      id: task.id,
      worktree_path: null,
      branch_name: null,
      resolved_base_branch: null,
      head_sha: 'captured-sha',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleTaskMove to To Do: the PR link', () => {
  it('forgets a merged link, its pushed_branch and head_sha for a task that did its own work, and tells the card', async () => {
    const { row, context } = await moveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
      pr_merge_readiness: 'ready',
    }));

    expect(mockCleanupTaskResources).toHaveBeenCalledTimes(1);
    const after = row();
    for (const column of PR_IDENTITY_COLUMNS) {
      expect(after[column], column).toBeNull();
    }
    expect(after.swimlane_id).toBe(TODO_LANE_ID);
    // The quiet reload reaches a host that refreshes only its own copy after
    // a move, as the Monitor's task-detail host does.
    expect(prLinkChangedPushes(context)).toEqual([[IPC.TASK_PR_LINK_CHANGED, PROJECT_ID]]);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('forgets the link of a no-worktree task whose push was recorded', async () => {
    // pushed_branch is the only anchor such a task can earn, and it is its own work.
    const { row, context } = await moveToTodo(makeTask({
      use_worktree: 0,
      pushed_branch: OLD_PUSHED_BRANCH,
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'open',
    }));

    const after = row();
    for (const column of PR_IDENTITY_COLUMNS) {
      expect(after[column], column).toBeNull();
    }
    expect(prLinkChangedPushes(context)).toHaveLength(1);
  });

  it('keeps a PR link typed onto a review task that never did work of its own', async () => {
    const { row, tasks, context } = await moveToTodo(makeTask({
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'open',
    }));

    const after = row();
    expect(after.pr_url).toBe(OLD_PR_URL);
    expect(after.pr_number).toBe(574);
    expect(after.pr_state).toBe('open');
    const prClearingWrites = tasks.update.mock.calls.filter(([patch]: [Partial<Task>]) => 'pr_number' in patch);
    expect(prClearingWrites).toEqual([]);
    expect(prLinkChangedPushes(context)).toEqual([]);
    expect(mockCancelVerdictRepollsForTask).not.toHaveBeenCalled();
  });

  it('writes nothing and pushes nothing when the task had work but no PR identity', async () => {
    // The own-work gate passes on the branch, but there is nothing to forget,
    // so no write bumps updated_at and no push reloads the board.
    const { tasks, context } = await moveToTodo(makeTask({ branch_name: 'never-pushed' }));

    const prClearingWrites = tasks.update.mock.calls.filter(([patch]: [Partial<Task>]) => 'pr_number' in patch);
    expect(prClearingWrites).toEqual([]);
    expect(prLinkChangedPushes(context)).toEqual([]);
    expect(mockCancelVerdictRepollsForTask).not.toHaveBeenCalled();
  });

  // The own-work gate reads four columns of the pre-cleanup snapshot. Each case
  // sets ONE of them next to a PR link, so a gate that dropped any one anchor
  // leaves that case's link on the row. The re-poll cancel runs once per write:
  // at the commit, and again after the cleanup only when the mocked cleanup
  // captured a head_sha, which it does for the task with a worktree.
  it.each([
    ['worktree_path', { worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7' }, 2],
    ['branch_name', { branch_name: 'cut-the-release-7' }, 1],
    ['pushed_branch', { pushed_branch: OLD_PUSHED_BRANCH }, 1],
    ['head_sha', { head_sha: 'old-sha' }, 1],
  ] as Array<[string, Partial<Task>, number]>)('forgets the link of a task whose only own work is its %s', async (_anchorName, anchorColumns, expectedCancelCount) => {
    const { row, context } = await moveToTodo(makeTask({
      ...anchorColumns,
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
    }));

    const after = row();
    for (const column of PR_IDENTITY_COLUMNS) {
      expect(after[column], column).toBeNull();
    }
    expect(prLinkChangedPushes(context)).toEqual([[IPC.TASK_PR_LINK_CHANGED, PROJECT_ID]]);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledTimes(expectedCancelCount);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('clears the head_sha the cleanup captured but pushes nothing when a worktree task held no PR link', async () => {
    // The cleanup captures a head_sha on nearly every worktree task. It feeds
    // Tiers 3 and 6 on the next run, so it goes. No chip is drawn from it, so
    // there is nothing for the card to reload.
    const { row, tasks, context } = await moveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
    }));

    // The premise: the cleanup wrote the captured sha, so a null below is the clear overwriting it.
    expect(tasks.update).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID, head_sha: 'captured-sha' }));
    expect(row().head_sha).toBeNull();
    const prClearingWrites = tasks.update.mock.calls.filter(([patch]: [Partial<Task>]) => 'pr_number' in patch);
    expect(prClearingWrites).toHaveLength(1);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
    expect(prLinkChangedPushes(context)).toEqual([]);
  });

  it('clears a recorded push but pushes nothing when a no-worktree task held no PR link', async () => {
    // pushed_branch is the Tier 5 anchor, and a PR keeps its source branch name
    // after the branch is deleted, so a kept one re-links the old PR later.
    const { row, tasks, context } = await moveToTodo(makeTask({
      use_worktree: 0,
      pushed_branch: OLD_PUSHED_BRANCH,
    }));

    expect(row().pushed_branch).toBeNull();
    const prClearingWrites = tasks.update.mock.calls.filter(([patch]: [Partial<Task>]) => 'pr_number' in patch);
    expect(prClearingWrites).toHaveLength(1);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
    expect(prLinkChangedPushes(context)).toEqual([]);
  });

  it('still forgets the link and the anchors when the worktree removal failed and the checkout survives', async () => {
    // A deliberate decision: the card drops its chip even though the directory
    // could not be deleted, and the next run re-links from the surviving
    // branch.
    const worktreePath = '/mock/todo-pr-reset-project/.kangentic/worktrees/7';
    mockCleanupTaskResources.mockImplementation(async () => {});
    const { row, context } = await moveToTodo(makeTask({
      worktree_path: worktreePath,
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
      pr_merge_readiness: 'ready',
    }));

    const after = row();
    for (const column of PR_IDENTITY_COLUMNS) {
      expect(after[column], column).toBeNull();
    }
    expect(after.worktree_path).toBe(worktreePath);
    expect(after.branch_name).toBe('cut-the-release-7');
    expect(prLinkChangedPushes(context)).toEqual([[IPC.TASK_PR_LINK_CHANGED, PROJECT_ID]]);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('forgets the link even when the cleanup throws, and rejects with the cleanup error', async () => {
    // The To Do move is already committed when the cleanup throws, and nothing
    // retries the clear, so it has to run from a finally.
    const cleanupFailure = new Error('worktree removal failed');
    mockCleanupTaskResources.mockRejectedValueOnce(cleanupFailure);
    const { row, context, run } = prepareMoveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
      pr_merge_readiness: 'ready',
    }));

    await expect(run()).rejects.toBe(cleanupFailure);

    const after = row();
    for (const column of PR_IDENTITY_COLUMNS) {
      expect(after[column], column).toBeNull();
    }
    // A Phase 1 throw is not rolled back (the rollback belongs to Phases 2 and 3),
    // so the card stays in To Do, which is the premise the finally relies on.
    expect(after.swimlane_id).toBe(TODO_LANE_ID);
    expect(prLinkChangedPushes(context)).toEqual([[IPC.TASK_PR_LINK_CHANGED, PROJECT_ID]]);
    expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('clears the link in the tick that commits the To Do lane, before the cleanup starts', async () => {
    // The cleanup takes seconds on Windows (awaitExit, the reap, the worktree
    // removal). A quit or crash inside it used to leave the old link on the To
    // Do card, so the row the cleanup is handed has to be clear already,
    // head_sha included.
    const rowsAtCleanup: Task[] = [];
    mockCleanupTaskResources.mockImplementation(async (
      _context: unknown,
      task: { id: string },
      tasks: TasksFake,
    ) => {
      rowsAtCleanup.push(tasks.getById(task.id));
    });
    const { context } = await moveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
      pr_merge_readiness: 'ready',
    }));

    expect(rowsAtCleanup).toHaveLength(1);
    for (const column of PR_IDENTITY_COLUMNS) {
      expect(rowsAtCleanup[0][column], column).toBeNull();
    }
    // The card heard about it before the cleanup started, not after it.
    const sendMock = context.mainWindow.webContents.send;
    const pushIndex = sendMock.mock.calls.findIndex((call: unknown[]) => call[0] === IPC.TASK_PR_LINK_CHANGED);
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(sendMock.mock.invocationCallOrder[pushIndex]).toBeLessThan(mockCleanupTaskResources.mock.invocationCallOrder[0]);
  });

  it('clears the link before the commit-time board event, so a paired phone never sees the old chip', async () => {
    const { row, context, run } = prepareMoveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
    }));
    const rowsAtBoardEvent: Task[] = [];
    context.boardEvents.emitBoardChanged.mockImplementation(() => {
      rowsAtBoardEvent.push({ ...row() });
    });

    await run();

    expect(rowsAtBoardEvent.length).toBeGreaterThan(0);
    expect(rowsAtBoardEvent[0].swimlane_id).toBe(TODO_LANE_ID);
    expect(rowsAtBoardEvent[0].pr_url).toBeNull();
    expect(rowsAtBoardEvent[0].pr_state).toBeNull();
  });

  it('still announces the move, runs the cleanup and finishes the clear when the commit-time pass throws', async () => {
    // The commit-time pass sits in its own try/catch so a throw (a locked
    // database, say) cannot skip the announce or the To Do branch behind it.
    // The pass in the finally after the cleanup re-reads the row and does the
    // whole clear, so the link still goes even though the first write never
    // landed.
    const { row, tasks, context, run } = prepareMoveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
      pr_merge_readiness: 'ready',
    }));
    const landingUpdate = tasks.update.getMockImplementation();
    if (!landingUpdate) throw new Error('The stateful tasks fake has no update implementation to fall back to');
    const writeFailure = new Error('database is locked');
    let cleanupCallsWhenWriteThrew = -1;
    tasks.update.mockImplementation((patch: Partial<Task>) => {
      if (cleanupCallsWhenWriteThrew === -1 && 'pr_number' in patch) {
        cleanupCallsWhenWriteThrew = mockCleanupTaskResources.mock.calls.length;
        throw writeFailure;
      }
      return landingUpdate(patch);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(run()).resolves.toBeUndefined();

      // The premise: the write that threw was the commit-time one, before the cleanup started.
      expect(cleanupCallsWhenWriteThrew).toBe(0);
      const forgetFailureLogs = consoleErrorSpy.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Forgetting the PR link failed'),
      );
      expect(forgetFailureLogs).toEqual([[expect.stringContaining('Forgetting the PR link failed for task'), writeFailure]]);

      // The announce and the To Do branch both still ran, in that order.
      expect(context.boardEvents.emitBoardChanged).toHaveBeenCalled();
      expect(mockCleanupTaskResources).toHaveBeenCalledTimes(1);
      expect(context.boardEvents.emitBoardChanged.mock.invocationCallOrder[0])
        .toBeLessThan(mockCleanupTaskResources.mock.invocationCallOrder[0]);

      // The retry in the finally cleared everything the failed pass left.
      const after = row();
      for (const column of PR_IDENTITY_COLUMNS) {
        expect(after[column], column).toBeNull();
      }
      expect(after.swimlane_id).toBe(TODO_LANE_ID);
      const prClearingWrites = tasks.update.mock.calls.filter(([patch]: [Partial<Task>]) => 'pr_number' in patch);
      expect(prClearingWrites).toHaveLength(2);
      // The retry still held a link to forget, so the card hears about it.
      expect(prLinkChangedPushes(context)).toEqual([[IPC.TASK_PR_LINK_CHANGED, PROJECT_ID]]);
      expect(mockCancelVerdictRepollsForTask).toHaveBeenCalledWith(TASK_ID);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('leaves the link alone when a task is only reordered within To Do', async () => {
    // A row already in To Do with its own work and a link is one a move made
    // before the clear existed. A reorder is not a reset, so it keeps the link.
    const { row, tasks, context } = await moveToTodo(makeTask({
      swimlane_id: TODO_LANE_ID,
      branch_name: 'cut-the-release-7',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'merged',
    }));

    const after = row();
    expect(after.pr_url).toBe(OLD_PR_URL);
    expect(after.pr_number).toBe(574);
    expect(after.pushed_branch).toBe(OLD_PUSHED_BRANCH);
    expect(after.head_sha).toBe('old-sha');
    const prClearingWrites = tasks.update.mock.calls.filter(([patch]: [Partial<Task>]) => 'pr_number' in patch);
    expect(prClearingWrites).toEqual([]);
    expect(mockCleanupTaskResources).not.toHaveBeenCalled();
    expect(prLinkChangedPushes(context)).toEqual([]);
    expect(mockCancelVerdictRepollsForTask).not.toHaveBeenCalled();
  });

  it('clears the messages held for the task\'s next agent, in the tick that commits the To Do lane', async () => {
    // A To Do move is a reset. Cleared before the cleanup, so a quit inside it
    // cannot leave a message waiting for an agent of the task's old run.
    await moveToTodo(makeTask({ worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7' }));

    expect(mockClearHeldMessages).toHaveBeenCalledWith(PROJECT_ID, TASK_ID);
    expect(mockClearHeldMessages.mock.invocationCallOrder[0]).toBeLessThan(mockCleanupTaskResources.mock.invocationCallOrder[0]);
  });

  it('keeps held messages when a task is only reordered within To Do', async () => {
    await moveToTodo(makeTask({ swimlane_id: TODO_LANE_ID }));

    expect(mockClearHeldMessages).not.toHaveBeenCalled();
  });

  it('tells the card with the project the move named, not the ambient current project', async () => {
    // getProjectRepos is mocked to ignore its id here, so the push payload and
    // the ids the move routed by are the evidence.
    const ambientProjectId = 'proj-ambient-other';
    const { context, run } = prepareMoveToTodo(makeTask({
      worktree_path: '/mock/todo-pr-reset-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-7',
      resolved_base_branch: 'main',
      pushed_branch: OLD_PUSHED_BRANCH,
      head_sha: 'old-sha',
      pr_url: OLD_PR_URL,
      pr_number: 574,
      pr_state: 'open',
    }), ambientProjectId);
    expect(context.currentProjectId).toBe(ambientProjectId);

    await run();

    expect(prLinkChangedPushes(context)).toEqual([[IPC.TASK_PR_LINK_CHANGED, PROJECT_ID]]);
    expect(mockGetProjectRepos.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockGetProjectRepos.mock.calls) {
      expect(call[1]).toBe(PROJECT_ID);
    }
  });
});
