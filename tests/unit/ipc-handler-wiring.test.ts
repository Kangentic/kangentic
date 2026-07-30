/**
 * Unit tests verifying that two new IPC channels added in the
 * live-session-briefing fix are wired to the correct implementations.
 *
 * A transposed pair would be silent at the call site:
 *   SESSION_GET_FIRST_OUTPUT -> getInFlightSpawnProgress()   (wrong: wrong shape)
 *   TASK_GET_SPAWN_PROGRESS  -> getFirstOutputCache()        (wrong: wrong shape)
 *
 * We cannot test the wiring via the full E2E suite without the 10s+ overhead
 * of a real Electron window. Instead, this test:
 *   1. Mocks ipcMain.handle to capture the registered handler callbacks.
 *   2. Calls registerSessionHandlers() with a minimal mock IpcContext.
 *   3. Invokes the captured SESSION_GET_FIRST_OUTPUT handler and asserts it
 *      delegates to sessionManager.getFirstOutputCache().
 *   4. Verifies that getInFlightSpawnProgress() (called by the
 *      TASK_GET_SPAWN_PROGRESS handler) returns the correct spawn-progress shape
 *      so a transposed pair would fail on the output type.
 *
 * All heavy dependencies (Electron, node-pty, SQLite, simple-git, analytics,
 * file system) are mocked at the module level so this file runs in < 100ms
 * with no build step. The pattern mirrors register-all-idempotency.test.ts,
 * using vi.hoisted() for mock functions that are referenced in vi.mock factories.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// vi.mock() factories are hoisted before const declarations, so any variable
// referenced inside a factory must be created with vi.hoisted().
// ---------------------------------------------------------------------------

const { mockHandle, mockOn } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
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

// Internal heavy modules
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { getLatestForTask = vi.fn(); updateStatus = vi.fn(); },
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
  notifyBranchCheckoutBlocked: vi.fn(),
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
vi.mock('../../src/main/transition-engine/injection-plan', () => ({
  prepareInjectionPlan: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/terminal-submit-scheduler', () => ({
  TerminalSubmitScheduler: class { cancelAll = vi.fn(); },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(), list: vi.fn(() => []) },
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

// ---------------------------------------------------------------------------
// Import the modules under test AFTER all mocks are defined.
// ---------------------------------------------------------------------------
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import {
  getInFlightSpawnProgress,
  emitSpawnProgress,
  __resetSpawnProgressForTest,
} from '../../src/main/transition-engine/spawn-progress';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helper: find the handler registered for a given channel by inspecting the
// mockHandle.mock.calls that accumulated during registerSessionHandlers().
// ---------------------------------------------------------------------------

function getRegisteredHandler(channel: string): ((...args: unknown[]) => unknown) | undefined {
  const call = mockHandle.mock.calls.find(
    (c): c is [string, (...args: unknown[]) => unknown] => c[0] === channel
  );
  return call?.[1];
}

// ---------------------------------------------------------------------------
// Minimal IpcContext stub
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<{
  getFirstOutputCache: () => Record<string, boolean>;
}> = {}) {
  const getFirstOutputCache = overrides.getFirstOutputCache ?? vi.fn(() => ({ 'sess-1': true }));
  return {
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    sessionManager: {
      getFirstOutputCache,
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

describe('IPC handler wiring: SESSION_GET_FIRST_OUTPUT', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    __resetSpawnProgressForTest();
  });

  it('SESSION_GET_FIRST_OUTPUT handler delegates to sessionManager.getFirstOutputCache()', () => {
    const expectedResult: Record<string, boolean> = { 'sess-abc': true, 'sess-def': true };
    const getFirstOutputCacheSpy = vi.fn(() => expectedResult);
    const context = makeContext({ getFirstOutputCache: getFirstOutputCacheSpy });

    registerSessionHandlers(context as Parameters<typeof registerSessionHandlers>[0]);

    const handler = getRegisteredHandler(IPC.SESSION_GET_FIRST_OUTPUT);
    expect(handler).toBeDefined();

    // Invoke the handler (ipcMain passes a synthetic event as the first arg;
    // SESSION_GET_FIRST_OUTPUT ignores it).
    const result = handler?.(null);

    expect(getFirstOutputCacheSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(expectedResult);
  });

  it('SESSION_GET_FIRST_OUTPUT and TASK_GET_SPAWN_PROGRESS channel name constants are correct', () => {
    // A rename that breaks the preload bridge would change these strings.
    // Locking them in here catches any accidental constant rename that the
    // preload and renderer rely on.
    expect(IPC.SESSION_GET_FIRST_OUTPUT).toBe('session:getFirstOutput');
    expect(IPC.TASK_GET_SPAWN_PROGRESS).toBe('task:getSpawnProgress');
  });
});

describe('IPC handler wiring: TASK_GET_SPAWN_PROGRESS return shape', () => {
  beforeEach(() => {
    __resetSpawnProgressForTest();
  });

  it('getInFlightSpawnProgress() returns Record<string, string> (not Record<string, boolean>)', () => {
    // The TASK_GET_SPAWN_PROGRESS handler is: () => getInFlightSpawnProgress()
    // The SESSION_GET_FIRST_OUTPUT handler is: () => context.sessionManager.getFirstOutputCache()
    //
    // If these were transposed, the renderer would receive:
    //   - spawnProgress map: Record<string, boolean> (wrong type - would break label rendering)
    //   - firstOutput map: Record<string, string> (wrong type - would always be truthy but with
    //     string values, breaking the === true checks)
    //
    // This test seeds the spawn-progress map and confirms the return value shape is
    // { [taskId]: string } (a label string), NOT { [taskId]: true }. A transposed
    // handler would return the boolean map instead.
    const mockMainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    } as unknown as import('electron').BrowserWindow;

    emitSpawnProgress(mockMainWindow, 'task-shape-check', 'starting-agent');

    const result = getInFlightSpawnProgress();

    // Shape must be Record<string, string> (not boolean).
    expect(typeof result['task-shape-check']).toBe('string');
    expect(result['task-shape-check']).toBe('Starting agent...');

    // Sanity: not the boolean shape that getFirstOutputCache() would return.
    expect(result['task-shape-check']).not.toBe(true);
  });
});
