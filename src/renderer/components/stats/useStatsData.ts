import { useMemo } from 'react';
import type {
  CostSeriesPoint,
  SessionStatus,
  TokenSeriesPoint,
  UsageDashboardStats,
  UsageKpis,
  UsageStatsScopeKind,
} from '../../../shared/types';
import { isLiveSessionStatus } from '../../../shared/session-liveness';
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

/**
 * True when a ModelStack's rows are all dense-zero (every series entry is 0
 * in every row), used for the Live per-bucket card's empty-state gate. Rows
 * are dense there (a row for every 5-minute slot even with no activity), so a
 * length check alone would call a quiet-but-present window non-empty; this
 * checks values, not row count. An empty `rows` array is vacuously empty too.
 */
export function isModelStackEmpty(stack: ModelStack): boolean {
  return stack.rows.every((row) => stack.series.every((entry) => (row[entry.key] as number) === 0));
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

/**
 * What the Cost tile shows. The live overlay carries each running session's
 * CUMULATIVE reading, and the 45s metrics timer has already upserted that same
 * reading into the ledger, so the ledger's own share of those sessions comes
 * off before the overlay goes on. Without the subtraction every running
 * session is counted twice and the tile floats above the by-model / by-agent /
 * by-effort breakdowns, which get no overlay at all.
 *
 * The 'live' period is the exception: its window is the trailing two hours, so
 * the in-memory numbers ARE the answer and the ledger does not enter.
 */
export function resolveDisplayCost(input: {
  isLivePeriod: boolean;
  ledgerCostUsd: number;
  liveLedgerBaselineCostUsd: number;
  liveOverlayCostUsd: number;
}): number {
  if (input.isLivePeriod) return input.liveOverlayCostUsd;
  return input.ledgerCostUsd - input.liveLedgerBaselineCostUsd + input.liveOverlayCostUsd;
}

/** The four token types the Tokens tile reports, kept DISJOINT. */
export interface TokenBuckets {
  freshInputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** False when the range has no per-turn rows at all: the tile reads "-",
   *  which is not the same claim as zero tokens. */
  hasTokens: boolean;
}

/**
 * Split the KPI payload into the four token types, the same split
 * `claude_code.token.usage` reports (a `type` of input / output / cacheRead /
 * cacheCreation) and the same one ccusage columns.
 *
 * Disjoint on purpose, and NOT rolled up into one total. OTel's GenAI
 * convention folds cache into input; Claude Code's own metric and ccusage keep
 * them apart, which is what `conversation_turn_usage` already stores and what
 * the cache-hit-rate denominator below assumes. A combined total would also be
 * dominated by cache read, which is an order of magnitude larger than fresh
 * traffic and priced completely differently.
 *
 * These come from the turn ledger, never from `usage_history`'s token columns:
 * those are status-line `context_window` totals, which Claude Code 2.1.132+
 * reports as CURRENT CONTEXT OCCUPANCY. Summing them across sessions produced
 * the old "1333.7M tokens", which is the sum of each session's last context
 * size and is not a token count.
 */
export function resolveTokenBuckets(kpis: UsageKpis | null): TokenBuckets {
  const freshInputTokens = kpis?.turnInputTokens ?? 0;
  const outputTokens = kpis?.turnOutputTokens ?? 0;
  const cacheCreationTokens = kpis?.cacheCreationTokens ?? 0;
  const cacheReadTokens = kpis?.cacheReadTokens ?? 0;
  return {
    freshInputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    hasTokens: freshInputTokens + outputTokens + cacheCreationTokens + cacheReadTokens > 0,
  };
}

/**
 * Cache-read share of all input, the cache hit rate ccusage reports:
 * `cache_read / (cache_read + cache_creation + uncached_input)`. Null when the
 * range has no input at all, which the tile renders as "-" rather than 0%.
 *
 * The denominator is why {@link resolveTokenBuckets} keeps the types disjoint:
 * a cache-inclusive "input" would double-count its own cache terms here.
 */
export function resolveCacheReadShare(buckets: TokenBuckets): number | null {
  const denominator = buckets.cacheReadTokens + buckets.cacheCreationTokens + buckets.freshInputTokens;
  return denominator > 0 ? buckets.cacheReadTokens / denominator : null;
}

/**
 * Average ACTIVE time per session, or null when the interval ledger does not
 * reach this range.
 *
 * The denominator is that ledger's OWN session count, never the Sessions
 * tile's: per-interval recording shipped later than the usage ledger, so the
 * two cover different session populations and mixing them under-reports every
 * historical range. Null rather than 0 keeps "not measured" distinct from
 * "measured as nothing".
 */
export function resolveAvgActiveMs(activeMs: number, activeSessionsCovered: number): number | null {
  return activeSessionsCovered > 0 ? activeMs / activeSessionsCovered : null;
}

/**
 * The session ids the live usage overlay may include: live status only, scoped
 * to the viewed project.
 *
 * Status-filtered deliberately. `sessionUsage` retains suspended and exited
 * sessions (it is reconciled against main's usage cache, which holds a session
 * until it leaves the registry), and each carries its full cumulative cost, so
 * an unfiltered overlay adds sessions the ledger has already finalized. The
 * set also has to match what main puts in `liveSessions`, since that is what
 * `liveLedgerBaseline` is measured over.
 *
 * Transient sessions are excluded for that second reason, not the first.
 * `buildLiveSessionRows` in `ipc/handlers/usage-stats.ts` skips them, so main
 * never measures a baseline for one - while `getUsageCache` does NOT filter
 * them, so a running Command Terminal does sit in `sessionUsage`. Including it
 * here would add cost the ledger has no row for and the baseline cannot
 * subtract, putting the Cost tile back above the by-model / by-agent /
 * by-effort breakdowns, which is the discrepancy this whole path exists to
 * close.
 */
export function selectLiveSessionIds(
  sessions: ReadonlyArray<{
    id: string;
    projectId: string;
    status: SessionStatus;
    transient?: boolean;
  }>,
  options: { includeLive: boolean; scopeKind: UsageStatsScopeKind; effectiveProjectId: string | null },
): Set<string> {
  if (!options.includeLive) return new Set<string>();
  const scopedToProject = options.scopeKind === 'project' && options.effectiveProjectId !== null;
  return new Set(
    sessions
      .filter((session) => isLiveSessionStatus(session.status))
      .filter((session) => session.transient !== true)
      .filter((session) => !scopedToProject || session.projectId === options.effectiveProjectId)
      .map((session) => session.id),
  );
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
  /** Per-subagent-type slices. Empty when the range has no subagent turns, which
   *  is what a pre-fan-out range and a range predating subagent capture both
   *  look like. Token-valued only: these rows carry no cost of their own. */
  bySubagentSlices: DonutSlice[];
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
        bySubagentSlices: [],
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
      // costUsd is 0 for every slice, and that is the truth rather than missing
      // data: the session's reported cost already covers its whole subagent
      // tree, so attributing dollars per subagent here would double count. The
      // card is rendered with costKnown={false} so it stays on tokens in both
      // metric modes instead of showing an all-zero cost donut.
      bySubagentSlices: foldBreakdownForDonut(
        (payload.bySubagentType ?? []).map((row) => ({
          id: row.agentType,
          label: row.agentType,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: 0,
        })),
      ),
    };
  }, [payload, effectiveMetric]);
}
