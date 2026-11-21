/**
 * #1141: a move into To Do or Done runs the destination's On task enter group
 * (src/main/ipc/handlers/task-move.ts, Priorities 1 and 2).
 *
 * Before, both branches returned out of Phase 1 without arming the group, so an
 * enter row there could never fire and the board refused the whole group. Now
 * each arms it after the reset or the suspend, and it runs once the move
 * releases the task lock, as a column with "Start an agent here" off already
 * did. Which types may run there is `canColumnRun`'s answer, pinned in
 * automation-adapter-parity.test.ts; this file pins that the move runs the group
 * at all, after the teardown, on the task as the teardown left it.
 *
 * Harness mirrors task-move-message-paste.test.ts, with an engine stub that
 * records each group's trigger, column, and the task it was handed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  /** Every group the stub engine was asked to run, with the task it was handed. */
  engineRuns: [] as Array<{ trigger: 'enter' | 'exit'; laneId: string; task: Task }>,
  /** The order teardown steps and groups ran in. */
  events: [] as string[],
  /** When set, the stub engine's enter group rejects, as a list that could not run. */
  failEnter: false,
  /** When set, the Done worktree delete aborts the move, as a newer move of the task would. */
  supersedeDuringDoneTeardown: false,
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  getGlobalDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []) })) })),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => ({
      id: 'rec-main',
      task_id: 'task-system-0001',
      isolated_swimlane_id: null,
      agent_session_id: 'agent-A',
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      session_type: 'claude_agent',
      permission_mode: null,
      applied_model: null,
      applied_effort: null,
    }));
    getLatestForTaskByTypeAndIsolation = vi.fn(() => null);
    findByAnyId = vi.fn(() => undefined);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
    getSummaryForTask = vi.fn(() => null);
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../src/main/git/worktree-manager', () => ({
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
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({ reportAutoCommandOutcome: vi.fn() }));
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/held-messages/held-messages')>();
  return { ...actual, clearHeldMessages: vi.fn() };
});

/** Stands in for the automation runner: records the group and runs nothing. */
function makeEngine() {
  return {
    executeTransition: vi.fn(async (task: Task, lane: Swimlane, trigger: 'enter' | 'exit') => {
      hoisted.engineRuns.push({ trigger, laneId: lane.id, task });
      hoisted.events.push(`group-${trigger}`);
      if (trigger === 'enter' && hoisted.failEnter) throw new Error('enter list could not run');
      return { outcomes: [], failures: [] };
    }),
  };
}

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => makeEngine()),
  cleanupTaskResources: vi.fn(async () => { hoisted.events.push('todo-cleanup'); }),
  deleteTaskWorktree: vi.fn(async () => {
    hoisted.events.push('done-worktree-delete');
    if (hoisted.supersedeDuringDoneTeardown) {
      const { abortInFlightMove } = await import('../../src/main/ipc/handlers/task-move-controllers');
      abortInFlightMove('task-system-0001');
    }
    return true;
  }),
  reapTaskLeftovers: vi.fn(async () => {}),
  reportAutomationFailures: vi.fn(),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';

const TASK_ID = 'task-system-0001';
const SESSION_ID = 'active-session-1';
const LANE_A = 'lane-a';
const LANE_TODO = 'lane-todo';
const LANE_DONE = 'lane-done';
const WORKTREE = '/mock/project/.kangentic/worktrees/my-task';

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
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(swimlaneId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: swimlaneId,
    position: 0,
    agent: 'claude',
    session_id: SESSION_ID,
    worktree_path: WORKTREE,
    branch_name: 'my-task',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    automations_disabled: false,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A stateful task row: the move's teardown mocks do not touch it, so the harness
 * applies what the real teardown does once it has run (`todo-cleanup` clears
 * the worktree and branch, `done-worktree-delete` clears the worktree), and a
 * later read sees it. That is how a case tells a re-read from the move's
 * Phase 1 snapshot, which still names the worktree.
 */
function makeHarness() {
  let currentLane = LANE_A;
  const readTask = (): Task => {
    const overrides: Partial<Task> = {};
    if (hoisted.events.includes('todo-cleanup')) Object.assign(overrides, { worktree_path: null, branch_name: null, session_id: null });
    if (hoisted.events.includes('done-worktree-delete')) Object.assign(overrides, { worktree_path: null, session_id: null });
    return makeTask(currentLane, overrides);
  };
  const taskRepo = {
    getById: vi.fn(readTask),
    move: vi.fn((input: { targetSwimlaneId: string }) => { currentLane = input.targetSwimlaneId; }),
    update: vi.fn(),
    list: vi.fn(() => [readTask()]),
    archive: vi.fn(),
    setWorktreeSkipReason: vi.fn(),
  };
  const lanes = new Map<string, Swimlane>([
    [LANE_A, makeSwimlane(LANE_A)],
    [LANE_TODO, makeSwimlane(LANE_TODO, { name: 'To Do', role: 'todo', auto_spawn: false })],
    [LANE_DONE, makeSwimlane(LANE_DONE, { name: 'Done', role: 'done', auto_spawn: false })],
  ]);
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: { getById: vi.fn((id: string) => lanes.get(id) ?? null), list: vi.fn(() => [...lanes.values()]) },
    actions: { getTransitionsFor: vi.fn(() => []) },
    automations: { listForColumn: vi.fn(() => []), getForTrigger: vi.fn(() => []) },
    automationRuns: { start: vi.fn(), finish: vi.fn(), recordSkipped: vi.fn(), updateDetail: vi.fn() },
    attachments: { deleteByTaskId: vi.fn(), getPathsForTask: vi.fn(() => []) },
  });
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      drainQueue: vi.fn(),
      columnBlocks: vi.fn(() => false),
      isResuming: vi.fn(() => false),
      holdColumnSlot: vi.fn(() => () => undefined),
      removeByTaskId: vi.fn(),
      killByTaskId: vi.fn(),
      listSessions: vi.fn(() => []),
      suspend: vi.fn(async () => { hoisted.events.push('suspend'); }),
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      awaitInputReady: vi.fn(async () => true),
      isAgentLaunching: vi.fn(() => false),
      awaitAgentLaunched: vi.fn(async () => true),
      findLiveSessionByTaskId: vi.fn(() => null),
      getUsageCache: vi.fn((): Record<string, unknown> => ({})),
      getFirstReportedEffort: vi.fn((): string | null => null),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' }, agent: { permissionMode: 'acceptEdits' } })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null), getBoardProfiles: vi.fn(() => []) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent: vi.fn(async () => {}) },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  return { context };
}

function move(context: unknown, targetSwimlaneId: string): Promise<void> {
  return handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId, targetPosition: 0 }, 'renderer');
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.engineRuns.length = 0;
  hoisted.events.length = 0;
  hoisted.failEnter = false;
  hoisted.supersedeDuringDoneTeardown = false;
});

describe('a move into To Do or Done runs the destination\'s On task enter group', () => {
  it('To Do: runs the enter group after the exit group and the reset, on the reset task', async () => {
    const { context } = makeHarness();

    await move(context, LANE_TODO);

    // Red: Priority 1 returned without arming the group, so no enter run.
    const enterRun = hoisted.engineRuns.find((run) => run.trigger === 'enter');
    expect(enterRun?.laneId).toBe(LANE_TODO);
    expect(hoisted.events).toEqual(['group-exit', 'todo-cleanup', 'group-enter']);
    // The task as the reset left it, not the Phase 1 snapshot: a template's
    // {{worktreePath}} and {{branchName}} resolve to nothing.
    expect(enterRun?.task.worktree_path).toBeNull();
    expect(enterRun?.task.branch_name).toBeNull();
  });

  it('Done: runs the enter group after the suspend and the worktree set-aside, on the archived task', async () => {
    const { context } = makeHarness();

    await move(context, LANE_DONE);

    const enterRun = hoisted.engineRuns.find((run) => run.trigger === 'enter');
    // Red: Priority 2 returned without arming the group.
    expect(enterRun?.laneId).toBe(LANE_DONE);
    expect(hoisted.events).toEqual(['group-exit', 'suspend', 'done-worktree-delete', 'group-enter']);
    // Done keeps the branch for a later restore; the worktree is gone.
    expect(enterRun?.task.worktree_path).toBeNull();
    expect(enterRun?.task.branch_name).toBe('my-task');
  });

  it('runs exactly one enter group per move', async () => {
    const { context } = makeHarness();

    await move(context, LANE_DONE);

    expect(hoisted.engineRuns.filter((run) => run.trigger === 'enter')).toHaveLength(1);
  });

  it('a list that cannot run leaves the move done and clears the card label', async () => {
    const { context } = makeHarness();
    hoisted.failEnter = true;
    const { clearSpawnProgress } = await import('../../src/main/transition-engine/spawn-progress');
    const { reportAutomationFailures } = await import('../../src/main/ipc/helpers/index');

    // The archive already committed, so a failed enter group must not reject the move.
    await expect(move(context, LANE_DONE)).resolves.toBeUndefined();

    expect(hoisted.events).toEqual(['group-exit', 'suspend', 'done-worktree-delete', 'group-enter']);
    expect(reportAutomationFailures).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), 'enter');
    expect(vi.mocked(clearSpawnProgress).mock.calls.length).toBeGreaterThan(0);
  });

  it('runs no enter group when a newer move of the task aborted this one first', async () => {
    const { context } = makeHarness();
    hoisted.supersedeDuringDoneTeardown = true;
    const { clearSpawnProgress } = await import('../../src/main/transition-engine/spawn-progress');

    await move(context, LANE_DONE);

    // The newer move owns the task: this move's group must not read the state it is changing.
    expect(hoisted.engineRuns.filter((run) => run.trigger === 'enter')).toHaveLength(0);
    expect(hoisted.events).not.toContain('group-enter');
    // The card's label is still retired by the group's finally.
    const clearsAfterTeardown = vi.mocked(clearSpawnProgress).mock.invocationCallOrder
      .filter((order) => order > vi.mocked(context.sessionManager.suspend).mock.invocationCallOrder[0]);
    expect(clearsAfterTeardown.length).toBeGreaterThan(0);
  });
});
