/**
 * Tests that the SESSION_GET_PERIOD_STATS IPC handler routes through
 * UsageHistoryRepository.getStatsAfter (not the old SessionRepository path).
 *
 * This pins the routing change introduced in sessions.ts line 264: the handler
 * now constructs a UsageHistoryRepository from the project DB and calls
 * getStatsAfter(since). If someone accidentally reverts the routing back to
 * SessionRepository, deleted-task stats would silently disappear from the
 * StatusBar.
 *
 * Pattern mirrors session-idle-timeout.test.ts: electron and ipcMain are
 * mocked so registerSessionHandlers can run without a real Electron process.
 * The handler registered for SESSION_GET_PERIOD_STATS is extracted from the
 * captured map and invoked directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import of the modules they mock)
// ---------------------------------------------------------------------------

const capturedIpcHandlers = new Map<string, (...args: unknown[]) => unknown>();

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

// SessionRepository stub: no getStatsAfter - if the handler calls it, the test
// would need to add this method, making the absence a clear signal of a regression.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    updateMetrics = vi.fn();
    updateGitStats = vi.fn();
    compareAndUpdateStatus = vi.fn(() => true);
    insert = vi.fn();
    updateStatus = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
    update = vi.fn();
  },
}));

// UsageHistoryRepository: getStatsAfter is the observable under test.
const mockGetStatsAfter = vi.fn(() => ({
  totalCostUsd: 9.99,
  totalInputTokens: 10000,
  totalOutputTokens: 5000,
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    getStatsAfter = mockGetStatsAfter;
    recordSessionUsage = vi.fn();
    updateGitStats = vi.fn();
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  abortBacklogPromotion: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
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
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
  default: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
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

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: vi.fn(() => null), list: vi.fn(() => []) },
    swimlanes: { getById: vi.fn(() => null), list: vi.fn(() => []) },
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
  })),
  ensureTaskWorktree: vi.fn(async () => {}),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  })),
  resolveSpawnOverrides: vi.fn(() => ({ model: null, effort: null })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  buildAutoCommandVars: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Context factory
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
      listSessions: vi.fn(() => []),
      getSession: vi.fn(() => null),
      getSessionTaskId: vi.fn(() => null),
      getSessionProjectId: vi.fn(() => null),
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
      on: vi.fn(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SESSION_GET_PERIOD_STATS handler routes to UsageHistoryRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedIpcHandlers.clear();
  });

  it('calls UsageHistoryRepository.getStatsAfter for the "all" period', () => {
    const context = createMockContext();
    registerSessionHandlers(context as never);

    const handler = capturedIpcHandlers.get(IPC.SESSION_GET_PERIOD_STATS);
    if (!handler) throw new Error(`Handler for ${IPC.SESSION_GET_PERIOD_STATS} was not registered`);

    const result = handler({} as never, 'all');

    // The handler must use the history, not any other repo.
    expect(mockGetStatsAfter).toHaveBeenCalledTimes(1);
    // 'all' maps to a null cutoff (all-time query, no WHERE clause).
    expect(mockGetStatsAfter).toHaveBeenCalledWith(null);
    expect(result).toEqual({
      totalCostUsd: 9.99,
      totalInputTokens: 10000,
      totalOutputTokens: 5000,
    });
  });

  it('passes a non-null cutoff string for the "today" period', () => {
    const context = createMockContext();
    registerSessionHandlers(context as never);

    const handler = capturedIpcHandlers.get(IPC.SESSION_GET_PERIOD_STATS);
    if (!handler) throw new Error(`Handler for ${IPC.SESSION_GET_PERIOD_STATS} was not registered`);

    handler({} as never, 'today');

    expect(mockGetStatsAfter).toHaveBeenCalledTimes(1);
    const [since] = mockGetStatsAfter.mock.calls[0] as [string | null];
    // computePeriodCutoff('today') produces an ISO date string for start-of-today.
    expect(typeof since).toBe('string');
    expect(since).not.toBeNull();
    expect(Number.isFinite(Date.parse(since as string))).toBe(true);
  });

  it('returns the zero-stats fallback when no project is currently open', () => {
    const context = createMockContext();
    // Simulate "no project open" state.
    context.currentProjectId = '';
    registerSessionHandlers(context as never);

    const handler = capturedIpcHandlers.get(IPC.SESSION_GET_PERIOD_STATS);
    if (!handler) throw new Error(`Handler for ${IPC.SESSION_GET_PERIOD_STATS} was not registered`);

    const result = handler({} as never, 'all');

    // Handler guards on !context.currentProjectId, so the history is not touched.
    expect(mockGetStatsAfter).not.toHaveBeenCalled();
    expect(result).toEqual({ totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 });
  });
});
