/**
 * SessionLifecycleBoardFeed bridges SessionManager lifecycle edges
 * (session-changed, exit) onto the BoardEventBus so a subscribed phone's
 * board view tracks spawn/queue/suspend/exit. Covered here: the
 * immediate emit, the coalesced settle re-emit, exit-time id resolution
 * through the registry getters, and dispose clearing every timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionLifecycleBoardFeed, type SessionLifecycleBoardFeedOptions } from '../../../src/main/mobile-bridge/session-lifecycle-feed';
import type { BoardChangedEvent } from '../../../src/main/mobile-bridge/board-event-bus';

class FakeSessionManager extends EventEmitter {
  getSessionTaskId = vi.fn((): string | undefined => 'task-1');
  getSessionProjectId = vi.fn((): string | undefined => 'proj-1');
  getSession = vi.fn((): Record<string, unknown> | undefined => sessionFixture());
}

function sessionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'running', ...overrides };
}

describe('SessionLifecycleBoardFeed', () => {
  let sessionManager: FakeSessionManager;
  let emitBoardChanged: ReturnType<typeof vi.fn>;
  let feed: SessionLifecycleBoardFeed;

  function eventsEmitted(): BoardChangedEvent[] {
    return emitBoardChanged.mock.calls.map(([event]) => event as BoardChangedEvent);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new FakeSessionManager();
    emitBoardChanged = vi.fn();
    feed = new SessionLifecycleBoardFeed({
      sessionManager: sessionManager as unknown as SessionLifecycleBoardFeedOptions['sessionManager'],
      boardEvents: { emitBoardChanged },
      settleDelayMs: 1000,
    });
    feed.start();
  });

  afterEach(() => {
    feed.dispose();
    vi.useRealTimers();
  });

  it('emits task-updated immediately on session-changed, then once more after the settle delay', () => {
    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    expect(eventsEmitted()).toEqual([{ projectId: 'proj-1', change: 'task-updated', ids: ['task-1'] }]);

    vi.advanceTimersByTime(1000);
    expect(eventsEmitted()).toEqual([
      { projectId: 'proj-1', change: 'task-updated', ids: ['task-1'] },
      { projectId: 'proj-1', change: 'task-updated', ids: ['task-1'] },
    ]);
  });

  it('emits task-updated on session-removed, the last edge a torn-down session has', () => {
    // A To Do reset or a task delete removes the row with no natural exit the
    // phone could ride; the removal carries the same (id, Session) payload.
    sessionManager.emit('session-removed', 'sess-1', sessionFixture({ status: 'exited' }));
    expect(eventsEmitted()).toEqual([{ projectId: 'proj-1', change: 'task-updated', ids: ['task-1'] }]);

    vi.advanceTimersByTime(1000);
    expect(eventsEmitted()).toHaveLength(2);
  });

  it('emits on exit, resolving the ids through the session-manager getters', () => {
    sessionManager.emit('exit', 'sess-1', 0, false);
    expect(sessionManager.getSessionTaskId).toHaveBeenCalledWith('sess-1');
    expect(sessionManager.getSessionProjectId).toHaveBeenCalledWith('sess-1');
    expect(eventsEmitted()).toEqual([{ projectId: 'proj-1', change: 'task-updated', ids: ['task-1'] }]);
  });

  it('skips an exit whose session cannot be resolved to a task and project', () => {
    sessionManager.getSessionTaskId.mockReturnValue(undefined);
    sessionManager.emit('exit', 'sess-ghost', 1, false);
    expect(emitBoardChanged).not.toHaveBeenCalled();
  });

  it('coalesces the settle re-emit per task: a burst of signals schedules exactly one', () => {
    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    sessionManager.emit('exit', 'sess-1', 0, true);
    expect(eventsEmitted()).toHaveLength(3); // three immediate emits

    vi.advanceTimersByTime(1000);
    expect(eventsEmitted()).toHaveLength(4); // one coalesced settle re-emit

    vi.advanceTimersByTime(5000);
    expect(eventsEmitted()).toHaveLength(4);
  });

  it('keeps settle timers independent across tasks', () => {
    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    sessionManager.emit('session-changed', 'sess-2', sessionFixture({ id: 'sess-2', taskId: 'task-2' }));
    vi.advanceTimersByTime(1000);
    const settleEmits = eventsEmitted().slice(2);
    expect(settleEmits.map((event) => event.ids[0]).sort()).toEqual(['task-1', 'task-2']);
  });

  it('a fresh signal after the settle fired schedules a new settle re-emit', () => {
    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    vi.advanceTimersByTime(1000);
    expect(eventsEmitted()).toHaveLength(2);

    sessionManager.emit('session-changed', 'sess-1', sessionFixture({ status: 'exited' }));
    vi.advanceTimersByTime(1000);
    expect(eventsEmitted()).toHaveLength(4);
  });

  it('dispose detaches the listeners and clears pending settle timers', () => {
    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    expect(eventsEmitted()).toHaveLength(1);

    feed.dispose();
    expect(sessionManager.listenerCount('session-changed')).toBe(0);
    expect(sessionManager.listenerCount('session-removed')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(eventsEmitted()).toHaveLength(1); // the pending settle never fires

    sessionManager.emit('session-changed', 'sess-1', sessionFixture());
    expect(eventsEmitted()).toHaveLength(1);
  });

  it('start is idempotent: a double start never doubles the listeners', () => {
    feed.start();
    expect(sessionManager.listenerCount('session-changed')).toBe(1);
    expect(sessionManager.listenerCount('session-removed')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);
  });

  describe('Command Terminals', () => {
    function terminalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return sessionFixture({
        id: 'term-1',
        taskId: 'made-up-uuid',
        transient: true,
        commandTerminalSlot: 'slot-1',
        commandTerminalLabel: null,
        ...overrides,
      });
    }

    it('never emits task-updated for a terminal: its task id names no board row', () => {
      sessionManager.getSession.mockReturnValue(terminalFixture());
      sessionManager.emit('session-changed', 'term-1', terminalFixture());
      sessionManager.emit('exit', 'term-1', 0, false);
      sessionManager.emit('session-removed', 'term-1', terminalFixture({ status: 'exited' }));
      vi.advanceTimersByTime(5000);
      expect(eventsEmitted().some((event) => event.change === 'task-updated')).toBe(false);
      expect(eventsEmitted().some((event) => event.ids.includes('made-up-uuid'))).toBe(false);
    });

    it('announces a start once, with the session id, and stays quiet on a status-only change', () => {
      sessionManager.emit('session-changed', 'term-1', terminalFixture());
      // An agent session id captured, say: same label, no news for the phone.
      sessionManager.emit('session-changed', 'term-1', terminalFixture());
      expect(eventsEmitted()).toEqual([{ projectId: 'proj-1', change: 'command-terminals-changed', ids: ['term-1'] }]);
      vi.advanceTimersByTime(5000);
      expect(eventsEmitted()).toHaveLength(1);
    });

    it('announces a rename when the derived name arrives', () => {
      sessionManager.emit('session-changed', 'term-1', terminalFixture());
      sessionManager.emit('session-changed', 'term-1', terminalFixture({ commandTerminalLabel: 'Audit Unused Feature Flags' }));
      expect(eventsEmitted()).toEqual([
        { projectId: 'proj-1', change: 'command-terminals-changed', ids: ['term-1'] },
        { projectId: 'proj-1', change: 'command-terminals-changed', ids: ['term-1'] },
      ]);
    });

    it('announces the end on removal, and a terminal reusing the id later counts as a new start', () => {
      sessionManager.emit('session-changed', 'term-1', terminalFixture());
      sessionManager.emit('session-removed', 'term-1', terminalFixture({ status: 'exited' }));
      expect(eventsEmitted()).toHaveLength(2);
      expect(eventsEmitted()[1]).toEqual({ projectId: 'proj-1', change: 'command-terminals-changed', ids: ['term-1'] });
      sessionManager.emit('session-changed', 'term-1', terminalFixture());
      expect(eventsEmitted()).toHaveLength(3);
    });

    it('does not subscribe to activity: a terminal\'s activity rides its own read-stream', () => {
      expect(sessionManager.listenerCount('activity')).toBe(0);
    });
  });
});
