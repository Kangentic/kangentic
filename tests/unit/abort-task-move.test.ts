/**
 * Unit tests for abortTaskMove (src/main/ipc/handlers/task-move.ts).
 *
 * `abortTaskMove(taskId)` is a thin seam exported alongside `handleTaskMove`:
 *   - Returns false when no AbortController is registered for the taskId.
 *   - Returns true (and calls .abort() on the controller) when one is registered.
 *
 * The `taskMoveControllers` map is module-private and is only populated by a
 * running `handleTaskMove`. The false-path (no controller) can be verified
 * directly. The true-path is covered here by starting a `handleTaskMove` call
 * that parks at the Phase 2 `ensureTaskWorktree` step (behind a controlled
 * promise), calling `abortTaskMove` while it is still in-flight, and verifying
 * the return value is `true` and the in-flight call resolves without error (the
 * AbortError path in handleTaskMove is the standard abort rollback path tested
 * elsewhere -- we only assert the return value here, not the rollback).
 *
 * All mocks mirror task-move-shutdown.test.ts and task-move-rollback.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
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
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => true);
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
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

// Phase 2 helper - configurable per test
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: vi.fn(() => ({})),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

const mockGetProjectRepos = vi.fn();

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { abortTaskMove, handleTaskMove } from '../../src/main/ipc/handlers/task-move';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-abort-0001',
    display_id: 1,
    title: 'Abort Test Task',
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

function makeContext(overrides: Record<string, unknown> = {}) {
  const context = {
    currentProjectId: 'proj-abort-test',
    currentProjectPath: '/mock/abort-test-project',
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
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: {
      cancel: vi.fn(),
      scheduleKeystrokes: vi.fn(),
    },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-abort-test', default_agent: 'claude' })) },
    ...overrides,
  };
  return context;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('abortTaskMove', () => {
  const TASK_ID = 'task-abort-0001';
  const SOURCE_LANE_ID = 'lane-todo';
  const TARGET_LANE_ID = 'lane-doing';

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTaskWorktree.mockReset();
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockReset();
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockReset();
    mockSpawnAgent.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // False-path: no controller registered
  // The function must return false immediately when no AbortController exists
  // for the given taskId. This guards against stale Cancel buttons calling
  // cancelSpawn on a task that has no in-flight move (e.g. after a completed spawn).
  // -------------------------------------------------------------------------
  it('returns false when no in-flight move is registered for the taskId', () => {
    // A taskId that has never had handleTaskMove called for it in this test run.
    const result = abortTaskMove('task-id-with-no-controller');

    expect(result).toBe(false);
  });

  it('returns false for an empty string taskId', () => {
    const result = abortTaskMove('');

    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // True-path: controller registered by a running handleTaskMove
  // Start a handleTaskMove that parks at Phase 2. While it is parked,
  // abortTaskMove must return true and resolve the in-flight call.
  // -------------------------------------------------------------------------
  it('returns true and aborts the in-flight move when a controller is registered', async () => {
    const task = makeTask({ id: TASK_ID, swimlane_id: SOURCE_LANE_ID, session_id: null });
    const sourceLane = makeSwimlane(SOURCE_LANE_ID, { role: 'todo' });
    const targetLane = makeSwimlane(TARGET_LANE_ID, { role: null, auto_spawn: true });

    const taskRepo = {
      getById: vi.fn(() => ({ ...task })),
      move: vi.fn(),
      update: vi.fn(),
      list: vi.fn(() => [{ ...task }]),
      archive: vi.fn(),
    };
    const swimlaneRepo = {
      getById: vi.fn((id: string) => {
        if (id === SOURCE_LANE_ID) return sourceLane;
        if (id === TARGET_LANE_ID) return targetLane;
        return null;
      }),
      list: vi.fn(() => [sourceLane, targetLane]),
    };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { deleteByTaskId: vi.fn() },
    });

    // Park Phase 2 behind a controlled promise so the handleTaskMove call stays
    // in-flight long enough for us to call abortTaskMove.
    let unblockPhase2: () => void;
    const phase2Block = new Promise<void>((resolve) => { unblockPhase2 = resolve; });
    mockEnsureTaskWorktree.mockImplementation(async () => {
      await phase2Block;
      return null;
    });

    const context = makeContext();
    const moveInput = { taskId: TASK_ID, targetSwimlaneId: TARGET_LANE_ID, targetPosition: 0 };

    // Start the move but do not await yet - it is parked at Phase 2.
    const movePromise = handleTaskMove(context as never, moveInput, 'renderer');

    // Yield so Phase 1 (sync lock body) can run and register the controller.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Now the controller is in the map - abortTaskMove should return true.
    const aborted = abortTaskMove(TASK_ID);
    expect(aborted).toBe(true);

    // Unblock Phase 2 so the aborted move can settle (it will take the AbortError path).
    unblockPhase2!();

    // The move promise should resolve (not reject) - the abort path swallows the error.
    await expect(movePromise).resolves.toBeUndefined();
  });
});
