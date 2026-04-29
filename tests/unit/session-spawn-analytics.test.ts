/**
 * Tests for the `sessionSpawnAnalyticsFired` fire-once and cleanup-on-exit
 * invariants in registerSessionHandlers.
 *
 * The `sessionSpawnAnalyticsFired` Set in sessions.ts prevents double-firing
 * `session_spawn` when `session-changed` re-emits a `running` status for a
 * session that is already known (e.g. a restart or status reconciliation loop).
 * The Set entry is deleted when `exit` fires so that a re-spawned session with
 * the same id can fire analytics again.
 *
 * Tests:
 *
 *   #1 - Fire-once: `session_spawn` is emitted only on the FIRST `running`
 *        transition for a given session id. A second `session-changed` with
 *        status=`running` for the same id must NOT call `trackEvent` again.
 *
 *   #2 - Cleanup-on-exit: after `exit` fires, the Set entry is cleared.
 *        A subsequent `session-changed` with status=`running` for the same
 *        id (simulating a re-spawn with the same id) fires analytics again.
 *
 * Mock strategy mirrors session-idle-timeout.test.ts:
 *   - `electron` and `ipcMain` are mocked so registerSessionHandlers can be
 *     called without a real Electron process.
 *   - `sessionManager.on` captures event handlers into a local Map so tests
 *     can emit synthetic events synchronously.
 *   - `../../src/main/analytics/analytics` is mocked; `trackEvent` is a
 *     `vi.fn()` whose call args are asserted.
 *   - Heavy dependencies (DB, git, engine) are stubbed out so only the
 *     analytics listener logic is exercised.
 *
 * Each test uses a unique session id so the module-scoped
 * `sessionSpawnAnalyticsFired` Set never carries state between tests (the Set
 * persists across tests in the same module because vi.clearAllMocks() only
 * resets mock call history, not module-level variables).
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

// The module under test: trackEvent is what we assert against.
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

// Import the module under test AFTER all vi.mock declarations.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { trackEvent } from '../../src/main/analytics/analytics';

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function createMockContext(
  sessionId: string,
  agentName: string | undefined,
): ReturnType<typeof buildMockContext> {
  return buildMockContext(sessionId, agentName);
}

function buildMockContext(sessionId: string, agentName: string | undefined) {
  return {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => [] as Session[]),
      getSession: vi.fn(() => null),
      getSessionTaskId: vi.fn(() => null as string | null),
      getSessionProjectId: vi.fn(() => 'proj-test' as string | undefined),
      getSessionAgentName: vi.fn((id: string) => (id === sessionId ? agentName : undefined)),
      getUsageCache: vi.fn(() => ({} as Record<string, unknown>)),
      getUsageCacheForProject: vi.fn(() => ({})),
      getActivityCache: vi.fn(() => ({})),
      getActivityCacheForProject: vi.fn(() => ({})),
      getEventsCache: vi.fn(() => ({})),
      getEventsCacheForProject: vi.fn(() => ({})),
      getEventsForSession: vi.fn(() => []),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      setFocusedSessions: vi.fn(),
      killByTaskId: vi.fn(),
      removeByTaskId: vi.fn(),
      suspend: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
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

/** Build a minimal Session DTO in `running` status. */
function makeRunningSession(sessionId: string): Session {
  return {
    id: sessionId,
    taskId: 'task-analytics-001',
    projectId: 'proj-test',
    pid: null,
    status: 'running',
    shell: '/bin/bash',
    cwd: '/home/dev/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
  };
}

// ---------------------------------------------------------------------------
// #1 - Fire-once: second running transition does NOT re-fire analytics
// ---------------------------------------------------------------------------

describe('session-changed listener - session_spawn fires exactly once per session id', () => {
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
  });

  it('calls trackEvent once for the first running transition and not again for a second', () => {
    // Use a session id that has never been seen by the module-scoped Set so
    // this test starts with a clean slate regardless of run order.
    const sessionId = 'analytics-fire-once-unique-id-001';
    const context = createMockContext(sessionId, 'claude');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    const runningSession = makeRunningSession(sessionId);

    // First running transition: should fire analytics.
    sessionChangedHandler(sessionId, runningSession);

    expect(vi.mocked(trackEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('session_spawn', {
      agent: 'claude',
      isTransient: false,
    });

    // Second running transition for the SAME session id: must NOT fire again.
    sessionChangedHandler(sessionId, runningSession);

    // trackEvent must still be called only once total.
    expect(vi.mocked(trackEvent)).toHaveBeenCalledTimes(1);
  });

  it('does NOT call trackEvent when agentName is undefined', () => {
    // Some legacy or in-progress spawn paths may not set agentName yet.
    // The guard `if (spawnAgentName)` in the listener skips trackEvent in
    // that case to avoid polluting analytics with empty-agent events.
    const sessionId = 'analytics-no-agent-unique-id-002';
    const context = createMockContext(sessionId, undefined);
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    sessionChangedHandler(sessionId, makeRunningSession(sessionId));

    expect(vi.mocked(trackEvent)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #2 - Cleanup-on-exit: Set entry deleted so re-spawn can fire analytics again
// ---------------------------------------------------------------------------

describe('exit listener - session_spawn Set entry is cleared so re-spawn fires analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();

    mockGetLatestForTask.mockReturnValue(null);

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });
  });

  it('allows session_spawn to fire a second time after exit clears the Set entry', () => {
    // Use a unique id that no other test has touched.
    const sessionId = 'analytics-re-spawn-unique-id-003';
    const context = createMockContext(sessionId, 'gemini');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    const exitHandler = capturedSessionEventHandlers.get('exit');
    if (!exitHandler) throw new Error('exit handler was not registered');

    const runningSession = makeRunningSession(sessionId);

    // First spawn: running transition fires analytics.
    sessionChangedHandler(sessionId, runningSession);
    expect(vi.mocked(trackEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('session_spawn', {
      agent: 'gemini',
      isTransient: false,
    });

    // Confirm fire-once: second running transition for same id does NOT fire.
    sessionChangedHandler(sessionId, runningSession);
    expect(vi.mocked(trackEvent)).toHaveBeenCalledTimes(1);

    // Exit fires: the exit listener deletes the sessionId from the Set AND
    // from sessionStartTimes. Since sessionStartTimes.get(sessionId) is null
    // (we never set it - the listener only records it on first running), the
    // session_exit branch with durationSeconds is skipped. That's correct for
    // this test because we're only verifying the Set cleanup, not exit metrics.
    //
    // To trigger the cleanup path we need sessionStartTimes to have an entry.
    // The `session-changed` handler sets sessionStartTimes when status=running,
    // which we already did above. So the exit handler WILL enter the branch
    // that deletes sessionSpawnAnalyticsFired[sessionId].
    exitHandler(sessionId, 0);

    // After exit, the Set entry should be cleared. A new running transition
    // (simulating a re-spawn with the same session id) must fire analytics again.
    vi.mocked(trackEvent).mockClear();
    sessionChangedHandler(sessionId, runningSession);
    expect(vi.mocked(trackEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('session_spawn', {
      agent: 'gemini',
      isTransient: false,
    });
  });
});
