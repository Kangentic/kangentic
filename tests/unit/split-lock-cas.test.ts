/**
 * Split-lock CAS invariants for TASK_MOVE and SESSION_RESUME.
 *
 * After the 2026-04-20 refactor, both handlers use a three-phase pattern:
 *   Phase 1 (locked)   - DB mutations + PTY kill/suspend dispatch
 *   Phase 2 (unlocked) - ensureTaskWorktree (serialized per-project by
 *                        WorktreeManager.projectQueues)
 *   Phase 3 (locked)   - re-read task state and bail if invariants changed
 *                        during the Phase 2 gap
 *
 * These tests exercise the CAS bail-out in Phase 3: if a concurrent handler
 * mutates task.swimlane_id or task.session_id while Phase 2 is holding the
 * lock open, Phase 3 must detect the change and skip the spawn rather than
 * producing a stale PTY or a duplicate session.
 *
 * task-lifecycle-lock is the REAL implementation so the handler-level lock
 * semantics are observable; only I/O helpers, repos, and sessionManager are
 * mocked.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
  default: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => {});
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
}));

// The backlog handler exposes abortBacklogPromotion, imported by task-move.
vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

// Mocked IPC helpers - configured per test
const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => {});
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn();
const mockCleanupTaskResources = vi.fn(async () => {});
const mockDeleteTaskWorktree = vi.fn(async () => true);
const mockBuildAutoCommandVars = vi.fn(() => ({}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskResources: (...args: unknown[]) => mockCleanupTaskResources(...args),
  deleteTaskWorktree: (...args: unknown[]) => mockDeleteTaskWorktree(...args),
  buildAutoCommandVars: (...args: unknown[]) => mockBuildAutoCommandVars(...args),
}));

// Import under test AFTER all mocks are registered
import { registerTaskMoveHandlers, handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';
import { resolveTargetAgent } from '../../src/main/engine/agent-resolver';
import { clearSpawnProgress } from '../../src/main/engine/spawn-progress';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  title: string;
  swimlane_id: string;
  position: number;
  worktree_path: string | null;
  session_id: string | null;
  branch_name: string | null;
  base_branch: string | null;
  agent: string;
}

interface MockSwimlane {
  id: string;
  role: string | null;
  auto_spawn: boolean;
  auto_command: string | null;
  permission_mode: string | null;
  agent_override: string | null;
}

function createMockTask(id: string, overrides: Partial<MockTask> = {}): MockTask {
  return {
    id,
    title: `Task ${id}`,
    swimlane_id: 'lane-todo',
    position: 0,
    worktree_path: null,
    session_id: null,
    branch_name: null,
    base_branch: null,
    agent: 'claude',
    ...overrides,
  };
}

function createMockSwimlane(id: string, overrides: Partial<MockSwimlane> = {}): MockSwimlane {
  return {
    id,
    role: null,
    auto_spawn: true,
    auto_command: null,
    permission_mode: null,
    agent_override: null,
    ...overrides,
  };
}

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => []),
      getSession: vi.fn(() => null),
      getSessionTaskId: vi.fn(() => null),
      getSessionProjectId: vi.fn(() => null),
      killByTaskId: vi.fn(),
      removeByTaskId: vi.fn(),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      getActivityCache: vi.fn(() => ({})),
      getUsageCache: vi.fn(() => ({})),
      getEventsCache: vi.fn(() => ({})),
      on: vi.fn(),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
    },
    commandInjector: {
      schedule: vi.fn(),
      cancel: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude' })),
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite: TASK_MOVE Phase 3 CAS
// ---------------------------------------------------------------------------

describe('TASK_MOVE split-lock CAS', () => {
  let context: ReturnType<typeof createMockContext>;
  let doingLane: MockSwimlane;
  let todoLane: MockSwimlane;
  let task: MockTask;
  let storedTask: MockTask;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    doingLane = createMockSwimlane('lane-doing', { auto_spawn: true });
    todoLane = createMockSwimlane('lane-todo', { role: 'todo' });
    task = createMockTask('task-1', { swimlane_id: 'lane-todo' });
    storedTask = { ...task };

    const taskRepo = {
      getById: vi.fn(() => storedTask),
      move: vi.fn((input: { taskId: string; targetSwimlaneId: string; targetPosition: number }) => {
        storedTask = { ...storedTask, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
      }),
      update: vi.fn((patch: Partial<MockTask> & { id: string }) => {
        storedTask = { ...storedTask, ...patch };
      }),
      archive: vi.fn(),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => ({ 'lane-doing': doingLane, 'lane-todo': todoLane }[id] ?? null)),
    };
    const actionsRepo = { getTransitionsFor: vi.fn(() => []) };
    const attachmentRepo = { add: vi.fn(), deleteByTaskId: vi.fn(), listForTask: vi.fn(() => []) };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: actionsRepo,
      attachments: attachmentRepo,
    });

    mockCreateTransitionEngine.mockReturnValue({
      executeTransition: vi.fn(async () => {}),
      resumeSuspendedSession: vi.fn(async () => {}),
    });

    context = createMockContext();
    registerTaskMoveHandlers(context as never);
  });

  it('calls spawnAgent on a normal Priority 4 move (To Do → Doing)', async () => {
    await handleTaskMove(context as never, {
      taskId: 'task-1',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 0,
    });

    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  /**
   * Arm `mockEnsureTaskWorktree` to block until the returned `release` callback
   * is called, and return a `phase2Entered` promise that resolves the moment
   * the handler enters Phase 2. Awaiting `phase2Entered` gives a deterministic
   * sync point instead of relying on microtask scheduling.
   */
  function armPhase2Hold(): { phase2Entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let signalEntered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const phase2Entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    mockEnsureTaskWorktree.mockImplementation(async () => {
      signalEntered();
      await hold;
    });
    return { phase2Entered, release };
  }

  it('bails out of spawn when swimlane_id changes during Phase 2 (concurrent move wins)', async () => {
    const { phase2Entered, release } = armPhase2Hold();

    const movePromise = handleTaskMove(context as never, {
      taskId: 'task-1',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 0,
    });

    await phase2Entered;

    // Simulate a concurrent Priority 1 move that put the task back in To Do.
    // The CAS check in Phase 3 reads task.swimlane_id via getById.
    storedTask = { ...storedTask, swimlane_id: 'lane-todo' };

    release();
    await movePromise;

    // ensureTaskWorktree ran once (Phase 2). But the CAS check saw the mutated
    // swimlane_id and skipped the spawn.
    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('bails out of spawn when session_id is set during Phase 2 (another handler spawned)', async () => {
    const { phase2Entered, release } = armPhase2Hold();

    const movePromise = handleTaskMove(context as never, {
      taskId: 'task-1',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 0,
    });

    await phase2Entered;

    // Simulate another handler having spawned a session during our Phase 2 gap.
    storedTask = { ...storedTask, session_id: 'sess-other' };

    release();
    await movePromise;

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test suite: Priority 3a agent handoff path
// ---------------------------------------------------------------------------

describe('TASK_MOVE Priority 3a - agent handoff', () => {
  let context: ReturnType<typeof createMockContext>;
  let doingLane: MockSwimlane;
  let reviewLane: MockSwimlane;
  let task: MockTask;
  let storedTask: MockTask;
  let resolveTargetAgentMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    // resolveTargetAgent is vi.fn() - grab the mocked reference.
    resolveTargetAgentMock = vi.mocked(resolveTargetAgent);

    doingLane = createMockSwimlane('lane-doing', { auto_spawn: true });
    // Review lane uses a different agent - triggers 3a handoff.
    reviewLane = createMockSwimlane('lane-review', {
      auto_spawn: true,
      agent_override: 'codex',
    });
    // Task already has an active session (it's running in Doing).
    task = createMockTask('task-3a', {
      swimlane_id: 'lane-doing',
      session_id: 'sess-running',
      agent: 'claude',
    });
    storedTask = { ...task };

    const taskRepo = {
      getById: vi.fn(() => storedTask),
      move: vi.fn((input: { taskId: string; targetSwimlaneId: string; targetPosition: number }) => {
        storedTask = { ...storedTask, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
      }),
      update: vi.fn((patch: Partial<MockTask> & { id: string }) => {
        storedTask = { ...storedTask, ...patch };
      }),
      archive: vi.fn(),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => ({
        'lane-doing': doingLane,
        'lane-review': reviewLane,
      }[id] ?? null)),
    };
    const actionsRepo = { getTransitionsFor: vi.fn(() => []) };
    const attachmentRepo = { add: vi.fn(), deleteByTaskId: vi.fn(), listForTask: vi.fn(() => []) };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: actionsRepo,
      attachments: attachmentRepo,
    });

    mockCreateTransitionEngine.mockReturnValue({
      executeTransition: vi.fn(async () => {}),
      resumeSuspendedSession: vi.fn(async () => {}),
    });

    context = createMockContext();
    registerTaskMoveHandlers(context as never);
  });

  it('suspends running session in Phase 1 then calls spawnAgent in Phase 3 (handoff)', async () => {
    // Simulate agent change: claude (running) -> codex (target lane)
    resolveTargetAgentMock.mockReturnValueOnce({ agent: 'codex', isHandoff: true });

    await handleTaskMove(context as never, {
      taskId: 'task-3a',
      targetSwimlaneId: 'lane-review',
      targetPosition: 0,
    });

    // Phase 1 must have suspended the old session.
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-running');

    // Phase 2 must have run ensureTaskWorktree.
    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);

    // Phase 3 must have spawned a new agent session.
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);

    // Verify the spawned call targets the correct lane (lane-review).
    const spawnCall = mockSpawnAgent.mock.calls[0][0] as { toLane: MockSwimlane };
    expect(spawnCall.toLane).toMatchObject({ id: 'lane-review' });
  });

  it('skips spawn in Phase 3 when another handler sets session_id during Phase 2 (handoff CAS)', async () => {
    resolveTargetAgentMock.mockReturnValueOnce({ agent: 'codex', isHandoff: true });

    const { phase2Entered, release } = (() => {
      let releaseFn!: () => void;
      let signalFn!: () => void;
      const hold = new Promise<void>((resolve) => { releaseFn = resolve; });
      const entered = new Promise<void>((resolve) => { signalFn = resolve; });
      mockEnsureTaskWorktree.mockImplementation(async () => {
        signalFn();
        await hold;
      });
      return { phase2Entered: entered, release: releaseFn };
    })();

    const movePromise = handleTaskMove(context as never, {
      taskId: 'task-3a',
      targetSwimlaneId: 'lane-review',
      targetPosition: 0,
    });

    await phase2Entered;

    // Simulate a concurrent spawn that already wrote session_id during our gap.
    storedTask = { ...storedTask, session_id: 'sess-concurrent' };

    release();
    await movePromise;

    // Phase 3 CAS check must bail: session_id already set -> no duplicate spawn.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test suite: TASK_MOVE AbortError cleanup
// ---------------------------------------------------------------------------

describe('TASK_MOVE AbortError cleanup', () => {
  let context: ReturnType<typeof createMockContext>;
  let doingLane: MockSwimlane;
  let task: MockTask;
  let storedTask: MockTask;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    doingLane = createMockSwimlane('lane-doing', { auto_spawn: true });
    task = createMockTask('task-abort', { swimlane_id: 'lane-todo' });
    storedTask = { ...task };

    const taskRepo = {
      getById: vi.fn(() => storedTask),
      move: vi.fn((input: { taskId: string; targetSwimlaneId: string; targetPosition: number }) => {
        storedTask = { ...storedTask, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
      }),
      update: vi.fn((patch: Partial<MockTask> & { id: string }) => {
        storedTask = { ...storedTask, ...patch };
      }),
      archive: vi.fn(),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => ({ 'lane-doing': doingLane, 'lane-todo': createMockSwimlane('lane-todo', { role: 'todo' }) }[id] ?? null)),
    };
    const actionsRepo = { getTransitionsFor: vi.fn(() => []) };
    const attachmentRepo = { add: vi.fn(), deleteByTaskId: vi.fn(), listForTask: vi.fn(() => []) };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: actionsRepo,
      attachments: attachmentRepo,
    });

    mockCreateTransitionEngine.mockReturnValue({
      executeTransition: vi.fn(async () => {}),
      resumeSuspendedSession: vi.fn(async () => {}),
    });

    context = createMockContext();
    registerTaskMoveHandlers(context as never);
  });

  it('fires clearSpawnProgress, removes session, nulls session_id, and returns (not throws) on AbortError mid-Phase-2', async () => {
    // Hold Phase 2 so we can inject an AbortError from inside ensureTaskWorktree.
    let triggerAbort!: () => void;
    let signalEntered!: () => void;
    const phase2Entered = new Promise<void>((resolve) => { signalEntered = resolve; });

    mockEnsureTaskWorktree.mockImplementation(async (_ctx: unknown, _task: unknown, _tasks: unknown, _path: unknown, _opts: unknown) => {
      signalEntered();
      // DOMException with name 'AbortError' is what isAbortError() checks for.
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    // Launch a first move and wait for it to reach Phase 2.
    const firstMovePromise = handleTaskMove(context as never, {
      taskId: 'task-abort',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 0,
    });

    await phase2Entered;

    // A second move for the same task aborts the first's controller.
    // The second move will also enter Phase 2 and throw AbortError - that's fine,
    // we only care that the first move's cleanup ran correctly.
    const secondMovePromise = handleTaskMove(context as never, {
      taskId: 'task-abort',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 1,
    });

    // Neither move should throw - AbortError is caught and returns void.
    await expect(firstMovePromise).resolves.toBeUndefined();
    // Let the second move settle too.
    await secondMovePromise.catch(() => {});

    // clearSpawnProgress must have been called for the aborted move's task.
    const clearSpawnProgressMock = vi.mocked(clearSpawnProgress);
    expect(clearSpawnProgressMock).toHaveBeenCalled();
    const taskIdArg = clearSpawnProgressMock.mock.calls.find(
      (callArgs) => callArgs[1] === 'task-abort',
    );
    expect(taskIdArg).toBeDefined();

    // removeByTaskId must have been called inside the locked micro-step cleanup.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith('task-abort');

    // session_id must have been nulled in the locked micro-step.
    // The tasks.update mock lives on the taskRepo object returned by mockGetProjectRepos.
    const lastRepos = mockGetProjectRepos.mock.results.at(-1)?.value as { tasks: { update: MockInstance } };
    expect(lastRepos?.tasks.update).toHaveBeenCalledWith({ id: 'task-abort', session_id: null });
  });
});

// ---------------------------------------------------------------------------
// Test suite: SESSION_RESUME AbortError cleanup
// ---------------------------------------------------------------------------

describe('SESSION_RESUME AbortError cleanup', () => {
  let context: ReturnType<typeof createMockContext>;
  let doingLane: MockSwimlane;
  let task: MockTask;
  let storedTask: MockTask;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    doingLane = createMockSwimlane('lane-doing', { auto_spawn: true });
    task = createMockTask('task-resume-abort', { swimlane_id: 'lane-doing', session_id: null });
    storedTask = { ...task };

    const taskRepo = {
      getById: vi.fn(() => storedTask),
      update: vi.fn((patch: Partial<MockTask> & { id: string }) => {
        storedTask = { ...storedTask, ...patch };
      }),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => ({ 'lane-doing': doingLane }[id] ?? null)),
    };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    mockCreateTransitionEngine.mockReturnValue({
      resumeSuspendedSession: vi.fn(async () => {}),
    });

    context = createMockContext();
    context.sessionManager.getSession.mockImplementation((id: string) => ({ id, taskId: 'task-resume-abort' }));

    registerSessionHandlers(context as never);
  });

  it('returns null, removes session, and nulls session_id on AbortError mid-Phase-2', async () => {
    const handler = capturedHandlers.get(IPC.SESSION_RESUME);
    if (!handler) throw new Error('SESSION_RESUME handler not registered');

    let signalEntered!: () => void;
    const phase2Entered = new Promise<void>((resolve) => { signalEntered = resolve; });

    mockEnsureTaskWorktree.mockImplementation(async (_ctx: unknown, _task: unknown, _tasks: unknown, _path: unknown, _opts: unknown) => {
      signalEntered();
      // DOMException with name 'AbortError' is what isAbortError() checks for.
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const firstResumePromise = handler(null, 'task-resume-abort') as Promise<unknown>;

    await phase2Entered;

    // Result must be null - AbortError is swallowed and null returned.
    const result = await firstResumePromise;
    expect(result).toBeNull();

    // removeByTaskId must be called inside the locked micro-step.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith('task-resume-abort');

    // session_id must have been nulled.
    const lastRepos = mockGetProjectRepos.mock.results.at(-1)?.value as { tasks: { update: MockInstance } };
    expect(lastRepos?.tasks.update).toHaveBeenCalledWith({ id: 'task-resume-abort', session_id: null });
  });
});

// ---------------------------------------------------------------------------
// Test suite: TASK_MOVE Phase 2 error path revert
// ---------------------------------------------------------------------------

describe('TASK_MOVE Phase 2 worktree error - revert locked micro-step', () => {
  let context: ReturnType<typeof createMockContext>;
  let doingLane: MockSwimlane;
  let todoLane: MockSwimlane;
  let task: MockTask;
  let storedTask: MockTask;
  let taskRepoMock: { getById: MockInstance; move: MockInstance; update: MockInstance; archive: MockInstance };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    doingLane = createMockSwimlane('lane-doing', { auto_spawn: true });
    todoLane = createMockSwimlane('lane-todo', { role: 'todo' });
    task = createMockTask('task-revert', { swimlane_id: 'lane-todo', position: 2 });
    storedTask = { ...task };

    taskRepoMock = {
      getById: vi.fn(() => storedTask),
      move: vi.fn((input: { taskId: string; targetSwimlaneId: string; targetPosition: number }) => {
        storedTask = { ...storedTask, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
      }),
      update: vi.fn((patch: Partial<MockTask> & { id: string }) => {
        storedTask = { ...storedTask, ...patch };
      }),
      archive: vi.fn(),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => ({ 'lane-doing': doingLane, 'lane-todo': todoLane }[id] ?? null)),
    };
    const actionsRepo = { getTransitionsFor: vi.fn(() => []) };
    const attachmentRepo = { add: vi.fn(), deleteByTaskId: vi.fn(), listForTask: vi.fn(() => []) };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepoMock,
      swimlanes: swimlaneRepo,
      actions: actionsRepo,
      attachments: attachmentRepo,
    });

    mockCreateTransitionEngine.mockReturnValue({
      executeTransition: vi.fn(async () => {}),
      resumeSuspendedSession: vi.fn(async () => {}),
    });

    context = createMockContext();
    registerTaskMoveHandlers(context as never);
  });

  it('reverts task to original column and re-throws wrapped error when ensureTaskWorktree fails', async () => {
    // Simulate a non-abort worktree failure (e.g. git branch already exists).
    mockEnsureTaskWorktree.mockRejectedValueOnce(new Error('branch already exists'));

    await expect(
      handleTaskMove(context as never, {
        taskId: 'task-revert',
        targetSwimlaneId: 'lane-doing',
        targetPosition: 0,
      }),
    ).rejects.toThrow('Worktree setup failed: branch already exists');

    // Forward move ran: task went to lane-doing.
    // Revert move must have called tasks.move with original args.
    const moveCalls = taskRepoMock.move.mock.calls as Array<[{ taskId: string; targetSwimlaneId: string; targetPosition: number }]>;
    const revertCall = moveCalls.find(
      ([callArgs]) => callArgs.targetSwimlaneId === 'lane-todo' && callArgs.targetPosition === 2,
    );
    expect(revertCall).toBeDefined();

    // The revert must restore the task back to the original position in To Do.
    expect(revertCall?.[0]).toMatchObject({
      taskId: 'task-revert',
      targetSwimlaneId: 'lane-todo',
      targetPosition: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Test suite: SESSION_RESUME Phase 3 dedup
// ---------------------------------------------------------------------------

describe('SESSION_RESUME split-lock dedup', () => {
  let context: ReturnType<typeof createMockContext>;
  let doingLane: MockSwimlane;
  let task: MockTask;
  let storedTask: MockTask;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    doingLane = createMockSwimlane('lane-doing', { auto_spawn: true });
    // Suspended task: has no session_id, is in a non-todo lane.
    task = createMockTask('task-2', { swimlane_id: 'lane-doing', session_id: null });
    storedTask = { ...task };

    const taskRepo = {
      getById: vi.fn(() => storedTask),
      update: vi.fn((patch: Partial<MockTask> & { id: string }) => {
        storedTask = { ...storedTask, ...patch };
      }),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => ({ 'lane-doing': doingLane }[id] ?? null)),
    };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    mockCreateTransitionEngine.mockReturnValue({
      resumeSuspendedSession: vi.fn(async () => {
        // Simulate the engine setting session_id on the task
        storedTask = { ...storedTask, session_id: 'sess-fresh' };
      }),
    });

    context = createMockContext();
    context.sessionManager.getSession.mockImplementation((id: string) => ({ id, taskId: 'task-2' }));

    registerSessionHandlers(context as never);
  });

  it('returns existing session (not a duplicate) when another handler wrote session_id during Phase 2', async () => {
    const handler = capturedHandlers.get(IPC.SESSION_RESUME);
    if (!handler) throw new Error('SESSION_RESUME handler not registered');

    // Hold Phase 2 until we simulate another handler's spawn completing. The
    // phase2Entered deferred gives a deterministic signal that we're inside
    // ensureTaskWorktree - no reliance on microtask scheduling.
    let release!: () => void;
    let signalEntered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const phase2Entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    mockEnsureTaskWorktree.mockImplementation(async () => {
      signalEntered();
      await hold;
    });

    const resumePromise = handler(null, 'task-2');

    await phase2Entered;

    // Simulate a concurrent spawn (e.g. from TASK_MOVE handoff) that wrote
    // session_id during our Phase 2 gap.
    storedTask = { ...storedTask, session_id: 'sess-other' };

    release();
    const result = await resumePromise;

    // Phase 3 bails out BEFORE building the transition engine or calling
    // resumeSuspendedSession - returning the existing session instead of
    // spawning a duplicate.
    expect(mockCreateTransitionEngine).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'sess-other' });
  });
});
