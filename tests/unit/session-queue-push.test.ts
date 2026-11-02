/**
 * Tests for `scheduleQueuePush` in registerSessionHandlers
 * (src/main/ipc/handlers/sessions.ts): the push that tells the renderer who is
 * waiting for an agent slot.
 *
 * The contract, from the handler's own comment: a promotion changes several
 * rows at once, so changes are coalesced on a short timer; and the line is sent
 * only when it changed, so a board with nothing queued pushes nothing. It
 * listens to 'session-changed', 'session-removed' and 'queue-changed', and
 * sends nothing during shutdown or once the main window is destroyed.
 *
 * `readQueueSnapshot` is mocked (the DB reads behind it are covered by the
 * queue-snapshot tests), so the snapshot each tick sees is whatever the test
 * sets. `broadcast()` is mocked, as in session-removed-forwarding.test.ts, so
 * the assertions isolate the call site's own guards. The session-removed
 * listener also broadcasts SESSION_REMOVED, so every assertion filters by the
 * SESSION_QUEUE_CHANGED channel.
 *
 * Harness mirrors session-removed-forwarding.test.ts: electron, the DB layer
 * and the transition-engine chain are stubbed so registerSessionHandlers runs
 * headless, sessionManager.on captures every handler per event, and fake
 * timers drive the coalesce window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueueSnapshot, QueueTask } from '../../src/shared/types';

const capturedSessionEventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

const { mockBroadcast, mockReadQueueSnapshot, mockIsShuttingDown } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  mockReadQueueSnapshot: vi.fn(),
  mockIsShuttingDown: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  webContents: {
    fromId: vi.fn(() => undefined),
  },
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({
  broadcast: mockBroadcast,
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: mockIsShuttingDown,
}));

vi.mock('../../src/main/ipc/helpers/queue-snapshot', () => ({
  EMPTY_QUEUE_SNAPSHOT: { columns: [], global: [] },
  readQueueSnapshot: mockReadQueueSnapshot,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
    findByAnyId = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
  trackMilestone: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'main'),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/agent/message-trail-tracker', () => ({
  MessageTrailTracker: class {
    on = vi.fn();
    snapshot = vi.fn(() => ({}));
  },
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';

const COALESCE_MS = 100;

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false })),
      getSessionTaskId: vi.fn(() => 'task-1' as string | null | undefined),
      getSessionProjectId: vi.fn(() => 'proj-1' as string | null | undefined),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        const handlers = capturedSessionEventHandlers.get(event) ?? [];
        handlers.push(handler);
        capturedSessionEventHandlers.set(event, handlers);
      }),
      listSessions: vi.fn(() => []),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

function fire(eventName: string, ...args: unknown[]): void {
  const handlers = capturedSessionEventHandlers.get(eventName);
  if (!handlers || handlers.length === 0) throw new Error(`${eventName} handler was not registered`);
  for (const handler of handlers) handler(...args);
}

function queueTask(id: string): QueueTask {
  return { sessionId: `sess-${id}`, taskId: `task-${id}`, projectId: 'proj-1', projectName: 'Sample app', title: `Task ${id}`, displayId: 1 };
}

function snapshotWaiting(...ids: string[]): QueueSnapshot {
  const waiting = ids.map(queueTask);
  return {
    columns: [{ projectId: 'proj-1', swimlaneId: 'lane-1', columnName: 'Merge', maxAgents: 1, holders: [], waiting }],
    global: waiting,
  };
}

function queuePushes(): unknown[][] {
  return mockBroadcast.mock.calls.filter((call) => call[1] === IPC.SESSION_QUEUE_CHANGED);
}

describe('sessions.ts scheduleQueuePush', () => {
  let context: ReturnType<typeof createMockContext>;
  let currentSnapshot: QueueSnapshot;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    vi.useFakeTimers();
    mockIsShuttingDown.mockReturnValue(false);
    currentSnapshot = snapshotWaiting('a');
    mockReadQueueSnapshot.mockImplementation(() => currentSnapshot);
    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of changes into one read and one broadcast of the new line', () => {
    fire('session-changed', 'sess-a', {});
    fire('queue-changed');
    fire('session-removed', 'sess-b', { id: 'sess-b', projectId: 'proj-1' });

    // Nothing is sent until the coalesce window closes.
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(queuePushes()).toHaveLength(0);

    vi.advanceTimersByTime(1);

    expect(mockReadQueueSnapshot).toHaveBeenCalledTimes(1);
    expect(queuePushes()).toHaveLength(1);
    expect(queuePushes()[0]).toEqual([context.mainWindow, IPC.SESSION_QUEUE_CHANGED, currentSnapshot]);
  });

  it.each(['session-changed', 'session-removed', 'queue-changed'])('a %s alone schedules a push', (eventName) => {
    fire(eventName, 'sess-a', { id: 'sess-a', projectId: 'proj-1' });

    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(1);
  });

  it('sends nothing when the line is unchanged since the last push', () => {
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(queuePushes()).toHaveLength(1);

    // Same line, rebuilt as a fresh object: compared by content, not identity.
    currentSnapshot = snapshotWaiting('a');
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(mockReadQueueSnapshot).toHaveBeenCalledTimes(2);
    expect(queuePushes()).toHaveLength(1);
  });

  it('sends again when the line changes after a push', () => {
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    currentSnapshot = snapshotWaiting('a', 'b');
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(2);
    expect(queuePushes()[1][2]).toEqual(snapshotWaiting('a', 'b'));
  });

  it('pushes nothing for a board that never had a queue', () => {
    currentSnapshot = { columns: [], global: [] };

    fire('session-changed', 'sess-a', {});
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(0);
  });

  it('pushes the empty line when the queue drains after a push', () => {
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    currentSnapshot = { columns: [], global: [] };
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(2);
    expect(queuePushes()[1][2]).toEqual({ columns: [], global: [] });
  });

  it('sends nothing when the main window is destroyed, and does not remember the skipped line', () => {
    context.mainWindow.isDestroyed.mockReturnValue(true);
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(0);
    expect(mockReadQueueSnapshot).not.toHaveBeenCalled();

    // A live window afterwards still gets the line the skipped tick would have sent.
    context.mainWindow.isDestroyed.mockReturnValue(false);
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(1);
  });

  it('sends nothing during shutdown, and does not remember the skipped line', () => {
    mockIsShuttingDown.mockReturnValue(true);
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(0);
    expect(mockReadQueueSnapshot).not.toHaveBeenCalled();

    mockIsShuttingDown.mockReturnValue(false);
    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(1);
  });

  it('survives a failed read: warns, sends nothing, and the next change schedules again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadQueueSnapshot.mockImplementationOnce(() => {
      throw new Error('database is closed');
    });

    fire('queue-changed');
    expect(() => vi.advanceTimersByTime(COALESCE_MS)).not.toThrow();

    expect(queuePushes()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);

    fire('queue-changed');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(queuePushes()).toHaveLength(1);
    warn.mockRestore();
  });
});
