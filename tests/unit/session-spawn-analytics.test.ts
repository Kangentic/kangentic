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
 *   #3 - session_exit costUsd/toolCalls: the `exit` listener reads
 *        `sessionManager.getUsageCache()[sessionId]` and attaches `costUsd`
 *        (rounded to 4 decimals) and `toolCalls` to the `session_exit` props
 *        when the cache entry carries `cost.totalCostUsd` /
 *        `toolCallCount`. When the cache entry is absent or lacks those
 *        fields, both props must be OMITTED (not sent as 0/undefined).
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
import type { Session, SessionRecord, Task } from '../../src/shared/types';

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
    on: vi.fn(),
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

const mockTaskGetById = vi.fn(() => null as Task | null);

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockTaskGetById;
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
}));

// The module under test: trackEvent is what we assert against.
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

// trackFeatureUsed/trackMilestone are mocked as plain spies (rather than
// leaving usage.ts real) so the enrichment/milestone assertions below aren't
// entangled with usage.ts's own once-per-day / once-per-install dedup state,
// which persists across tests within this file (vitest shares module
// instances per file) and would make only the FIRST matching test in the
// file observe a call.
vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
  trackMilestone: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
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
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
}));

// Import the module under test AFTER all vi.mock declarations.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { trackEvent } from '../../src/main/analytics/analytics';
import { trackFeatureUsed, trackMilestone } from '../../src/main/analytics/usage';

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
      getToolCallCount: vi.fn(() => 0),
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
    terminalSubmitScheduler: {
      scheduleKeystrokes: vi.fn(),
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
// #1b - Enrichment branch: permissionMode/worktree props + trackFeatureUsed
// ---------------------------------------------------------------------------
//
// The `sessionSpawnAnalyticsFired` fire-once branch performs a best-effort DB
// read (SessionRepository.getLatestForTask + TaskRepository.getById) to
// enrich session_spawn's props and fire trackFeatureUsed for worktree/profile
// adoption. Every test above this point leaves both repository mocks at their
// declared default (getLatestForTask -> null, TaskRepository.getById -> null),
// so `if (spawnRecord?.permission_mode)` / `if (taskRow) {...}` never execute
// and this whole branch is untested - the exact-match `toHaveBeenCalledWith`
// assertions above pass only because the enrichment adds nothing. Red-green:
// deleting the enrichment block from sessions.ts would leave
// `session_spawn`'s props at the bare `{ agent, isTransient }` shape and this
// test would fail on the missing permissionMode/worktree keys.

describe('session-changed listener - enrichment reads permission mode, worktree, and profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();
    mockGetLatestForTask.mockReturnValue(null);
    mockTaskGetById.mockReturnValue(null);

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });
  });

  it('adds permissionMode + worktree:true to session_spawn props and fires trackFeatureUsed for worktree_session and board_profile', () => {
    const sessionId = 'analytics-enrichment-full-unique-id-010';
    mockGetLatestForTask.mockReturnValue({ permission_mode: 'plan' } as unknown as SessionRecord);
    mockTaskGetById.mockReturnValue({
      id: 'task-analytics-001',
      worktree_path: '/mock/project/.kangentic/worktrees/task',
      profile_id: 'profile-1',
    } as unknown as Task);

    const context = createMockContext(sessionId, 'claude');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    sessionChangedHandler(sessionId, makeRunningSession(sessionId));

    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('session_spawn', {
      agent: 'claude',
      isTransient: false,
      permissionMode: 'plan',
      worktree: true,
    });
    expect(vi.mocked(trackFeatureUsed)).toHaveBeenCalledWith('worktree_session');
    expect(vi.mocked(trackFeatureUsed)).toHaveBeenCalledWith('board_profile');
  });

  it('omits permissionMode, reports worktree:false, and does not fire trackFeatureUsed when the record has no permission_mode and the task has no worktree/profile', () => {
    const sessionId = 'analytics-enrichment-empty-unique-id-011';
    mockGetLatestForTask.mockReturnValue(null);
    mockTaskGetById.mockReturnValue({
      id: 'task-analytics-001',
      worktree_path: null,
      profile_id: null,
    } as unknown as Task);

    const context = createMockContext(sessionId, 'claude');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    sessionChangedHandler(sessionId, makeRunningSession(sessionId));

    // `worktree` is unconditionally set to `!!taskRow.worktree_path` once a
    // task row is found (unlike `permissionMode`, which is only added when
    // truthy) - so a found task with no worktree still reports worktree:false.
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('session_spawn', {
      agent: 'claude',
      isTransient: false,
      worktree: false,
    });
    expect(vi.mocked(trackFeatureUsed)).not.toHaveBeenCalled();
  });

  it('omits both permissionMode and worktree when no task row is found at all', () => {
    const sessionId = 'analytics-enrichment-no-task-unique-id-017';
    mockGetLatestForTask.mockReturnValue(null);
    mockTaskGetById.mockReturnValue(null);

    const context = createMockContext(sessionId, 'claude');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    sessionChangedHandler(sessionId, makeRunningSession(sessionId));

    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('session_spawn', {
      agent: 'claude',
      isTransient: false,
    });
    expect(vi.mocked(trackFeatureUsed)).not.toHaveBeenCalled();
  });

  // A dedicated "isShuttingDown() === true skips the enrichment reads" case
  // was considered and deliberately skipped: proving it would require
  // vi.resetModules() + re-importing sessions.ts (plus every mock it closes
  // over) mid-file so the real, unmocked shutdown-state module's flag could
  // be flipped without leaking `true` into every other test in this file
  // (the flag has no reset export). That is not cheap, and the module-reset
  // gymnastics risk destabilizing the rest of this shared-mock suite for a
  // branch that is already covered indirectly: every OTHER test in this file
  // exercises the isShuttingDown()===false path by construction (the module
  // default), which is the state that matters for production behavior.
});

// ---------------------------------------------------------------------------
// #1c - trackMilestone('first_spawn') fires for a real (non-transient) spawn
// ---------------------------------------------------------------------------

describe('session-changed listener - trackMilestone("first_spawn")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();
    mockGetLatestForTask.mockReturnValue(null);
    mockTaskGetById.mockReturnValue(null);

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });
  });

  it('fires trackMilestone("first_spawn") for a non-transient running transition', () => {
    const sessionId = 'analytics-milestone-nontransient-unique-id-014';
    const context = createMockContext(sessionId, 'claude');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    sessionChangedHandler(sessionId, makeRunningSession(sessionId));

    expect(vi.mocked(trackMilestone)).toHaveBeenCalledWith('first_spawn');
  });

  it('does NOT fire trackMilestone("first_spawn") for a transient running transition', () => {
    const sessionId = 'analytics-milestone-transient-unique-id-015';
    const context = createMockContext(sessionId, 'claude');
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');

    const transientRunningSession: Session = { ...makeRunningSession(sessionId), transient: true };
    sessionChangedHandler(sessionId, transientRunningSession);

    expect(vi.mocked(trackMilestone)).not.toHaveBeenCalled();
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
    mockTaskGetById.mockReturnValue(null);

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

// ---------------------------------------------------------------------------
// #3 - session_exit costUsd/toolCalls sourced from the in-memory usage cache
// ---------------------------------------------------------------------------

describe('exit listener - session_exit attaches costUsd/toolCalls from the usage cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
    capturedSessionEventHandlers.clear();

    mockGetLatestForTask.mockReturnValue(null);
    mockTaskGetById.mockReturnValue(null);

    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => null), update: vi.fn() },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
    });
  });

  /**
   * Runs the running -> exit sequence and returns the props object passed to
   * the `session_exit` trackEvent call. Fails loudly if session_exit was
   * never tracked (e.g. because sessionStartTimes was never populated).
   * `liveToolCallCount` seeds `sessionManager.getToolCallCount` - the source
   * `toolCalls` reads from directly (not the usage cache's stamped
   * `toolCallCount`, which this listener no longer reads). `intentional` is
   * forwarded as the exit listener's third positional arg (crash-vs-deliberate).
   */
  function fireRunningThenExit(
    sessionId: string,
    agentName: string,
    usageCacheEntry: Record<string, unknown> | undefined,
    liveToolCallCount = 0,
    intentional?: boolean,
  ): Record<string, string | number | boolean> {
    const context = createMockContext(sessionId, agentName);
    context.sessionManager.getUsageCache.mockReturnValue(
      usageCacheEntry !== undefined ? { [sessionId]: usageCacheEntry } : {},
    );
    context.sessionManager.getToolCallCount.mockReturnValue(liveToolCallCount);
    registerSessionHandlers(context as never);

    const sessionChangedHandler = capturedSessionEventHandlers.get('session-changed');
    if (!sessionChangedHandler) throw new Error('session-changed handler was not registered');
    const exitHandler = capturedSessionEventHandlers.get('exit');
    if (!exitHandler) throw new Error('exit handler was not registered');

    // Populate sessionStartTimes so the exit listener's duration branch (and
    // therefore the trackEvent('session_exit', ...) call) actually runs.
    sessionChangedHandler(sessionId, makeRunningSession(sessionId));
    vi.mocked(trackEvent).mockClear();

    exitHandler(sessionId, 0, intentional);

    const exitCall = vi.mocked(trackEvent).mock.calls.find((call) => call[0] === 'session_exit');
    if (!exitCall) throw new Error('session_exit was never tracked');
    return exitCall[1] as Record<string, string | number | boolean>;
  }

  it('marks session_exit intentional:true when the exit listener\'s third arg is true', () => {
    // kill()/suspend tag the exit intentional (session-spawn-flow.ts); a
    // force-killed or user-stopped session must not read as a crash.
    const sessionId = 'analytics-exit-intentional-true-012';

    const props = fireRunningThenExit(sessionId, 'claude', undefined, 0, true);

    expect(props.intentional).toBe(true);
  });

  it('marks session_exit intentional:false when the exit listener receives no third arg (genuine agent-side exit)', () => {
    const sessionId = 'analytics-exit-intentional-false-013';

    const props = fireRunningThenExit(sessionId, 'claude', undefined, 0, undefined);

    expect(props.intentional).toBe(false);
  });

  it('attaches costUsd (rounded to 4 decimals) and toolCalls from the live counter', () => {
    const sessionId = 'analytics-exit-usage-populated-005';

    const props = fireRunningThenExit(
      sessionId,
      'claude',
      { cost: { totalCostUsd: 1.23456 }, model: { id: 'claude-opus-4-8' } },
      7,
    );

    expect(props.costUsd).toBe(1.2346);
    expect(props.toolCalls).toBe(7);
    expect(props.model).toBe('claude-opus-4-8');
  });

  it('toolCalls reads the live counter, not the usage cache\'s stamped toolCallCount', () => {
    const sessionId = 'analytics-exit-live-vs-stamped-008';

    // Cache entry carries a stale/stamped toolCallCount; the live counter
    // (getToolCallCount) is the source of truth and must win.
    const props = fireRunningThenExit(
      sessionId,
      'claude',
      { toolCallCount: 2, model: { id: 'claude-opus-4-8' } } as unknown as Record<string, unknown>,
      9,
    );

    expect(props.toolCalls).toBe(9);
  });

  it('omits costUsd when the usage cache entry lacks cost, but toolCalls is still unconditionally emitted', () => {
    const sessionId = 'analytics-exit-usage-missing-fields-006';

    const props = fireRunningThenExit(sessionId, 'claude', {
      model: { id: 'claude-opus-4-8' },
    });

    expect(props).not.toHaveProperty('costUsd');
    // toolCalls now reads the live counter directly and is unconditionally
    // emitted (default 0 when nothing was seeded).
    expect(props.toolCalls).toBe(0);
    // model is independently gated and still attaches when present.
    expect(props.model).toBe('claude-opus-4-8');
  });

  it('omits costUsd and model when getUsageCache() has no entry for the session', () => {
    const sessionId = 'analytics-exit-usage-empty-cache-007';

    const props = fireRunningThenExit(sessionId, 'claude', undefined);

    expect(props).not.toHaveProperty('costUsd');
    expect(props).not.toHaveProperty('model');
    expect(props.toolCalls).toBe(0);
  });

  it('collapses a [1m] context-window model id to its base id', () => {
    const sessionId = 'analytics-exit-model-1m-009';

    const props = fireRunningThenExit(sessionId, 'claude', {
      model: { id: 'claude-opus-4-8[1m]' },
    });

    expect(props.model).toBe('claude-opus-4-8');
  });
});
