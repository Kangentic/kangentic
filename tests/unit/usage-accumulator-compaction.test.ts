/**
 * Unit tests pinning the compaction-counting behavior added to
 * UsageAccumulator and SessionTelemetry.
 *
 * Behavior under test:
 *   - UsageAccumulator.recordCompaction(sessionId) increments a per-session
 *     counter.
 *   - UsageAccumulator.getCompactionCount(sessionId) returns the counter value,
 *     or 0 for a session that has never been recorded.
 *   - UsageAccumulator.removeSession(sessionId) now also clears the compaction
 *     counter so a reused session id starts fresh.
 *   - SessionTelemetry.ingestEvents() calls recordCompaction when it encounters
 *     an event with type EventType.Compact, and the count is retrievable via
 *     SessionTelemetry.getCompactionCount().
 *
 * Red-green anchors (each assertion fails if the cited line is reverted):
 *   - First recordCompaction -> 1: fails if the `+ 1` increment in
 *     usage-accumulator.ts line 227 is removed.
 *   - Second recordCompaction -> 2: same.
 *   - Unknown session -> 0: fails if the `?? 0` fallback in
 *     usage-accumulator.ts line 232 is removed.
 *   - After removeSession -> 0: fails if the `this.compactionCounts.delete`
 *     call in usage-accumulator.ts line 248 is removed.
 *   - SessionTelemetry Compact routing: fails if the
 *     `if (event.type === EventType.Compact) this.usage.recordCompaction`
 *     branch in session-telemetry.ts line 601 is removed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UsageAccumulator } from '../../src/main/activity-engine/usage-accumulator';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { SessionUsage, SessionEvent } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// UsageAccumulator - compaction counting
// ---------------------------------------------------------------------------

describe('UsageAccumulator - compaction counting', () => {
  let accumulator: UsageAccumulator;

  beforeEach(() => {
    accumulator = new UsageAccumulator();
  });

  it('getCompactionCount returns 0 for a session that has never been recorded', () => {
    expect(accumulator.getCompactionCount('unknown-session')).toBe(0);
  });

  it('first recordCompaction increments the counter to 1', () => {
    accumulator.recordCompaction('session-a');
    expect(accumulator.getCompactionCount('session-a')).toBe(1);
  });

  it('second recordCompaction increments the counter to 2', () => {
    accumulator.recordCompaction('session-a');
    accumulator.recordCompaction('session-a');
    expect(accumulator.getCompactionCount('session-a')).toBe(2);
  });

  it('compaction counts are independent across different sessions', () => {
    accumulator.recordCompaction('session-x');
    accumulator.recordCompaction('session-x');
    accumulator.recordCompaction('session-y');
    expect(accumulator.getCompactionCount('session-x')).toBe(2);
    expect(accumulator.getCompactionCount('session-y')).toBe(1);
  });

  it('removeSession clears the compaction count so a reused session id starts at 0', () => {
    accumulator.recordCompaction('session-b');
    accumulator.recordCompaction('session-b');
    expect(accumulator.getCompactionCount('session-b')).toBe(2); // pre-remove sanity
    accumulator.removeSession('session-b');
    expect(accumulator.getCompactionCount('session-b')).toBe(0);
  });

  it('removeSession for a session that had no compactions leaves the count at 0', () => {
    // No recordCompaction calls - removeSession must not throw.
    accumulator.removeSession('session-never-compacted');
    expect(accumulator.getCompactionCount('session-never-compacted')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SessionTelemetry - Compact event routing to recordCompaction
// ---------------------------------------------------------------------------

/** Minimal callbacks stub - only the required interface, no side effects. */
function makeCallbacks() {
  return {
    onUsageChange: (_sessionId: string, _usage: SessionUsage): void => {},
    onActivityChange: (): void => {},
    onEvent: (): void => {},
    onIdleTimeout: (): void => {},
    onPlanExit: (): void => {},
    onPRCandidate: (): void => {},
    requestSuspend: (): void => {},
    isSessionRunning: (): boolean => true,
  };
}

function makeSessionEvent(type: EventType): SessionEvent {
  return { ts: Date.now(), type };
}

describe('SessionTelemetry - Compact event increments compaction count', () => {
  const SESSION_ID = 'telemetry-compact-test';
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    telemetry = new SessionTelemetry(
      makeCallbacks(),
      { disableBgShellWatcher: true },
    );
    telemetry.initSession(SESSION_ID);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('ingesting one Compact event increments the session compaction count to 1', () => {
    telemetry.ingestEvents(SESSION_ID, [makeSessionEvent(EventType.Compact)]);
    expect(telemetry.getCompactionCount(SESSION_ID)).toBe(1);
  });

  it('ingesting two Compact events increments the session compaction count to 2', () => {
    telemetry.ingestEvents(SESSION_ID, [
      makeSessionEvent(EventType.Compact),
      makeSessionEvent(EventType.Compact),
    ]);
    expect(telemetry.getCompactionCount(SESSION_ID)).toBe(2);
  });

  it('non-Compact events do not affect the compaction count', () => {
    telemetry.ingestEvents(SESSION_ID, [
      makeSessionEvent(EventType.Prompt),
      makeSessionEvent(EventType.ToolStart),
      makeSessionEvent(EventType.ToolEnd),
      makeSessionEvent(EventType.Idle),
    ]);
    expect(telemetry.getCompactionCount(SESSION_ID)).toBe(0);
  });

  it('returns 0 for a session that has never received a Compact event', () => {
    expect(telemetry.getCompactionCount('never-compacted-session')).toBe(0);
  });
});
