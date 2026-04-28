/**
 * Tests for the idle-timeout listener DB side-effect in registerSessionHandlers.
 *
 * The idle-timeout path was the root-cause of the divergence bug on this branch:
 * `usage-tracker.requestSuspend` flipped the SessionRegistry entry to
 * 'suspended', but the corresponding 'idle-timeout' listener in sessions.ts
 * never wrote the DB counterpart. That left `task.session_id` pointing at a
 * registry entry that was already suspended - SESSION_RESUME would then throw
 * "Task X already has an active session" instead of reconciling and proceeding.
 *
 * The fix adds `applySuspendDbWrites(context, projectId, taskId, 'system')`
 * inside a `withTaskLock(taskId, ...)` block in the 'idle-timeout' listener.
 * These tests verify:
 *
 *   #6 - When projectId is resolvable, the listener:
 *        - sends SESSION_IDLE_TIMEOUT to the renderer
 *        - calls commandInjector.cancel(taskId)
 *        - calls markRecordSuspended with 'system'
 *        - calls tasks.update({ id, session_id: null })
 *
 *   #7 - When projectId is missing (getSessionProjectId returns undefined):
 *        - renderer still receives SESSION_IDLE_TIMEOUT
 *        - withTaskLock is NOT entered (no DB writes, no cancel)
 *
 * Mock strategy mirrors split-lock-cas.test.ts:
 *   - electron and ipcMain are mocked so registerSessionHandlers can be called
 *     without a real Electron process
 *   - sessionManager.on is mocked with a Map to capture event handlers
 *   - withTaskLock from task-lifecycle-lock.ts is the REAL implementation so
 *     the lock semantics are testable
 *   - DB helpers, repositories, and session-lifecycle functions are mocked
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, SessionRecord } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

const capturedIpcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedIpcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

// SessionRepository mock: getLatestForTask is driven by mockGetLatestForTask
// which is set per-test in beforeEach. All other methods are stubs.
const mockGetLatestForTask = vi.fn(() => null as SessionRecord | null);

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = mockGetLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
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

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    removeWorktree = vi.fn(async () => {});
    pruneWorktrees = vi.fn(async () => {});
    removeBranch = vi.fn(async () => {});
    static scheduleBackgroundPrune = vi.fn();
  },
}));

// getProjectRepos is configured per-test.
const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => {}),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  buildAutoCommandVars: vi.fn(() => ({})),
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';
import { markRecordSuspended } from '../../src/main/engine/session-lifecycle';

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => [] as Session[]),
      getSession: vi.fn(() => null),
      getSessionTaskId: vi.fn(() => null),
      getSessionProjectId: vi.fn(() => null as string | null | undefined),
      killByTaskId: vi.fn(),
      removeByTaskId: vi.fn(),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      getActivityCache: vi.fn(() => ({})),
      getActivityCacheForProject: vi.fn(() => ({})),
      getUsageCache: vi.fn(() => ({})),
      getUsageCacheForProject: vi.fn(() => ({})),
      getEventsCache: vi.fn(() => ({})),
      getEventsCacheForProject: vi.fn(() => ({})),
      getEventsForSession: vi.fn(() => []),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      setFocusedSessions: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
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
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

/**
 * Drain the withTaskLock PQueue by polling until a condition is met or a
 * maximum number of microtask ticks have been consumed. PQueue uses microtasks
 * internally so repeated `await Promise.resolve()` yields to pending work.
 */
async function drainUntil(
  condition: () => boolean,
  maxTicks = 50,
): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (condition()) return;
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// #6 - idle-timeout listener fires DB writes when projectId is present
// ---------------------------------------------------------------------------

describe('idle-timeout listener - DB side-effect when projectId is present', () => {
  let context: ReturnType<typeof createMockContext>;
  let taskUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();

    taskUpdate = vi.fn();

    // Task repo: getById returns a task with a live session_id.
    const taskRepo = {
      getById: vi.fn(() => ({
        id: 'task-idle',
        session_id: 'sess-idle',
        title: 'Idle task',
        swimlane_id: 'lane-doing',
        position: 0,
        worktree_path: null,
        session_type: null,
        branch_name: null,
        base_branch: null,
        agent: 'claude',
      })),
      update: taskUpdate,
    };

    // SessionRepository.getLatestForTask returns a running record with
    // agent_session_id set so decideSuspendDbAction returns 'suspend'.
    mockGetLatestForTask.mockReturnValue({
      id: 'record-idle',
      task_id: 'task-idle',
      session_type: 'agent',
      agent_session_id: 'agent-idle',
      command: 'claude',
      cwd: '/tmp',
      permission_mode: null,
      prompt: null,
      status: 'running',
      exit_code: null,
      started_at: new Date().toISOString(),
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
      total_cost_usd: null,
      total_input_tokens: null,
      total_output_tokens: null,
      model_id: null,
      model_display_name: null,
      total_duration_ms: null,
    } as SessionRecord);

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    context = createMockContext();
    context.sessionManager.getSessionProjectId.mockReturnValue('proj-1');
    registerSessionHandlers(context as never);
  });

  it('sends SESSION_IDLE_TIMEOUT to renderer, cancels command, marks record suspended, and clears session_id', async () => {
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    // Fire the idle-timeout event. The handler schedules async DB work via
    // withTaskLock (which enqueues via PQueue). We drain the queue by polling.
    idleTimeoutHandler('sess-idle', 'task-idle', 5);

    // Wait for commandInjector.cancel to be called - this is the first
    // observable side-effect inside the locked block, confirming the lock ran.
    await drainUntil(() => context.commandInjector.cancel.mock.calls.length > 0);

    // Renderer must be notified regardless of projectId presence.
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-idle',
      'task-idle',
      5,
      'proj-1',
    );

    // commandInjector.cancel is the first action inside the locked block.
    expect(context.commandInjector.cancel).toHaveBeenCalledWith('task-idle');

    // markRecordSuspended must be called with 'system' as the suspendedBy source.
    expect(vi.mocked(markRecordSuspended)).toHaveBeenCalledWith(
      expect.anything(), // SessionRepository instance
      'record-idle',
      'system',
    );

    // tasks.update must clear session_id.
    expect(taskUpdate).toHaveBeenCalledWith({ id: 'task-idle', session_id: null });
  });
});

// ---------------------------------------------------------------------------
// #7 - idle-timeout listener skips DB writes when projectId is missing
// ---------------------------------------------------------------------------

describe('idle-timeout listener - early exit when projectId is missing', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });

    context = createMockContext();
    // getSessionProjectId returns undefined -> no projectId -> early return
    context.sessionManager.getSessionProjectId.mockReturnValue(undefined);
    registerSessionHandlers(context as never);
  });

  it('sends SESSION_IDLE_TIMEOUT to renderer but does NOT enter the lock or write the DB', async () => {
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-orphan', 'task-orphan', 10);

    // Intentional fixed wait - we cannot poll for non-occurrence. Give the
    // event loop enough time to process any inadvertently scheduled microtasks.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Renderer must still be notified (IPC send happens before the projectId
    // guard, so it fires unconditionally as long as the window is not destroyed).
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_IDLE_TIMEOUT,
      'sess-orphan',
      'task-orphan',
      10,
      undefined,
    );

    // commandInjector.cancel is only called inside withTaskLock, which is
    // guarded by `if (!projectId) return;`. Must NOT have been called.
    expect(context.commandInjector.cancel).not.toHaveBeenCalled();

    // markRecordSuspended must NOT have been called.
    expect(vi.mocked(markRecordSuspended)).not.toHaveBeenCalled();

    // getProjectRepos must NOT have been called (applySuspendDbWrites skipped).
    expect(mockGetProjectRepos).not.toHaveBeenCalled();
  });
});
