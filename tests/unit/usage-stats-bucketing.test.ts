/**
 * The pure bucketing/aggregation math behind the usage dashboard
 * (src/main/usage-stats/bucketing.ts). Everything here runs against plain
 * arrays (better-sqlite3 cannot load under vitest). Expectations for
 * local-boundary bucketing are computed via the SAME `Date` component APIs
 * the implementation uses, so the suite passes in any timezone (including
 * DST ones) without pinning an offset - what it locks is the RELATIONSHIP
 * (buckets align to local midnights/Mondays, ranges fold without gaps), not
 * absolute epoch values.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_TIME_DAILY_MAX_DAYS,
  LIVE_WINDOW_MS,
  MAX_SERIES_POINTS,
  TURN_GROUP_MS,
  allocateGroupCost,
  bucketStartFor,
  buildAgentBreakdown,
  buildBucketStarts,
  buildEffortBreakdown,
  buildModelBreakdown,
  buildSessionTokenTotals,
  computeKpis,
  foldCostSeries,
  foldTokenSeries,
  nextBucketStart,
  resolveAllTimeBucketKinds,
  resolveBucketing,
} from '../../src/main/usage-stats/bucketing';
import { resolvePreviousWindow } from '../../src/main/usage-stats/bucketing';
import { computePeriodCutoff } from '../../src/shared/period-cutoff';
import type { UsageHistoryRow } from '../../src/main/db/repositories/usage-history-repository';
import type { GroupedTurnUsageRow } from '../../src/main/retrieval/conversation/conversation-usage-store';

function makeGroup(overrides: Partial<GroupedTurnUsageRow> = {}): GroupedTurnUsageRow {
  return {
    bucketStartMs: 0,
    sessionId: 'session-1',
    model: 'model-x',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 500,
    turnCount: 1,
    ...overrides,
  };
}

function makeRow(overrides: Partial<UsageHistoryRow> = {}): UsageHistoryRow {
  return {
    sessionRecordId: 'session-1',
    sessionStartedAt: '2026-06-17T10:00:00.000Z',
    totalCostUsd: 1,
    totalInputTokens: 1000,
    totalOutputTokens: 400,
    totalDurationMs: 60_000,
    toolCallCount: 5,
    modelId: 'model-x',
    modelDisplayName: 'Model X',
    linesAdded: 10,
    linesRemoved: 2,
    filesChanged: 3,
    compactionCount: 0,
    agent: 'claude',
    effort: null,
    ...overrides,
  };
}

describe('resolveBucketing', () => {
  it('live: trailing 120-minute window aligned down to the 5-minute grid', () => {
    const nowMs = Date.now();
    const resolved = resolveBucketing('live', nowMs);
    expect(resolved.sinceMs).toBe(Math.floor((nowMs - LIVE_WINDOW_MS) / TURN_GROUP_MS) * TURN_GROUP_MS);
    expect(resolved.sinceMs! % TURN_GROUP_MS).toBe(0);
    expect(resolved.sinceIso).toBe(new Date(resolved.sinceMs!).toISOString());
    expect(resolved.tokenBucketKind).toBe('fiveMinutes');
  });

  it('today/week/month reuse computePeriodCutoff; all is unbounded', () => {
    const nowMs = Date.now();
    for (const period of ['today', 'week', 'month'] as const) {
      const resolved = resolveBucketing(period, nowMs);
      expect(resolved.sinceIso).toBe(computePeriodCutoff(period));
      expect(resolved.sinceMs).toBe(Date.parse(resolved.sinceIso!));
    }
    const all = resolveBucketing('all', nowMs);
    expect(all.sinceIso).toBeNull();
    expect(all.sinceMs).toBeNull();
    expect(all.tokenBucketKind).toBe('week');
  });

  it('picks half-hour token buckets for today and day buckets for week/month', () => {
    const nowMs = Date.now();
    // Hourly would give a fresh day only 1-2 points; half-hour caps at 48/day.
    expect(resolveBucketing('today', nowMs).tokenBucketKind).toBe('halfHour');
    expect(resolveBucketing('week', nowMs).tokenBucketKind).toBe('day');
    expect(resolveBucketing('month', nowMs).tokenBucketKind).toBe('day');
  });

  it('picks HOURLY cost buckets for today (a single day is one lonely daily bar) and daily/weekly beyond', () => {
    const nowMs = Date.now();
    expect(resolveBucketing('today', nowMs).costBucketKind).toBe('hour');
    expect(resolveBucketing('week', nowMs).costBucketKind).toBe('day');
    expect(resolveBucketing('month', nowMs).costBucketKind).toBe('day');
    expect(resolveBucketing('all', nowMs).costBucketKind).toBe('week');
  });

  it('All Time granularity adapts to the actual data span: daily for short histories, weekly beyond', () => {
    const dayMs = 24 * 3_600_000;
    const nowMs = Date.now();
    // A two-week history at weekly buckets is three lonely bars - use days.
    expect(resolveAllTimeBucketKinds(nowMs - 14 * dayMs, nowMs)).toEqual({
      tokenBucketKind: 'day',
      costBucketKind: 'day',
    });
    expect(resolveAllTimeBucketKinds(nowMs - ALL_TIME_DAILY_MAX_DAYS * dayMs, nowMs).costBucketKind).toBe('day');
    expect(resolveAllTimeBucketKinds(nowMs - (ALL_TIME_DAILY_MAX_DAYS + 30) * dayMs, nowMs)).toEqual({
      tokenBucketKind: 'week',
      costBucketKind: 'week',
    });
    // Empty history (rangeStart = now) degrades to daily, not an error.
    expect(resolveAllTimeBucketKinds(nowMs, nowMs).costBucketKind).toBe('day');
  });
});

describe('resolvePreviousWindow (the "vs previous period" comparison)', () => {
  it('today compares against yesterday; a drill against the preceding local day', () => {
    const todayStart = new Date(2026, 5, 17).getTime();
    const expected = {
      sinceMs: new Date(2026, 5, 16).getTime(),
      untilMs: todayStart,
    };
    expect(resolvePreviousWindow('today', todayStart, false)).toMatchObject(expected);
    expect(resolvePreviousWindow('week', todayStart, true)).toMatchObject(expected);
  });

  it('week compares against the previous local week and month against the previous month 1st', () => {
    const weekStart = new Date(2026, 5, 15).getTime(); // a Monday
    expect(resolvePreviousWindow('week', weekStart, false)).toMatchObject({
      sinceMs: new Date(2026, 5, 8).getTime(),
      untilMs: weekStart,
    });
    const monthStart = new Date(2026, 5, 1).getTime();
    expect(resolvePreviousWindow('month', monthStart, false)).toMatchObject({
      sinceMs: new Date(2026, 4, 1).getTime(),
      untilMs: monthStart,
    });
  });

  it('live compares against the prior 2 hours; all time has no previous window', () => {
    const liveStart = TURN_GROUP_MS * 5000;
    expect(resolvePreviousWindow('live', liveStart, false)).toMatchObject({
      sinceMs: liveStart - LIVE_WINDOW_MS,
      untilMs: liveStart,
    });
    expect(resolvePreviousWindow('all', Date.now(), false)).toBeNull();
  });
});

describe('bucketStartFor / nextBucketStart (local calendar arithmetic)', () => {
  // 2026-06-17 is a Wednesday; constructed LOCALLY so getDay() is stable in
  // every timezone.
  const wednesdayAfternoon = new Date(2026, 5, 17, 14, 23, 45).getTime();

  it('day buckets start at local midnight', () => {
    expect(bucketStartFor(wednesdayAfternoon, 'day')).toBe(new Date(2026, 5, 17).getTime());
  });

  it('hour buckets start at the local hour', () => {
    expect(bucketStartFor(wednesdayAfternoon, 'hour')).toBe(new Date(2026, 5, 17, 14).getTime());
  });

  it('week buckets start at the local Monday (matching computePeriodCutoff)', () => {
    expect(bucketStartFor(wednesdayAfternoon, 'week')).toBe(new Date(2026, 5, 15).getTime());
    // A Sunday belongs to the week that started the PREVIOUS Monday.
    const sunday = new Date(2026, 5, 21, 9).getTime();
    expect(bucketStartFor(sunday, 'week')).toBe(new Date(2026, 5, 15).getTime());
  });

  it('fiveMinutes buckets are fixed UTC-grid multiples', () => {
    const ms = TURN_GROUP_MS * 1000 + 42;
    expect(bucketStartFor(ms, 'fiveMinutes')).toBe(TURN_GROUP_MS * 1000);
  });

  it('nextBucketStart(day) survives DST transitions via Date component overflow', () => {
    // Walk 30 consecutive days from a fixed local date: every step lands on
    // the NEXT local midnight even across a DST shift (a 23h/25h day).
    let cursor = new Date(2026, 2, 1).getTime();
    for (let day = 2; day <= 31; day++) {
      cursor = nextBucketStart(cursor, 'day');
      expect(cursor).toBe(new Date(2026, 2, day).getTime());
    }
  });
});

describe('buildBucketStarts', () => {
  it('produces a dense local-day grid covering the range', () => {
    const rangeStart = new Date(2026, 5, 15, 8).getTime();
    const rangeEnd = new Date(2026, 5, 20, 12).getTime();
    const starts = buildBucketStarts(rangeStart, rangeEnd, 'day');
    expect(starts).toEqual([
      new Date(2026, 5, 15).getTime(),
      new Date(2026, 5, 16).getTime(),
      new Date(2026, 5, 17).getTime(),
      new Date(2026, 5, 18).getTime(),
      new Date(2026, 5, 19).getTime(),
      new Date(2026, 5, 20).getTime(),
    ]);
  });

  it('clamps to the newest MAX_SERIES_POINTS buckets for long ranges', () => {
    const rangeEnd = TURN_GROUP_MS * 10_000;
    const rangeStart = rangeEnd - TURN_GROUP_MS * 600;
    const starts = buildBucketStarts(rangeStart, rangeEnd, 'fiveMinutes');
    expect(starts).toHaveLength(MAX_SERIES_POINTS);
    // The newest bucket survives the clamp; the oldest are dropped.
    expect(starts[starts.length - 1]).toBe(rangeEnd - TURN_GROUP_MS);
  });

  it('returns an empty grid for an empty range', () => {
    const now = Date.now();
    expect(buildBucketStarts(now, now, 'day').length).toBeLessThanOrEqual(1);
  });
});

describe('cost allocation', () => {
  it('splits a session cost across its groups proportionally by fresh tokens', () => {
    const groups = [
      makeGroup({ bucketStartMs: 0, inputTokens: 20, outputTokens: 10 }),   // 30 tokens
      makeGroup({ bucketStartMs: TURN_GROUP_MS, inputTokens: 50, outputTokens: 20 }), // 70 tokens
    ];
    const costs = new Map([['session-1', 10]]);
    const totals = buildSessionTokenTotals(groups);
    expect(totals.get('session-1')).toBe(100);
    expect(allocateGroupCost(groups[0], costs, totals)).toBeCloseTo(3);
    expect(allocateGroupCost(groups[1], costs, totals)).toBeCloseTo(7);
  });

  it('allocates zero for unknown sessions, zero-cost sessions, and null session ids', () => {
    const groups = [makeGroup({ sessionId: null }), makeGroup({ sessionId: 'other' })];
    const totals = buildSessionTokenTotals(groups);
    expect(allocateGroupCost(groups[0], new Map(), totals)).toBe(0);
    expect(allocateGroupCost(groups[1], new Map([['other', 0]]), totals)).toBe(0);
  });
});

describe('foldTokenSeries', () => {
  it('folds 5-minute groups into local-hour buckets, dense and zero-filled', () => {
    const hourStart = new Date(2026, 5, 17, 10).getTime();
    const starts = [hourStart, new Date(2026, 5, 17, 11).getTime(), new Date(2026, 5, 17, 12).getTime()];
    const groups = [
      makeGroup({ bucketStartMs: hourStart + TURN_GROUP_MS, inputTokens: 10, outputTokens: 5 }),
      makeGroup({ bucketStartMs: hourStart + 2 * TURN_GROUP_MS, inputTokens: 20, outputTokens: 5 }),
      makeGroup({ bucketStartMs: new Date(2026, 5, 17, 12, 30).getTime(), inputTokens: 7, outputTokens: 3 }),
    ];
    const series = foldTokenSeries(groups, new Map(), starts, 'hour');
    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ bucketStartMs: starts[0], inputTokens: 30, outputTokens: 10, turnCount: 2 });
    expect(series[1]).toMatchObject({ bucketStartMs: starts[1], inputTokens: 0, outputTokens: 0, turnCount: 0 });
    expect(series[2]).toMatchObject({ bucketStartMs: starts[2], inputTokens: 7, outputTokens: 3 });
  });

  it('drops groups older than the (clamped) first bucket', () => {
    const dayStart = new Date(2026, 5, 17).getTime();
    const starts = [dayStart];
    const groups = [
      makeGroup({ bucketStartMs: new Date(2026, 5, 10, 12).getTime(), inputTokens: 999 }),
      makeGroup({ bucketStartMs: dayStart + TURN_GROUP_MS, inputTokens: 5 }),
    ];
    const series = foldTokenSeries(groups, new Map(), starts, 'day');
    expect(series[0].inputTokens).toBe(5);
  });
});

describe('foldCostSeries', () => {
  it('buckets session rows by the LOCAL day the session started', () => {
    const day1 = new Date(2026, 5, 17, 9, 30);
    const day2 = new Date(2026, 5, 18, 22, 0);
    const starts = [new Date(2026, 5, 17).getTime(), new Date(2026, 5, 18).getTime()];
    const rows = [
      makeRow({ sessionRecordId: 'a', sessionStartedAt: day1.toISOString(), totalCostUsd: 2 }),
      makeRow({ sessionRecordId: 'b', sessionStartedAt: day1.toISOString(), totalCostUsd: 3 }),
      makeRow({ sessionRecordId: 'c', sessionStartedAt: day2.toISOString(), totalCostUsd: 5 }),
    ];
    const series = foldCostSeries(rows, starts, 'day');
    expect(series[0]).toMatchObject({ costUsd: 5, sessionCount: 2 });
    expect(series[1]).toMatchObject({ costUsd: 5, sessionCount: 1 });
  });

  it('carries per-model splits (normalized base ids) that sum to the bucket totals', () => {
    const day = new Date(2026, 5, 17, 9, 30);
    const starts = [new Date(2026, 5, 17).getTime()];
    const rows = [
      makeRow({ sessionRecordId: 'a', sessionStartedAt: day.toISOString(), totalCostUsd: 2, totalInputTokens: 100, modelId: 'claude-opus-4-8' }),
      // Dated pin of the same base model merges into one slice.
      makeRow({ sessionRecordId: 'b', sessionStartedAt: day.toISOString(), totalCostUsd: 3, totalInputTokens: 50, modelId: 'claude-opus-4-8-20250514' }),
      makeRow({ sessionRecordId: 'c', sessionStartedAt: day.toISOString(), totalCostUsd: 1, totalInputTokens: 25, modelId: null }),
    ];
    const [point] = foldCostSeries(rows, starts, 'day');
    expect(point.byModel).toHaveLength(2);
    const opus = point.byModel.find((slice) => slice.modelId === 'claude-opus-4-8');
    const unknown = point.byModel.find((slice) => slice.modelId === null);
    expect(opus).toMatchObject({ costUsd: 5, inputTokens: 150 });
    expect(unknown).toMatchObject({ costUsd: 1, inputTokens: 25 });
    const sliceCostSum = point.byModel.reduce((sum, slice) => sum + slice.costUsd, 0);
    expect(sliceCostSum).toBeCloseTo(point.costUsd);
  });
});

describe('computeKpis', () => {
  it('sums usage_history fields and derives turn-side cache/burn fields', () => {
    const rows = [
      makeRow({ sessionRecordId: 'a', totalCostUsd: 2, totalInputTokens: 100, totalOutputTokens: 50 }),
      makeRow({ sessionRecordId: 'b', totalCostUsd: 0, totalInputTokens: 10, totalOutputTokens: 5, agent: null }),
    ];
    const groups = [
      makeGroup({ sessionId: 'a', inputTokens: 600, outputTokens: 200, cacheReadTokens: 1000, cacheCreationTokens: 50 }),
      makeGroup({ sessionId: 'a', inputTokens: 100, outputTokens: 100, cacheReadTokens: 500, cacheCreationTokens: 25 }),
    ];
    const costs = new Map([['a', 2], ['b', 0]]);
    const twoHoursMs = 2 * 3_600_000;
    const kpis = computeKpis(rows, groups, costs, twoHoursMs);

    expect(kpis.totalCostUsd).toBe(2);
    expect(kpis.costKnown).toBe(true);
    expect(kpis.totalTokens).toBe(165);
    expect(kpis.sessionCount).toBe(2);
    expect(kpis.turnInputTokens).toBe(700);
    expect(kpis.turnOutputTokens).toBe(300);
    expect(kpis.cacheReadTokens).toBe(1500);
    expect(kpis.cacheCreationTokens).toBe(75);
    // 1000 turn tokens over 2 hours.
    expect(kpis.burnRateTokensPerHour).toBeCloseTo(500);
    // The full $2 allocated across the window.
    expect(kpis.burnRateUsdPerHour).toBeCloseTo(1);
  });

  it('reports null burn rates with no turn data, and null $/hr when no cost was reported', () => {
    const noTurns = computeKpis([makeRow()], [], new Map(), 3_600_000);
    expect(noTurns.burnRateTokensPerHour).toBeNull();
    expect(noTurns.burnRateUsdPerHour).toBeNull();

    const noCost = computeKpis(
      [makeRow({ totalCostUsd: 0 })],
      [makeGroup()],
      new Map([['session-1', 0]]),
      3_600_000,
    );
    expect(noCost.costKnown).toBe(false);
    expect(noCost.burnRateTokensPerHour).not.toBeNull();
    expect(noCost.burnRateUsdPerHour).toBeNull();
  });

  it('floors the elapsed window at one minute so tiny ranges cannot explode the rate', () => {
    const kpis = computeKpis([], [makeGroup({ inputTokens: 60, outputTokens: 0 })], new Map(), 1);
    // 60 tokens over the 1-minute floor = 3600 tokens/hr, not 216M.
    expect(kpis.burnRateTokensPerHour).toBeCloseTo(3600);
  });
});

describe('breakdowns', () => {
  it('merges dated model pins and [1m] variants onto the base model id', () => {
    const rows = [
      makeRow({ sessionRecordId: 'a', modelId: 'claude-opus-4-8', totalInputTokens: 100 }),
      makeRow({ sessionRecordId: 'b', modelId: 'claude-opus-4-8-20250514', totalInputTokens: 50 }),
      makeRow({ sessionRecordId: 'c', modelId: 'claude-opus-4-8[1m]', totalInputTokens: 25 }),
      makeRow({ sessionRecordId: 'd', modelId: null, totalInputTokens: 5 }),
    ];
    const breakdown = buildModelBreakdown(rows);
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].modelId).toBe('claude-opus-4-8');
    expect(breakdown[0].sessionCount).toBe(3);
    expect(breakdown[1].modelId).toBeNull();
  });

  it('groups agents with null bucketed separately, sorted by tokens descending', () => {
    const rows = [
      makeRow({ sessionRecordId: 'a', agent: 'codex', totalInputTokens: 10 }),
      makeRow({ sessionRecordId: 'b', agent: 'claude', totalInputTokens: 500 }),
      makeRow({ sessionRecordId: 'c', agent: 'claude', totalInputTokens: 100 }),
      makeRow({ sessionRecordId: 'd', agent: null, totalInputTokens: 1 }),
    ];
    const breakdown = buildAgentBreakdown(rows);
    expect(breakdown.map((entry) => entry.agent)).toEqual(['claude', 'codex', null]);
    expect(breakdown[0].sessionCount).toBe(2);
  });

  it('groups efforts with null (agent default) as its own bucket, sorted by tokens descending', () => {
    const rows = [
      makeRow({ sessionRecordId: 'a', effort: 'high', totalInputTokens: 300, totalCostUsd: 3 }),
      makeRow({ sessionRecordId: 'b', effort: 'high', totalInputTokens: 200, totalCostUsd: 2 }),
      makeRow({ sessionRecordId: 'c', effort: 'low', totalInputTokens: 50 }),
      makeRow({ sessionRecordId: 'd', effort: null, totalInputTokens: 5000 }),
    ];
    const breakdown = buildEffortBreakdown(rows);
    expect(breakdown.map((entry) => entry.effort)).toEqual([null, 'high', 'low']);
    expect(breakdown[1].sessionCount).toBe(2);
    expect(breakdown[1].costUsd).toBe(5);
  });
});
