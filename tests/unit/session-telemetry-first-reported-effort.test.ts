/**
 * Wiring test for the first reported effort level, read through SessionTelemetry.
 *
 * `SessionManager.getFirstReportedEffort` delegates to
 * `SessionTelemetry.getFirstReportedEffort`, which delegates to
 * `UsageAccumulator.getFirstReportedEffort`. The accumulator has its own tests;
 * this file crosses the SessionTelemetry delegation through the real public
 * ingest path (`processStatusUpdate`, the status.json channel), so a getter
 * that stops delegating, or an ingest path that stops feeding the accumulator,
 * goes red here.
 *
 * Red-green: making SessionTelemetry.getFirstReportedEffort return null, or
 * removing the `firstReportedEffort.delete` in UsageAccumulator.removeSession,
 * fails the matching assertion below.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionUsage } from '../../src/shared/types';

function makeTelemetry(): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: () => {},
      isSessionRunning: () => true,
    },
    { disableBgShellWatcher: true },
  );
}

function usageWithEffort(effort: string): SessionUsage {
  return {
    contextWindow: {
      usedPercentage: 0,
      usedTokens: 0,
      cacheTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      contextWindowSize: 200_000,
    },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort },
  };
}

describe('SessionTelemetry.getFirstReportedEffort', () => {
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    telemetry = makeTelemetry();
  });

  afterEach(() => {
    telemetry.dispose();
  });

  it('returns the first effort a session reported, not a later one', () => {
    telemetry.processStatusUpdate('session-a', usageWithEffort('high'));
    telemetry.processStatusUpdate('session-a', usageWithEffort('low'));

    expect(telemetry.getFirstReportedEffort('session-a')).toBe('high');
  });

  it('returns null for a session that never reported', () => {
    telemetry.processStatusUpdate('session-a', usageWithEffort('high'));

    expect(telemetry.getFirstReportedEffort('unknown-session')).toBeNull();
  });

  it('keeps each session\'s first effort separate', () => {
    telemetry.processStatusUpdate('session-a', usageWithEffort('high'));
    telemetry.processStatusUpdate('session-b', usageWithEffort('low'));

    expect(telemetry.getFirstReportedEffort('session-a')).toBe('high');
    expect(telemetry.getFirstReportedEffort('session-b')).toBe('low');
  });

  it('returns null again after removeSession, so a reused id does not inherit the old first level', () => {
    telemetry.processStatusUpdate('session-a', usageWithEffort('high'));
    expect(telemetry.getFirstReportedEffort('session-a')).toBe('high');

    telemetry.removeSession('session-a');

    expect(telemetry.getFirstReportedEffort('session-a')).toBeNull();
  });
});
