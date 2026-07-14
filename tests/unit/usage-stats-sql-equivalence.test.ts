/**
 * Equivalence oracle for the SQL-pushdown refactor of the usage dashboard:
 * every aggregate the dashboard now reads from SQL (window totals, dimension
 * rollup, 15-minute cost groups, SQL-allocated turn-group costs) must produce
 * the SAME numbers the retired JS folds produced over the raw rows - on a
 * deterministic pseudo-random dataset large enough to exercise NULL
 * dimensions, zero costs, model-id variants, window edges, and multi-project
 * merging.
 *
 * The legacy pipeline lives HERE as verbatim copies of the pre-refactor
 * bucketing.ts functions plus the raw SELECTs the old readers issued
 * (listRowsAfter / the join-less getGroupedUsageSince). Break any new SQL
 * and this suite fails against the old math - the red-green mechanism for
 * the refactor.
 *
 * Comparison contract (the sanctioned deviation from byte-identical):
 * integers, strings, structure, and array ORDER are exact; float cost
 * fields compare at relative 1e-9 (SQLite sums floats in scan order and the
 * app-wide merge sums per-project subtotals, so last-ulp drift is expected).
 *
 * Real in-memory better-sqlite3 DBs bootstrapped via runProjectMigrations;
 * skips cleanly when better-sqlite3 cannot load under the runner's Node ABI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors usage-history-migration.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    // Use a variable for the module name to avoid the static-require lint rule
    // (which targets string-literal bare requires in bundled main/preload code;
    // this is a test helper for a native probe, not a bundled require).
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { UsageHistoryRepository } from '../../src/main/db/repositories/usage-history-repository';
import { ConversationUsageStore, type GroupedTurnUsageRow } from '../../src/main/retrieval/conversation/conversation-usage-store';
import {
  COST_GROUP_MS,
  TURN_GROUP_MS,
  buildAgentBreakdown,
  buildBucketStarts,
  buildEffortBreakdown,
  buildModelBreakdown,
  bucketStartFor,
  computeKpis,
  foldCostSeries,
  foldTokenSeries,
  mergeUsageTotals,
  type ChartBucketKind,
} from '../../src/main/usage-stats/bucketing';
import { humanizeModelId, parseModelId } from '../../src/shared/model-id';
import type {
  AgentUsageBreakdown,
  CostSeriesPoint,
  EffortUsageBreakdown,
  ModelUsageBreakdown,
  TokenSeriesPoint,
  UsageKpis,
} from '../../src/shared/types';

// ---------------------------------------------------------------------------
// The LEGACY pipeline: verbatim copies of the pre-refactor fold functions and
// the raw row/group SELECTs the old readers issued. Deliberately duplicated
// here (not imported) so the production code can evolve while the oracle
// stays frozen at the pre-refactor semantics.
// ---------------------------------------------------------------------------

interface LegacyUsageRow {
  sessionRecordId: string;
  sessionStartedAt: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number | null;
  toolCallCount: number;
  modelId: string | null;
  modelDisplayName: string | null;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  compactionCount: number;
  agent: string | null;
  effort: string | null;
}

/** The pre-refactor group shape: per (bucket, session, model), no SQL cost. */
interface LegacyGroup {
  bucketStartMs: number;
  sessionId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnCount: number;
}

function legacyListRowsAfter(db: InstanceType<typeof DatabaseType>, since: string | null, until: string | null): LegacyUsageRow[] {
  const select = `
    SELECT
      session_record_id AS sessionRecordId,
      session_started_at AS sessionStartedAt,
      total_cost_usd AS totalCostUsd,
      total_input_tokens AS totalInputTokens,
      total_output_tokens AS totalOutputTokens,
      total_duration_ms AS totalDurationMs,
      tool_call_count AS toolCallCount,
      model_id AS modelId,
      model_display_name AS modelDisplayName,
      lines_added AS linesAdded,
      lines_removed AS linesRemoved,
      files_changed AS filesChanged,
      compaction_count AS compactionCount,
      agent,
      effort
    FROM usage_history
  `;
  const clauses: string[] = [];
  const params: string[] = [];
  if (since !== null) {
    clauses.push('session_started_at >= ?');
    params.push(since);
  }
  if (until !== null) {
    clauses.push('session_started_at < ?');
    params.push(until);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`${select}${where} ORDER BY session_started_at ASC`).all(...params) as LegacyUsageRow[];
}

function legacyGetGroupedUsageSince(db: InstanceType<typeof DatabaseType>, sinceMs: number | null, groupMs: number, untilMs: number | null): LegacyGroup[] {
  const select = `
    SELECT
      CAST(ts / ? AS INTEGER) * ? AS bucketStartMs,
      session_id AS sessionId,
      model,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_creation_input_tokens) AS cacheCreationTokens,
      SUM(cache_read_input_tokens) AS cacheReadTokens,
      COUNT(*) AS turnCount
    FROM conversation_turn_usage
  `;
  const tail = 'GROUP BY bucketStartMs, session_id, model ORDER BY bucketStartMs ASC';
  const clauses = ['ts IS NOT NULL'];
  const params: number[] = [groupMs, groupMs];
  if (sinceMs !== null) {
    clauses.push('ts >= ?');
    params.push(sinceMs);
  }
  if (untilMs !== null) {
    clauses.push('ts < ?');
    params.push(untilMs);
  }
  return db.prepare(`${select} WHERE ${clauses.join(' AND ')} ${tail}`).all(...params) as LegacyGroup[];
}

function legacyBuildSessionTokenTotals(groups: LegacyGroup[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const group of groups) {
    if (group.sessionId === null) continue;
    totals.set(group.sessionId, (totals.get(group.sessionId) ?? 0) + group.inputTokens + group.outputTokens);
  }
  return totals;
}

function legacyAllocateGroupCost(
  group: LegacyGroup,
  sessionCostUsd: ReadonlyMap<string, number>,
  sessionTokenTotals: ReadonlyMap<string, number>,
): number {
  if (group.sessionId === null) return 0;
  const cost = sessionCostUsd.get(group.sessionId);
  const totalTokens = sessionTokenTotals.get(group.sessionId);
  if (!cost || !totalTokens) return 0;
  return cost * ((group.inputTokens + group.outputTokens) / totalTokens);
}

function legacyFoldTokenSeries(
  groups: LegacyGroup[],
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
  const sessionTokenTotals = legacyBuildSessionTokenTotals(groups);
  for (const group of groups) {
    const index = indexByStart.get(bucketStartFor(group.bucketStartMs, kind));
    if (index === undefined) continue;
    const point = points[index];
    point.inputTokens += group.inputTokens;
    point.outputTokens += group.outputTokens;
    point.cacheCreationTokens += group.cacheCreationTokens;
    point.cacheReadTokens += group.cacheReadTokens;
    point.allocatedCostUsd += legacyAllocateGroupCost(group, sessionCostUsd, sessionTokenTotals);
    point.turnCount += group.turnCount;
  }
  return points;
}

function legacyFoldCostSeries(usageRows: LegacyUsageRow[], starts: number[], kind: ChartBucketKind): CostSeriesPoint[] {
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

function legacyComputeKpis(
  usageRows: LegacyUsageRow[],
  groups: LegacyGroup[],
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
  const sessionTokenTotals = legacyBuildSessionTokenTotals(groups);
  for (const group of groups) {
    cacheCreationTokens += group.cacheCreationTokens;
    cacheReadTokens += group.cacheReadTokens;
    turnInputTokens += group.inputTokens;
    turnOutputTokens += group.outputTokens;
    allocatedCostUsd += legacyAllocateGroupCost(group, sessionCostUsd, sessionTokenTotals);
  }
  const turnTokens = turnInputTokens + turnOutputTokens;

  const elapsedHours = Math.max(elapsedMs, 60_000) / 3_600_000;
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

function legacyBuildModelBreakdown(usageRows: LegacyUsageRow[]): ModelUsageBreakdown[] {
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

function legacyBuildAgentBreakdown(usageRows: LegacyUsageRow[]): AgentUsageBreakdown[] {
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

function legacyBuildEffortBreakdown(usageRows: LegacyUsageRow[]): EffortUsageBreakdown[] {
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

// ---------------------------------------------------------------------------
// Numeric comparison: exact for integers/strings/structure/order, relative
// 1e-9 for floats (the sanctioned deviation).
// ---------------------------------------------------------------------------

function expectNumericallyEqual(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isInteger(expected) && Number.isInteger(actual)) {
      expect(actual, path).toBe(expected);
    } else {
      const tolerance = Math.max(Math.abs(expected) * 1e-9, 1e-12);
      expect(Math.abs(actual - expected), `${path} (|${actual} - ${expected}|)`).toBeLessThanOrEqual(tolerance);
    }
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path}.length`).toBe(expected.length);
    expected.forEach((entry, index) => expectNumericallyEqual((actual as unknown[])[index], entry, `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', path).toBe(true);
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    expect(actualKeys, `${path} keys`).toEqual(expectedKeys);
    for (const key of expectedKeys) {
      expectNumericallyEqual(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

// ---------------------------------------------------------------------------
// Deterministic dataset (mulberry32, same PRNG the seed script uses).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_MS = Date.parse('2026-03-01T00:00:00.000Z');
const SPAN_DAYS = 40;
const MODELS: Array<{ id: string | null; display: string | null }> = [
  { id: 'claude-opus-4-8', display: 'Opus 4.8' },
  { id: 'claude-opus-4-8-20250815', display: 'Opus 4.8' },
  { id: 'claude-opus-4-8[1m]', display: 'Opus 4.8 [1m]' },
  { id: 'gpt-5.3-codex', display: 'GPT-5.3 Codex' },
  { id: null, display: null },
];
const AGENTS: Array<string | null> = ['claude', 'codex', 'gemini', null];
const EFFORTS: Array<string | null> = ['low', 'medium', 'high', null, null];

function seedProject(db: InstanceType<typeof DatabaseType>, prngSeed: number, sessionCount: number): void {
  const random = mulberry32(prngSeed);
  const insertUsage = db.prepare(`
    INSERT INTO usage_history (id, session_record_id, recorded_at,
      session_started_at, total_cost_usd, total_input_tokens,
      total_output_tokens, total_duration_ms, tool_call_count, model_id,
      model_display_name, lines_added, lines_removed, files_changed,
      compaction_count, agent, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTurn = db.prepare(`
    INSERT INTO conversation_turn_usage (turn_uuid, session_id, model, ts,
      input_tokens, output_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < sessionCount; index++) {
    const sessionRecordId = `seed-${prngSeed}-${index}`;
    const startedMs = BASE_MS + Math.floor(random() * SPAN_DAYS * 24 * 3_600_000);
    const startedIso = new Date(startedMs).toISOString();
    const model = MODELS[Math.floor(random() * MODELS.length)];
    const costUsd = random() < 0.2 ? 0 : Math.round(random() * 8_000) / 1000;
    const inputTokens = Math.floor(random() * 200_000);
    const outputTokens = Math.floor(random() * 20_000);
    // ~10% of sessions have NO usage_history row at all (turns only) - the
    // "no ledger row for this session" allocation edge.
    const hasLedgerRow = random() >= 0.1;
    if (hasLedgerRow) {
      insertUsage.run(
        `id-${sessionRecordId}`,
        sessionRecordId,
        new Date(startedMs + 3_600_000).toISOString(),
        startedIso,
        costUsd,
        inputTokens,
        outputTokens,
        random() < 0.15 ? null : Math.floor(random() * 7_200_000),
        Math.floor(random() * 120),
        model.id,
        model.display,
        Math.floor(random() * 400),
        Math.floor(random() * 150),
        Math.floor(random() * 20),
        Math.floor(random() * 4),
        AGENTS[Math.floor(random() * AGENTS.length)],
        EFFORTS[Math.floor(random() * EFFORTS.length)],
      );
    }
    const turnCount = Math.floor(random() * 9);
    for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
      const tsIsNull = random() < 0.05;
      const sessionIdIsNull = random() < 0.05;
      insertTurn.run(
        `turn-${prngSeed}-${index}-${turnIndex}`,
        sessionIdIsNull ? null : sessionRecordId,
        model.id,
        tsIsNull ? null : startedMs + Math.floor(random() * 2 * 3_600_000),
        Math.floor(random() * 5_000),
        Math.floor(random() * 2_000),
        Math.floor(random() * 10_000),
        Math.floor(random() * 100_000),
        new Date(startedMs + 3_600_000).toISOString(),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The equivalence suite.
// ---------------------------------------------------------------------------

describe.runIf(CAN_RUN)('usage-stats SQL pushdown equivalence (new SQL vs legacy JS folds)', () => {
  const databases: Array<InstanceType<typeof DatabaseType>> = [];

  beforeAll(() => {
    if (!Database) return;
    for (const [prngSeed, sessionCount] of [[42, 220], [1337, 180]] as const) {
      const db = new Database(':memory:');
      runProjectMigrations(db);
      seedProject(db, prngSeed, sessionCount);
      databases.push(db);
    }
  });

  afterAll(() => {
    for (const db of databases) db.close();
  });

  /** Windows exercised per assertion: all time, a bounded mid-history slice
   *  (edges land mid-data), and an empty far-future window. */
  const WINDOWS: Array<{ label: string; sinceIso: string | null; untilIso: string | null }> = [
    { label: 'all time', sinceIso: null, untilIso: null },
    {
      label: 'bounded mid-history',
      sinceIso: new Date(BASE_MS + 10 * 24 * 3_600_000).toISOString(),
      untilIso: new Date(BASE_MS + 25 * 24 * 3_600_000).toISOString(),
    },
    {
      label: 'empty window',
      sinceIso: '2031-01-01T00:00:00.000Z',
      untilIso: '2031-02-01T00:00:00.000Z',
    },
  ];

  function msOf(iso: string | null): number | null {
    return iso === null ? null : Date.parse(iso);
  }

  it('KPIs: SQL totals + SQL-allocated groups equal the legacy row/group fold, per window and merged across projects', () => {
    for (const window of WINDOWS) {
      const sinceMs = msOf(window.sinceIso);
      const untilMs = msOf(window.untilIso);
      const elapsedMs = 7 * 24 * 3_600_000;

      const totalsList = [];
      // The KPI group sums are grid-independent; read at the coarse
      // (non-Live) width the service uses for these periods.
      const newGroups: GroupedTurnUsageRow[] = [];
      const legacyRows: LegacyUsageRow[] = [];
      const legacyGroups: LegacyGroup[] = [];
      for (const db of databases) {
        const repository = new UsageHistoryRepository(db);
        const store = new ConversationUsageStore(db);
        totalsList.push(repository.getUsageTotals(window.sinceIso, window.untilIso));
        newGroups.push(...store.getGroupedUsageSince(sinceMs, COST_GROUP_MS, untilMs, window.sinceIso, window.untilIso));
        legacyRows.push(...legacyListRowsAfter(db, window.sinceIso, window.untilIso));
        legacyGroups.push(...legacyGetGroupedUsageSince(db, sinceMs, TURN_GROUP_MS, untilMs));
      }
      const legacyCostMap = new Map(legacyRows.map((row) => [row.sessionRecordId, row.totalCostUsd]));

      const newKpis = computeKpis(mergeUsageTotals(totalsList), newGroups, elapsedMs);
      const legacyKpis = legacyComputeKpis(legacyRows, legacyGroups, legacyCostMap, elapsedMs);
      // burnRateTokensPerHour gates on groups.length > 0; the counts differ
      // between the shapes (buckets vs session-groups), but the GATE (any
      // turns at all) must agree, and every summed field must match.
      expectNumericallyEqual(newKpis, legacyKpis, `kpis[${window.label}]`);
    }
  });

  it('cost series: 15-minute SQL groups fold to the same points (including byModel slice order) as raw rows', () => {
    for (const window of WINDOWS) {
      for (const kind of ['hour', 'day', 'week'] as const) {
        const newCostGroups = [];
        const legacyRows: LegacyUsageRow[] = [];
        for (const db of databases) {
          newCostGroups.push(...new UsageHistoryRepository(db).listUsageCostGroups(window.sinceIso, window.untilIso, COST_GROUP_MS));
          legacyRows.push(...legacyListRowsAfter(db, window.sinceIso, window.untilIso));
        }
        const rangeStartMs = msOf(window.sinceIso) ?? BASE_MS;
        const rangeEndMs = msOf(window.untilIso) ?? BASE_MS + SPAN_DAYS * 24 * 3_600_000;
        const starts = buildBucketStarts(rangeStartMs, rangeEndMs, kind);

        const newSeries = foldCostSeries(newCostGroups, starts, kind);
        const legacySeries = legacyFoldCostSeries(legacyRows, starts, kind);
        expectNumericallyEqual(newSeries, legacySeries, `costSeries[${window.label}][${kind}]`);
      }
    }
  });

  it('token series: SQL-allocated bucket groups fold to the same points as legacy map-based allocation', () => {
    for (const window of WINDOWS) {
      // fiveMinutes exercises the Live grid; the coarser kinds exercise the
      // 15-minute grid the service uses everywhere else - both must fold to
      // the same chart points the legacy 5-minute per-session groups did.
      for (const kind of ['fiveMinutes', 'halfHour', 'hour', 'day', 'week'] as const) {
        const groupMs = kind === 'fiveMinutes' ? TURN_GROUP_MS : COST_GROUP_MS;
        const sinceMs = msOf(window.sinceIso);
        const untilMs = msOf(window.untilIso);
        const newGroups: GroupedTurnUsageRow[] = [];
        const legacyRows: LegacyUsageRow[] = [];
        const legacyGroups: LegacyGroup[] = [];
        for (const db of databases) {
          newGroups.push(...new ConversationUsageStore(db).getGroupedUsageSince(sinceMs, groupMs, untilMs, window.sinceIso, window.untilIso));
          legacyRows.push(...legacyListRowsAfter(db, window.sinceIso, window.untilIso));
          legacyGroups.push(...legacyGetGroupedUsageSince(db, sinceMs, TURN_GROUP_MS, untilMs));
        }
        const legacyCostMap = new Map(legacyRows.map((row) => [row.sessionRecordId, row.totalCostUsd]));
        const rangeStartMs = msOf(window.sinceIso) ?? BASE_MS;
        const rangeEndMs = msOf(window.untilIso) ?? BASE_MS + SPAN_DAYS * 24 * 3_600_000;
        const starts = buildBucketStarts(rangeStartMs, rangeEndMs, kind);

        const newSeries = foldTokenSeries(newGroups, starts, kind);
        const legacySeries = legacyFoldTokenSeries(legacyGroups, legacyCostMap, starts, kind);
        expectNumericallyEqual(newSeries, legacySeries, `tokenSeries[${window.label}][${kind}]`);
      }
    }
  });

  it('breakdowns: the dimension rollup regroups to the same model/agent/effort tables (order included)', () => {
    for (const window of WINDOWS) {
      const newRollup = [];
      const legacyRows: LegacyUsageRow[] = [];
      for (const db of databases) {
        newRollup.push(...new UsageHistoryRepository(db).listUsageRollup(window.sinceIso, window.untilIso));
        legacyRows.push(...legacyListRowsAfter(db, window.sinceIso, window.untilIso));
      }
      expectNumericallyEqual(buildModelBreakdown(newRollup), legacyBuildModelBreakdown(legacyRows), `byModel[${window.label}]`);
      expectNumericallyEqual(buildAgentBreakdown(newRollup), legacyBuildAgentBreakdown(legacyRows), `byAgent[${window.label}]`);
      expectNumericallyEqual(buildEffortBreakdown(newRollup), legacyBuildEffortBreakdown(legacyRows), `byEffort[${window.label}]`);
    }
  });

  it('live-session dedup: the windowed COUNT equals the legacy set-membership count', () => {
    for (const window of WINDOWS) {
      const db = databases[0];
      const repository = new UsageHistoryRepository(db);
      const legacyRows = legacyListRowsAfter(db, window.sinceIso, window.untilIso);
      // Half real ids sampled from the ledger, half unknown live ids.
      const candidateIds = [
        ...legacyRows.slice(0, 5).map((row) => row.sessionRecordId),
        'live-a',
        'live-b',
      ];
      const legacyLedgerIds = new Set(legacyRows.map((row) => row.sessionRecordId));
      const legacyCount = candidateIds.filter((recordId) => legacyLedgerIds.has(recordId)).length;
      expect(repository.countSessionsRepresented(window.sinceIso, window.untilIso, candidateIds)).toBe(legacyCount);
    }
  });
});

// ---------------------------------------------------------------------------
// Skip-notice for environments where better-sqlite3 cannot load.
// ---------------------------------------------------------------------------

describe.runIf(!CAN_RUN)('usage-stats SQL equivalence tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
