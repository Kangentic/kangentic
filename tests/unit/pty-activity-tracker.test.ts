/**
 * Direct unit tests for PtyActivityTracker, the PTY-pattern fallback that
 * infers activity for agents without hook event streams (Aider) or with
 * broken hooks (Codex). It is the second activity source alongside the
 * hook-driven ActivityEngine; SessionTelemetry suppresses it once hook
 * thinking events prove hooks work.
 *
 * Two mechanisms are pinned here:
 *  - prompt detection: `onIdleDetected` -> immediate idle (IdleReason.Prompt)
 *  - silence timer: 3s of no PTY data while thinking -> idle (IdleReason.Silence)
 * plus the two guards (`suppressed`, `!isSessionRunning`) on every entry point,
 * and timer cleanup on suppress / clearSession / dispose.
 *
 * The 3000ms threshold is PtyActivityTracker's real production constant; tests
 * use fake timers so they run in single-digit ms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PtyActivityTracker } from '../../src/main/activity-engine/pty-activity-tracker';
import { IdleReason } from '../../src/shared/types';
import type { ActivityState } from '../../src/shared/types';

const SESSION_ID = 'session-1';
const SILENCE_MS = 3_000;

interface Harness {
  tracker: PtyActivityTracker;
  thinkingCalls: string[];
  idleCalls: Array<{ sessionId: string; detail: IdleReason }>;
  setActivity(sessionId: string, activity: ActivityState): void;
  setRunning(sessionId: string, running: boolean): void;
}

function makeTracker(): Harness {
  const activity = new Map<string, ActivityState>();
  const running = new Set<string>();
  const thinkingCalls: string[] = [];
  const idleCalls: Array<{ sessionId: string; detail: IdleReason }> = [];

  const tracker = new PtyActivityTracker({
    onThinking(sessionId) {
      thinkingCalls.push(sessionId);
      activity.set(sessionId, 'thinking');
    },
    onIdle(sessionId, detail) {
      idleCalls.push({ sessionId, detail });
      activity.set(sessionId, 'idle');
    },
    getActivity(sessionId) {
      return activity.get(sessionId) ?? 'idle';
    },
    isSessionRunning(sessionId) {
      return running.has(sessionId);
    },
  });

  return {
    tracker,
    thinkingCalls,
    idleCalls,
    setActivity: (sessionId, value) => activity.set(sessionId, value),
    setRunning: (sessionId, value) => {
      if (value) running.add(sessionId);
      else running.delete(sessionId);
    },
  };
}

describe('PtyActivityTracker', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = makeTracker();
    harness.setRunning(SESSION_ID, true);
  });

  afterEach(() => {
    harness.tracker.dispose();
    vi.useRealTimers();
  });

  describe('onData', () => {
    it('wakes an idle session to thinking and arms the silence timer', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID);
      expect(harness.thinkingCalls).toEqual([SESSION_ID]);
    });

    it('does not re-fire onThinking when already thinking, but keeps the timer fresh', () => {
      harness.setActivity(SESSION_ID, 'thinking');
      harness.tracker.onData(SESSION_ID);
      expect(harness.thinkingCalls).toHaveLength(0);
    });

    it('is a no-op when suppressed', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.suppress(SESSION_ID);
      harness.tracker.onData(SESSION_ID);
      expect(harness.thinkingCalls).toHaveLength(0);
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
    });

    it('is a no-op when the session is not running', () => {
      harness.setRunning(SESSION_ID, false);
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID);
      expect(harness.thinkingCalls).toHaveLength(0);
    });
  });

  describe('silence timer', () => {
    it('idles a thinking session after 3s of no data (IdleReason.Silence)', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID); // idle -> thinking, arm timer
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toEqual([{ sessionId: SESSION_ID, detail: IdleReason.Silence }]);
    });

    it('resets the deadline on each new chunk (no premature idle)', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID); // arm at t=0
      vi.advanceTimersByTime(2_000);
      harness.tracker.onData(SESSION_ID); // re-arm at t=2000 (still thinking)
      vi.advanceTimersByTime(2_000); // t=4000, only 2s since re-arm
      expect(harness.idleCalls).toHaveLength(0);
      vi.advanceTimersByTime(1_000 + 10); // t=5000, 3s since re-arm
      expect(harness.idleCalls).toEqual([{ sessionId: SESSION_ID, detail: IdleReason.Silence }]);
    });

    it('does not idle if the session stopped running before the timer fired', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID);
      harness.setRunning(SESSION_ID, false);
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
    });

    it('does not idle if the session already left thinking before the timer fired', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID);
      harness.setActivity(SESSION_ID, 'permission'); // some other path moved it
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
    });
  });

  describe('onIdleDetected (prompt pattern)', () => {
    it('idles a thinking session immediately with IdleReason.Prompt', () => {
      harness.setActivity(SESSION_ID, 'thinking');
      harness.tracker.onIdleDetected(SESSION_ID);
      expect(harness.idleCalls).toEqual([{ sessionId: SESSION_ID, detail: IdleReason.Prompt }]);
    });

    it('does not re-fire when already idle (but still clears any armed timer)', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID); // thinking + armed timer
      harness.idleCalls.length = 0;
      harness.setActivity(SESSION_ID, 'idle'); // pretend it idled already
      harness.tracker.onIdleDetected(SESSION_ID);
      expect(harness.idleCalls).toHaveLength(0);
      // The timer was cleared, so no later Silence idle fires either.
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
    });

    it('is a no-op when suppressed', () => {
      harness.setActivity(SESSION_ID, 'thinking');
      harness.tracker.suppress(SESSION_ID);
      harness.tracker.onIdleDetected(SESSION_ID);
      expect(harness.idleCalls).toHaveLength(0);
    });

    it('is a no-op when the session is not running', () => {
      harness.setRunning(SESSION_ID, false);
      harness.setActivity(SESSION_ID, 'thinking');
      harness.tracker.onIdleDetected(SESSION_ID);
      expect(harness.idleCalls).toHaveLength(0);
    });
  });

  describe('timer cleanup', () => {
    it('isSuppressed reflects suppress() and suppress() cancels an armed timer', () => {
      expect(harness.tracker.isSuppressed(SESSION_ID)).toBe(false);
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID); // arm timer
      harness.tracker.suppress(SESSION_ID);
      expect(harness.tracker.isSuppressed(SESSION_ID)).toBe(true);
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
    });

    it('clearSession cancels the timer and un-suppresses', () => {
      harness.setActivity(SESSION_ID, 'idle');
      harness.tracker.onData(SESSION_ID); // arm timer
      harness.tracker.suppress(SESSION_ID);
      harness.tracker.clearSession(SESSION_ID);
      expect(harness.tracker.isSuppressed(SESSION_ID)).toBe(false);
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
    });

    it('dispose clears all timers and suppression and is idempotent', () => {
      const other = 'session-2';
      harness.setRunning(other, true);
      harness.setActivity(SESSION_ID, 'idle');
      harness.setActivity(other, 'idle');
      harness.tracker.onData(SESSION_ID);
      harness.tracker.onData(other);
      harness.tracker.suppress(SESSION_ID);

      harness.tracker.dispose();
      expect(harness.tracker.isSuppressed(SESSION_ID)).toBe(false);
      vi.advanceTimersByTime(SILENCE_MS + 10);
      expect(harness.idleCalls).toHaveLength(0);
      expect(() => harness.tracker.dispose()).not.toThrow();
    });
  });
});
