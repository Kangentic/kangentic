import { useMemo } from 'react';
import type { CostSeriesPoint, TokenSeriesPoint, UsageDashboardStats } from '../../../shared/types';
import { useUsageDashboardStore, type UsageMetricMode } from '../../stores/usage-dashboard-store';
import { agentShortName } from '../../utils/agent-display-name';

/**
 * Derivations from the composite payload into chart-ready series. All memoized
 * on the payload object reference (stable per cache entry), so live sessionUsage
 * ticks never recompute chart data. The pure helpers are exported for unit
 * tests (tests/unit/usage-dashboard-helpers.test.ts).
 */

export interface TimePoint {
  x: number;
  y: number;
}

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  costUsd: number;
  /** CSS custom property name, e.g. '--kng-chart-1'. Never a raw hex. */
  colorVar: string;
}

/** Max individually-colored slices; the tail folds into "Other". */
export const MAX_DONUT_SLICES = 6;

const CHART_SLOT_VARS = [
  '--kng-chart-1',
  '--kng-chart-2',
  '--kng-chart-3',
  '--kng-chart-4',
  '--kng-chart-5',
  '--kng-chart-6',
] as const;

/** Neutral swatches: "(unknown)" (no id reported) and the folded "Other" tail. */
export const UNKNOWN_SLICE_VAR = '--kng-fg-disabled';
export const OTHER_SLICE_VAR = '--kng-fg-faint';

export interface BreakdownEntry {
  id: string | null;
  label: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Fold a (backend-sorted, tokens-descending) breakdown into donut slices:
 * top entries take the fixed categorical slots IN ORDER (slot order is the
 * CVD-safety mechanism; colors follow the entity's rank at fold time and the
 * fold is stable per payload), a null id renders as "(unknown)" with a
 * neutral swatch, and everything past MAX_DONUT_SLICES folds into "Other".
 * Zero-token entries are dropped.
 */
export function foldBreakdownForDonut(entries: BreakdownEntry[]): DonutSlice[] {
  const nonEmpty = entries.filter((entry) => entry.inputTokens + entry.outputTokens > 0);
  const head = nonEmpty.slice(0, MAX_DONUT_SLICES);
  const tail = nonEmpty.slice(MAX_DONUT_SLICES);

  let slotIndex = 0;
  const slices: DonutSlice[] = head.map((entry) => {
    const isUnknown = entry.id === null;
    return {
      id: entry.id ?? '(unknown)',
      label: isUnknown ? '(unknown)' : entry.label ?? entry.id ?? '(unknown)',
      value: entry.inputTokens + entry.outputTokens,
      costUsd: entry.costUsd,
      colorVar: isUnknown ? UNKNOWN_SLICE_VAR : CHART_SLOT_VARS[slotIndex++] ?? OTHER_SLICE_VAR,
    };
  });

  if (tail.length > 0) {
    slices.push({
      id: '__other__',
      label: `Other (${tail.length})`,
      value: tail.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0),
      costUsd: tail.reduce((sum, entry) => sum + entry.costUsd, 0),
      colorVar: OTHER_SLICE_VAR,
    });
  }
  return slices;
}

/**
 * Turn-derived burn-rate series normalized to a per-hour rate so the y-axis
 * reads "$/hr" or "tokens/hr" regardless of bucket width.
 */
export function deriveBurnRateSeries(
  tokenSeries: TokenSeriesPoint[],
  bucketSizeMs: number,
  metric: UsageMetricMode,
): TimePoint[] {
  const perHourFactor = 3_600_000 / Math.max(bucketSizeMs, 1);
  return tokenSeries.map((point) => ({
    x: point.bucketStartMs,
    y: (metric === 'cost' ? point.allocatedCostUsd : point.inputTokens + point.outputTokens) * perHourFactor,
  }));
}

export interface ModelStackSeries {
  /** Row property carrying this model's value (e.g. 'stack0', 'stackOther'). */
  key: string;
  label: string;
  colorVar: string;
}

export interface ModelStackRow {
  x: number;
  label: string;
  [seriesKey: string]: number | string;
}

export interface ModelStack {
  series: ModelStackSeries[];
  rows: ModelStackRow[];
}

/**
 * Fold the cost series' per-model splits into stacked-bar data using the SAME
 * ranking/colors as the donut fold (`slices` comes from
 * {@link foldBreakdownForDonut} over the payload's range-wide byModel
 * breakdown), so the stack and the donut always agree on model identity.
 * Models outside the donut's individually-colored slots accumulate into its
 * "Other" slice; models absent from the ranking entirely (possible only in
 * degenerate payloads) fold into Other too rather than being dropped.
 */
export function deriveModelStack(
  costSeries: CostSeriesPoint[],
  slices: DonutSlice[],
  metric: UsageMetricMode,
  formatLabel: (bucketStartMs: number) => string,
): ModelStack {
  const series: ModelStackSeries[] = slices.map((slice, index) => ({
    key: `stack${index}`,
    label: slice.label,
    colorVar: slice.colorVar,
  }));
  const keyBySliceId = new Map<string, string>(slices.map((slice, index) => [slice.id, `stack${index}`]));
  const otherKey = keyBySliceId.get('__other__');

  const rows: ModelStackRow[] = costSeries.map((point) => {
    const row: ModelStackRow = { x: point.bucketStartMs, label: formatLabel(point.bucketStartMs) };
    for (const entry of series) row[entry.key] = 0;
    for (const slice of point.byModel) {
      const sliceId = slice.modelId ?? '(unknown)';
      const key = keyBySliceId.get(sliceId) ?? otherKey;
      if (!key) continue;
      const value = metric === 'cost' ? slice.costUsd : slice.inputTokens + slice.outputTokens;
      row[key] = (row[key] as number) + value;
    }
    return row;
  });
  return { series, rows };
}

/** Running sum over the cost series (cumulative spend / cumulative tokens). */
export function deriveCumulative(
  costSeries: CostSeriesPoint[],
  metric: UsageMetricMode,
): TimePoint[] {
  let runningTotal = 0;
  return costSeries.map((point) => {
    runningTotal += metric === 'cost' ? point.costUsd : point.inputTokens + point.outputTokens;
    return { x: point.bucketStartMs, y: runningTotal };
  });
}

/** Running sum over the turn-derived token series, so the Cumulative card
 *  populates in Live where costSeries (and thus `deriveCumulative`) is empty. */
export function deriveCumulativeFromTokenSeries(
  tokenSeries: TokenSeriesPoint[],
  metric: UsageMetricMode,
): TimePoint[] {
  let runningTotal = 0;
  return tokenSeries.map((point) => {
    runningTotal += metric === 'cost' ? point.allocatedCostUsd : point.inputTokens + point.outputTokens;
    return { x: point.bucketStartMs, y: runningTotal };
  });
}

/**
 * Per-bucket TOKEN-TYPE stack (input / output / cache read / cache write) in
 * the ModelStack shape, so KngBarChart renders it unchanged. Used for the
 * Live per-bucket card, where per-model cost splits are unavailable; this is
 * always a tokens view regardless of the cost/tokens toggle.
 */
export function deriveTokenTypeStack(
  tokenSeries: TokenSeriesPoint[],
  formatLabel: (bucketStartMs: number) => string,
): ModelStack {
  // Slot 6 (not the sequential slot 4) for Cache write: slot 4 is also a
  // green and sits alongside slot 2 (Output) with only a floor-band CVD
  // separation (validated via the dataviz palette validator); slot 6 (red)
  // clears CVD separation cleanly on every theme with no other slot reused.
  const series: ModelStackSeries[] = [
    { key: 'stack0', label: 'Input', colorVar: CHART_SLOT_VARS[0] },
    { key: 'stack1', label: 'Output', colorVar: CHART_SLOT_VARS[1] },
    { key: 'stack2', label: 'Cache read', colorVar: CHART_SLOT_VARS[2] },
    { key: 'stack3', label: 'Cache write', colorVar: CHART_SLOT_VARS[5] },
  ];
  const rows: ModelStackRow[] = tokenSeries.map((point) => ({
    x: point.bucketStartMs,
    label: formatLabel(point.bucketStartMs),
    stack0: point.inputTokens,
    stack1: point.outputTokens,
    stack2: point.cacheReadTokens,
    stack3: point.cacheCreationTokens,
  }));
  return { series, rows };
}

/** Sparkline input: total tokens per bucket. */
export function deriveTokenSparkline(tokenSeries: TokenSeriesPoint[]): TimePoint[] {
  return tokenSeries.map((point) => ({
    x: point.bucketStartMs,
    y: point.inputTokens + point.outputTokens,
  }));
}

/** Sparkline input: turn-allocated cost per bucket (the Cost hero tile). Sourced from
 *  tokenSeries so it populates in Live, matching the Tokens and Burn hero sparklines. */
export function deriveCostSparkline(tokenSeries: TokenSeriesPoint[]): TimePoint[] {
  return tokenSeries.map((point) => ({ x: point.bucketStartMs, y: point.allocatedCostUsd }));
}

/**
 * Percent change vs the previous window, or null when no honest comparison
 * exists (no previous window, or a zero/absent baseline - a delta against
 * zero reads as infinity, not insight).
 */
export function deltaPercent(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous <= 0) return null;
  return (current - previous) / previous;
}

/** Axis tick / tooltip label formatter picked by bucket width. */
export function formatBucketLabel(bucketStartMs: number, bucketSizeMs: number): string {
  const date = new Date(bucketStartMs);
  if (bucketSizeMs < 24 * 3_600_000) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface StatsDerivedData {
  payload: UsageDashboardStats | null;
  burnRate: TimePoint[];
  /** Stacked-by-model daily bars (colors/ranking shared with the donut). */
  modelStack: ModelStack;
  cumulative: TimePoint[];
  /** Cumulative running sum from tokenSeries, for the Live card (costSeries empty). */
  cumulativeFromTokens: TimePoint[];
  /** Per-bucket token-type stack for the Live per-bucket card (ModelStack shape). */
  tokenTypeStack: ModelStack;
  tokenSparkline: TimePoint[];
  costSparkline: TimePoint[];
  byModelSlices: DonutSlice[];
  byAgentSlices: DonutSlice[];
  byEffortSlices: DonutSlice[];
}

/** Select the active payload and derive all chart series, memoized per payload. */
export function useStatsData(effectiveMetric: UsageMetricMode): StatsDerivedData {
  const payload = useUsageDashboardStore((state) =>
    state.activeKey ? state.cache[state.activeKey]?.payload ?? null : null,
  );

  return useMemo(() => {
    if (!payload) {
      return {
        payload: null,
        burnRate: [],
        modelStack: { series: [], rows: [] },
        cumulative: [],
        cumulativeFromTokens: [],
        tokenTypeStack: { series: [], rows: [] },
        tokenSparkline: [],
        costSparkline: [],
        byModelSlices: [],
        byAgentSlices: [],
        byEffortSlices: [],
      };
    }
    const byModelSlices = foldBreakdownForDonut(
      payload.byModel.map((model) => ({
        id: model.modelId,
        label: model.modelDisplayName ?? model.modelId,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        costUsd: model.costUsd,
      })),
    );
    return {
      payload,
      burnRate: deriveBurnRateSeries(payload.tokenSeries, payload.bucketSizeMs, effectiveMetric),
      modelStack: deriveModelStack(
        payload.costSeries,
        byModelSlices,
        effectiveMetric,
        (bucketStartMs) => formatBucketLabel(bucketStartMs, payload.costBucketSizeMs),
      ),
      cumulative: deriveCumulative(payload.costSeries, effectiveMetric),
      cumulativeFromTokens: deriveCumulativeFromTokenSeries(payload.tokenSeries, effectiveMetric),
      tokenTypeStack: deriveTokenTypeStack(
        payload.tokenSeries,
        (bucketStartMs) => formatBucketLabel(bucketStartMs, payload.bucketSizeMs),
      ),
      tokenSparkline: deriveTokenSparkline(payload.tokenSeries),
      costSparkline: deriveCostSparkline(payload.tokenSeries),
      byModelSlices,
      byAgentSlices: foldBreakdownForDonut(
        payload.byAgent.map((agent) => ({
          id: agent.agent,
          // Product-style short name ('claude' -> 'Claude'); a null agent
          // keeps a null label so the fold renders its "(unknown)" bucket.
          label: agent.agent === null ? null : agentShortName(agent.agent),
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
          costUsd: agent.costUsd,
        })),
      ),
      // Null effort means "agent default" - a real bucket (often the largest),
      // so it is pre-labeled and takes a categorical slot, unlike the neutral
      // "(unknown)" swatch a null model/agent gets.
      byEffortSlices: foldBreakdownForDonut(
        (payload.byEffort ?? []).map((effort) => ({
          id: effort.effort ?? '(default)',
          label: effort.effort ?? '(default)',
          inputTokens: effort.inputTokens,
          outputTokens: effort.outputTokens,
          costUsd: effort.costUsd,
        })),
      ),
    };
  }, [payload, effectiveMetric]);
}
