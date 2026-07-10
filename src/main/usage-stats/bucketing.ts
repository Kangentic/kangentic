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
import type { UsageHistoryRow } from '../db/repositories/usage-history-repository';
import type { GroupedTurnUsageRow } from '../retrieval/conversation/conversation-usage-store';

/**
 * Pure bucketing / aggregation math for the usage dashboard. NO database or
 * Electron imports (type-only imports are fine): better-sqlite3 cannot load
 * under vitest, so everything interesting lives here where the unit tests can
 * exercise it with plain arrays.
 *
 * Two-stage bucketing: SQL groups turns into fixed 5-minute UTC buckets
 * (bounded row counts; 5-minute UTC groups nest cleanly into local hour/day
 * boundaries because every real-world UTC offset is a multiple of 15 minutes
 * and DST shifts are multiples of 30), then these functions fold the groups
 * into chart buckets aligned to LOCAL calendar boundaries via `Date` component
 * arithmetic - automatically DST-correct and consistent with
 * `computePeriodCutoff`'s local-midnight semantics.
 */

/** SQL-side turn grouping width: 5 minutes. */
export const TURN_GROUP_MS = 5 * 60_000;
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

/** Total fresh (input + output) tokens per session across the given groups. */
export function buildSessionTokenTotals(groups: GroupedTurnUsageRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const group of groups) {
    if (group.sessionId === null) continue;
    totals.set(group.sessionId, (totals.get(group.sessionId) ?? 0) + group.inputTokens + group.outputTokens);
  }
  return totals;
}

/**
 * Dollars of a session's reported cost allocated to one turn group,
 * proportional to the group's share of the session's fresh tokens.
 * API-equivalent and approximate by design (cache reads are weighted the same
 * as nothing; the point is a plausible $-over-time shape, not billing).
 */
export function allocateGroupCost(
  group: GroupedTurnUsageRow,
  sessionCostUsd: ReadonlyMap<string, number>,
  sessionTokenTotals: ReadonlyMap<string, number>,
): number {
  if (group.sessionId === null) return 0;
  const cost = sessionCostUsd.get(group.sessionId);
  const totalTokens = sessionTokenTotals.get(group.sessionId);
  if (!cost || !totalTokens) return 0;
  return cost * ((group.inputTokens + group.outputTokens) / totalTokens);
}

/**
 * Fold 5-minute turn groups into a dense token series aligned to `starts`
 * (from {@link buildBucketStarts}). Groups falling before the (possibly
 * clamped) first bucket are dropped.
 */
export function foldTokenSeries(
  groups: GroupedTurnUsageRow[],
  sessionCostUsd: ReadonlyMap<string, number>,
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
  const sessionTokenTotals = buildSessionTokenTotals(groups);
  for (const group of groups) {
    const index = indexByStart.get(bucketStartFor(group.bucketStartMs, kind));
    if (index === undefined) continue;
    const point = points[index];
    point.inputTokens += group.inputTokens;
    point.outputTokens += group.outputTokens;
    point.cacheCreationTokens += group.cacheCreationTokens;
    point.cacheReadTokens += group.cacheReadTokens;
    point.allocatedCostUsd += allocateGroupCost(group, sessionCostUsd, sessionTokenTotals);
    point.turnCount += group.turnCount;
  }
  return points;
}

/**
 * Fold finalized-session usage rows into a dense cost series aligned to
 * `starts`, bucketed by the local day (or local week for 'all') the session
 * STARTED. Per-session attribution at daily granularity is deliberate: exact
 * sub-day cost timing is unknowable from the ledger, and daily bars do not
 * need it. Each bucket also carries per-model splits (normalized base model
 * ids, same normalization as {@link buildModelBreakdown}) for the stacked
 * by-model daily bars; the splits sum to the bucket totals.
 */
export function foldCostSeries(
  usageRows: UsageHistoryRow[],
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
  for (const row of usageRows) {
    const startedMs = Date.parse(row.sessionStartedAt);
    if (Number.isNaN(startedMs)) continue;
    const index = indexByStart.get(bucketStartFor(startedMs, kind));
    if (index === undefined) continue;
    const point = points[index];
    point.costUsd += row.totalCostUsd;
    point.inputTokens += row.totalInputTokens;
    point.outputTokens += row.totalOutputTokens;
    point.sessionCount += 1;

    const baseId = row.modelId === null ? null : parseModelId(row.modelId).baseId;
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
    slice.costUsd += row.totalCostUsd;
    slice.inputTokens += row.totalInputTokens;
    slice.outputTokens += row.totalOutputTokens;
  }
  return points;
}

/**
 * KPI totals over the selected range. The cost/token/session/tool/line fields
 * sum `usage_history` rows (snapshot-token semantics, footer parity); the
 * cache and burn-rate fields derive from the turn groups. See the
 * `UsageKpis` JSDoc in shared/types.ts for why the two token measurements
 * never reconcile.
 */
export function computeKpis(
  usageRows: UsageHistoryRow[],
  groups: GroupedTurnUsageRow[],
  sessionCostUsd: ReadonlyMap<string, number>,
  elapsedMs: number,
): UsageKpis {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let filesChanged = 0;
  let compactionCount = 0;
  let totalDurationMs = 0;
  let costKnown = false;
  for (const row of usageRows) {
    totalCostUsd += row.totalCostUsd;
    totalInputTokens += row.totalInputTokens;
    totalOutputTokens += row.totalOutputTokens;
    toolCallCount += row.toolCallCount;
    linesAdded += row.linesAdded;
    linesRemoved += row.linesRemoved;
    filesChanged += row.filesChanged;
    compactionCount += row.compactionCount;
    totalDurationMs += row.totalDurationMs ?? 0;
    if (row.totalCostUsd > 0) costKnown = true;
  }

  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let allocatedCostUsd = 0;
  const sessionTokenTotals = buildSessionTokenTotals(groups);
  for (const group of groups) {
    cacheCreationTokens += group.cacheCreationTokens;
    cacheReadTokens += group.cacheReadTokens;
    turnInputTokens += group.inputTokens;
    turnOutputTokens += group.outputTokens;
    allocatedCostUsd += allocateGroupCost(group, sessionCostUsd, sessionTokenTotals);
  }
  const turnTokens = turnInputTokens + turnOutputTokens;

  // Burn rates average over the elapsed window (floored at one minute so a
  // just-started range cannot produce absurd rates).
  const elapsedHours = Math.max(elapsedMs, 60_000) / HOUR_MS;
  const burnRateTokensPerHour = groups.length > 0 ? turnTokens / elapsedHours : null;
  const burnRateUsdPerHour = groups.length > 0 && costKnown ? allocatedCostUsd / elapsedHours : null;

  return {
    totalCostUsd,
    costKnown,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    sessionCount: usageRows.length,
    toolCallCount,
    linesAdded,
    linesRemoved,
    filesChanged,
    compactionCount,
    totalDurationMs,
    turnInputTokens,
    turnOutputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    burnRateTokensPerHour,
    burnRateUsdPerHour,
  };
}

/**
 * Per-model rollup, grouped on the parsed BASE model id so dated pins and
 * `[1m]` variants of one model merge into a single row (pure string-shape
 * normalization from shared/model-id.ts - no agent branching). Sorted by
 * total tokens descending; null-model rows group together at their natural
 * rank (the renderer labels them "(unknown)").
 */
export function buildModelBreakdown(usageRows: UsageHistoryRow[]): ModelUsageBreakdown[] {
  const byBaseId = new Map<string, ModelUsageBreakdown>();
  for (const row of usageRows) {
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
    entry.inputTokens += row.totalInputTokens;
    entry.outputTokens += row.totalOutputTokens;
    entry.costUsd += row.totalCostUsd;
    entry.sessionCount += 1;
  }
  return [...byBaseId.values()].sort(
    (first, second) => (second.inputTokens + second.outputTokens) - (first.inputTokens + first.outputTokens),
  );
}

/** Per-agent rollup, sorted by total tokens descending. */
export function buildAgentBreakdown(usageRows: UsageHistoryRow[]): AgentUsageBreakdown[] {
  const byAgent = new Map<string, AgentUsageBreakdown>();
  for (const row of usageRows) {
    const key = row.agent ?? '';
    let entry = byAgent.get(key);
    if (!entry) {
      entry = { agent: row.agent, inputTokens: 0, outputTokens: 0, costUsd: 0, sessionCount: 0 };
      byAgent.set(key, entry);
    }
    entry.inputTokens += row.totalInputTokens;
    entry.outputTokens += row.totalOutputTokens;
    entry.costUsd += row.totalCostUsd;
    entry.sessionCount += 1;
  }
  return [...byAgent.values()].sort(
    (first, second) => (second.inputTokens + second.outputTokens) - (first.inputTokens + first.outputTokens),
  );
}

/** Per-effort rollup, sorted by total tokens descending. Null effort (agent
 *  default, no flag) is a real bucket, kept distinct from named levels. */
export function buildEffortBreakdown(usageRows: UsageHistoryRow[]): EffortUsageBreakdown[] {
  const byEffort = new Map<string, EffortUsageBreakdown>();
  for (const row of usageRows) {
    const key = row.effort ?? '';
    let entry = byEffort.get(key);
    if (!entry) {
      entry = { effort: row.effort, inputTokens: 0, outputTokens: 0, costUsd: 0, sessionCount: 0 };
      byEffort.set(key, entry);
    }
    entry.inputTokens += row.totalInputTokens;
    entry.outputTokens += row.totalOutputTokens;
    entry.costUsd += row.totalCostUsd;
    entry.sessionCount += 1;
  }
  return [...byEffort.values()].sort(
    (first, second) => (second.inputTokens + second.outputTokens) - (first.inputTokens + first.outputTokens),
  );
}
