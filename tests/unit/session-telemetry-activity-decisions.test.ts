/**
 * Activity-decision tests for SessionTelemetry. The orchestrator's wiring is
 * covered by session-telemetry-wiring.test.ts; this file pins the three places
 * SessionTelemetry makes its OWN activity decision rather than delegating to
 * the engine's predicate:
 *
 *  - forceActivity(): the generic force primitive (PTY tracker / external).
 *  - processStatusUpdate(): heartbeat recovery - tokens grew while idle for
 *    >1s means the agent silently resumed, so force thinking.
 *  - checkIdleTimeouts(): the per-minute sweep that auto-suspends a session
 *    idle past the configured timeout.
 *
 * The bg-shell watcher is disabled (no OS process enumeration needed) and
 * engine timings are collapsed so transitions are synchronous.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionTelemetryOptions } from '../../src/main/activity-engine/session-telemetry';
import { EventType, Activity, IdleReason, PromptReason } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionEvent, SessionUsage } from '../../src/shared/types';

interface DecisionLog {
  activityChanges: Array<{ sessionId: string; activity: ActivityState; reason: ActivityReason }>;
  events: Array<{ sessionId: string; event: SessionEvent }>;
  suspends: string[];
  idleTimeouts: string[];
}

function makeTelemetry(log: DecisionLog, notRunning: Set<string>): SessionTelemetry {
  const options: SessionTelemetryOptions = {
    disableBgShellWatcher: true,
    activityEngineOptions: {
      bgShellEscapeHatchMs: 600_000,
      staleThinkingTimeoutMs: 600_000,
      idleStabilityWindowMs: 0,
    },
  };
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: (sessionId, activity, reason) => {
        log.activityChanges.push({ sessionId, activity, reason });
      },
      onEvent: (sessionId, event) => {
        log.events.push({ sessionId, event });
      },
      onIdleTimeout: (sessionId) => {
        log.idleTimeouts.push(sessionId);
      },
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: (sessionId) => {
        log.suspends.push(sessionId);
      },
      isSessionRunning: (sessionId) => !notRunning.has(sessionId),
    },
    options,
  );
}

/** Build a minimal valid SessionUsage with the given cumulative token totals. */
function usage(totalInputTokens: number, totalOutputTokens: number): SessionUsage {
  return {
    contextWindow: {
      usedPercentage: 0,
      usedTokens: totalInputTokens,
      cacheTokens: 0,
      totalInputTokens,
      totalOutputTokens,
      contextWindowSize: 200_000,
    },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus' },
  };
}

describe('SessionTelemetry activity decisions', () => {
  let log: DecisionLog;
  let notRunning: Set<string>;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    log = { activityChanges: [], events: [], suspends: [], idleTimeouts: [] };
    notRunning = new Set();
    telemetry = makeTelemetry(log, notRunning);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  describe('forceActivity', () => {
    it('forces thinking and pushes a synthetic PTY-activity Prompt event', () => {
      telemetry.initSession('s1');
      telemetry.forceActivity('s1', Activity.Thinking);
      expect(telemetry.getActivityCache()['s1']).toBe('thinking');
      const last = log.events[log.events.length - 1].event;
      expect(last.type).toBe(EventType.Prompt);
      expect(last.detail).toBe(PromptReason.PtyActivity);
    });

    it('forces idle and pushes a synthetic Idle/Prompt event', () => {
      telemetry.initSession('s1');
      telemetry.forceActivity('s1', Activity.Thinking);
      telemetry.forceActivity('s1', Activity.Idle);
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
      const last = log.events[log.events.length - 1].event;
      expect(last.type).toBe(EventType.Idle);
      expect(last.detail).toBe(IdleReason.Prompt);
    });
  });

  describe('processStatusUpdate heartbeat recovery', () => {
    it('forces thinking when tokens grow while idle for >1s', () => {
      telemetry.initSession('s1'); // idle, idleTimestamp = now
      telemetry.processStatusUpdate('s1', usage(100, 50)); // seeds previousUsage
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
      vi.advanceTimersByTime(1_500); // idle for >1s
      telemetry.processStatusUpdate('s1', usage(200, 100)); // tokens grew
      expect(telemetry.getActivityCache()['s1']).toBe('thinking');
    });

    it('does NOT recover within the 1s grace (race guard)', () => {
      telemetry.initSession('s1');
      telemetry.processStatusUpdate('s1', usage(100, 50));
      vi.advanceTimersByTime(500); // under the 1s grace
      telemetry.processStatusUpdate('s1', usage(200, 100));
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
    });

    it('does NOT recover when tokens did not grow', () => {
      telemetry.initSession('s1');
      telemetry.processStatusUpdate('s1', usage(100, 50));
      vi.advanceTimersByTime(1_500);
      telemetry.processStatusUpdate('s1', usage(100, 50)); // same totals
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
    });

    it('keeps a thinking session warm without forcing a transition', () => {
      telemetry.initSession('s1');
      telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]);
      expect(telemetry.getActivityCache()['s1']).toBe('thinking');
      log.activityChanges.length = 0;
      telemetry.processStatusUpdate('s1', usage(100, 50)); // markThinkingSignal branch
      expect(telemetry.getActivityCache()['s1']).toBe('thinking');
      expect(log.activityChanges).toHaveLength(0);
    });
  });

  describe('checkIdleTimeouts sweep', () => {
    // setIdleTimeout(1) arms a 60s sweep; advancing past two sweeps (plus a 1s
    // margin) lets the second sweep see the session's idle age exceed the 60s
    // timeout.
    const PAST_TWO_SWEEPS_MS = 121_000;

    it('suspends a session idle past the timeout', () => {
      telemetry.initSession('s1'); // idle at t0
      telemetry.setIdleTimeout(1); // 1 minute; arms the 60s sweep interval
      vi.advanceTimersByTime(PAST_TWO_SWEEPS_MS); // second sweep: idle age > 60s
      expect(log.suspends).toContain('s1');
      expect(log.idleTimeouts).toContain('s1');
    });

    it('does not suspend a thinking session', () => {
      telemetry.initSession('s1');
      telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]); // thinking
      telemetry.setIdleTimeout(1);
      vi.advanceTimersByTime(PAST_TWO_SWEEPS_MS);
      expect(log.suspends).not.toContain('s1');
    });

    it('does not suspend a session that is no longer running', () => {
      telemetry.initSession('s1');
      notRunning.add('s1');
      telemetry.setIdleTimeout(1);
      vi.advanceTimersByTime(PAST_TWO_SWEEPS_MS);
      expect(log.suspends).not.toContain('s1');
    });

    it('setIdleTimeout(0) cancels the sweep so an enrolled idle session is never suspended', () => {
      telemetry.initSession('s1'); // idle at t0
      telemetry.setIdleTimeout(1); // arm the 60s sweep interval
      telemetry.setIdleTimeout(0); // disarm: clears the interval, does not re-arm
      vi.advanceTimersByTime(PAST_TWO_SWEEPS_MS);
      expect(log.suspends).not.toContain('s1');
      expect(log.idleTimeouts).not.toContain('s1');
    });
  });
});
