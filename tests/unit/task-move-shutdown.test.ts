/**
 * Unit tests for shutdown-race protection in handleTaskMove and the
 * TASK_MOVE IPC handler registration (src/main/ipc/handlers/task-move.ts).
 *
 * The synchronous before-quit handler closes SQLite while async work in
 * Phase 2 / Phase 3 is in flight. Without these guards, the resumed
 * Phase 3 calls taskRepo.update -> better-sqlite3 throws "The database
 * connection is not open", and Electron's default ipcMain error reporter
 * logs a noisy stack trace.
 *
 * The fix has three parts (mirrored by these tests):
 *   1. Early-exit between Phase 1 and Phase 2 when isShuttingDown() is true.
 *   2. Early-exit at the top of the Phase 3 lock body.
 *   3. IPC-level try/catch that swallows errors when isShuttingDown() is true.
 *
 * Strategy: invoke handleTaskMove directly (named export). Phase 1 is driven
 * through its happy path so it returns a MoveSpawnPlan. The shutdown flag is
 * mocked via vi.mock('../../src/main/shutdown-state') so each test can set
 * its return value precisely. For Phase 3 entry coverage, the flag flips
 * inside ensureTaskWorktree's mock (a Phase 2 step), so by the time Phase 3
 * acquires the lock, the guard fires. The IPC test exercises the registered
 * handler via the mocked ipcMain.handle capture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import of the module under test)
// ---------------------------------------------------------------------------

// Capture the registered IPC handler so we can invoke it in the IPC swallow test.
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    }),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
  default: vi.fn(() => ({})),
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
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => true);
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

const mockClearSpawnProgress = vi.fn();
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: (...args: unknown[]) => mockClearSpawnProgress(...args),
  createProgressCallback: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

// Shutdown flag mock - controlled per test. vi.hoisted ensures the vi.fn is
// initialized before the vi.mock factory runs (vi.mock is hoisted to the top
// of the file by vitest's compiler).
const { mockIsShuttingDown } = vi.hoisted(() => ({
  mockIsShuttingDown: vi.fn(() => false),
}));
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: mockIsShuttingDown,
  setShuttingDown: vi.fn(),
}));

// Helpers that drive Phase 2 / Phase 3 - configured per test
const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn(() => ({}));
const mockBuildAutoCommandVars = vi.fn(() => ({}));
const mockCleanupTaskResources = vi.fn(async () => {});
const mockDeleteTaskWorktree = vi.fn(async () => true);

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  buildAutoCommandVars: (...args: unknown[]) => mockBuildAutoCommandVars(...args),
  cleanupTaskResources: (...args: unknown[]) => mockCleanupTaskResources(...args),
  deleteTaskWorktree: (...args: unknown[]) => mockDeleteTaskWorktree(...args),
  autoSpawnForTask: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
// ---------------------------------------------------------------------------

import { handleTaskMove, registerTaskMoveHandlers } from '../../src/main/ipc/handlers/task-move';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helper types and factory functions
// ---------------------------------------------------------------------------

interface MockTaskRepo {
  getById: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
}

interface MockSwimlaneRepo {
  getById: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

interface MockSessionManager {
  removeByTaskId: ReturnType<typeof vi.fn>;
  killByTaskId: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
}

interface MockContext {
  currentProjectId: string;
  currentProjectPath: string;
  mainWindow: {
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  };
  sessionManager: MockSessionManager;
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: { getDefaultBaseBranch: ReturnType<typeof vi.fn> };
  terminalSubmitScheduler: {
    cancel: ReturnType<typeof vi.fn>;
    scheduleKeystrokes: ReturnType<typeof vi.fn>;
  };
  projectRepo: { getById: ReturnType<typeof vi.fn> };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-todo',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
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

function makeSessionManager(): MockSessionManager {
  return {
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => {}),
  };
}

function makeTaskRepo(task: Task): MockTaskRepo {
  return {
    getById: vi.fn(() => ({ ...task })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [{ ...task }]),
    archive: vi.fn(),
  };
}

function makeSwimlaneRepo(lanes: Swimlane[]): MockSwimlaneRepo {
  const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
  return {
    getById: vi.fn((id: string) => laneMap.get(id) ?? null),
    list: vi.fn(() => Array.from(laneMap.values())),
  };
}

function makeContext(
  taskRepo: MockTaskRepo,
  swimlaneRepo: MockSwimlaneRepo,
): MockContext {
  const sessionManager = makeSessionManager();
  const context: MockContext = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager,
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
    },
    terminalSubmitScheduler: {
      cancel: vi.fn(),
      scheduleKeystrokes: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })),
    },
  };

  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn() },
  });

  return context;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SOURCE_LANE_ID = 'lane-todo';
const TARGET_LANE_ID = 'lane-doing';

const MOVE_INPUT = {
  taskId: 'task-aaa00001',
  targetSwimlaneId: TARGET_LANE_ID,
  targetPosition: 0,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('handleTaskMove shutdown protection', () => {
  let sourceLane: Swimlane;
  let targetLane: Swimlane;
  let task: Task;
  let taskRepo: MockTaskRepo;
  let swimlaneRepo: MockSwimlaneRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClearSpawnProgress.mockClear();
    mockIsShuttingDown.mockReturnValue(false);
    ipcHandlers.clear();

    sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: 'todo' });
    targetLane = makeSwimlane(TARGET_LANE_ID, { role: null, auto_spawn: true });

    task = makeTask({
      id: 'task-aaa00001',
      swimlane_id: SOURCE_LANE_ID,
      session_id: null,
    });

    taskRepo = makeTaskRepo(task);
    swimlaneRepo = makeSwimlaneRepo([sourceLane, targetLane]);

    // Default Phase 2 mocks resolve cleanly.
    mockEnsureTaskWorktree.mockReset();
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockReset();
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockReset();
    mockSpawnAgent.mockResolvedValue(undefined);
  });

  // =========================================================================
  // Test 1: Early-exit between Phase 1 and Phase 2 when shutdown is in progress
  //
  // If isShuttingDown() returns true after Phase 1 returns a plan, the handler
  // must skip Phase 2 git work and Phase 3 spawn. Phase 1's DB writes already
  // committed. autoSpawnTasks on next launch will spawn for the new column.
  // =========================================================================

  it('skips Phase 2 and Phase 3 when shutdown started before Phase 2', async () => {
    mockIsShuttingDown.mockImplementation(() => true);

    const context = makeContext(taskRepo, swimlaneRepo);

    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).resolves.toBeUndefined();

    // Phase 1 forward move ran (DB write committed before shutdown checked).
    expect(taskRepo.move).toHaveBeenCalledTimes(1);
    // Phase 2 and Phase 3 helpers must NOT run.
    expect(mockEnsureTaskWorktree).not.toHaveBeenCalled();
    expect(mockEnsureTaskBranchCheckout).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 2: Early-exit inside the Phase 3 lock body when shutdown started during Phase 2
  //
  // If isShuttingDown() flips to true during Phase 2 git work, Phase 3 must
  // bail before calling getProjectRepos / spawnAgent (which would access a
  // closed DB and produce the original "database connection is not open" log).
  // The try/finally must still call clearSpawnProgress to clean the UI.
  // =========================================================================

  it('bails inside Phase 3 lock when shutdown flips during Phase 2', async () => {
    // Flip the flag as a Phase 2 side effect: ensureTaskWorktree resolves
    // (no error) but isShuttingDown() returns true after.
    mockEnsureTaskWorktree.mockImplementation(async () => {
      mockIsShuttingDown.mockReturnValue(true);
      return null;
    });

    const context = makeContext(taskRepo, swimlaneRepo);

    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).resolves.toBeUndefined();

    // Phase 2 ran (it's where the flag flipped).
    expect(mockEnsureTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockEnsureTaskBranchCheckout).toHaveBeenCalledTimes(1);
    // Phase 3 spawn must NOT run.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    // The Phase 3 try/finally still clears spawn progress so the renderer UI
    // doesn't get stuck on "starting agent".
    expect(mockClearSpawnProgress).toHaveBeenCalledWith(
      context.mainWindow,
      task.id,
    );
  });

  // =========================================================================
  // Test 3: IPC handler swallows errors when isShuttingDown() is true
  //
  // Backstop for any future code path that slips a DB write past the early-exit
  // guards. The registered ipcMain.handle wrapper must catch and silently
  // return when isShuttingDown() is true, so Electron's default error reporter
  // doesn't log "Error occurred in handler for 'task:move': ..." on shutdown.
  // =========================================================================

  it('IPC handler swallows errors when shutdown is in progress', async () => {
    const context = makeContext(taskRepo, swimlaneRepo);

    // Force a Phase 2 throw that resembles the real shutdown error.
    mockEnsureTaskWorktree.mockImplementation(async () => {
      mockIsShuttingDown.mockReturnValue(true);
      throw new TypeError('The database connection is not open');
    });

    registerTaskMoveHandlers(context as never);

    const handler = ipcHandlers.get(IPC.TASK_MOVE);
    expect(handler).toBeDefined();

    // Should resolve, not throw - the wrapper catches because isShuttingDown().
    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)({}, MOVE_INPUT),
    ).resolves.toBeUndefined();
  });

  // =========================================================================
  // Test 4: Phase 1 inner-await race (the actual user-reported scenario)
  //
  // The user moved a task with an active session to Done and then closed the
  // app. Phase 1 (Priority 2, target=Done) hits:
  //   markRecordSuspended(...)              // sync OK
  //   await sessionManager.suspend(...)     // awaits while DB closes
  //   tasks.update({ session_id: null })    // throws against closed DB
  // The outer catch at task-move.ts:564 runs and would normally call rollback
  // (which itself touches the closed DB). The shutdown guard at the top of
  // that catch must bail silently so neither the original error nor the
  // rollback error escape.
  // =========================================================================

  it('silences the Phase 1 post-await DB write when shutdown closes the DB mid-suspend', async () => {
    // Task has an active session and target lane is Done.
    const doneLaneId = 'lane-done';
    const doneLane = makeSwimlane(doneLaneId, { role: 'done', auto_spawn: false });
    swimlaneRepo = makeSwimlaneRepo([sourceLane, doneLane]);

    task = makeTask({
      id: 'task-aaa00001',
      swimlane_id: SOURCE_LANE_ID,
      session_id: 'pty-session-active',
    });
    taskRepo = makeTaskRepo(task);

    const context = makeContext(taskRepo, swimlaneRepo);

    // Simulate shutdown firing during sessionManager.suspend(): the await
    // resolves cleanly, but the post-await tasks.update at line 226 hits a
    // closed DB and throws. Phase 1's outer try has only a finally (no
    // catch), so the throw propagates to the IPC wrapper - which is where
    // the swallow lives. We register the handler and invoke it directly to
    // exercise the real production path (handleTaskMove + IPC wrapper).
    context.sessionManager.suspend.mockImplementation(async () => {
      mockIsShuttingDown.mockReturnValue(true);
    });
    taskRepo.update.mockImplementation(() => {
      throw new TypeError('The database connection is not open');
    });

    registerTaskMoveHandlers(context as never);
    const handler = ipcHandlers.get(IPC.TASK_MOVE);
    expect(handler).toBeDefined();

    const moveToDoneInput = {
      taskId: 'task-aaa00001',
      targetSwimlaneId: doneLaneId,
      targetPosition: 0,
    };

    // The IPC wrapper's catch swallows the closed-DB error because
    // isShuttingDown() returns true at that point.
    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)({}, moveToDoneInput),
    ).resolves.toBeUndefined();

    // Phase 1's earlier sync writes ran successfully before the await.
    expect(taskRepo.move).toHaveBeenCalledTimes(1);
    expect(taskRepo.archive).toHaveBeenCalledWith('task-aaa00001');
    // sessionManager.suspend was awaited (the race window).
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('pty-session-active');
    // The post-await tasks.update was attempted (and threw the simulated
    // closed-DB error).
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-aaa00001', session_id: null });
  });

  // =========================================================================
  // Test 5: IPC handler re-throws errors when NOT shutting down
  //
  // The shutdown swallow must not mask real errors during normal operation.
  // When isShuttingDown() is false, errors thrown by handleTaskMove must
  // propagate to Electron's IPC layer like before.
  // =========================================================================

  it('IPC handler re-throws errors when not shutting down', async () => {
    const context = makeContext(taskRepo, swimlaneRepo);

    // Phase 2 throws during normal operation (not shutdown).
    mockEnsureTaskWorktree.mockRejectedValue(new Error('git error: branch locked'));
    mockIsShuttingDown.mockReturnValue(false);

    registerTaskMoveHandlers(context as never);

    const handler = ipcHandlers.get(IPC.TASK_MOVE);
    expect(handler).toBeDefined();

    // Real errors must surface. The outer handler in handleTaskMove wraps
    // worktree errors as 'Worktree setup failed: ...'.
    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)({}, MOVE_INPUT),
    ).rejects.toThrow('Worktree setup failed');
  });
});
