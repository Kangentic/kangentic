/**
 * Unit tests for startMetricsSnapshotTimer / stopMetricsSnapshotTimer
 * (src/main/ipc/handlers/metrics-snapshot-timer.ts).
 *
 * Three behaviors pinned with vi.useFakeTimers():
 *   1. Idempotent start - calling start twice does NOT register a second interval
 *      (the `if (snapshotTimer) return` guard). Verified by (a) spying on the
 *      fake setInterval to assert exactly one registration, and (b) asserting that
 *      only one tick worth of effects fires per 45s advance.
 *   2. Stop cancels future ticks; a subsequent start re-arms the timer correctly
 *      (the module var was nulled).
 *   3. Only-running filter - the tick skips sessions whose in-memory status is not
 *      'running'; also skips running-in-memory sessions whose DB record is not
 *      'running' (the second guard inside snapshotRunningSessions).
 *
 * The tick function is synchronous (no awaits), so vi.advanceTimersByTime is used
 * throughout (not the async variant). Module-level snapshotTimer state is cleaned
 * up via stopMetricsSnapshotTimer() in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '../../src/shared/types';
import type { SessionManager } from '../../src/main/pty/session-manager';

// ---------------------------------------------------------------------------
// Module-level mock instances.
// vi.hoisted ensures these are initialized before vi.mock factories run (which
// are hoisted to the top of the file ahead of all imports).
// ---------------------------------------------------------------------------

// better-sqlite3's `db.transaction(fn)` returns a callable that runs `fn` inside
// a transaction. The mock mirrors that: transaction(fn) => fn, so calling the
// returned function synchronously runs the batch body.
const makeMockDb = () => ({ transaction: (fn: () => void) => fn });

const { mockCaptureSessionMetrics, mockGetProjectDb, mockGetLatestForTask } = vi.hoisted(() => ({
  mockCaptureSessionMetrics: vi.fn(),
  mockGetProjectDb: vi.fn(() => ({ transaction: (fn: () => void) => fn })),
  /** Shared getLatestForTask stub - re-configured per test in beforeEach. */
  mockGetLatestForTask: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: mockGetProjectDb,
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  // Each new SessionRepository(db) instance created in snapshotRunningSessions
  // exposes the same mockGetLatestForTask reference, so calls from any instance
  // are observable on a single spy.
  SessionRepository: class {
    getLatestForTask = mockGetLatestForTask;
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: mockCaptureSessionMetrics,
}));

// Imported AFTER vi.mock declarations so the mocked modules are in place.
import {
  startMetricsSnapshotTimer,
  stopMetricsSnapshotTimer,
} from '../../src/main/ipc/handlers/metrics-snapshot-timer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Must match METRICS_SNAPSHOT_INTERVAL_MS in the source module. */
const SNAPSHOT_INTERVAL_MS = 45_000;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal Session stub. Only id/taskId/projectId/status are read by snapshotRunningSessions. */
function makeSession(overrides: Partial<Pick<Session, 'id' | 'taskId' | 'projectId' | 'status'>> = {}): Session {
  return {
    id: 'session-1',
    taskId: 'task-1',
    projectId: 'project-1',
    pid: null,
    status: 'running',
    shell: 'bash',
    cwd: '/repo',
    startedAt: '2026-01-01T00:00:00Z',
    exitCode: null,
    resuming: false,
    ...overrides,
  } as Session;
}

/**
 * Minimal SessionRecord shape for getLatestForTask. Only id/status/started_at/session_type
 * are read by snapshotRunningSessions before it calls captureSessionMetrics.
 */
function makeRunningRecord(overrides: { id?: string; status?: string } = {}) {
  return {
    id: overrides.id ?? 'rec-1',
    status: overrides.status ?? 'running',
    started_at: '2026-01-01T00:00:00Z',
    session_type: 'claude_agent',
  };
}

/** Minimal SessionManager stub. snapshotRunningSessions only calls listSessions(). */
function makeManagerStub(sessions: Session[]): SessionManager {
  return { listSessions: vi.fn(() => sessions) } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Default: getLatestForTask returns a running record, so any running in-memory
  // session will propagate all the way to captureSessionMetrics. Individual tests
  // that want to verify the DB-record guard override this.
  mockGetLatestForTask.mockReturnValue(makeRunningRecord());
});

afterEach(() => {
  // Always stop the timer so module-level snapshotTimer state doesn't leak into
  // the next test. This is safe to call even if the timer was already stopped.
  stopMetricsSnapshotTimer();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Idempotent start
// ---------------------------------------------------------------------------

describe('startMetricsSnapshotTimer - idempotent start', () => {
  it('registers setInterval exactly once even when called twice', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const manager = makeManagerStub([makeSession()]);
    startMetricsSnapshotTimer(manager);
    startMetricsSnapshotTimer(manager); // second call must be a no-op

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('fires the tick exactly once per interval after a double start', () => {
    const manager = makeManagerStub([makeSession()]);
    startMetricsSnapshotTimer(manager);
    startMetricsSnapshotTimer(manager); // guard: if (snapshotTimer) return

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    // If a second interval had been created the tick would fire twice.
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Stop cancels; subsequent start re-arms
// ---------------------------------------------------------------------------

describe('stopMetricsSnapshotTimer', () => {
  it('cancels the interval so no ticks fire after stop', () => {
    const manager = makeManagerStub([makeSession()]);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS); // first tick
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);

    stopMetricsSnapshotTimer();
    mockCaptureSessionMetrics.mockClear();

    // Two full intervals after stop: no ticks should fire.
    vi.advanceTimersByTime(2 * SNAPSHOT_INTERVAL_MS);
    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });

  it('nulls the module var so a subsequent startMetricsSnapshotTimer re-arms correctly', () => {
    const manager = makeManagerStub([makeSession()]);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS); // first tick
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);

    stopMetricsSnapshotTimer(); // nulls snapshotTimer

    // Start again - must register a new interval (would fail if the guard kept
    // the old null/cleared-but-not-null handle and skipped registration).
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    startMetricsSnapshotTimer(manager);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    mockCaptureSessionMetrics.mockClear();
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS); // tick from the new interval
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when called before start (does not throw)', () => {
    // snapshotTimer is null at this point (never started or already stopped by afterEach).
    expect(() => stopMetricsSnapshotTimer()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Only-running filter
// ---------------------------------------------------------------------------

describe('snapshotRunningSessions filter', () => {
  it('calls captureSessionMetrics only for sessions whose in-memory status is running', () => {
    const sessions = [
      makeSession({ id: 'session-run', taskId: 'task-run', status: 'running' }),
      makeSession({ id: 'session-sus', taskId: 'task-sus', status: 'suspended' }),
      makeSession({ id: 'session-que', taskId: 'task-que', status: 'queued' }),
    ];
    const manager = makeManagerStub(sessions);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    // Only the running session reaches captureSessionMetrics.
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);
    // The first positional arg to captureSessionMetrics is sessionManager; the
    // fourth is sessionId. Assert on the sessionId to confirm the right session.
    expect(mockCaptureSessionMetrics).toHaveBeenCalledWith(
      manager,
      expect.anything(), // sessionRepo instance
      expect.anything(), // usageHistoryRepo instance
      'session-run',
      expect.any(String), // record.id
      expect.any(String), // record.started_at
      expect.any(String), // record.session_type
    );

    // getLatestForTask was queried only for the running session (not the
    // suspended or queued ones, which were filtered before the DB call).
    expect(mockGetLatestForTask).toHaveBeenCalledTimes(1);
    expect(mockGetLatestForTask).toHaveBeenCalledWith('task-run');
  });

  it('skips a session whose in-memory status is running but whose DB record is not running', () => {
    // The tick has TWO guards:
    //   1. if (session.status !== 'running') continue   <- in-memory
    //   2. if (!record || record.status !== 'running') continue  <- DB re-read
    // This test covers the second guard: in-memory says running, DB says suspended.
    mockGetLatestForTask.mockReturnValue(makeRunningRecord({ status: 'suspended' }));

    const manager = makeManagerStub([makeSession({ status: 'running' })]);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    // DB record status is 'suspended' -> second guard skips -> no capture call.
    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });

  it('skips a session whose in-memory status is running but getLatestForTask returns null', () => {
    // null record from getLatestForTask hits the `!record` branch of the second guard.
    mockGetLatestForTask.mockReturnValue(null);

    const manager = makeManagerStub([makeSession({ status: 'running' })]);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });

  it('continues processing other sessions when getProjectDb throws for one', () => {
    // snapshotRunningSessions wraps each session in try/catch (best-effort).
    // The first session throws; the second must still be processed.
    mockGetProjectDb
      .mockImplementationOnce(() => { throw new Error('DB unavailable'); })
      .mockImplementation(() => makeMockDb());

    const sessions = [
      makeSession({ id: 'session-a', taskId: 'task-a', projectId: 'proj-a', status: 'running' }),
      makeSession({ id: 'session-b', taskId: 'task-b', projectId: 'proj-b', status: 'running' }),
    ];
    const manager = makeManagerStub(sessions);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    // session-a threw, session-b must still have been captured.
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);
    expect(mockCaptureSessionMetrics).toHaveBeenCalledWith(
      manager,
      expect.anything(),
      expect.anything(),
      'session-b',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('fires captureSessionMetrics on every tick interval, not just the first', () => {
    const manager = makeManagerStub([makeSession()]);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS); // tick 1
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS); // tick 2
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS); // tick 3
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(3);
  });

  it('isolates one session\'s getLatestForTask throw from its sibling in the same project transaction', () => {
    // The fix: each session's body inside the shared per-project db.transaction
    // is wrapped in its own try/catch, so one session's getLatestForTask throw
    // must not roll back / skip its sibling's capture in the same batch. This is
    // distinct from the "getProjectDb throws for one project" test above, which
    // covers isolation ACROSS projects, not across sessions within one project's
    // shared transaction.
    mockGetLatestForTask.mockImplementation((taskId: string) => {
      if (taskId === 'task-throws') {
        throw new Error('DB read failed for task-throws');
      }
      return makeRunningRecord();
    });

    const sessions = [
      makeSession({ id: 'session-throws', taskId: 'task-throws', projectId: 'proj-shared', status: 'running' }),
      makeSession({ id: 'session-ok', taskId: 'task-ok', projectId: 'proj-shared', status: 'running' }),
    ];
    const manager = makeManagerStub(sessions);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    // session-throws's getLatestForTask threw; session-ok, in the same project's
    // shared transaction, must still have been captured.
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);
    expect(mockCaptureSessionMetrics).toHaveBeenCalledWith(
      manager,
      expect.anything(),
      expect.anything(),
      'session-ok',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('groups sessions by project: one getProjectDb + one transaction per project', () => {
    // Each project's captures commit in a single transaction, so a project with
    // multiple running sessions opens the DB once and runs one transaction.
    let transactionCalls = 0;
    mockGetProjectDb.mockImplementation(() => ({
      transaction: (fn: () => void) => () => { transactionCalls += 1; fn(); },
    }));

    const sessions = [
      makeSession({ id: 's-a1', taskId: 't-a1', projectId: 'proj-a', status: 'running' }),
      makeSession({ id: 's-a2', taskId: 't-a2', projectId: 'proj-a', status: 'running' }),
      makeSession({ id: 's-b1', taskId: 't-b1', projectId: 'proj-b', status: 'running' }),
    ];
    const manager = makeManagerStub(sessions);
    startMetricsSnapshotTimer(manager);

    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);

    // Two distinct projects -> two getProjectDb opens, two transactions, but all
    // three sessions captured.
    expect(mockGetProjectDb).toHaveBeenCalledTimes(2);
    expect(transactionCalls).toBe(2);
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(3);
  });
});
