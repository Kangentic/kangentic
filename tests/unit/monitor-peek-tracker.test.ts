import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MonitorPeekTracker, PEEK_SAMPLE_INTERVAL_MS } from '../../src/main/monitor/monitor-peek-tracker';
import type { SessionManager } from '../../src/main/pty/session-manager';

/**
 * The live output-peek tracker.
 *
 * Two properties carry the design and are what these tests exist to hold:
 *
 *  1. COST. The peek is the only monitor stream with a standing cost in main (a
 *     PTY output listener plus a sampling timer), so it must attach only while a
 *     monitor is on screen and detach when the last one goes away. `data-tap`
 *     emits are a no-op with no listener, so detaching is what makes a closed
 *     monitor genuinely free.
 *  2. QUIET. A repainting TUI produces output constantly while its visible text
 *     is unchanged. Sampling only DIRTY sessions and pushing only CHANGED text is
 *     what keeps that from becoming a push every 500ms per session forever.
 */

class FakeSessionManager extends EventEmitter {
  peeks = new Map<string, string[]>();
  summaries: Array<{ id: string }> = [];

  listManagedSummaries() {
    return this.summaries;
  }

  getOutputPeek(sessionId: string): string[] {
    return this.peeks.get(sessionId) ?? [];
  }
}

function makeTracker() {
  const sessionManager = new FakeSessionManager();
  const emit = vi.fn<(peeks: Record<string, string[]>) => void>();
  const tracker = new MonitorPeekTracker({
    sessionManager: sessionManager as unknown as SessionManager,
    emit,
  });
  return { sessionManager, emit, tracker };
}

/** Count of `data-tap` listeners, i.e. whether main is watching PTY output. */
function tapListeners(sessionManager: FakeSessionManager): number {
  return sessionManager.listenerCount('data-tap');
}

describe('MonitorPeekTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('the cost gate', () => {
    it('watches PTY output only while a monitor is subscribed', () => {
      const { sessionManager, tracker } = makeTracker();
      expect(tapListeners(sessionManager)).toBe(0);

      tracker.subscribe(1);
      expect(tapListeners(sessionManager)).toBe(1);

      tracker.unsubscribe(1);
      expect(tapListeners(sessionManager)).toBe(0);
    });

    it('keeps watching while a SECOND subscriber remains', () => {
      // The detached monitor window is an independent subscriber; one closing
      // must not cut off the other.
      const { sessionManager, tracker } = makeTracker();
      tracker.subscribe(1);
      tracker.subscribe(2);
      expect(tapListeners(sessionManager)).toBe(1);

      tracker.unsubscribe(1);
      expect(tapListeners(sessionManager)).toBe(1);

      tracker.unsubscribe(2);
      expect(tapListeners(sessionManager)).toBe(0);
    });

    it('stops sampling once detached, so no timer survives a closed monitor', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      tracker.subscribe(1);
      tracker.unsubscribe(1);
      emit.mockClear();

      sessionManager.peeks.set('a', ['later output']);
      sessionManager.emit('data-tap', 'a', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS * 3);

      expect(emit).not.toHaveBeenCalled();
    });

    it('is idempotent per subscriber id', () => {
      const { sessionManager, tracker } = makeTracker();
      tracker.subscribe(1);
      tracker.subscribe(1);
      expect(tapListeners(sessionManager)).toBe(1);
      tracker.unsubscribe(1);
      expect(tapListeners(sessionManager)).toBe(0);
    });
  });

  describe('seeding', () => {
    it('pushes every live session on subscribe, so an idle one is never blank', () => {
      // An idle session emits no output, so without the seed it would produce no
      // sample and its card would stay empty until it happened to speak.
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }, { id: 'b' }];
      sessionManager.peeks.set('a', ['alpha']);
      sessionManager.peeks.set('b', ['bravo']);

      tracker.subscribe(1);

      expect(emit).toHaveBeenCalledWith({ a: ['alpha'], b: ['bravo'] });
    });

    it('re-seeds a LATER subscriber even though the text has not changed', () => {
      // The change-gate is about avoiding redundant pushes over time, not about
      // starving a window that just opened and has received nothing yet.
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      sessionManager.peeks.set('a', ['alpha']);

      tracker.subscribe(1);
      emit.mockClear();
      tracker.subscribe(2);

      expect(emit).toHaveBeenCalledWith({ a: ['alpha'] });
    });

    it('forgets a session as soon as it exits, not just on the next subscribe', () => {
      // `lastSent` otherwise only shrinks on a re-subscribe, so a monitor left
      // open all day accumulates one entry per session that ever spoke.
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      sessionManager.peeks.set('a', ['alpha']);
      tracker.subscribe(1);
      emit.mockClear();

      sessionManager.emit('exit', 'a', 0);

      // The change-gate entry is gone, so the SAME text would push again rather
      // than being suppressed as a duplicate. That is what proves it was dropped.
      sessionManager.emit('data-tap', 'a', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);
      expect(emit).toHaveBeenCalledWith({ a: ['alpha'] });
    });

    it('forgets sessions the registry no longer lists', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'gone' }];
      sessionManager.peeks.set('gone', ['old']);
      tracker.subscribe(1);

      // The session exits and leaves the registry; a later seed must not carry it.
      sessionManager.summaries = [];
      emit.mockClear();
      tracker.subscribe(2);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('sampling', () => {
    it('samples only sessions that produced output', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }, { id: 'b' }];
      sessionManager.peeks.set('a', ['alpha']);
      sessionManager.peeks.set('b', ['bravo']);
      tracker.subscribe(1);
      emit.mockClear();

      sessionManager.peeks.set('a', ['alpha 2']);
      sessionManager.peeks.set('b', ['bravo 2']);
      // Only 'a' reported output, so only 'a' is resampled - 'b' keeps its stale
      // value rather than costing a grid read it did not earn.
      sessionManager.emit('data-tap', 'a', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({ a: ['alpha 2'] });
    });

    it('does not push when the visible text is unchanged', () => {
      // The repainting-TUI case: bytes keep arriving, the grid keeps saying the
      // same thing, so nothing should cross IPC.
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      sessionManager.peeks.set('a', ['steady']);
      tracker.subscribe(1);
      emit.mockClear();

      for (let tick = 0; tick < 5; tick++) {
        sessionManager.emit('data-tap', 'a', 'repaint bytes');
        vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);
      }

      expect(emit).not.toHaveBeenCalled();
    });

    it('coalesces a burst of output into one sample per interval', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      tracker.subscribe(1);
      emit.mockClear();

      for (let chunk = 0; chunk < 50; chunk++) {
        sessionManager.emit('data-tap', 'a', 'chunk');
      }
      sessionManager.peeks.set('a', ['final line']);
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({ a: ['final line'] });
    });

    it('never pushes an empty batch', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      tracker.subscribe(1);
      emit.mockClear();

      // Output arrived but the grid yields nothing worth showing.
      sessionManager.emit('data-tap', 'a', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS * 2);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('the per-session gate', () => {
    // A subscriber names the sessions whose cards draw a peek. With the card's
    // slot following Card Preview, most cards draw the agent's messages instead,
    // so this is what keeps an open monitor from sampling every agent on the
    // machine for text nobody sees.
    it('drops output from a session the subscriber did not name, at the tap', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }, { id: 'b' }];
      sessionManager.peeks.set('a', ['alpha']);
      sessionManager.peeks.set('b', ['bravo']);

      tracker.subscribe(1, new Set(['a']));
      // The seed covers only the wanted session.
      expect(emit).toHaveBeenCalledWith({ a: ['alpha'] });
      emit.mockClear();

      sessionManager.peeks.set('b', ['bravo 2']);
      sessionManager.emit('data-tap', 'b', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);
      expect(emit).not.toHaveBeenCalled();

      sessionManager.peeks.set('a', ['alpha 2']);
      sessionManager.emit('data-tap', 'a', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);
      expect(emit).toHaveBeenCalledWith({ a: ['alpha 2'] });
    });

    it('keeps the listener and the timer off while a subscriber wants nothing', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }];
      sessionManager.peeks.set('a', ['alpha']);

      tracker.subscribe(1, new Set());
      expect(tapListeners(sessionManager)).toBe(0);
      expect(emit).not.toHaveBeenCalled();

      // Naming a session later attaches and seeds just that session.
      tracker.subscribe(1, new Set(['a']));
      expect(tapListeners(sessionManager)).toBe(1);
      expect(emit).toHaveBeenCalledWith({ a: ['alpha'] });

      // Dropping it again detaches without unsubscribing.
      tracker.subscribe(1, new Set());
      expect(tapListeners(sessionManager)).toBe(0);
      tracker.unsubscribe(1);
      expect(tapListeners(sessionManager)).toBe(0);
    });

    it('re-stating the same set seeds nothing; adding a session seeds only that session', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }, { id: 'b' }];
      sessionManager.peeks.set('a', ['alpha']);
      sessionManager.peeks.set('b', ['bravo']);

      tracker.subscribe(1, new Set(['a']));
      emit.mockClear();
      tracker.subscribe(1, new Set(['a']));
      expect(emit).not.toHaveBeenCalled();

      tracker.subscribe(1, new Set(['a', 'b']));
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({ b: ['bravo'] });
    });

    it('samples the union of what every subscriber wants', () => {
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      tracker.subscribe(1, new Set(['a']));
      tracker.subscribe(2, new Set(['b']));
      emit.mockClear();

      sessionManager.peeks.set('a', ['alpha']);
      sessionManager.peeks.set('b', ['bravo']);
      sessionManager.peeks.set('c', ['charlie']);
      for (const sessionId of ['a', 'b', 'c']) sessionManager.emit('data-tap', sessionId, 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);

      expect(emit).toHaveBeenCalledWith({ a: ['alpha'], b: ['bravo'] });

      // One subscriber leaving narrows the union to the other's set.
      tracker.unsubscribe(1);
      emit.mockClear();
      sessionManager.peeks.set('a', ['alpha 2']);
      sessionManager.emit('data-tap', 'a', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);
      expect(emit).not.toHaveBeenCalled();
    });

    it('a subscriber naming nothing in particular still gets every session', () => {
      // The `null` form is what a caller that does not narrow sends.
      const { sessionManager, emit, tracker } = makeTracker();
      sessionManager.summaries = [{ id: 'a' }, { id: 'b' }];
      tracker.subscribe(1, new Set(['a']));
      tracker.subscribe(2, null);
      emit.mockClear();

      sessionManager.peeks.set('b', ['bravo']);
      sessionManager.emit('data-tap', 'b', 'bytes');
      vi.advanceTimersByTime(PEEK_SAMPLE_INTERVAL_MS);
      expect(emit).toHaveBeenCalledWith({ b: ['bravo'] });
    });
  });

  it('dispose detaches everything', () => {
    const { sessionManager, tracker } = makeTracker();
    tracker.subscribe(1);
    tracker.subscribe(2);
    tracker.dispose();
    expect(tapListeners(sessionManager)).toBe(0);
  });
});
