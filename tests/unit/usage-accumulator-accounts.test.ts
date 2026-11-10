/**
 * Two accounts of one agent each report a window with the same id (`seven-day`), often the same
 * reset time. They are different windows (task #1057): a reset on one account's window must not
 * bump the other account's generation, nor bring the other account's cached session up to it.
 *
 * Red-green: keying the generation lookup or the catch-up comparison by `window.id` alone
 * (dropping `rateLimitWindowKey`) makes the cross-account cases fail; the same-account control
 * guards against a fix that disables catch-up altogether.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { UsageAccumulator } from '../../src/main/activity-engine/usage-accumulator';
import type { SessionUsage } from '../../src/shared/types';

const SHARED_RESET = 1_792_508_400;

function sevenDayUsage(usedPercentage: number, accountId: string): SessionUsage {
  return {
    contextWindow: { usedPercentage: 0, usedTokens: 0, cacheTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, contextWindowSize: 0 },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    rateLimits: [
      {
        id: 'seven-day',
        label: '7d weekly',
        iconKind: 'period',
        usedPercentage,
        resetsAt: SHARED_RESET,
        windowDurationSeconds: 7 * 24 * 60 * 60,
        agent: 'claude',
        accountId,
      },
    ],
  };
}

describe('UsageAccumulator: rate-limit windows are kept apart per account', () => {
  let usage: UsageAccumulator;

  function cachedWindow(sessionId: string): { usedPercentage: number; generation: number | undefined } | undefined {
    const cached = usage.getUsageCache()[sessionId]?.rateLimits?.[0];
    return cached ? { usedPercentage: cached.usedPercentage, generation: cached.generation } : undefined;
  }

  beforeEach(() => {
    usage = new UsageAccumulator();
  });

  it('does not catch another account\'s session up to a reset, though the id and reset time match', () => {
    usage.replaceSessionUsage('session-on-1', sevenDayUsage(99, 'account-1'));
    usage.replaceSessionUsage('session-on-2', sevenDayUsage(80, 'account-2'));

    usage.replaceSessionUsage('session-on-1', sevenDayUsage(1, 'account-1'));

    expect(cachedWindow('session-on-1')).toEqual({ usedPercentage: 1, generation: 1 });
    expect(cachedWindow('session-on-2')).toEqual({ usedPercentage: 80, generation: 0 });
    expect(usage.takeSessionsCaughtUpToReset()).toEqual([]);
  });

  it('opens the first generation of the second account\'s window at 0, not behind the first account\'s count', () => {
    usage.replaceSessionUsage('session-on-1', sevenDayUsage(99, 'account-1'));
    usage.replaceSessionUsage('session-on-1', sevenDayUsage(1, 'account-1'));
    usage.replaceSessionUsage('session-on-2', sevenDayUsage(80, 'account-2'));

    expect(cachedWindow('session-on-2')).toEqual({ usedPercentage: 80, generation: 0 });
    // A drop on account 2 is its own reset: generation 1 for it, with account 1 left alone.
    usage.replaceSessionUsage('session-on-2', sevenDayUsage(2, 'account-2'));
    expect(cachedWindow('session-on-2')).toEqual({ usedPercentage: 2, generation: 1 });
    expect(cachedWindow('session-on-1')).toEqual({ usedPercentage: 1, generation: 1 });
    expect(usage.takeSessionsCaughtUpToReset()).toEqual([]);
  });

  it('still catches a second session on the same account up to its reset', () => {
    usage.replaceSessionUsage('session-a', sevenDayUsage(99, 'account-1'));
    usage.replaceSessionUsage('session-b', sevenDayUsage(99, 'account-1'));

    usage.replaceSessionUsage('session-a', sevenDayUsage(1, 'account-1'));

    expect(cachedWindow('session-b')).toEqual({ usedPercentage: 1, generation: 1 });
    expect(usage.takeSessionsCaughtUpToReset()).toEqual(['session-b']);
  });
});
