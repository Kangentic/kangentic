/**
 * The KPI tiles' own arithmetic, extracted out of `KpiTiles.tsx` into pure
 * helpers so it can be pinned. None of it had coverage before: the live
 * overlay layering, the token split, the cache share and the session-duration
 * average were all inline expressions in the component, and every one of them
 * was a defect the usage audit found.
 *
 * Each block names the wrong number it replaced, so a regression reads as a
 * return to that number rather than as an unexplained assertion.
 */

import { describe, it, expect } from 'vitest';
import type { SessionStatus, UsageKpis } from '../../src/shared/types';
import {
  resolveAvgActiveMs,
  resolveCacheReadShare,
  resolveDisplayCost,
  resolveTokenBuckets,
  selectLiveSessionIds,
} from '../../src/renderer/components/stats/useStatsData';

function makeKpis(overrides: Partial<UsageKpis> = {}): UsageKpis {
  return {
    totalCostUsd: 0,
    costKnown: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    sessionCount: 0,
    toolCallCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: 0,
    compactionCount: 0,
    totalDurationMs: 0,
    activeMs: 0,
    activeSessionsCovered: 0,
    turnInputTokens: 0,
    turnOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCacheCreationTokens: 0,
    subagentCacheReadTokens: 0,
    subagentTurnCount: 0,
    subagentCount: 0,
    subagentNestedCount: 0,
    burnRateTokensPerHour: null,
    burnRateUsdPerHour: null,
    ...overrides,
  };
}

function makeSession(id: string, projectId: string, status: SessionStatus, transient = false) {
  return { id, projectId, status, transient };
}

describe('resolveDisplayCost', () => {
  it('subtracts what the ledger already holds for the live sessions before layering', () => {
    // The $758 gap: a running session is upserted into the ledger every 45s,
    // so adding its in-memory cumulative reading on top counted it twice and
    // the Cost tile floated above the breakdowns, which get no overlay.
    const cost = resolveDisplayCost({
      isLivePeriod: false,
      ledgerCostUsd: 1000,
      liveLedgerBaselineCostUsd: 40,
      liveOverlayCostUsd: 55,
    });
    expect(cost).toBe(1015);
  });

  it('equals the ledger exactly when nothing is running', () => {
    // The invariant the breakdowns rely on: with no live session there is no
    // overlay and no baseline, so tile == sum(byModel) == sum(byAgent).
    expect(resolveDisplayCost({
      isLivePeriod: false,
      ledgerCostUsd: 1000,
      liveLedgerBaselineCostUsd: 0,
      liveOverlayCostUsd: 0,
    })).toBe(1000);
  });

  it('adds only the un-snapshotted delta while a session runs', () => {
    // A session whose ledger row is fully up to date contributes nothing extra.
    expect(resolveDisplayCost({
      isLivePeriod: false,
      ledgerCostUsd: 1000,
      liveLedgerBaselineCostUsd: 55,
      liveOverlayCostUsd: 55,
    })).toBe(1000);
  });

  it('shows the in-memory numbers alone for the live period', () => {
    // Live is the trailing two hours, so the ledger does not enter.
    expect(resolveDisplayCost({
      isLivePeriod: true,
      ledgerCostUsd: 1000,
      liveLedgerBaselineCostUsd: 40,
      liveOverlayCostUsd: 7,
    })).toBe(7);
  });
});

describe('resolveTokenBuckets', () => {
  it('reports the four types disjointly, from the TURN ledger', () => {
    // The old tile summed `usage_history`'s token columns, which are
    // context-window snapshots: 4,122 sessions x ~317k of context read as
    // "1333.7M tokens", a number that measured context size, not consumption.
    const buckets = resolveTokenBuckets(makeKpis({
      totalInputTokens: 1_308_878_620,
      totalOutputTokens: 24_405_535,
      turnInputTokens: 20_307_634,
      turnOutputTokens: 216_693_223,
      cacheCreationTokens: 1_305_952_147,
      cacheReadTokens: 94_543_575_247,
    }));
    expect(buckets.freshInputTokens).toBe(20_307_634);
    expect(buckets.outputTokens).toBe(216_693_223);
    expect(buckets.cacheCreationTokens).toBe(1_305_952_147);
    expect(buckets.cacheReadTokens).toBe(94_543_575_247);
    expect(buckets.hasTokens).toBe(true);
  });

  it('reports no tokens rather than zero tokens for a range with no turns', () => {
    // Anything predating the per-turn ledger. "-" and "0" are different claims.
    expect(resolveTokenBuckets(makeKpis({ totalCostUsd: 500 })).hasTokens).toBe(false);
    expect(resolveTokenBuckets(null).hasTokens).toBe(false);
  });

  it('counts a range as having tokens when only cache moved', () => {
    expect(resolveTokenBuckets(makeKpis({ cacheReadTokens: 1 })).hasTokens).toBe(true);
  });
});

describe('resolveCacheReadShare', () => {
  it('matches the cache hit rate ccusage reports', () => {
    // cache_read / (cache_read + cache_creation + uncached_input).
    const share = resolveCacheReadShare({
      freshInputTokens: 10,
      outputTokens: 999,
      cacheCreationTokens: 30,
      cacheReadTokens: 60,
      hasTokens: true,
    });
    expect(share).toBeCloseTo(0.6, 10);
  });

  it('leaves OUTPUT out of the denominator', () => {
    // It is a share of INPUT. Folding output in would make the rate drift with
    // how talkative the agent was.
    const withOutput = resolveCacheReadShare({
      freshInputTokens: 10, outputTokens: 1_000_000,
      cacheCreationTokens: 30, cacheReadTokens: 60, hasTokens: true,
    });
    const withoutOutput = resolveCacheReadShare({
      freshInputTokens: 10, outputTokens: 0,
      cacheCreationTokens: 30, cacheReadTokens: 60, hasTokens: true,
    });
    expect(withOutput).toBe(withoutOutput);
  });

  it('returns null, not zero, when the range has no input at all', () => {
    expect(resolveCacheReadShare({
      freshInputTokens: 0, outputTokens: 5,
      cacheCreationTokens: 0, cacheReadTokens: 0, hasTokens: true,
    })).toBeNull();
  });
});

describe('resolveAvgActiveMs', () => {
  it('divides by the interval ledger own session count, not the Sessions tile', () => {
    // The two ledgers cover different populations: per-interval recording
    // shipped later, so 1,205 of 2,433 records had coverage on the dogfooding
    // install. Dividing by the larger count under-reports every old range.
    expect(resolveAvgActiveMs(600_000, 4)).toBe(150_000);
  });

  it('returns null when the interval ledger does not reach the range', () => {
    // "Not measured" and "measured as nothing" are different; the tile shows
    // "-" for the first.
    expect(resolveAvgActiveMs(0, 0)).toBeNull();
    expect(resolveAvgActiveMs(600_000, 0)).toBeNull();
  });
});

describe('selectLiveSessionIds', () => {
  const sessions = [
    makeSession('running-a', 'p1', 'running'),
    makeSession('queued-a', 'p1', 'queued'),
    makeSession('suspended-a', 'p1', 'suspended'),
    makeSession('exited-a', 'p1', 'exited'),
    makeSession('running-b', 'p2', 'running'),
  ];

  it('excludes suspended and exited sessions', () => {
    // `sessionUsage` retains them (it is reconciled against main's usage cache,
    // which holds a session until it leaves the registry) and each carries its
    // full cumulative cost. Two suspended sessions held $783 on the dogfooding
    // install, against a reported $758 gap.
    const ids = selectLiveSessionIds(sessions, {
      includeLive: true, scopeKind: 'all', effectiveProjectId: null,
    });
    expect([...ids].sort()).toEqual(['queued-a', 'running-a', 'running-b']);
  });

  it('scopes to the viewed project', () => {
    const ids = selectLiveSessionIds(sessions, {
      includeLive: true, scopeKind: 'project', effectiveProjectId: 'p1',
    });
    expect([...ids].sort()).toEqual(['queued-a', 'running-a']);
  });

  it('spans projects when the app-wide scope has no project id', () => {
    const ids = selectLiveSessionIds(sessions, {
      includeLive: true, scopeKind: 'project', effectiveProjectId: null,
    });
    expect(ids.size).toBe(3);
  });

  it('is empty when live layering is off', () => {
    // A day drill or custom window is pure ledger accounting over a possibly
    // past range, so in-memory usage must not layer onto it.
    expect(selectLiveSessionIds(sessions, {
      includeLive: false, scopeKind: 'all', effectiveProjectId: null,
    }).size).toBe(0);
  });

  it('excludes a running Command Terminal, which main never measures a baseline for', () => {
    // `buildLiveSessionRows` skips transient sessions, so `liveLedgerBaseline`
    // holds nothing for one - while `getUsageCache` does NOT filter them, and a
    // transient spawn passes a statusOutputPath, so a Command Terminal running
    // Claude does sit in `sessionUsage` carrying real cumulative cost. Layering
    // that on would add cost the ledger has no row for and the baseline cannot
    // subtract, putting the Cost tile back above the breakdowns.
    const withCommandTerminal = [
      makeSession('agent-a', 'p1', 'running'),
      makeSession('command-terminal-a', 'p1', 'running', true),
    ];
    const ids = selectLiveSessionIds(withCommandTerminal, {
      includeLive: true, scopeKind: 'all', effectiveProjectId: null,
    });
    expect([...ids]).toEqual(['agent-a']);
  });

  it('keeps a live session that carries no transient flag at all', () => {
    // The flag is optional on the DTO, so an absent one must read as "not
    // transient" rather than excluding every task agent from the overlay.
    const ids = selectLiveSessionIds(
      [{ id: 'agent-b', projectId: 'p1', status: 'running' as SessionStatus }],
      { includeLive: true, scopeKind: 'all', effectiveProjectId: null },
    );
    expect([...ids]).toEqual(['agent-b']);
  });
});
