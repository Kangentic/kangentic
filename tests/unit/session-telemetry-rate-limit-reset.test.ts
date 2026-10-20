/**
 * A free usage reset seen by one session must reach the renderer through every
 * session it brought up, not only the one that saw it. The renderer drops usage
 * from other projects, so when the resetting session belongs to another project
 * the re-emitted sibling is the only way the reset arrives. These tests drive
 * the real status-update ingest and record what `onUsageChange` emits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionUsage } from '../../src/shared/types';

const SEVEN_DAY_RESET = 1_792_508_400;

function makeTracker(onUsageChange: (sessionId: string, usage: SessionUsage) => void): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange,
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

function statusWithSevenDay(usedPercentage: number): SessionUsage {
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
    model: { id: 'sonnet', displayName: 'Claude Sonnet' },
    rateLimits: [
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt: SEVEN_DAY_RESET, windowDurationSeconds: 7 * 24 * 60 * 60 },
    ],
  };
}

describe('SessionTelemetry: a free usage reset re-emits the sessions it brought up', () => {
  let emitted: Array<{ sessionId: string; usedPercentage: number | undefined; generation: number | undefined }>;
  let tracker: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    tracker = makeTracker((sessionId, usage) => {
      const sevenDay = usage.rateLimits?.[0];
      emitted.push({ sessionId, usedPercentage: sevenDay?.usedPercentage, generation: sevenDay?.generation });
    });
    tracker.initSession('sess-resetting');
    tracker.initSession('sess-stale');
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('emits the resetting session first, then the stale sibling carrying the reset', () => {
    tracker.processStatusUpdate('sess-resetting', statusWithSevenDay(99));
    tracker.processStatusUpdate('sess-stale', statusWithSevenDay(99));
    emitted.length = 0;

    tracker.processStatusUpdate('sess-resetting', statusWithSevenDay(1));

    expect(emitted).toEqual([
      { sessionId: 'sess-resetting', usedPercentage: 1, generation: 1 },
      { sessionId: 'sess-stale', usedPercentage: 1, generation: 1 },
    ]);
  });

  it('keeps a stale repeat emitting the caught-up value, not the pre-reset one', () => {
    tracker.processStatusUpdate('sess-resetting', statusWithSevenDay(99));
    tracker.processStatusUpdate('sess-stale', statusWithSevenDay(99));
    tracker.processStatusUpdate('sess-resetting', statusWithSevenDay(1));
    emitted.length = 0;

    tracker.processStatusUpdate('sess-stale', statusWithSevenDay(99));

    expect(emitted).toEqual([{ sessionId: 'sess-stale', usedPercentage: 1, generation: 1 }]);
  });

  it('re-emits the stale sibling after a reset reported through the merge path too', () => {
    tracker.processStatusUpdate('sess-resetting', statusWithSevenDay(99));
    tracker.processStatusUpdate('sess-stale', statusWithSevenDay(99));
    emitted.length = 0;

    // The Codex and Gemini route: a partial usage upsert instead of a status.json replace.
    tracker.setSessionUsage('sess-resetting', { rateLimits: statusWithSevenDay(1).rateLimits });

    expect(emitted).toEqual([
      { sessionId: 'sess-resetting', usedPercentage: 1, generation: 1 },
      { sessionId: 'sess-stale', usedPercentage: 1, generation: 1 },
    ]);
  });
});
