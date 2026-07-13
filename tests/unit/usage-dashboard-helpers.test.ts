/**
 * Pure renderer-side derivations for the usage dashboard: the store's cache
 * key / bound, the donut fold (top-6 + Other, "(unknown)" handling, fixed slot
 * order), and the chart series derivations. The store module is imported under
 * a stubbed `window` (its actions read window.electronAPI at CALL time only;
 * creating the store just subscribes to the config store, which is inert
 * here).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('window', {
    electronAPI: {
      config: { set: vi.fn() },
      usage: { getDashboardStats: vi.fn(async () => ({})) },
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

import {
  boundCache,
  dashboardCacheKey,
  type DashboardCacheEntry,
} from '../../src/renderer/stores/usage-dashboard-store';
import {
  MAX_DONUT_SLICES,
  OTHER_SLICE_VAR,
  UNKNOWN_SLICE_VAR,
  deriveBurnRateSeries,
  deriveCostSparkline,
  deriveCumulative,
  deriveCumulativeFromTokenSeries,
  deriveModelStack,
  deriveTokenTypeStack,
  foldBreakdownForDonut,
  type BreakdownEntry,
} from '../../src/renderer/components/stats/useStatsData';
import type { CostSeriesPoint, TokenSeriesPoint, UsageDashboardStats } from '../../src/shared/types';

function makeEntry(id: string | null, tokens: number, costUsd = 0): BreakdownEntry {
  return { id, label: id, inputTokens: tokens, outputTokens: 0, costUsd };
}

function makeCacheEntry(): DashboardCacheEntry {
  return { payload: {} as UsageDashboardStats, fetchedAt: 0 };
}

describe('dashboardCacheKey', () => {
  it('keys project scope by project id and all scope without one', () => {
    expect(dashboardCacheKey('project', 'p1', 'week')).toBe('project:p1:week:base:full');
    expect(dashboardCacheKey('all', 'p1', 'live')).toBe('all:all:live:base:full');
    expect(dashboardCacheKey('project', null, 'all')).toBe('project:none:all:base:full');
  });

  it('separates day-drill payloads from the base range', () => {
    expect(dashboardCacheKey('project', 'p1', 'week', 1750000000000)).toBe('project:p1:week:1750000000000:full');
    expect(dashboardCacheKey('project', 'p1', 'week', null)).toBe('project:p1:week:base:full');
  });

  it('separates custom-window payloads by their bounds', () => {
    expect(dashboardCacheKey('project', 'p1', 'month', null, { sinceMs: 100, untilMs: 200 }))
      .toBe('project:p1:month:base:100-200');
    expect(dashboardCacheKey('project', 'p1', 'month', null, null)).toBe('project:p1:month:base:full');
  });
});

describe('boundCache', () => {
  it('evicts the OLDEST insertions once past the cap', () => {
    const cache: Record<string, DashboardCacheEntry> = {};
    for (let index = 0; index < 25; index++) {
      cache[`key-${index}`] = makeCacheEntry();
    }
    const bounded = boundCache(cache, 20);
    expect(Object.keys(bounded)).toHaveLength(20);
    expect(bounded['key-0']).toBeUndefined();
    expect(bounded['key-4']).toBeUndefined();
    expect(bounded['key-5']).toBeDefined();
    expect(bounded['key-24']).toBeDefined();
  });

  it('returns the same object when under the cap', () => {
    const cache = { one: makeCacheEntry() };
    expect(boundCache(cache, 20)).toBe(cache);
  });
});

describe('foldBreakdownForDonut', () => {
  it('assigns the fixed categorical slots in order and folds the tail into Other', () => {
    const entries = Array.from({ length: 9 }, (_, index) => makeEntry(`model-${index}`, 1000 - index));
    const slices = foldBreakdownForDonut(entries);

    expect(slices).toHaveLength(MAX_DONUT_SLICES + 1);
    expect(slices[0].colorVar).toBe('--kng-chart-1');
    expect(slices[5].colorVar).toBe('--kng-chart-6');
    const other = slices[slices.length - 1];
    expect(other.id).toBe('__other__');
    expect(other.label).toBe('Other (3)');
    expect(other.colorVar).toBe(OTHER_SLICE_VAR);
    expect(other.value).toBe(994 + 993 + 992);
  });

  it('renders a null id as "(unknown)" with the neutral swatch WITHOUT consuming a slot', () => {
    const slices = foldBreakdownForDonut([
      makeEntry('model-a', 100),
      makeEntry(null, 50),
      makeEntry('model-b', 10),
    ]);
    expect(slices[1].label).toBe('(unknown)');
    expect(slices[1].colorVar).toBe(UNKNOWN_SLICE_VAR);
    // model-b still gets slot 2, not slot 3.
    expect(slices[2].colorVar).toBe('--kng-chart-2');
  });

  it('drops zero-token entries', () => {
    expect(foldBreakdownForDonut([makeEntry('empty', 0), makeEntry('real', 5)])).toHaveLength(1);
  });
});

describe('chart series derivations', () => {
  const HOUR = 3_600_000;

  it('deriveBurnRateSeries normalizes bucket totals to a per-hour rate', () => {
    const tokenSeries: TokenSeriesPoint[] = [
      { bucketStartMs: 0, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 0.5, turnCount: 1 },
    ];
    // 5-minute buckets: multiply by 12 for the hourly rate.
    const tokens = deriveBurnRateSeries(tokenSeries, HOUR / 12, 'tokens');
    expect(tokens[0].y).toBeCloseTo(1800);
    const cost = deriveBurnRateSeries(tokenSeries, HOUR / 12, 'cost');
    expect(cost[0].y).toBeCloseTo(6);
  });

  it('deriveCostSparkline reads allocated cost from the turn-derived series, so it populates in Live', () => {
    const tokenSeries: TokenSeriesPoint[] = [
      { bucketStartMs: 0, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 0.5, turnCount: 1 },
      { bucketStartMs: 1, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 0.1, turnCount: 1 },
    ];
    // Live has no finalized costSeries yet, only tokenSeries; the sparkline must still populate.
    expect(deriveCostSparkline(tokenSeries)).toEqual([
      { x: 0, y: 0.5 },
      { x: 1, y: 0.1 },
    ]);
  });

  it('deriveCumulative produces a running sum over the cost series', () => {
    const costSeries: CostSeriesPoint[] = [
      { bucketStartMs: 0, costUsd: 1, inputTokens: 10, outputTokens: 5, sessionCount: 1, byModel: [] },
      { bucketStartMs: 1, costUsd: 2, inputTokens: 20, outputTokens: 10, sessionCount: 1, byModel: [] },
      { bucketStartMs: 2, costUsd: 0, inputTokens: 0, outputTokens: 0, sessionCount: 0, byModel: [] },
    ];
    expect(deriveCumulative(costSeries, 'cost').map((point) => point.y)).toEqual([1, 3, 3]);
    expect(deriveCumulative(costSeries, 'tokens').map((point) => point.y)).toEqual([15, 45, 45]);
  });

  it('deriveCumulativeFromTokenSeries sums the token series, so Cumulative populates in Live', () => {
    const tokenSeries: TokenSeriesPoint[] = [
      { bucketStartMs: 0, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 1, turnCount: 1 },
      { bucketStartMs: 1, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 2, turnCount: 1 },
      { bucketStartMs: 2, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 0, turnCount: 0 },
    ];
    expect(deriveCumulativeFromTokenSeries(tokenSeries, 'cost').map((point) => point.y)).toEqual([1, 3, 3]);
    expect(deriveCumulativeFromTokenSeries(tokenSeries, 'tokens').map((point) => point.y)).toEqual([15, 45, 45]);
    expect(deriveCumulativeFromTokenSeries(tokenSeries, 'tokens').map((point) => point.x)).toEqual([0, 1, 2]);
  });
});

describe('deriveTokenTypeStack', () => {
  it('stacks input / output / cache-read / cache-write per bucket in slot colors', () => {
    const tokenSeries: TokenSeriesPoint[] = [
      { bucketStartMs: 1000, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 20, cacheReadTokens: 200, allocatedCostUsd: 0.5, turnCount: 2 },
      { bucketStartMs: 2000, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 0, turnCount: 0 },
    ];
    const stack = deriveTokenTypeStack(tokenSeries, (bucketStartMs) => `t${bucketStartMs}`);
    expect(stack.series.map((entry) => entry.label)).toEqual(['Input', 'Output', 'Cache read', 'Cache write']);
    expect(stack.series.map((entry) => entry.colorVar)).toEqual([
      '--kng-chart-1',
      '--kng-chart-2',
      '--kng-chart-3',
      '--kng-chart-6',
    ]);
    expect(stack.rows[0]).toMatchObject({ x: 1000, label: 't1000', stack0: 100, stack1: 50, stack2: 200, stack3: 20 });
    expect(stack.rows[1]).toMatchObject({ label: 't2000', stack0: 0, stack1: 0, stack2: 0, stack3: 0 });
  });

  it('stays dense and never gap-fills an empty series', () => {
    const stack = deriveTokenTypeStack([], (bucketStartMs) => `t${bucketStartMs}`);
    expect(stack.rows).toHaveLength(0);
    expect(stack.series).toHaveLength(4);
  });
});

describe('deriveModelStack', () => {
  const slices = foldBreakdownForDonut([
    makeEntry('model-a', 1000, 10),
    makeEntry(null, 500, 0),
    makeEntry('model-b', 100, 1),
  ]);

  const costSeries: CostSeriesPoint[] = [
    {
      bucketStartMs: 1000,
      costUsd: 6,
      inputTokens: 900,
      outputTokens: 0,
      sessionCount: 3,
      byModel: [
        { modelId: 'model-a', costUsd: 5, inputTokens: 600, outputTokens: 0 },
        { modelId: null, costUsd: 0, inputTokens: 250, outputTokens: 0 },
        { modelId: 'model-b', costUsd: 1, inputTokens: 50, outputTokens: 0 },
      ],
    },
    { bucketStartMs: 2000, costUsd: 0, inputTokens: 0, outputTokens: 0, sessionCount: 0, byModel: [] },
  ];

  it('keys rows by the donut ranking (same slot colors), dense with zero-filled buckets', () => {
    const stack = deriveModelStack(costSeries, slices, 'tokens', (ms) => `t${ms}`);
    expect(stack.series.map((entry) => entry.label)).toEqual(['model-a', '(unknown)', 'model-b']);
    expect(stack.series[0].colorVar).toBe(slices[0].colorVar);
    expect(stack.rows).toHaveLength(2);
    expect(stack.rows[0]).toMatchObject({ label: 't1000', stack0: 600, stack1: 250, stack2: 50 });
    expect(stack.rows[1]).toMatchObject({ label: 't2000', stack0: 0, stack1: 0, stack2: 0 });
  });

  it('switches values with the metric', () => {
    const stack = deriveModelStack(costSeries, slices, 'cost', (ms) => `t${ms}`);
    expect(stack.rows[0]).toMatchObject({ stack0: 5, stack1: 0, stack2: 1 });
  });

  it('folds models beyond the ranked slots into the Other slice', () => {
    const manySlices = foldBreakdownForDonut(
      Array.from({ length: 8 }, (_, index) => makeEntry(`model-${index}`, 1000 - index)),
    );
    const otherIndex = manySlices.findIndex((slice) => slice.id === '__other__');
    expect(otherIndex).toBeGreaterThan(-1);
    const point: CostSeriesPoint = {
      bucketStartMs: 0,
      costUsd: 0,
      inputTokens: 30,
      outputTokens: 0,
      sessionCount: 1,
      // model-7 is past the 6 colored slots, so its value lands on Other.
      byModel: [{ modelId: 'model-7', costUsd: 0, inputTokens: 30, outputTokens: 0 }],
    };
    const stack = deriveModelStack([point], manySlices, 'tokens', () => 'x');
    expect(stack.rows[0][`stack${otherIndex}`]).toBe(30);
  });
});
