/**
 * Tests that syncShutdownCleanup wires a UsageHistoryRepository instance into
 * the captureSessionMetrics call during the per-session shutdown loop.
 *
 * The shutdown path (src/main/shutdown.ts lines 70-80) constructs
 * UsageHistoryRepository from the project DB and forwards it through
 * captureSessionMetrics. A regression here (e.g. passing undefined or reverting
 * to the old 5-arg captureSessionMetrics signature) would silently drop
 * in-flight session metrics from the history on every clean app close.
 *
 * captureSessionMetrics is mocked so we can inspect its call arguments.
 * UsageHistoryRepository is also mocked (better-sqlite3 cannot load under
 * vitest); the mock records every constructed instance so the test can
 * assert the right one reached captureSessionMetrics as arg[2].
 *
 * SessionRepository.getLatestForTask is configured via a module-level fn ref
 * so each test can control what record the shutdown loop sees for the session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import of the modules they mock)
// ---------------------------------------------------------------------------

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeAll: vi.fn(),
}));

// getLatestForTask is configured per-test via the exported fn reference.
const mockGetLatestForTask = vi.fn(() => null as null | {
  id: string;
  status: string;
  agent_session_id: string | null;
  session_type: string | null;
  started_at: string;
});

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = mockGetLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    updateStatus = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    update = vi.fn();
  },
}));

// Track instances created by the UsageHistoryRepository constructor so tests
// can verify the same instance was forwarded to captureSessionMetrics.
const createdHistoryInstances: object[] = [];

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    constructor() {
      createdHistoryInstances.push(this);
    }
    recordSessionUsage = vi.fn();
    updateGitStats = vi.fn();
    getStatsAfter = vi.fn(() => ({ totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 }));
  },
}));

const mockCaptureSessionMetrics = vi.fn();
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: (...args: unknown[]) => mockCaptureSessionMetrics(...args),
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
// ---------------------------------------------------------------------------

import { syncShutdownCleanup } from '../../src/main/shutdown';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function buildRunningSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'pty-abc',
    taskId: 'task-111',
    projectId: 'proj-1',
    status: 'running',
    command: 'claude',
    cwd: '/mock/project',
    ...overrides,
  } as Session;
}

function buildMockDependencies(sessions: Session[]) {
  // Stable diffWatcher stub so a test can assert closeAll() ran during cleanup.
  const diffWatcher = { closeAll: vi.fn() };
  return {
    getSessionManager: vi.fn(() => ({
      listSessions: vi.fn(() => sessions),
      killAll: vi.fn(),
      dispose: vi.fn(),
      cancelAll: vi.fn(),
      getUsageCache: vi.fn(() => ({})),
      getToolCallCount: vi.fn(() => 0),
    })),
    getBoardConfigManager: vi.fn(() => ({
      detach: vi.fn(),
    })),
    getDiffWatcher: vi.fn(() => diffWatcher),
    getTerminalSubmitScheduler: vi.fn(() => ({
      cancelAll: vi.fn(),
    })),
    getCurrentProjectId: vi.fn(() => null),
    deleteProjectFromIndex: vi.fn(),
    stopUpdaterTimers: vi.fn(),
    clearPendingTimers: vi.fn(),
    isEphemeral: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncShutdownCleanup history wire-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdHistoryInstances.length = 0;
  });

  it('constructs a UsageHistoryRepository and passes it as the third argument to captureSessionMetrics', () => {
    mockGetLatestForTask.mockReturnValue({
      id: 'record-001',
      status: 'running',
      agent_session_id: 'agent-aaa',
      session_type: 'claude_agent',
      started_at: '2026-01-01T10:00:00Z',
    });

    const session = buildRunningSession();
    const dependencies = buildMockDependencies([session]);

    syncShutdownCleanup(dependencies);

    // captureSessionMetrics must have been called once (for the one running session).
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);

    // Arg index 2 (zero-indexed) is the usageHistoryRepo parameter.
    const callArgs = mockCaptureSessionMetrics.mock.calls[0] as unknown[];
    const passedHistory = callArgs[2];

    // A UsageHistoryRepository instance must have been constructed and forwarded.
    expect(createdHistoryInstances).toHaveLength(1);
    expect(passedHistory).toBe(createdHistoryInstances[0]);
  });

  it('does NOT call captureSessionMetrics when no sessions are running', () => {
    const dependencies = buildMockDependencies([]);
    syncShutdownCleanup(dependencies);
    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });

  it('closes the diff watchers so recursive fs.watch handles do not keep the process alive past quit', () => {
    const dependencies = buildMockDependencies([]);
    syncShutdownCleanup(dependencies);
    // getDiffWatcher returns the same stub on every call, so reading it here
    // gives the instance the cleanup path acted on.
    expect(dependencies.getDiffWatcher().closeAll).toHaveBeenCalledTimes(1);
  });

  it('does NOT call captureSessionMetrics for queued sessions (never spawned - nothing to capture)', () => {
    mockGetLatestForTask.mockReturnValue({
      id: 'record-002',
      status: 'queued',
      agent_session_id: null,
      session_type: null,
      started_at: '2026-01-01T10:00:00Z',
    });

    // SessionManager.listSessions returns the session with status 'queued'.
    const session = buildRunningSession({ status: 'queued' });
    const dependencies = buildMockDependencies([session]);

    syncShutdownCleanup(dependencies);

    // Queued sessions are marked exited but never go through captureSessionMetrics.
    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });
});
