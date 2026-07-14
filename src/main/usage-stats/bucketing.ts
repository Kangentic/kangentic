import type {
  AgentUsageBreakdown,
  CostSeriesPoint,
  EffortUsageBreakdown,
  ModelUsageBreakdown,
  TokenSeriesPoint,
  UsageKpis,
  UsageTimePeriod,
} from '../../shared/types';
import { computePeriodCutoff } from '../../shared/period-cutoff';
import { humanizeModelId, parseModelId } from '../../shared/model-id';
import type {
  UsageCostGroupRow,
  UsageRollupRow,
  UsageWindowTotals,
} from '../db/repositories/usage-history-repository';
import type { GroupedTurnUsageRow } from '../retrieval/conversation/conversation-usage-store';

/**
 * Pure bucketing / aggregation math for the usage dashboard. NO database or
 * Electron imports (type-only imports are fine): better-sqlite3 cannot load
 * under vitest, so everything interesting lives here where the unit tests can
 * exercise it with plain arrays.
 *
 * Two-stage bucketing: SQL groups both ledgers into fixed fine-grained UTC
 * buckets (bounded row counts; the fine UTC groups nest cleanly into local
 * hour/day boundaries because every real-world UTC offset is a multiple of
 * 15 minutes and DST shifts are multiples of 30), then these functions fold
 * the groups into chart buckets aligned to LOCAL calendar boundaries via
 * `Date` component arithmetic - automatically DST-correct and consistent with
 * `computePeriodCutoff`'s local-midnight semantics. KPI totals and the
 * breakdowns likewise arrive pre-aggregated from SQL (one totals row and an
 * O(dimension-combos) rollup per project), so the JS here is O(buckets), not
 * O(historical rows).
 */

/** SQL-side turn grouping width for the Live period: 5 minutes (Live's
 *  chart buckets sit directly on this grid). */
export const TURN_GROUP_MS = 5 * 60_000;
/** SQL-side grouping width for everything else - the usage_history cost
 *  series and the non-Live turn series: 15 minutes, the coarsest grid that
 *  still nests into every real-world local hour/day/week chart boundary
 *  (all UTC offsets are multiples of 15 minutes). */
export const COST_GROUP_MS = 15 * 60_000;
/** Trailing window for the 'live' period: 120 minutes. */
export const LIVE_WINDOW_MS = 120 * 60_000;
/** Hard cap on chart series length; longer ranges keep only the newest buckets. */
export const MAX_SERIES_POINTS = 400;
/** Backstop against pathological bucket iteration (never hit in practice). */
const HARD_ITERATION_CAP = 100_000;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type ChartBucketKind = 'fiveMinutes' | 'halfHour' | 'hour' | 'day' | 'week';

/** Nominal bucket widths (a DST-shift day is an hour off; advisory only). */
export const NOMINAL_BUCKET_MS: Record<ChartBucketKind, number> = {
  fiveMinutes: TURN_GROUP_MS,
  halfHour: 30 * 60_000,
  hour: HOUR_MS,
  day: DAY_MS,
  week: WEEK_MS,
};

export interface ResolvedBucketing {
  period: UsageTimePeriod;
  /** usage_history filter (`session_started_at >= sinceIso`); null = all time. */
  sinceIso: string | null;
  /** conversation_turn_usage filter (`ts >= sinceMs`); null = all time. */
  sinceMs: number | null;
  tokenBucketKind: ChartBucketKind;
  /** Cost/session series bucket: hourly inside a single day ('today'), else
   *  daily/weekly - one bar per bucket must stay a useful count, and a single
   *  lonely bar is not a chart. */
  costBucketKind: 'hour' | 'day' | 'week';
}

/**
 * Resolve a period to its query cutoffs and chart bucket widths. Reuses
 * `computePeriodCutoff` for the local-midnight / Monday / 1st-of-month
 * semantics; 'live' gets a trailing 120-minute window aligned down to the
 * 5-minute grid (so consecutive refreshes keep stable bucket keys), and its
 * ISO cutoff also scopes the usage_history KPI totals to sessions STARTED in
 * the window (a session finalized in-window but started earlier is a
 * documented edge that the renderer's live-session layering covers).
 */
export function resolveBucketing(period: UsageTimePeriod, nowMs: number): ResolvedBucketing {
  switch (period) {
    case 'live': {
      const sinceMs = Math.floor((nowMs - LIVE_WINDOW_MS) / TURN_GROUP_MS) * TURN_GROUP_MS;
      return {
        period,
        sinceIso: new Date(sinceMs).toISOString(),
        sinceMs,
        tokenBucketKind: 'fiveMinutes',
        costBucketKind: 'day',
      };
    }
    case 'today': {
      const sinceIso = computePeriodCutoff(period);
      return {
        period,
        sinceIso,
        sinceMs: sinceIso ? Date.parse(sinceIso) : null,
        // Half-hour token buckets: hourly gives a fresh day only 1-2 points
        // (a meaningless two-point diagonal); 30-minute buckets cap at 48/day
        // and give the burn chart a real shape within the first hours.
        tokenBucketKind: 'halfHour',
        // A single local day yields exactly one daily bucket - a lonely bar.
        // Sessions carry start times, so bucket by hour instead.
        costBucketKind: 'hour',
      };
    }
    case 'week':
    case 'month': {
      const sinceIso = computePeriodCutoff(period);
      return {
        period,
        sinceIso,
        sinceMs: sinceIso ? Date.parse(sinceIso) : null,
        tokenBucketKind: 'day',
        costBucketKind: 'day',
      };
    }
    case 'all':
      // Provisional: 'all' has no cutoff, so its bucket kinds depend on the
      // actual data span, which the service only knows after reading the
      // ledgers - it refines these via resolveAllTimeBucketKinds.
      return { period, sinceIso: null, sinceMs: null, tokenBucketKind: 'week', costBucketKind: 'week' };
  }
}

/** A bounded comparison window (the "vs previous period" KPI deltas). */
export interface PreviousWindow {
  sinceIso: string;
  untilIso: string;
  sinceMs: number;
  untilMs: number;
}

/**
 * The window immediately PRECEDING the current one, for the hero tiles'
 * "vs previous period" deltas: live compares against the prior 2 hours,
 * today against yesterday, week/month against the previous local week/month,
 * and a day drill against the preceding local day. All Time has no previous
 * window (null). Local-calendar arithmetic throughout, DST-safe.
 */
export function resolvePreviousWindow(
  period: UsageTimePeriod,
  currentStartMs: number,
  isDrill: boolean,
): PreviousWindow | null {
  const start = new Date(currentStartMs);
  let previousStartMs: number;
  if (isDrill || period === 'today') {
    previousStartMs = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1).getTime();
  } else if (period === 'live') {
    previousStartMs = currentStartMs - LIVE_WINDOW_MS;
  } else if (period === 'week') {
    previousStartMs = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7).getTime();
  } else if (period === 'month') {
    previousStartMs = new Date(start.getFullYear(), start.getMonth() - 1, 1).getTime();
  } else {
    return null; // 'all' has no previous window
  }
  return {
    sinceIso: new Date(previousStartMs).toISOString(),
    untilIso: new Date(currentStartMs).toISOString(),
    sinceMs: previousStartMs,
    untilMs: currentStartMs,
  };
}

/** Data spans at or under this many days render All Time at DAILY granularity. */
export const ALL_TIME_DAILY_MAX_DAYS = 90;

/**
 * Adaptive All Time granularity: a short history (a new install, a young
 * project) at fixed weekly buckets collapses into two or three lonely bars,
 * while a long one at daily buckets would blow the series cap. Up to
 * ~ALL_TIME_DAILY_MAX_DAYS of actual data span, use days (<= ~90 points);
 * beyond that, weeks (~2 years per 104 points, clamped by MAX_SERIES_POINTS
 * far later than any realistic history).
 */
export function resolveAllTimeBucketKinds(rangeStartMs: number, rangeEndMs: number): {
  tokenBucketKind: ChartBucketKind;
  costBucketKind: 'hour' | 'day' | 'week';
} {
  const spanDays = Math.max(rangeEndMs - rangeStartMs, 0) / DAY_MS;
  const kind = spanDays <= ALL_TIME_DAILY_MAX_DAYS ? 'day' : 'week';
  return { tokenBucketKind: kind, costBucketKind: kind };
}

/** The start of the chart bucket containing `epochMs`, in local calendar time.
 *  Sub-hour kinds use the fixed UTC grid (like the SQL 5-minute groups); hour
 *  and larger align to local calendar boundaries. */
export function bucketStartFor(epochMs: number, kind: ChartBucketKind): number {
  if (kind === 'fiveMinutes' || kind === 'halfHour') {
    const gridMs = NOMINAL_BUCKET_MS[kind];
    return Math.floor(epochMs / gridMs) * gridMs;
  }
  const date = new Date(epochMs);
  if (kind === 'hour') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
  }
  if (kind === 'day') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  // week: the local Monday (matches computePeriodCutoff('week')).
  const day = date.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysFromMonday).getTime();
}

/** The start of the chart bucket after the one starting at `startMs`. */
export function nextBucketStart(startMs: number, kind: ChartBucketKind): number {
  if (kind === 'fiveMinutes' || kind === 'halfHour') return startMs + NOMINAL_BUCKET_MS[kind];
  const date = new Date(startMs);
  if (kind === 'hour') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime();
  }
  if (kind === 'day') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7).getTime();
}

/**
 * The dense, ordered list of chart-bucket starts covering
 * [rangeStartMs, rangeEndMs). Clamped to the newest MAX_SERIES_POINTS buckets
 * so an ancient 'all time' range cannot produce an unbounded series (data
 * folded into dropped buckets disappears from the CHART only; KPI totals stay
 * full-range).
 */
export function buildBucketStarts(rangeStartMs: number, rangeEndMs: number, kind: ChartBucketKind): number[] {
  const starts: number[] = [];
  let cursor = bucketStartFor(Math.min(rangeStartMs, rangeEndMs), kind);
  while (cursor < rangeEndMs && starts.length < HARD_ITERATION_CAP) {
    starts.push(cursor);
    cursor = nextBucketStart(cursor, kind);
  }
  return starts.length > MAX_SERIES_POINTS ? starts.slice(-MAX_SERIES_POINTS) : starts;
}

/**
 * Fold fine-grained UTC turn groups into a dense token series aligned to
 * `starts` (from {@link buildBucketStarts}). Groups falling before the
 * (possibly clamped) first bucket are dropped. Each group's cost share
 * arrives pre-allocated from SQL (`allocatedCostUsd`).
 */
export function foldTokenSeries(
  groups: GroupedTurnUsageRow[],
  starts: number[],
  kind: ChartBucketKind,
): TokenSeriesPoint[] {
  const indexByStart = new Map<number, number>(starts.map((start, index) => [start, index]));
  const points: TokenSeriesPoint[] = starts.map((start) => ({
    bucketStartMs: start,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    allocatedCostUsd: 0,
    turnCount: 0,
  }));
  for (const group of groups) {
    const index = indexByStart.get(bucketStartFor(group.bucketStartMs, kind));
    if (index === undefined) continue;
    const point = points[index];
    point.inputTokens += group.inputTokens;
    point.outputTokens += group.outputTokens;
    point.cacheCreationTokens += group.cacheCreationTokens;
    point.cacheReadTokens += group.cacheReadTokens;
    point.allocatedCostUsd += group.allocatedCostUsd;
    point.turnCount += group.turnCount;
  }
  return points;
}

/**
 * Fold 15-minute usage_history cost groups into a dense cost series aligned
 * to `starts`, bucketed by the local day (or local week for 'all') the
 * sessions STARTED. Per-session attribution at daily granularity is
 * deliberate: exact sub-day cost timing is unknowable from the ledger, and
 * daily bars do not need it. Each bucket also carries per-model splits
 * (normalized base model ids, same normalization as
 * {@link buildModelBreakdown}) for the stacked by-model daily bars; the
 * splits sum to the bucket totals. Slice order within a point follows group
 * order (the SQL orders groups by bucket then earliest session), preserving
 * the old row-by-row first-encounter order.
 */
export function foldCostSeries(
  costGroups: UsageCostGroupRow[],
  starts: number[],
  kind: ChartBucketKind,
): CostSeriesPoint[] {
  const indexByStart = new Map<number, number>(starts.map((start, index) => [start, index]));
  const points: CostSeriesPoint[] = starts.map((start) => ({
    bucketStartMs: start,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    sessionCount: 0,
    byModel: [],
  }));
  const modelSlicesByPoint = new Map<number, Map<string, CostSeriesPoint['byModel'][number]>>();
  for (const group of costGroups) {
    const index = indexByStart.get(bucketStartFor(group.bucketStartMs, kind));
    if (index === undefined) continue;
    const point = points[index];
    point.costUsd += group.costUsd;
    point.inputTokens += group.inputTokens;
    point.outputTokens += group.outputTokens;
    point.sessionCount += group.sessionCount;

    const baseId = group.modelId === null ? null : parseModelId(group.modelId).baseId;
    let slices = modelSlicesByPoint.get(index);
    if (!slices) {
      slices = new Map();
      modelSlicesByPoint.set(index, slices);
    }
    const sliceKey = baseId ?? '';
    let slice = slices.get(sliceKey);
    if (!slice) {
      slice = { modelId: baseId, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      slices.set(sliceKey, slice);
      point.byModel.push(slice);
    }
    slice.costUsd += group.costUsd;
    slice.inputTokens += group.inputTokens;
    slice.outputTokens += group.outputTokens;
  }
  return points;
}

/** Per-project window totals merged across the project loop (integer adds
 *  plus float cost adds - one add per project, not per row). */
export function mergeUsageTotals(totalsList: UsageWindowTotals[]): UsageWindowTotals {
  const merged: UsageWindowTotals = {
    sessionCount: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    toolCallCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: 0,
    compactionCount: 0,
    totalDurationMs: 0,
    costKnownCount: 0,
    minSessionStartedAt: null,
    maxSessionStartedAt: null,
  };
  for (const totals of totalsList) {
    merged.sessionCount += totals.sessionCount;
    merged.totalCostUsd += totals.totalCostUsd;
    merged.totalInputTokens += totals.totalInputTokens;
    merged.totalOutputTokens += totals.totalOutputTokens;
    merged.toolCallCount += totals.toolCallCount;
    merged.linesAdded += totals.linesAdded;
    merged.linesRemoved += totals.linesRemoved;
    merged.filesChanged += totals.filesChanged;
    merged.compactionCount += totals.compactionCount;
    merged.totalDurationMs += totals.totalDurationMs;
    merged.costKnownCount += totals.costKnownCount;
    // UTC ISO strings compare lexicographically in chronological order.
    if (totals.minSessionStartedAt !== null
      && (merged.minSessionStartedAt === null || totals.minSessionStartedAt < merged.minSessionStartedAt)) {
      merged.minSessionStartedAt = totals.minSessionStartedAt;
    }
    if (totals.maxSessionStartedAt !== null
      && (merged.maxSessionStartedAt === null || totals.maxSessionStartedAt > merged.maxSessionStartedAt)) {
      merged.maxSessionStartedAt = totals.maxSessionStartedAt;
    }
  }
  return merged;
}

/**
 * KPI totals over the selected range. The cost/token/session/tool/line fields
 * come from the SQL-aggregated `usage_history` window totals (snapshot-token
 * semantics, footer parity); the cache and burn-rate fields derive from the
 * turn groups, whose cost shares arrive pre-allocated from SQL. See the
 * `UsageKpis` JSDoc in shared/types.ts for why the two token measurements
 * never reconcile.
 */
export function computeKpis(
  totals: UsageWindowTotals,
  groups: GroupedTurnUsageRow[],
  elapsedMs: number,
): UsageKpis {
  const costKnown = totals.costKnownCount > 0;

  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let allocatedCostUsd = 0;
  for (const group of groups) {
    cacheCreationTokens += group.cacheCreationTokens;
    cacheReadTokens += group.cacheReadTokens;
    turnInputTokens += group.inputTokens;
    turnOutputTokens += group.outputTokens;
    allocatedCostUsd += group.allocatedCostUsd;
  }
  const turnTokens = turnInputTokens + turnOutputTokens;

  // Burn rates average over the elapsed window (floored at one minute so a
  // just-started range cannot produce absurd rates).
  const elapsedHours = Math.max(elapsedMs, 60_000) / HOUR_MS;
  const burnRateTokensPerHour = groups.length > 0 ? turnTokens / elapsedHours : null;
  const burnRateUsdPerHour = groups.length > 0 && costKnown ? allocatedCostUsd / elapsedHours : null;

  return {
    totalCostUsd: totals.totalCostUsd,
    costKnown,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalTokens: totals.totalInputTokens + totals.totalOutputTokens,
    sessionCount: totals.sessionCount,
    toolCallCount: totals.toolCallCount,
    linesAdded: totals.linesAdded,
    linesRemoved: totals.linesRemoved,
    filesChanged: totals.filesChanged,
    compactionCount: totals.compactionCount,
    totalDurationMs: totals.totalDurationMs,
    turnInputTokens,
    turnOutputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    burnRateTokensPerHour,
    burnRateUsdPerHour,
  };
}

/**
 * Per-model breakdown from the SQL dimension rollup, regrouped on the parsed
 * BASE model id so dated pins and `[1m]` variants of one model merge into a
 * single row (pure string-shape normalization from shared/model-id.ts - no
 * agent branching; this is why the merge cannot live in the SQL GROUP BY).
 * Sorted by total tokens descending; null-model rows group together at their
 * natural rank (the renderer labels them "(unknown)"). Rollup rows arrive
 * ordered by earliest session, so the first row seen for a base id carries
 * the same display name the old row-by-row fold picked, and stable-sort ties
 * keep first-encounter order.
 */
export function buildModelBreakdown(rollupRows: UsageRollupRow[]): ModelUsageBreakdown[] {
  const byBaseId = new Map<string, ModelUsageBreakdown>();
  for (const row of rollupRows) {
    const baseId = row.modelId === null ? null : parseModelId(row.modelId).baseId;
    const key = baseId ?? '';
    let entry = byBaseId.get(key);
    if (!entry) {
      entry = {
        modelId: baseId,
        modelDisplayName: baseId === null
          ? null
          : row.modelDisplayName ?? humanizeModelId(baseId) ?? baseId,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        sessionCount: 0,
      };
      byBaseId.set(key, entry);
    }
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    entry.costUsd += row.costUsd;
    entry.sessionCount += row.sessionCount;
  }
  return [...byBaseId.values()].sort(
    (first, second) => (second.inputTokens + second.outputTokens) - (first.inputTokens + first.outputTokens),
  );
}

/** Per-agent breakdown from the SQL dimension rollup, sorted by total tokens
 *  descending. */
export function buildAgentBreakdown(rollupRows: UsageRollupRow[]): AgentUsageBreakdown[] {
  const byAgent = new Map<string, AgentUsageBreakdown>();
  for (const row of rollupRows) {
    const key = row.agent ?? '';
    let entry = byAgent.get(key);
    if (!entry) {
      entry = { agent: row.agent, inputTokens: 0, outputTokens: 0, costUsd: 0, sessionCount: 0 };
      byAgent.set(key, entry);
    }
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    entry.costUsd += row.costUsd;
    entry.sessionCount += row.sessionCount;
  }
  return [...byAgent.values()].sort(
    (first, second) => (second.inputTokens + second.outputTokens) - (first.inputTokens + first.outputTokens),
  );
}

/** Per-effort breakdown from the SQL dimension rollup, sorted by total tokens
 *  descending. Null effort (agent default, no flag) is a real bucket, kept
 *  distinct from named levels. */
export function buildEffortBreakdown(rollupRows: UsageRollupRow[]): EffortUsageBreakdown[] {
  const byEffort = new Map<string, EffortUsageBreakdown>();
  for (const row of rollupRows) {
    const key = row.effort ?? '';
    let entry = byEffort.get(key);
    if (!entry) {
      entry = { effort: row.effort, inputTokens: 0, outputTokens: 0, costUsd: 0, sessionCount: 0 };
      byEffort.set(key, entry);
    }
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    entry.costUsd += row.costUsd;
    entry.sessionCount += row.sessionCount;
  }
  return [...byEffort.values()].sort(
    (first, second) => (second.inputTokens + second.outputTokens) - (first.inputTokens + first.outputTokens),
  );
}
