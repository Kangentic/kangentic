/**
 * QueuePlaceFeed (src/main/mobile-bridge/queue-place-feed.ts): a phone's
 * queued card reads "Next in line..." or "# tasks ahead..." from its board row
 * (protocol 0.28.0), and a slot opening moves everyone behind it up without
 * any edge of their own sessions. Without this feed the phone's count stays
 * where it was until something else about the task changes.
 *
 * Runs the real feed, the real `queuePlacesByTaskId` and a real EventEmitter
 * for the session manager; only the snapshot read stands in.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuePlaceFeed, type QueuePlaceFeedOptions } from '../../../src/main/mobile-bridge/queue-place-feed';
import type { QueueSnapshot, QueueTask } from '../../../src/shared/types';
import type { SessionManager } from '../../../src/main/pty/session-manager';

function queued(taskId: string, projectId = 'proj-1', title: string | null = `Task ${taskId}`): QueueTask {
  return { sessionId: `sess-${taskId}`, taskId, projectId, projectName: 'Alpha', title, displayId: 1 };
}

interface Announcement {
  projectId: string;
  taskIds: string[];
}

describe('QueuePlaceFeed', () => {
  let sessionManager: EventEmitter;
  let snapshot: QueueSnapshot;
  let emitted: Announcement[];
  let feed: QueuePlaceFeed;

  function createFeed(overrides: Partial<QueuePlaceFeedOptions> = {}): QueuePlaceFeed {
    const created = new QueuePlaceFeed({
      sessionManager: sessionManager as unknown as Pick<SessionManager, 'on' | 'off'>,
      readSnapshot: () => snapshot,
      coalesceMs: 100,
      ...overrides,
    });
    created.onQueuePlacesChanged((projectId, taskIds) => emitted.push({ projectId, taskIds }));
    created.start();
    return created;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new EventEmitter();
    snapshot = { columns: [], global: [] };
    emitted = [];
    feed = createFeed();
  });

  afterEach(() => {
    feed.dispose();
    vi.useRealTimers();
  });

  it('announces every task behind a promoted one when the line drains, with no session edge of their own', () => {
    snapshot = { columns: [], global: [queued('a'), queued('b'), queued('c')] };
    sessionManager.emit('queue-changed');
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual([{ projectId: 'proj-1', taskIds: ['a', 'b', 'c'] }]);

    // A slot opened and 'a' was promoted: 'b' and 'c' each moved up one.
    emitted = [];
    snapshot = { columns: [], global: [queued('b'), queued('c')] };
    sessionManager.emit('queue-changed');
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual([{ projectId: 'proj-1', taskIds: ['b', 'c', 'a'] }]);
  });

  it('coalesces a burst of edges into one read, and announces nothing when no place changed', () => {
    const readSnapshot = vi.fn(() => snapshot);
    feed.dispose();
    feed = createFeed({ readSnapshot });
    snapshot = { columns: [], global: [queued('a')] };

    sessionManager.emit('session-changed');
    sessionManager.emit('queue-changed');
    sessionManager.emit('session-removed');
    vi.advanceTimersByTime(100);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);

    sessionManager.emit('session-changed');
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(1);
  });

  it('groups by project and leaves out a Command Terminal, which has no board row', () => {
    snapshot = { columns: [], global: [queued('a', 'proj-1'), queued('terminal', 'proj-1', null), queued('b', 'proj-2')] };
    sessionManager.emit('queue-changed');
    vi.advanceTimersByTime(100);

    expect(emitted).toEqual([
      { projectId: 'proj-1', taskIds: ['a'] },
      { projectId: 'proj-2', taskIds: ['b'] },
    ]);
  });

  it('announces a column limit change of place, kind included', () => {
    snapshot = { columns: [], global: [queued('a')] };
    sessionManager.emit('queue-changed');
    vi.advanceTimersByTime(100);
    emitted = [];

    // The Merge column's limit now holds 'a' back: same position, a new reason.
    const line = { projectId: 'proj-1', swimlaneId: 'lane-merge', columnName: 'Merge', maxAgents: 1, holders: [queued('holder')], waiting: [queued('a')] };
    snapshot = { columns: [line], global: [queued('a')] };
    sessionManager.emit('queue-changed');
    vi.advanceTimersByTime(100);

    expect(emitted).toEqual([{ projectId: 'proj-1', taskIds: ['a'] }]);
  });

  it('a read that fails costs a count, never the bridge', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    feed.dispose();
    feed = createFeed({ readSnapshot: () => { throw new Error('database is closed'); } });

    sessionManager.emit('queue-changed');
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(emitted).toEqual([]);
  });

  describe('listener lifecycle', () => {
    // The outer feed (with its own listener) shares this session manager; detach it.
    beforeEach(() => {
      feed.dispose();
    });

    function bareFeed(readSnapshot: () => QueueSnapshot): QueuePlaceFeed {
      return new QueuePlaceFeed({
        sessionManager: sessionManager as unknown as Pick<SessionManager, 'on' | 'off'>,
        readSnapshot,
        coalesceMs: 100,
      });
    }

    it('with no listener subscribed, queue events read nothing and announce nothing', () => {
      const readSnapshot = vi.fn(() => snapshot);
      const bare = bareFeed(readSnapshot);
      bare.start();
      snapshot = { columns: [], global: [queued('a')] };

      sessionManager.emit('queue-changed');
      vi.advanceTimersByTime(100);
      bare.flush();

      expect(readSnapshot).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
      bare.dispose();
    });

    it('after a quiet period with no listener, the first read announces every queued task once, even an unchanged one', () => {
      snapshot = { columns: [], global: [queued('a'), queued('b')] };
      const bare = bareFeed(() => snapshot);
      bare.start();
      const stop = bare.onQueuePlacesChanged((projectId, taskIds) => emitted.push({ projectId, taskIds }));
      sessionManager.emit('queue-changed');
      vi.advanceTimersByTime(100);
      expect(emitted).toEqual([{ projectId: 'proj-1', taskIds: ['a', 'b'] }]);

      // Nobody listens while the line stays exactly as it was.
      stop();
      sessionManager.emit('queue-changed');
      vi.advanceTimersByTime(100);
      emitted = [];

      bare.onQueuePlacesChanged((projectId, taskIds) => emitted.push({ projectId, taskIds }));
      sessionManager.emit('queue-changed');
      vi.advanceTimersByTime(100);
      expect(emitted).toEqual([{ projectId: 'proj-1', taskIds: ['a', 'b'] }]);
      bare.dispose();
    });

    it('calling start twice registers one listener per event, and dispose leaves none', () => {
      const bare = bareFeed(() => snapshot);
      bare.start();
      bare.start();
      expect(sessionManager.listenerCount('queue-changed')).toBe(1);
      expect(sessionManager.listenerCount('session-changed')).toBe(1);
      expect(sessionManager.listenerCount('session-removed')).toBe(1);

      bare.dispose();
      expect(sessionManager.listenerCount('queue-changed')).toBe(0);
      expect(sessionManager.listenerCount('session-changed')).toBe(0);
      expect(sessionManager.listenerCount('session-removed')).toBe(0);
    });

    it('flush and start after dispose do nothing', () => {
      const readSnapshot = vi.fn(() => snapshot);
      const bare = bareFeed(readSnapshot);
      bare.onQueuePlacesChanged((projectId, taskIds) => emitted.push({ projectId, taskIds }));
      bare.dispose();
      snapshot = { columns: [], global: [queued('a')] };

      bare.start();
      bare.flush();

      expect(sessionManager.listenerCount('queue-changed')).toBe(0);
      expect(readSnapshot).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });

    it('a listener that throws does not stop a second listener hearing the same batch', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const bare = bareFeed(() => snapshot);
      const heard: Announcement[] = [];
      bare.onQueuePlacesChanged(() => { throw new Error('phone gone'); });
      bare.onQueuePlacesChanged((projectId, taskIds) => heard.push({ projectId, taskIds }));
      snapshot = { columns: [], global: [queued('a')] };

      bare.flush();

      expect(heard).toEqual([{ projectId: 'proj-1', taskIds: ['a'] }]);
      expect(warn).toHaveBeenCalled();
      bare.dispose();
    });
  });

  it('dispose detaches every listener and clears a pending read, synchronously', () => {
    snapshot = { columns: [], global: [queued('a')] };
    sessionManager.emit('queue-changed');
    feed.dispose();

    vi.advanceTimersByTime(100);
    expect(emitted).toEqual([]);
    expect(sessionManager.listenerCount('queue-changed')).toBe(0);
    expect(sessionManager.listenerCount('session-changed')).toBe(0);
    expect(sessionManager.listenerCount('session-removed')).toBe(0);
  });
});
