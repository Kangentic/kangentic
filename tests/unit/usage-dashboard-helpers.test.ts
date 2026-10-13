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
  deriveCacheHitRateSeries,
  deriveCostSparkline,
  deriveCumulative,
  deriveCumulativeFromTokenSeries,
  deriveModelStack,
  deriveTokenTypeStack,
  fitRatioDomain,
  foldBreakdownForDonut,
  isModelStackEmpty,
  rankSlicesByMetric,
  visibleSlices,
  type BreakdownEntry,
  type ModelStack,
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

  it('drops an entry with neither tokens nor cost', () => {
    expect(foldBreakdownForDonut([makeEntry('empty', 0), makeEntry('real', 5)])).toHaveLength(1);
  });

  it('keeps an entry with cost and no tokens, so the Cost view still adds up', () => {
    // A model whose sessions predate per-turn capture has ledger cost and no
    // turn tokens ($2,910 at 0 tokens on the dogfooding install). Dropping it
    // took that cost out of the cost-ranked list, the donut and the bars.
    const slices = foldBreakdownForDonut([makeEntry('current', 500, 10), makeEntry('older', 0, 29)]);
    expect(slices.map((slice) => slice.id)).toEqual(['current', 'older']);
    expect(slices[1]).toMatchObject({ value: 0, costUsd: 29 });
  });
});

describe('visibleSlices', () => {
  it('leaves out a slice with nothing in the selected metric', () => {
    const slices = foldBreakdownForDonut([makeEntry('current', 500, 10), makeEntry('older', 0, 29)]);
    expect(visibleSlices(slices, true).map((slice) => slice.id)).toEqual(['current', 'older']);
    expect(visibleSlices(slices, false).map((slice) => slice.id)).toEqual(['current']);
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

describe('isModelStackEmpty', () => {
  // Live's per-bucket rows are DENSE (a row per 5-minute slot even with no
  // activity), so this must check VALUES, not row count - the real-world
  // regression this guards is a quiet-but-present window (rows exist, every
  // value is 0) being mistaken for non-empty by a length-only check.
  it('is true when every row is all-zero across every series entry, even with multiple present rows', () => {
    const stack: ModelStack = {
      series: [
        { key: 'stack0', label: 'Input', colorVar: '--kng-chart-1' },
        { key: 'stack1', label: 'Output', colorVar: '--kng-chart-2' },
      ],
      rows: [
        { x: 0, label: 't0', stack0: 0, stack1: 0 },
        { x: 1, label: 't1', stack0: 0, stack1: 0 },
      ],
    };
    expect(isModelStackEmpty(stack)).toBe(true);
  });

  it('is false when any row has a nonzero value in any series entry', () => {
    const stack: ModelStack = {
      series: [
        { key: 'stack0', label: 'Input', colorVar: '--kng-chart-1' },
        { key: 'stack1', label: 'Output', colorVar: '--kng-chart-2' },
      ],
      rows: [
        { x: 0, label: 't0', stack0: 0, stack1: 0 },
        { x: 1, label: 't1', stack0: 0, stack1: 5 },
      ],
    };
    expect(isModelStackEmpty(stack)).toBe(false);
  });

  it('is vacuously true for an empty rows array', () => {
    expect(isModelStackEmpty({ series: [], rows: [] })).toBe(true);
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

  it('keeps a model the ranking does not know, in a catch-all series added only when needed', () => {
    // The Tokens view tags each TURN with its model while the ranking tags each
    // session with one, so a mid-session model switch has no slice. With no
    // "Other" slice to absorb it, its tokens used to be dropped and the bars
    // came up short of the Tokens tile.
    const point: CostSeriesPoint = {
      bucketStartMs: 0,
      costUsd: 0,
      inputTokens: 970,
      outputTokens: 0,
      sessionCount: 0,
      byModel: [
        { modelId: 'model-a', costUsd: 0, inputTokens: 900, outputTokens: 0 },
        { modelId: 'model-switched-to', costUsd: 0, inputTokens: 70, outputTokens: 0 },
      ],
    };
    const stack = deriveModelStack([point], slices, 'tokens', () => 'x');
    const catchAll = stack.series[stack.series.length - 1];
    expect(catchAll).toMatchObject({ label: 'Other', colorVar: OTHER_SLICE_VAR });
    expect(stack.rows[0][catchAll.key]).toBe(70);
    const rowTotal = stack.series.reduce((sum, entry) => sum + (stack.rows[0][entry.key] as number), 0);
    expect(rowTotal).toBe(970);

    // Every known model: no catch-all series at all.
    expect(deriveModelStack(costSeries, slices, 'tokens', () => 'x').series.map((entry) => entry.label))
      .not.toContain('Other');
  });
});

describe('deriveCacheHitRateSeries', () => {
  const point = (bucketStartMs: number, fresh: number, write: number, read: number): TokenSeriesPoint => ({
    bucketStartMs,
    inputTokens: fresh,
    outputTokens: 0,
    cacheCreationTokens: write,
    cacheReadTokens: read,
    allocatedCostUsd: 0,
    turnCount: 1,
  });

  it('is cache read over all input, per bucket', () => {
    expect(deriveCacheHitRateSeries([point(1, 10, 30, 960)])).toEqual([{ x: 1, y: 0.96 }]);
  });

  it('leaves out a bucket with no input instead of plotting a dip to zero', () => {
    const series = deriveCacheHitRateSeries([point(1, 10, 30, 960), point(2, 0, 0, 0), point(3, 20, 0, 980)]);
    expect(series.map((entry) => entry.x)).toEqual([1, 3]);
  });
});

describe('fitRatioDomain', () => {
  it('fits the observed band with headroom, inside 0..1', () => {
    // The preview's two days: 90.4% and 87.2%. A 0-based axis drew them on
    // 0% to 400% (whole-number ticks on a ratio).
    const [lower, upper] = fitRatioDomain([{ x: 1, y: 0.904 }, { x: 2, y: 0.872 }]);
    expect(lower).toBeCloseTo(0.862, 3);
    expect(upper).toBeCloseTo(0.914, 3);
  });

  it('never leaves 0..1, and gives a flat or empty series a visible band', () => {
    expect(fitRatioDomain([{ x: 1, y: 0.999 }, { x: 2, y: 0.998 }])[1]).toBe(1);
    expect(fitRatioDomain([{ x: 1, y: 0.004 }])[0]).toBe(0);
    const [flatLower, flatUpper] = fitRatioDomain([{ x: 1, y: 0.5 }, { x: 2, y: 0.5 }]);
    expect(flatUpper - flatLower).toBeCloseTo(0.02, 6);
    expect(fitRatioDomain([])).toEqual([0, 1]);
  });
});

describe('rankSlicesByMetric', () => {
  // Fixed by the token fold: low effort is smallest by tokens, second by cost.
  const slices = foldBreakdownForDonut([
    makeEntry('high', 1160, 8),
    makeEntry('default', 500, 1.34),
    makeEntry('low', 260, 3),
  ]);

  it('ranks by the selected metric and keeps each slice its color', () => {
    expect(rankSlicesByMetric(slices, true).map((slice) => slice.id)).toEqual(['high', 'low', 'default']);
    expect(rankSlicesByMetric(slices, false).map((slice) => slice.id)).toEqual(['high', 'default', 'low']);
    const colorById = new Map(slices.map((slice) => [slice.id, slice.colorVar]));
    for (const slice of rankSlicesByMetric(slices, true)) expect(slice.colorVar).toBe(colorById.get(slice.id));
  });

  it('does not reorder its input', () => {
    rankSlicesByMetric(slices, true);
    expect(slices.map((slice) => slice.id)).toEqual(['high', 'default', 'low']);
  });
});
