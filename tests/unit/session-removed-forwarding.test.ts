/**
 * Tests for the `session-removed` listener in registerSessionHandlers
 * (src/main/ipc/handlers/sessions.ts).
 *
 * Two behaviors of that one listener are covered here:
 *
 * 1. Background-buffer purge (HOLE 1). The 'usage' and 'event' listeners in
 *    the same file buffer non-focused sessions' emissions into `bufferedUsage`
 *    / `bufferedEvents` and flush them on a 2s timer (BACKGROUND_FLUSH_MS).
 *    Without purging a removed session's entries first, the sequence is: a
 *    background session's usage ticks buffer -> the task moves to To Do (or
 *    is deleted/reset), firing `remove()` and the renderer drops the row and
 *    clears `sessionUsage[id]` -> two seconds later the timer fires and
 *    broadcasts a SESSION_USAGE for the removed id -> the renderer writes
 *    `sessionUsage[id]` back under a row that no longer exists. That is the
 *    stale context bar of #661 arriving two seconds late. The purge must be
 *    TARGETED (only the removed session's entries), never a blanket clear of
 *    the buffers - the positive-control cases below pin that.
 *
 * 2. The forwarder itself (HOLE 2). Every OTHER main-side consumer of
 *    `session-removed` (activity recorder, message-trail tracker, monitor,
 *    mobile-bridge feed) has its own unit test; this is the one that actually
 *    puts IPC.SESSION_REMOVED on the wire to the renderer, guarded by
 *    `!mainWindow.isDestroyed()`.
 *
 * `pop-out/window-broadcast`'s `broadcast()` is mocked (as in
 * monitor-push-gate.test.ts), rather than left real: `broadcast()` itself
 * re-checks `mainWindow.isDestroyed()` internally before it ever reaches
 * `webContents.send`, so asserting against `webContents.send` cannot tell
 * apart "the call-site guard in the listener runs `broadcast()`" from "the
 * call-site guard is missing/inverted and `broadcast()`'s own internal check
 * happened to swallow it" - confirmed empirically: inverting the listener's
 * `if (!context.mainWindow.isDestroyed())` guard left a `webContents.send`
 * -based assertion green. Asserting on the mock isolates the call site.
 * SESSION_EVENT's background flush does NOT go through `broadcast()` (it
 * calls `context.mainWindow.webContents.send` directly), so those assertions
 * stay on the fake `webContents.send`, matching the real code path exactly.
 *
 * Mock strategy for everything else mirrors
 * session-usage-event-focus-buffering.test.ts: electron, the DB helpers,
 * repositories, and the transition-engine chain are stubbed so
 * registerSessionHandlers can run headless; sessionManager.on captures every
 * handler per event (not just the last) into a Map, since more than one
 * listener subscribes to the same event name; fake timers drive the 2s
 * background flush deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

const capturedSessionEventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

const { mockBroadcast } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
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

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    pid: null,
    status: 'running',
    shell: '',
    cwd: '/mock/cwd',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    ...overrides,
  } as Session;
}

function fireUsage(sessionId: string, data: unknown): void {
  const handlers = capturedSessionEventHandlers.get('usage');
  if (!handlers || handlers.length === 0) throw new Error('usage handler was not registered');
  for (const handler of handlers) handler(sessionId, data);
}

function fireEvent(sessionId: string, event: unknown): void {
  const handlers = capturedSessionEventHandlers.get('event');
  if (!handlers || handlers.length === 0) throw new Error('event handler was not registered');
  for (const handler of handlers) handler(sessionId, event);
}

function fireSessionRemoved(sessionId: string, session: Session): void {
  const handlers = capturedSessionEventHandlers.get('session-removed');
  if (!handlers || handlers.length === 0) throw new Error('session-removed handler was not registered');
  for (const handler of handlers) handler(sessionId, session);
}

describe('sessions.ts session-removed listener', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    vi.useFakeTimers();
    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('background-buffer purge (#661: the late context-bar write)', () => {
    it('purges a removed session\'s buffered usage before the 2s flush fires, so no stale SESSION_USAGE reaches the renderer', () => {
      // sess-1 is unfocused (getFocusedSessions() is empty), so its usage tick buffers.
      fireUsage('sess-1', { totalTokens: 100 });
      expect(mockBroadcast).not.toHaveBeenCalled();

      fireSessionRemoved('sess-1', sessionFixture({ id: 'sess-1' }));
      mockBroadcast.mockClear(); // drop the SESSION_REMOVED broadcast call itself

      vi.advanceTimersByTime(2000);

      expect(mockBroadcast).not.toHaveBeenCalledWith(
        context.mainWindow,
        IPC.SESSION_USAGE,
        'sess-1',
        expect.anything(),
        expect.anything(),
      );
    });

    it('positive control: a DIFFERENT session\'s buffered usage still flushes, proving the purge is targeted, not blanket', () => {
      fireUsage('sess-1', { totalTokens: 100 });
      fireUsage('sess-2', { totalTokens: 200 });

      fireSessionRemoved('sess-1', sessionFixture({ id: 'sess-1' }));
      mockBroadcast.mockClear();

      vi.advanceTimersByTime(2000);

      expect(mockBroadcast).toHaveBeenCalledWith(
        context.mainWindow,
        IPC.SESSION_USAGE,
        'sess-2',
        { totalTokens: 200 },
        'proj-1',
      );
      expect(mockBroadcast).not.toHaveBeenCalledWith(
        context.mainWindow,
        IPC.SESSION_USAGE,
        'sess-1',
        expect.anything(),
        expect.anything(),
      );
    });

    it('purges a removed session\'s buffered events before the 2s flush fires, so no stale SESSION_EVENT reaches the renderer', () => {
      // Events flush through context.mainWindow.webContents.send directly
      // (not broadcast()), matching the real code path.
      fireEvent('sess-1', { type: 'tool_start' });
      expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();

      fireSessionRemoved('sess-1', sessionFixture({ id: 'sess-1' }));
      context.mainWindow.webContents.send.mockClear();

      vi.advanceTimersByTime(2000);

      expect(context.mainWindow.webContents.send).not.toHaveBeenCalledWith(
        IPC.SESSION_EVENT,
        'sess-1',
        expect.anything(),
        expect.anything(),
      );
    });

    it('positive control: a DIFFERENT session\'s buffered event still flushes, proving the events purge is targeted too', () => {
      fireEvent('sess-1', { type: 'tool_start' });
      fireEvent('sess-2', { type: 'tool_end' });

      fireSessionRemoved('sess-1', sessionFixture({ id: 'sess-1' }));
      context.mainWindow.webContents.send.mockClear();

      vi.advanceTimersByTime(2000);

      expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
        IPC.SESSION_EVENT,
        'sess-2',
        { type: 'tool_end' },
        'proj-1',
      );
      expect(context.mainWindow.webContents.send).not.toHaveBeenCalledWith(
        IPC.SESSION_EVENT,
        'sess-1',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('the SESSION_REMOVED forwarder', () => {
    it('broadcasts IPC.SESSION_REMOVED with the sessionId, the session snapshot, and its projectId', () => {
      const removedSession = sessionFixture({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1' });

      fireSessionRemoved('sess-1', removedSession);

      expect(mockBroadcast).toHaveBeenCalledWith(
        context.mainWindow,
        IPC.SESSION_REMOVED,
        'sess-1',
        removedSession,
        'proj-1',
      );
    });

    it('broadcasts nothing when the main window is destroyed', () => {
      context.mainWindow.isDestroyed.mockReturnValue(true);
      const removedSession = sessionFixture({ id: 'sess-1' });

      fireSessionRemoved('sess-1', removedSession);

      expect(mockBroadcast).not.toHaveBeenCalled();
    });
  });
});
