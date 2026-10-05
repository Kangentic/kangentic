/**
 * The IPC.SESSION_GET_TOOL_BREAKDOWN handler in
 * `registerSessionHandlers` (src/main/ipc/handlers/sessions.ts).
 *
 * The handler now returns `sessionManager.refreshToolBreakdownAcrossRuns(id)`: the
 * track's earlier runs' stored rows merged with the live accumulator, which is
 * what the context bar's tool-call popover shows for a resumed session.
 * `sessionManager.getToolBreakdown(id)` is the PER-RUN read and stays in use by
 * `captureSessionMetrics`, which must store only this run's rows. Pointing the
 * handler back at the per-run method type-checks, passes every
 * SessionManager-level test, and silently resets a resumed session's popover to
 * the current run alone, because the UI tests run against the mock bridge and
 * never load this handler.
 *
 * Same approach as ipc-handler-wiring.test.ts and message-trail-ipc-wiring.test.ts:
 * capture the `ipcMain.handle` callbacks, register the session handlers against
 * a stub IpcContext, and invoke the handler directly. Kept out of
 * register-all-earlier-runs-source.test.ts because that file mocks the whole
 * sessions handler module.
 *
 * Red-green, from the code (nothing was toggled): change the handler body to
 * `context.sessionManager.getToolBreakdown(sessionId)` and the result assertion
 * (the per-run sentinel is returned instead of the across-runs one), the
 * across-runs call assertion, and the not-called assertion all fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PerToolStat } from '../../src/shared/types';

// Hoisted mock functions.

const { mockHandle, mockOn, mockRetrievalCall } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
  mockRetrievalCall: vi.fn(),
}));

// Module-level mocks. These mirror message-trail-ipc-wiring.test.ts, which
// loads the same registerSessionHandlers import chain.

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, on: mockOn },
  app: { getPath: vi.fn(() => '/mock/data') },
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'mock-uuid') }));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn();
    updateStatus = vi.fn();
    findByAnyId = vi.fn();
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
  readTranscriptToolResultTokens: vi.fn(),
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
  agentRegistry: { get: vi.fn(), list: vi.fn(() => []), getBySessionType: vi.fn() },
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: mockRetrievalCall, notifyRunning: vi.fn(), on: vi.fn() },
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
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
// The tracker is constructed by registerSessionHandlers but is not under test.
vi.mock('../../src/main/agent/message-trail-tracker', () => ({
  MessageTrailTracker: class {
    on = vi.fn();
    snapshot = vi.fn(() => ({}));
  },
}));

// Imported AFTER all mocks are defined.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';

// Helpers.

function getRegisteredHandler(channel: string): ((...args: unknown[]) => unknown) | undefined {
  const call = mockHandle.mock.calls.find(
    (candidate): candidate is [string, (...args: unknown[]) => unknown] => candidate[0] === channel,
  );
  return call?.[1];
}

/** Distinct sentinels so a handler reading the wrong method cannot return the right one. */
const ACROSS_RUNS_ROWS: PerToolStat[] = [
  { toolName: 'Read', callCount: 12, totalDurationMs: 0, interruptedCount: 0 },
  { toolName: 'Bash', callCount: 3, totalDurationMs: 0, interruptedCount: 0 },
];
const PER_RUN_ROWS: PerToolStat[] = [
  { toolName: 'Read', callCount: 2, totalDurationMs: 0, interruptedCount: 0 },
];

function makeContext(overrides: { acrossRuns?: PerToolStat[]; perRun?: PerToolStat[] } = {}) {
  const refreshToolBreakdownAcrossRuns = vi.fn((_sessionId: string) => overrides.acrossRuns ?? ACROSS_RUNS_ROWS);
  const getToolBreakdown = vi.fn((_sessionId: string) => overrides.perRun ?? PER_RUN_ROWS);
  const context = {
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    sessionManager: {
      refreshToolBreakdownAcrossRuns,
      getToolBreakdown,
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
    boardConfigManager: { attach: vi.fn(), detach: vi.fn() },
    gitDetector: { detect: vi.fn(() => Promise.resolve(null)) },
    shellResolver: { getDefaultShell: vi.fn(() => Promise.resolve('/bin/bash')) },
    terminalSubmitScheduler: { cancelAll: vi.fn() },
    terminalSubmit: { submitContent: vi.fn(), submitKeystrokes: vi.fn() },
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
    projectGroupRepo: { list: vi.fn(() => []) },
  };
  return context;
}

// Tests.

describe('IPC handler wiring: SESSION_GET_TOOL_BREAKDOWN', () => {
  beforeEach(() => {
    mockHandle.mockClear();
  });

  it('returns the across-runs breakdown for the session, not the per-run one', () => {
    const context = makeContext();
    registerSessionHandlers(context as unknown as Parameters<typeof registerSessionHandlers>[0]);

    const handler = getRegisteredHandler(IPC.SESSION_GET_TOOL_BREAKDOWN);
    expect(handler, 'registerSessionHandlers must register IPC.SESSION_GET_TOOL_BREAKDOWN').toBeDefined();

    // ipcMain passes a synthetic event first, then the renderer's argument.
    const result = handler?.(null, 'session-42');

    expect(result).toBe(ACROSS_RUNS_ROWS);
    expect(context.sessionManager.refreshToolBreakdownAcrossRuns).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.refreshToolBreakdownAcrossRuns).toHaveBeenCalledWith('session-42');
  });

  it('never reads the per-run breakdown, which captureSessionMetrics still owns', () => {
    const context = makeContext();
    registerSessionHandlers(context as unknown as Parameters<typeof registerSessionHandlers>[0]);

    getRegisteredHandler(IPC.SESSION_GET_TOOL_BREAKDOWN)?.(null, 'session-42');

    expect(context.sessionManager.getToolBreakdown).not.toHaveBeenCalled();
  });

  it('returns an empty across-runs answer as is, with no fallback to the per-run rows', () => {
    // A length-based fallback such as `across.length > 0 ? across : perRun`
    // would resurrect the current run's rows for a session whose merged table
    // is empty.
    const emptyAcrossRuns: PerToolStat[] = [];
    const context = makeContext({ acrossRuns: emptyAcrossRuns });
    registerSessionHandlers(context as unknown as Parameters<typeof registerSessionHandlers>[0]);

    const result = getRegisteredHandler(IPC.SESSION_GET_TOOL_BREAKDOWN)?.(null, 'session-42');

    expect(result).toBe(emptyAcrossRuns);
    expect(context.sessionManager.getToolBreakdown).not.toHaveBeenCalled();
  });
});
