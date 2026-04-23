/**
 * Unit tests for the outer-catch rollback path in handleTaskMove
 * (src/main/ipc/handlers/task-move.ts, lines 476-511).
 *
 * The rollback path runs when Phase 2 (worktree / branch checkout) or Phase 3
 * (spawn) throws a non-abort error. It must:
 *   1. Call sessionManager.removeByTaskId to discard any partially-spawned PTY.
 *   2. Clear task.session_id from the DB when a partial session row exists.
 *   3. Revert task.swimlane_id to the source column via tasks.move -- but ONLY
 *      when the task is still in the destination column (CAS guard).
 *   4. Skip the move revert when isAbortError(error) is true (a concurrent move
 *      superseded this one -- don't clobber the newer placement).
 *   5. Exit early without crashing when tasks.getById returns null (task was
 *      deleted mid-flight).
 *   6. Surface the original error to the caller even when the rollback's inner
 *      tasks.move itself throws.
 *
 * Strategy: invoke handleTaskMove directly (it is a named export). Phase 1 is
 * driven through its happy path so it always returns a MoveSpawnPlan. To make
 * Phase 1 succeed, tasks.getById must return a task with session_id=null on
 * the first call (Phase 1 re-read). Then mockEnsureTaskWorktree is made to
 * throw, which triggers the outer catch (Phase 2 failure path). The rollback
 * call to tasks.getById (inside the outer catch's withTaskLock) is the SECOND
 * call and can return whatever the test needs.
 *
 * All mocks follow task-archive-handler.test.ts: top-level vi.mock() stubs for
 * every module imported by task-move.ts, then per-test overrides. The real
 * task-lifecycle-lock (PQueue concurrency:1) is used so serialization semantics
 * are observable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import of the module under test)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
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

vi.mock('../../src/main/engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/engine/agent-resolver', () => ({
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

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';

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
  commandInjector: {
    cancel: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
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

/**
 * Build a minimal task repo that serves Phase 1 correctly:
 *  - getById(phase1Call=true): returns the task with session_id=null so Phase 1
 *    always produces a MoveSpawnPlan (not the Priority 3 active-session path).
 *  - move: tracks calls; a custom implementation can be supplied via the
 *    `moveImpl` override.
 *  - update: no-op by default.
 *
 * Each test that needs rollback getById to return a specific value should
 * configure `getById` after calling this factory (using mockReturnValueOnce
 * for Phase 1 and mockReturnValueOnce again for the rollback call).
 */
function makeTaskRepo(task: Task): MockTaskRepo {
  return {
    // By default return the task. Individual tests override this with
    // mockReturnValueOnce for different Phase 1 vs rollback return values.
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
    commandInjector: {
      cancel: vi.fn(),
      schedule: vi.fn(),
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

/** Move input that reaches Phase 2 when Phase 1 returns a MoveSpawnPlan. */
const MOVE_INPUT = {
  taskId: 'task-aaa00001',
  targetSwimlaneId: TARGET_LANE_ID,
  targetPosition: 0,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('handleTaskMove outer-catch rollback', () => {
  let sourceLane: Swimlane;
  let targetLane: Swimlane;
  let task: Task;
  let taskRepo: MockTaskRepo;
  let swimlaneRepo: MockSwimlaneRepo;

  beforeEach(() => {
    vi.clearAllMocks();

    // Source: role=todo. Phase 1 skips suspend (task has no active session).
    sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: 'todo' });
    // Target: auto_spawn=true, not todo/done so Phase 1 returns a plan.
    targetLane = makeSwimlane(TARGET_LANE_ID, { role: null, auto_spawn: true });

    // Task starts in source lane with no active session. Phase 1 reads this
    // and returns a MoveSpawnPlan (Priority 4: no active session, auto_spawn).
    task = makeTask({
      id: 'task-aaa00001',
      swimlane_id: SOURCE_LANE_ID,
      session_id: null,
    });

    taskRepo = makeTaskRepo(task);
    swimlaneRepo = makeSwimlaneRepo([sourceLane, targetLane]);

    // Default: Phase 2 throws a plain error (not AbortError) to trigger the
    // outer catch. Individual tests can override this.
    mockEnsureTaskWorktree.mockRejectedValue(new Error('git error: branch locked'));
  });

  // =========================================================================
  // Test 1: CAS guard correctly skips column revert when a concurrent move won
  //
  // If by the time rollback runs the task has already been moved to a third
  // column by a concurrent handler, `current.swimlane_id !== targetSwimlaneId`
  // so tasks.move must NOT be called for the revert.
  // =========================================================================

  it('skips column revert when swimlane_id no longer matches the destination', async () => {
    const concurrentLaneId = 'lane-review';

    // Phase 1 call: returns task with session_id=null (standard plan path).
    // Rollback call: task is now in the concurrent lane (concurrent handler won).
    taskRepo.getById
      .mockReturnValueOnce({ ...task, swimlane_id: SOURCE_LANE_ID, session_id: null })
      .mockReturnValueOnce({ ...task, swimlane_id: concurrentLaneId, session_id: null });

    const context = makeContext(taskRepo, swimlaneRepo);

    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).rejects.toThrow('Worktree setup failed');

    // removeByTaskId must run regardless (cleans up any partial PTY).
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(task.id);
    // session_id is null so update must NOT be called.
    expect(taskRepo.update).not.toHaveBeenCalled();
    // tasks.move called exactly once: the Phase 1 forward move.
    // Rollback must NOT add a second call (CAS guard blocked it).
    expect(taskRepo.move).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Test 2: Abort path cleans up session but skips the column revert
  //
  // When isAbortError(error) is true a newer move superseded this one. The
  // rollback must still remove the partial PTY session and clear session_id,
  // but must NOT call tasks.move (which would clobber the newer placement).
  // The handler returns undefined rather than re-throwing.
  // =========================================================================

  it('cleans up partial session but skips column revert on abort error', async () => {
    // Abort the signal used internally by handleTaskMove by creating a
    // pre-aborted controller and throwing its reason as the Phase 2 error.
    const abortController = new AbortController();
    abortController.abort();
    // DOMException with name 'AbortError' is what AbortSignal.throwIfAborted()
    // and AbortController.abort() produce. isAbortError() checks this shape.
    const abortError = abortController.signal.reason as DOMException;
    mockEnsureTaskWorktree.mockRejectedValue(abortError);

    const partialSessionId = 'partial-session-abort';

    // Phase 1 call: session_id=null so Phase 1 returns a plan.
    // Rollback call: a partial session_id was written before the abort fired.
    taskRepo.getById
      .mockReturnValueOnce({ ...task, swimlane_id: SOURCE_LANE_ID, session_id: null })
      .mockReturnValueOnce({ ...task, swimlane_id: TARGET_LANE_ID, session_id: partialSessionId });

    const context = makeContext(taskRepo, swimlaneRepo);

    // Abort errors are swallowed - the handler returns undefined.
    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).resolves.toBeUndefined();

    // PTY map cleanup must still run on abort.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(task.id);
    // DB row must be cleared because current.session_id was non-null.
    expect(taskRepo.update).toHaveBeenCalledWith({ id: task.id, session_id: null });
    // tasks.move called once only (Phase 1 forward). Rollback skips the revert
    // on abort to avoid clobbering the superseding move's column placement.
    expect(taskRepo.move).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Test 3: Task deleted mid-flight - rollback exits early without crashing
  //
  // If tasks.getById returns null inside the rollback block, the inner guard
  // `if (!current) return` must fire. The handler must still surface the
  // original Phase 2 error (not crash with a null dereference).
  // =========================================================================

  it('exits rollback early when task is deleted mid-flight without secondary throw', async () => {
    // Phase 1 call: task exists with no session.
    // Rollback call: task was deleted (getById returns null).
    taskRepo.getById
      .mockReturnValueOnce({ ...task, swimlane_id: SOURCE_LANE_ID, session_id: null })
      .mockReturnValueOnce(null);

    const context = makeContext(taskRepo, swimlaneRepo);

    // Original Phase 2 error must surface (wrapped by the inner worktree catch).
    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).rejects.toThrow('Worktree setup failed');

    // removeByTaskId runs before the getById check.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(task.id);
    // No update or additional move calls after early return.
    expect(taskRepo.update).not.toHaveBeenCalled();
    // Phase 1 forward move only. Rollback bailed before move.
    expect(taskRepo.move).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Test 4: Session cleanup runs removeByTaskId AND clears session_id
  //
  // When a partial session_id exists on the task row at rollback time, both
  // sessionManager.removeByTaskId and tasks.update({ session_id: null }) must
  // be called. The column revert also runs (task is still in target lane).
  // =========================================================================

  it('calls removeByTaskId and clears session_id when a partial session row exists', async () => {
    const partialSessionId = 'session-partial-001';

    // Phase 1 call: no session (so Phase 1 returns a plan).
    // Rollback call: partial session was written before Phase 2 threw.
    taskRepo.getById
      .mockReturnValueOnce({ ...task, swimlane_id: SOURCE_LANE_ID, session_id: null })
      .mockReturnValueOnce({ ...task, swimlane_id: TARGET_LANE_ID, session_id: partialSessionId });

    const context = makeContext(taskRepo, swimlaneRepo);

    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).rejects.toThrow('Worktree setup failed');

    // PTY map cleanup.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(task.id);
    // DB row session_id cleared.
    expect(taskRepo.update).toHaveBeenCalledWith({ id: task.id, session_id: null });
    // Column revert: Phase 1 forward + rollback reverse = 2 calls.
    expect(taskRepo.move).toHaveBeenCalledTimes(2);
    const rollbackMoveArg = taskRepo.move.mock.calls[1][0];
    expect(rollbackMoveArg).toMatchObject({
      taskId: task.id,
      targetSwimlaneId: SOURCE_LANE_ID,
      targetPosition: task.position,
    });
  });

  // =========================================================================
  // Test 5: Rollback inner error does not suppress the original Phase 2 error
  //
  // If tasks.move throws inside the rollback block, the inner catch logs the
  // rollback error but must NOT replace the original error. The caller must
  // receive the original Phase 2 error ('Worktree setup failed'), not the
  // rollback error ('rollback move failed: DB locked').
  // =========================================================================

  it('surfaces the original Phase 2 error even when rollback tasks.move throws', async () => {
    const rollbackMoveError = new Error('rollback move failed: DB locked');

    // Phase 1 call: task in source with no session.
    // Rollback call: task still in target lane, no session.
    taskRepo.getById
      .mockReturnValueOnce({ ...task, swimlane_id: SOURCE_LANE_ID, session_id: null })
      .mockReturnValueOnce({ ...task, swimlane_id: TARGET_LANE_ID, session_id: null });

    // Phase 1 forward move succeeds; rollback reverse move throws.
    taskRepo.move
      .mockImplementationOnce(() => {}) // Phase 1 forward move
      .mockImplementationOnce(() => {
        throw rollbackMoveError;
      }); // rollback reverse move

    const context = makeContext(taskRepo, swimlaneRepo);

    // Must throw the ORIGINAL error ('Worktree setup failed'), not the
    // rollback error ('rollback move failed: DB locked').
    await expect(
      handleTaskMove(context as never, MOVE_INPUT),
    ).rejects.toThrow('Worktree setup failed');

    // removeByTaskId ran before the failing move.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith(task.id);
    // Both move calls were attempted.
    expect(taskRepo.move).toHaveBeenCalledTimes(2);
  });
});
