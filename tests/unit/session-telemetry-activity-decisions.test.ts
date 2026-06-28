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

function makeTelemetry(
  log: DecisionLog,
  notRunning: Set<string>,
  engineOverrides: Partial<NonNullable<SessionTelemetryOptions['activityEngineOptions']>> = {},
): SessionTelemetry {
  const options: SessionTelemetryOptions = {
    disableBgShellWatcher: true,
    activityEngineOptions: {
      bgShellEscapeHatchMs: 600_000,
      staleThinkingTimeoutMs: 600_000,
      idleStabilityWindowMs: 0,
      ...engineOverrides,
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
    it('forces thinking when output tokens grow while idle for >1s', () => {
      telemetry.initSession('s1'); // idle, idleTimestamp = now
      telemetry.processStatusUpdate('s1', usage(100, 50)); // seeds previousUsage
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
      vi.advanceTimersByTime(1_500); // idle for >1s
      telemetry.processStatusUpdate('s1', usage(200, 100)); // output tokens grew
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

    // Claude's totalInputTokens is current context-window occupancy (cache +
    // input), which climbs while a session is parked at its prompt (cache
    // settling, pending/pasted input, statusline) with no generation. Heartbeat
    // recovery must compare OUTPUT tokens only, or that context-fill alone
    // false-flips a correct hook-derived idle to thinking. Values mirror the real
    // #295 window-2 capture: output frozen at 4111 while context drifted up.
    it('does NOT recover when only input (context occupancy) grows', () => {
      telemetry.initSession('s1');
      telemetry.processStatusUpdate('s1', usage(443667, 4111));
      vi.advanceTimersByTime(1_500);
      telemetry.processStatusUpdate('s1', usage(447789, 4111)); // context grew, output frozen
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
    });

    it('recovers when output grows even if input is flat (real generation)', () => {
      telemetry.initSession('s1');
      telemetry.processStatusUpdate('s1', usage(447789, 200));
      vi.advanceTimersByTime(1_500);
      telemetry.processStatusUpdate('s1', usage(447789, 959)); // output grew: the agent resumed
      expect(telemetry.getActivityCache()['s1']).toBe('thinking');
    });

    // Contract: heartbeat recovery compares OUTPUT tokens only. A drop in
    // output tokens must never flip idle to thinking, regardless of how
    // much input (context-window occupancy) grew. This directly pins the
    // diff that replaced summed-token comparison with output-only comparison.
    //
    // Red-green: the old summed-token logic would compute
    //   (500 + 90) = 590 > (100 + 100) = 200 -> force thinking (wrong).
    // The current output-only logic computes
    //   90 > 100 -> false -> stays idle (correct).
    it('does NOT recover when output tokens drop even if input grows substantially', () => {
      telemetry.initSession('s1');
      telemetry.processStatusUpdate('s1', usage(100, 100)); // seed: input=100, output=100
      vi.advanceTimersByTime(1_500); // idle for >1s, past the grace window
      telemetry.processStatusUpdate('s1', usage(500, 90)); // input rose, output DROPPED
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

    // Task #294: a parked Claude session ticks total_output_tokens upward on
    // background housekeeping (compaction/summarization) with NO turn-start hook.
    // When the idle was hook-AUTHORITATIVE (a real Idle/Stop or idle_hint that
    // ended the turn), that output growth must NOT force-think it back to active -
    // the agent told us it is parked. (The fresh-initSession idle in the tests
    // above is NON-authoritative, which is why it correctly recovers; this is the
    // provenance distinction.)
    //
    // Red-green: drop the `!state.idleAuthoritative` guard in processStatusUpdate
    // and this goes red (the second status update force-thinks the parked agent).
    it('does NOT recover when output grows but the idle is hook-authoritative (parked agent)', () => {
      telemetry.initSession('s1');
      telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]); // thinking
      telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Idle }]); // hook-authoritative idle
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
      telemetry.processStatusUpdate('s1', usage(602813, 1273)); // seed previousUsage
      vi.advanceTimersByTime(1_500); // idle for >1s, past the grace
      telemetry.processStatusUpdate('s1', usage(610402, 1400)); // output grew (housekeeping)
      expect(telemetry.getActivityCache()['s1']).toBe('idle');
    });

    // The guard is provenance-scoped, not a blanket suppression: a FALLBACK idle
    // (here the stale-thinking watchdog reclaimed a stuck turn) still recovers
    // when output grows, since the engine only GUESSED the turn ended. This pins
    // that the heartbeat's real job (waking a non-authoritative idle whose agent
    // is actually generating) survives the fix.
    it('STILL recovers when output grows on a non-authoritative (watchdog) idle', () => {
      const localLog: DecisionLog = { activityChanges: [], events: [], suspends: [], idleTimeouts: [] };
      const localTelemetry = makeTelemetry(localLog, new Set(), { staleThinkingTimeoutMs: 1_000 });
      localTelemetry.initSession('s1');
      localTelemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]); // thinking
      vi.advanceTimersByTime(1_100); // stale-thinking watchdog reclaims -> fallback idle
      expect(localTelemetry.getActivityCache()['s1']).toBe('idle');
      localTelemetry.processStatusUpdate('s1', usage(100, 50)); // seed previousUsage
      vi.advanceTimersByTime(1_500);
      localTelemetry.processStatusUpdate('s1', usage(100, 120)); // output grew: real generation
      expect(localTelemetry.getActivityCache()['s1']).toBe('thinking');
      localTelemetry.dispose();
    });

    // Task #294 part 2: once idle_hint is pending, status.json churn is parked-TUI
    // statusline noise, not proof of work - the heartbeat must NOT keep refreshing
    // lastSignalAt, or it re-blinds the stale-thinking net and pins a stuck turn.
    //
    // Red-green: drop the `&& !state.idleHintPending` guard on the markThinkingSignal
    // call and this goes red (the mid-window heartbeat re-arms the watchdog, so the
    // stuck turn never idles within the window).
    it('heartbeat does NOT keep a stuck turnActive warm once idle_hint is pending (part 2)', () => {
      const localLog: DecisionLog = { activityChanges: [], events: [], suspends: [], idleTimeouts: [] };
      const localTelemetry = makeTelemetry(localLog, new Set(), { staleThinkingTimeoutMs: 1_000 });
      const now = Date.now();
      localTelemetry.initSession('s1');
      localTelemetry.ingestEvents('s1', [{ ts: now, type: EventType.Prompt }]); // thinking
      localTelemetry.ingestEvents('s1', [{ ts: now, type: EventType.ToolStart, tool: 'Bash', toolId: 't1' }]);
      localTelemetry.ingestEvents('s1', [{ ts: now, type: EventType.IdleHint, detail: 'Claude is waiting for your input' }]);
      localTelemetry.ingestEvents('s1', [{ ts: now, type: EventType.ToolEnd, tool: 'Bash', toolId: 't1' }]);
      // Stuck: turnActive true, counters zero, idle_hint pending; lastSignalAt
      // frozen at the ToolEnd, the stale-thinking timer armed for 1000ms.
      expect(localTelemetry.getActivityCache()['s1']).toBe('thinking');

      vi.advanceTimersByTime(600); // a heartbeat lands BEFORE the stale window
      localTelemetry.processStatusUpdate('s1', usage(100, 50));
      vi.advanceTimersByTime(600); // total 1200ms > the 1000ms stale window
      expect(localTelemetry.getActivityCache()['s1']).toBe('idle');
      localTelemetry.dispose();
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
