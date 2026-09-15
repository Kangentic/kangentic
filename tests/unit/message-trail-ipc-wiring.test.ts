/**
 * Unit tests for the message-trail-tracker wiring inside
 * `registerSessionHandlers` (src/main/ipc/handlers/sessions.ts).
 *
 * `MessageTrailTracker` itself (eviction, coalescing, dedupe) is covered in
 * tests/unit/message-trail-tracker.test.ts, driven directly against the
 * class. Nothing exercises the GLUE around it: the constructor call, the
 * 'trail' -> broadcast(IPC.SESSION_MESSAGE_TRAIL) wire, and the
 * IPC.SESSION_GET_MESSAGE_TRAILS handler's delegation to snapshot(). A
 * transposed or dropped wire here is silent everywhere else - the tracker's
 * own tests never touch sessions.ts, and the UI specs run against
 * tests/ui/mock-electron-api.js, which never loads main-process code at all.
 *
 * Same approach as tests/unit/ipc-handler-wiring.test.ts: mock ipcMain.handle
 * to capture registered callbacks, call registerSessionHandlers() with a
 * minimal mock IpcContext, and mock every heavy dependency at module level so
 * this runs in well under 100ms with no build step. MessageTrailTracker is
 * additionally mocked here (its own class body is exercised elsewhere) so
 * these tests are scoped purely to how sessions.ts wires it up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantMessageTrailEntry } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// vi.mock() factories are hoisted before const declarations, so any variable
// referenced inside a factory must be created with vi.hoisted().
// ---------------------------------------------------------------------------

const {
  mockHandle,
  mockOn,
  trailerConstructorCalls,
  trailerOnCalls,
  trailerSnapshotMock,
  mockFindByAnyId,
  mockGetBySessionType,
} = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
  trailerConstructorCalls: [] as unknown[],
  trailerOnCalls: [] as Array<[string, (...args: unknown[]) => void]>,
  trailerSnapshotMock: vi.fn(() => ({
    'fake-session-id': [{ uuid: 'trail-u1', ts: 1, text: 'fake trail entry' }],
  })),
  // Shared across every `new SessionRepository(...)` instance the closure
  // under test creates, so a per-test return value/throw is reachable without
  // capturing the constructed instance.
  mockFindByAnyId: vi.fn(),
  mockGetBySessionType: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, on: mockOn },
  app: { getPath: vi.fn(() => '/mock/data') },
}));

// Native modules
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'mock-uuid') }));

// Internal heavy modules (mirrors tests/unit/ipc-handler-wiring.test.ts, the
// same registerSessionHandlers import chain)
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn();
    updateStatus = vi.fn();
    findByAnyId(sessionId: string): unknown { return mockFindByAnyId(sessionId); }
  },
}));
vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class { record = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); getById = vi.fn(); },
}));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((message: string) => message),
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  deleteTaskWorktree: vi.fn(),
  spawnAgent: vi.fn(),
  resolveSpawnOverrides: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  registerTaskMoveHandlers: vi.fn(),
  handleTaskMove: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(() => ({ liveSession: null })),
}));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  registerBacklogHandlers: vi.fn(),
  abortBacklogPromotion: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'main'),
}));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
  prepareInjectionPlan: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/terminal-submit-scheduler', () => ({
  TerminalSubmitScheduler: class { cancelAll = vi.fn(); },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(), list: vi.fn(() => []), getBySessionType: mockGetBySessionType },
}));
vi.mock('../../src/main/agent/adapters/claude/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(),
}));
vi.mock('../../src/main/agent/adapters/claude/hook-manager', () => ({
  buildHooks: vi.fn(),
  removeHooks: vi.fn(),
}));
vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class { ensureWorktree = vi.fn(); },
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn((_id: string, fn: () => unknown) => fn()),
}));
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));
vi.mock('../../src/main/diagnostics/debug-dump-resolver', () => ({
  resolveDebugDumpDir: vi.fn(),
}));

// The dependency under test: a fake standing in for the real
// MessageTrailTracker (covered on its own in
// tests/unit/message-trail-tracker.test.ts). Captures the deps it was
// constructed with and the 'trail' listener sessions.ts registers, so the
// tests below can invoke that listener directly instead of driving the real
// eviction/coalescing machinery.
vi.mock('../../src/main/agent/message-trail-tracker', () => ({
  MessageTrailTracker: class {
    constructor(deps: unknown) {
      trailerConstructorCalls.push(deps);
    }
    on(event: string, callback: (...args: unknown[]) => void): void {
      trailerOnCalls.push([event, callback]);
    }
    snapshot(): unknown {
      return trailerSnapshotMock();
    }
  },
}));

// ---------------------------------------------------------------------------
// Import the modules under test AFTER all mocks are defined.
// ---------------------------------------------------------------------------
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helper: find the handler registered for a given channel by inspecting the
// mockHandle.mock.calls that accumulated during registerSessionHandlers().
// ---------------------------------------------------------------------------

function getRegisteredHandler(channel: string): ((...args: unknown[]) => unknown) | undefined {
  const call = mockHandle.mock.calls.find(
    (c): c is [string, (...args: unknown[]) => unknown] => c[0] === channel,
  );
  return call?.[1];
}

function getTrailListener(): ((...args: unknown[]) => void) | undefined {
  return trailerOnCalls.find(([event]) => event === 'trail')?.[1];
}

/**
 * The two DI closures `sessions.ts` builds inline and hands to
 * `MessageTrailTracker`'s constructor: `resolveSessionFacts` (the DB lookup
 * and snake_case -> camelCase field map) and `resolveAdapter` (the
 * `agentRegistry` delegation). `MessageTrailTracker` itself is mocked above,
 * so these are exercised directly against the real closures - nothing else in
 * the tree calls them, since every tracker test in message-trail-tracker.test.ts
 * supplies its own fake lambda instead.
 */
interface CapturedMessageTrailDeps {
  resolveSessionFacts: (sessionId: string, projectId: string) => {
    sessionType: string;
    agentSessionId: string | null;
    cwd: string;
  } | null;
  resolveAdapter: (sessionType: string) => unknown;
}

function getConstructedDeps(): CapturedMessageTrailDeps {
  return trailerConstructorCalls[0] as CapturedMessageTrailDeps;
}

// ---------------------------------------------------------------------------
// Minimal IpcContext stub
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<{ mainWindowDestroyed: boolean }> = {}) {
  const mainWindowDestroyed = overrides.mainWindowDestroyed ?? false;
  return {
    mainWindow: {
      isDestroyed: vi.fn(() => mainWindowDestroyed),
      webContents: { send: vi.fn() },
    },
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    sessionManager: {
      getFirstOutputCache: vi.fn(() => ({})),
      listSessions: vi.fn(() => []),
      spawn: vi.fn(),
      kill: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      getScrollback: vi.fn(() => ''),
      getUsageCache: vi.fn(() => ({})),
      getUsageCacheForProject: vi.fn(() => ({})),
      getActivityCache: vi.fn(() => ({})),
      getActivityCacheForProject: vi.fn(() => ({})),
      getActivityReason: vi.fn(() => null),
      getActivityReasonsCache: vi.fn(() => ({})),
      getActivityReasonsCacheForProject: vi.fn(() => ({})),
      getActivityStatsSnapshot: vi.fn(() => null),
      getEventsForSession: vi.fn(() => []),
      getEventsCache: vi.fn(() => ({})),
      getEventsCacheForProject: vi.fn(() => ({})),
      getToolCallCount: vi.fn(() => 0),
      getToolBreakdown: vi.fn(() => []),
      getSessionTaskId: vi.fn(() => undefined),
      getSessionProjectId: vi.fn(() => undefined),
      getSessionAgentName: vi.fn(() => undefined),
      write: vi.fn(),
      resize: vi.fn(),
      setFocusedSessions: vi.fn(),
      getFocusedSessions: vi.fn(() => new Set()),
      signalUserInterrupt: vi.fn(),
      drain: vi.fn(() => Promise.resolve()),
      writeRaw: vi.fn(),
      findLiveSessionByTaskId: vi.fn(() => undefined),
      hasSessionForTask: vi.fn(() => false),
      setTranscriptRepository: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      getSession: vi.fn(() => undefined),
      getSessionCounts: vi.fn(() => ({ active: 0, suspended: 0, total: 0 })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        claude: {},
        git: {},
        terminal: {},
        behavior: {},
        notifications: {},
        privacy: {},
      })),
    },
    boardConfigManager: {
      attach: vi.fn(),
      detach: vi.fn(),
    },
    gitDetector: {
      detect: vi.fn(() => Promise.resolve(null)),
    },
    shellResolver: {
      getDefaultShell: vi.fn(() => Promise.resolve('/bin/bash')),
    },
    terminalSubmitScheduler: {
      cancelAll: vi.fn(),
    },
    terminalSubmit: {
      submitContent: vi.fn(),
      submitKeystrokes: vi.fn(),
    },
    recoveredProjects: new Set<string>(),
    snapshottedProjects: new Set<string>(),
    mcpServerHandle: null,
    projectRepo: {
      list: vi.fn(() => []),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    projectGroupRepo: {
      list: vi.fn(() => []),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IPC handler wiring: message trail tracker', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    trailerConstructorCalls.length = 0;
    trailerOnCalls.length = 0;
    trailerSnapshotMock.mockClear();
    mockFindByAnyId.mockReset();
    mockGetBySessionType.mockReset();
  });

  it('constructs exactly one MessageTrailTracker and registers SESSION_GET_MESSAGE_TRAILS delegating to its snapshot()', () => {
    const context = makeContext();
    registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);

    expect(trailerConstructorCalls).toHaveLength(1);

    const handler = getRegisteredHandler(IPC.SESSION_GET_MESSAGE_TRAILS);
    expect(handler).toBeDefined();

    const result = handler?.(null);

    expect(trailerSnapshotMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      'fake-session-id': [{ uuid: 'trail-u1', ts: 1, text: 'fake trail entry' }],
    });
  });

  it('a tracker \'trail\' emit reaches the main window on IPC.SESSION_MESSAGE_TRAIL with the session id, entries, and project id', () => {
    const context = makeContext();
    registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);

    const trailListener = getTrailListener();
    expect(trailListener).toBeDefined();

    const entries: AssistantMessageTrailEntry[] = [{ uuid: 'u2', ts: 2, text: 'hello from the agent' }];
    trailListener?.('sess-abc', entries, 'proj-xyz');

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_MESSAGE_TRAIL,
      'sess-abc',
      entries,
      'proj-xyz',
    );
  });

  it('does not broadcast a trail emit once the main window is destroyed', () => {
    const context = makeContext({ mainWindowDestroyed: true });
    registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);

    const trailListener = getTrailListener();
    trailListener?.('sess-abc', [], 'proj-xyz');

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  describe('resolveSessionFacts / resolveAdapter (the DI closures passed to the tracker)', () => {
    it('maps a found record to MessageTrailSessionFacts, snake_case field for snake_case field', () => {
      const context = makeContext();
      registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);
      const { resolveSessionFacts } = getConstructedDeps();

      mockFindByAnyId.mockReturnValueOnce({
        session_type: 'claude',
        agent_session_id: 'claude-agent-session-1',
        cwd: '/mock/project/worktree',
      });

      const facts = resolveSessionFacts('sess-abc', 'proj-xyz');

      expect(mockFindByAnyId).toHaveBeenCalledWith('sess-abc');
      // Exact shape, not just non-null: a transposed field (e.g. cwd swapped
      // with agentSessionId) would still satisfy a truthy or a `toBeDefined`
      // check while pointing the tracker's window reads at the wrong file.
      expect(facts).toEqual({
        sessionType: 'claude',
        agentSessionId: 'claude-agent-session-1',
        cwd: '/mock/project/worktree',
      });
    });

    it('returns null when no record is found for the id', () => {
      const context = makeContext();
      registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);
      const { resolveSessionFacts } = getConstructedDeps();

      mockFindByAnyId.mockReturnValueOnce(undefined);

      expect(resolveSessionFacts('sess-unknown', 'proj-xyz')).toBeNull();
    });

    it('returns null, not throw, when the lookup itself throws (a project DB that will not open)', () => {
      const context = makeContext();
      registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);
      const { resolveSessionFacts } = getConstructedDeps();

      mockFindByAnyId.mockImplementationOnce(() => {
        throw new Error('[test] simulated DB-open failure');
      });

      expect(() => resolveSessionFacts('sess-abc', 'proj-broken')).not.toThrow();
      expect(resolveSessionFacts('sess-abc', 'proj-broken')).toBeNull();
    });

    it('delegates resolveAdapter to agentRegistry.getBySessionType', () => {
      const context = makeContext();
      registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);
      const { resolveAdapter } = getConstructedDeps();

      const fakeAdapter = { name: 'fake-claude-adapter' };
      mockGetBySessionType.mockReturnValueOnce(fakeAdapter);

      expect(resolveAdapter('claude')).toBe(fakeAdapter);
      expect(mockGetBySessionType).toHaveBeenCalledWith('claude');
    });
  });
});
