/**
 * The usage-stats service orchestration (src/main/usage-stats/
 * usage-stats-service.ts) through its DI seam: which cutoffs reach the
 * readers, the app-wide project loop's guards, and the composite payload
 * shape. The math itself is covered by usage-stats-bucketing.test.ts and the
 * real-DB aggregate suites; the critical contract HERE is the
 * missing-DB-file guard - `getProjectDb` CREATES a database for a missing
 * file, so the loop must never touch a project whose DB file does not exist.
 *
 * The fake reader is a tiny reference implementation: it derives the
 * SQL-shaped aggregates (window totals, dimension rollup, cost groups, cost
 * allocation) from plain row fixtures, applying the same [since, until)
 * session_started_at window the real queries apply. The real SQL is pinned
 * separately by usage-history-aggregates.test.ts and
 * conversation-usage-cost-allocation.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { createUsageStatsService, type ProjectUsageReader } from '../../src/main/usage-stats/usage-stats-service';
import { COST_GROUP_MS, LIVE_WINDOW_MS, TURN_GROUP_MS } from '../../src/main/usage-stats/bucketing';
import { computePeriodCutoff } from '../../src/shared/period-cutoff';
import type {
  UsageCostGroupRow,
  UsageRollupRow,
  UsageWindowTotals,
} from '../../src/main/db/repositories/usage-history-repository';
import type { GroupedTurnUsageRow } from '../../src/main/retrieval/conversation/conversation-usage-store';
import type { LiveSessionRow } from '../../src/shared/types';

/** Plain fixture row mirroring one usage_history row. */
interface FixtureRow {
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

function makeRow(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    sessionRecordId: 'session-1',
    // "Now", not now-minus-an-hour: the fake reader applies real window
    // filtering, and a fixed offset would fall outside the 'today' window
    // when the suite runs within that offset of local midnight.
    sessionStartedAt: new Date().toISOString(),
    totalCostUsd: 1,
    totalInputTokens: 100,
    totalOutputTokens: 40,
    totalDurationMs: 1000,
    toolCallCount: 2,
    modelId: 'model-x',
    modelDisplayName: 'Model X',
    linesAdded: 1,
    linesRemoved: 1,
    filesChanged: 1,
    compactionCount: 0,
    agent: 'claude',
    effort: null,
    ...overrides,
  };
}

function makeLiveSession(overrides: Partial<LiveSessionRow> = {}): LiveSessionRow {
  return {
    sessionRecordId: 'live-1',
    projectId: 'p1',
    startedAtIso: new Date().toISOString(),
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0,
    totalDurationMs: null,
    toolCallCount: 1,
    modelId: null,
    modelDisplayName: null,
    agent: null,
    effort: null,
    ...overrides,
  };
}

/** Per-session turn fixture: the fake reader allocates cost from the
 *  project's rows and folds to bucket-only output, like the real SQL does. */
interface FixtureGroup {
  bucketStartMs: number;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnCount: number;
}

function makeGroup(overrides: Partial<FixtureGroup> = {}): FixtureGroup {
  return {
    bucketStartMs: Math.floor((Date.now() - 30 * 60_000) / TURN_GROUP_MS) * TURN_GROUP_MS,
    sessionId: 'session-1',
    inputTokens: 50,
    outputTokens: 25,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turnCount: 1,
    ...overrides,
  };
}

function inWindow(row: FixtureRow, sinceIso: string | null, untilIso: string | null): boolean {
  if (sinceIso !== null && row.sessionStartedAt < sinceIso) return false;
  if (untilIso !== null && row.sessionStartedAt >= untilIso) return false;
  return true;
}

function computeTotals(rows: FixtureRow[]): UsageWindowTotals {
  const totals: UsageWindowTotals = {
    sessionCount: rows.length,
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
  for (const row of rows) {
    totals.totalCostUsd += row.totalCostUsd;
    totals.totalInputTokens += row.totalInputTokens;
    totals.totalOutputTokens += row.totalOutputTokens;
    totals.toolCallCount += row.toolCallCount;
    totals.linesAdded += row.linesAdded;
    totals.linesRemoved += row.linesRemoved;
    totals.filesChanged += row.filesChanged;
    totals.compactionCount += row.compactionCount;
    totals.totalDurationMs += row.totalDurationMs ?? 0;
    if (row.totalCostUsd > 0) totals.costKnownCount += 1;
    if (totals.minSessionStartedAt === null || row.sessionStartedAt < totals.minSessionStartedAt) {
      totals.minSessionStartedAt = row.sessionStartedAt;
    }
    if (totals.maxSessionStartedAt === null || row.sessionStartedAt > totals.maxSessionStartedAt) {
      totals.maxSessionStartedAt = row.sessionStartedAt;
    }
  }
  return totals;
}

function computeRollup(rows: FixtureRow[]): UsageRollupRow[] {
  const sorted = [...rows].sort((first, second) => first.sessionStartedAt.localeCompare(second.sessionStartedAt));
  const byCombo = new Map<string, UsageRollupRow>();
  for (const row of sorted) {
    const key = JSON.stringify([row.modelId, row.modelDisplayName, row.agent, row.effort]);
    let entry = byCombo.get(key);
    if (!entry) {
      entry = {
        modelId: row.modelId,
        modelDisplayName: row.modelDisplayName,
        agent: row.agent,
        effort: row.effort,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        sessionCount: 0,
      };
      byCombo.set(key, entry);
    }
    entry.inputTokens += row.totalInputTokens;
    entry.outputTokens += row.totalOutputTokens;
    entry.costUsd += row.totalCostUsd;
    entry.sessionCount += 1;
  }
  return [...byCombo.values()];
}

function computeCostGroups(rows: FixtureRow[]): UsageCostGroupRow[] {
  const sorted = [...rows].sort((first, second) => first.sessionStartedAt.localeCompare(second.sessionStartedAt));
  const byBucketAndModel = new Map<string, UsageCostGroupRow>();
  for (const row of sorted) {
    const startedMs = Date.parse(row.sessionStartedAt);
    if (Number.isNaN(startedMs)) continue;
    const bucketStartMs = Math.floor(startedMs / COST_GROUP_MS) * COST_GROUP_MS;
    const key = `${bucketStartMs}::${row.modelId ?? ''}`;
    let entry = byBucketAndModel.get(key);
    if (!entry) {
      entry = { bucketStartMs, modelId: row.modelId, costUsd: 0, inputTokens: 0, outputTokens: 0, sessionCount: 0 };
      byBucketAndModel.set(key, entry);
    }
    entry.costUsd += row.totalCostUsd;
    entry.inputTokens += row.totalInputTokens;
    entry.outputTokens += row.totalOutputTokens;
    entry.sessionCount += 1;
  }
  return [...byBucketAndModel.values()].sort((first, second) => first.bucketStartMs - second.bucketStartMs);
}

function allocateGroups(
  groups: FixtureGroup[],
  costRows: FixtureRow[],
): GroupedTurnUsageRow[] {
  const costBySession = new Map(costRows.map((row) => [row.sessionRecordId, row.totalCostUsd]));
  const tokensBySession = new Map<string, number>();
  for (const group of groups) {
    if (group.sessionId === null) continue;
    tokensBySession.set(group.sessionId, (tokensBySession.get(group.sessionId) ?? 0) + group.inputTokens + group.outputTokens);
  }
  const byBucket = new Map<number, GroupedTurnUsageRow>();
  for (const group of groups) {
    const cost = group.sessionId === null ? undefined : costBySession.get(group.sessionId);
    const totalTokens = group.sessionId === null ? undefined : tokensBySession.get(group.sessionId);
    const allocatedCostUsd = !cost || !totalTokens ? 0 : cost * ((group.inputTokens + group.outputTokens) / totalTokens);
    let bucket = byBucket.get(group.bucketStartMs);
    if (!bucket) {
      bucket = {
        bucketStartMs: group.bucketStartMs,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        turnCount: 0,
        allocatedCostUsd: 0,
      };
      byBucket.set(group.bucketStartMs, bucket);
    }
    bucket.inputTokens += group.inputTokens;
    bucket.outputTokens += group.outputTokens;
    bucket.cacheCreationTokens += group.cacheCreationTokens;
    bucket.cacheReadTokens += group.cacheReadTokens;
    bucket.turnCount += group.turnCount;
    bucket.allocatedCostUsd += allocatedCostUsd;
  }
  return [...byBucket.values()].sort((first, second) => first.bucketStartMs - second.bucketStartMs);
}

interface FakeProject {
  id: string;
  name: string;
  exists?: boolean;
  rows?: FixtureRow[];
  groups?: FixtureGroup[];
  throws?: boolean;
}

interface ReaderCall {
  projectId: string;
  method: 'getUsageTotals' | 'listUsageRollup' | 'listUsageCostGroups' | 'listTurnGroups' | 'countSessionsRepresented';
  sinceIso?: string | null;
  untilIso?: string | null;
  sinceMs?: number | null;
  untilMs?: number | null;
  groupMs?: number;
  costSinceIso?: string | null;
  costUntilIso?: string | null;
  sessionRecordIds?: string[];
}

function makeService(projects: FakeProject[], nowMs = Date.now()) {
  const readerCalls: ReaderCall[] = [];
  const openReader = vi.fn((projectId: string): ProjectUsageReader => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    if (project.throws) throw new Error('corrupt database');
    const allRows = project.rows ?? [];
    const allGroups = project.groups ?? [];
    return {
      getUsageTotals: (sinceIso, untilIso) => {
        readerCalls.push({ projectId, method: 'getUsageTotals', sinceIso, untilIso });
        return computeTotals(allRows.filter((row) => inWindow(row, sinceIso, untilIso)));
      },
      listUsageRollup: (sinceIso, untilIso) => {
        readerCalls.push({ projectId, method: 'listUsageRollup', sinceIso, untilIso });
        return computeRollup(allRows.filter((row) => inWindow(row, sinceIso, untilIso)));
      },
      listUsageCostGroups: (sinceIso, untilIso, groupMs) => {
        readerCalls.push({ projectId, method: 'listUsageCostGroups', sinceIso, untilIso, groupMs });
        return computeCostGroups(allRows.filter((row) => inWindow(row, sinceIso, untilIso)));
      },
      listTurnGroups: (sinceMs, groupMs, untilMs, costSinceIso, costUntilIso) => {
        readerCalls.push({ projectId, method: 'listTurnGroups', sinceMs, untilMs, groupMs, costSinceIso, costUntilIso });
        const windowed = allGroups.filter((group) =>
          (sinceMs === null || group.bucketStartMs >= sinceMs) && (untilMs === null || group.bucketStartMs < untilMs));
        return allocateGroups(windowed, allRows.filter((row) => inWindow(row, costSinceIso, costUntilIso)));
      },
      countSessionsRepresented: (sinceIso, untilIso, sessionRecordIds) => {
        readerCalls.push({ projectId, method: 'countSessionsRepresented', sinceIso, untilIso, sessionRecordIds });
        const windowedIds = new Set(
          allRows.filter((row) => inWindow(row, sinceIso, untilIso)).map((row) => row.sessionRecordId),
        );
        return sessionRecordIds.filter((recordId) => windowedIds.has(recordId)).length;
      },
    };
  });
  const service = createUsageStatsService({
    openReader,
    listProjects: () => projects.map((project) => ({ id: project.id, name: project.name })),
    projectDbExists: (projectId) => projects.find((candidate) => candidate.id === projectId)?.exists !== false,
    now: () => nowMs,
  });
  return { service, openReader, readerCalls };
}

describe('usage-stats service: cutoffs and payload shape', () => {
  it('passes the ISO cutoff to usage aggregates and the epoch-ms cutoff to turn groups', () => {
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    const totalsCall = readerCalls.find((call) => call.method === 'getUsageTotals');
    const groupCall = readerCalls.find((call) => call.method === 'listTurnGroups');
    expect(totalsCall?.sinceIso).toBe(computePeriodCutoff('today'));
    expect(groupCall?.sinceMs).toBe(Date.parse(computePeriodCutoff('today')!));
    // Non-Live periods group turns on the coarser 15-minute grid (nests into
    // every halfHour-and-up chart bucket; 3x fewer group rows on wide ranges).
    expect(groupCall?.groupMs).toBe(COST_GROUP_MS);
  });

  it('groups turns on the 5-minute grid ONLY for Live (its chart buckets sit on that grid)', () => {
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'live');

    const groupCall = readerCalls.find((call) => call.method === 'listTurnGroups');
    expect(groupCall?.groupMs).toBe(TURN_GROUP_MS);
  });

  it('passes the SAME usage window to the turn-group cost allocation (a session outside it allocates $0)', () => {
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    const totalsCall = readerCalls.find((call) => call.method === 'getUsageTotals');
    const groupCall = readerCalls.find((call) => call.method === 'listTurnGroups');
    expect(groupCall?.costSinceIso).toBe(totalsCall?.sinceIso);
    expect(groupCall?.costUntilIso).toBe(totalsCall?.untilIso ?? null);
  });

  it('requests cost groups on the 15-minute grid', () => {
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    const costGroupCall = readerCalls.find((call) => call.method === 'listUsageCostGroups');
    expect(costGroupCall?.groupMs).toBe(COST_GROUP_MS);
  });

  it('live scopes both reads to the trailing window and returns an empty cost series', () => {
    const nowMs = Date.now();
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }], nowMs);
    const stats = service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'live');

    const groupCall = readerCalls.find((call) => call.method === 'listTurnGroups');
    expect(groupCall?.sinceMs).toBe(Math.floor((nowMs - LIVE_WINDOW_MS) / TURN_GROUP_MS) * TURN_GROUP_MS);
    expect(stats.costSeries).toEqual([]);
    expect(stats.rangeEndMs).toBe(nowMs);
    expect(stats.generatedAtMs).toBe(nowMs);
  });

  it('project scope carries no perProject/skippedProjects; series are dense', () => {
    const { service } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow()], groups: [makeGroup()] },
    ]);
    const stats = service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    expect(stats.perProject).toBeUndefined();
    expect(stats.skippedProjects).toBeUndefined();
    expect(stats.tokenSeries.length).toBeGreaterThan(0);
    // Dense: every bucket present between range start and end.
    for (let index = 1; index < stats.tokenSeries.length; index++) {
      expect(stats.tokenSeries[index].bucketStartMs).toBeGreaterThan(stats.tokenSeries[index - 1].bucketStartMs);
    }
    expect(stats.kpis.totalTokens).toBe(140);
  });
});

describe('usage-stats service: app-wide rollup', () => {
  it('NEVER opens a project whose DB file does not exist (getProjectDb would create it)', () => {
    const { service, openReader } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow()] },
      { id: 'p2', name: 'Never Opened', exists: false },
    ]);
    const stats = service.getDashboardStats({ kind: 'all' }, 'all');

    expect(openReader).toHaveBeenCalledTimes(1);
    expect(openReader).toHaveBeenCalledWith('p1');
    // Missing DB = legitimately zero usage, not an error.
    expect(stats.skippedProjects).toBeUndefined();
    expect(stats.perProject).toHaveLength(1);
  });

  it('a project whose read throws lands in skippedProjects instead of failing the payload', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { service } = makeService([
        { id: 'p1', name: 'Good', rows: [makeRow()] },
        { id: 'p2', name: 'Corrupt', throws: true },
      ]);
      const stats = service.getDashboardStats({ kind: 'all' }, 'all');

      expect(stats.skippedProjects).toEqual([{ projectId: 'p2', projectName: 'Corrupt' }]);
      expect(stats.perProject).toHaveLength(1);
      expect(stats.kpis.sessionCount).toBe(1);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('merges every project before one global fold: KPIs sum, breakdowns merge', () => {
    const { service } = makeService([
      {
        id: 'p1',
        name: 'One',
        rows: [makeRow({ sessionRecordId: 'a', agent: 'claude', effort: 'high', totalCostUsd: 2 })],
        groups: [makeGroup({ sessionId: 'a' })],
      },
      {
        id: 'p2',
        name: 'Two',
        rows: [makeRow({ sessionRecordId: 'b', agent: 'codex', totalCostUsd: 3 })],
        groups: [makeGroup({ sessionId: 'b' })],
      },
    ]);
    const stats = service.getDashboardStats({ kind: 'all' }, 'all');

    expect(stats.kpis.totalCostUsd).toBe(5);
    expect(stats.kpis.sessionCount).toBe(2);
    expect(stats.byAgent.map((entry) => entry.agent).sort()).toEqual(['claude', 'codex']);
    expect(stats.byEffort).toHaveLength(2);
    expect(stats.byEffort.map((entry) => entry.effort)).toEqual(expect.arrayContaining(['high', null]));
    expect(stats.perProject).toEqual([
      expect.objectContaining({ projectId: 'p1', projectName: 'One', costUsd: 2, sessionCount: 1, topAgent: 'claude' }),
      expect.objectContaining({ projectId: 'p2', projectName: 'Two', costUsd: 3, sessionCount: 1, topAgent: 'codex' }),
    ]);
  });

  it('sums filesChanged into each perProject summary (previously dropped)', () => {
    const { service } = makeService([
      {
        id: 'p1',
        name: 'One',
        rows: [
          makeRow({ sessionRecordId: 'a', filesChanged: 2 }),
          makeRow({ sessionRecordId: 'b', filesChanged: 3 }),
        ],
      },
    ]);
    const stats = service.getDashboardStats({ kind: 'all' }, 'all');

    expect(stats.perProject?.[0]).toEqual(expect.objectContaining({ filesChanged: 5 }));
  });

  it("All Time buckets adapt to the data span: a two-week history renders DAILY, not three weekly bars", () => {
    const nowMs = Date.now();
    const dayMs = 24 * 3_600_000;
    const { service } = makeService([
      {
        id: 'p1',
        name: 'One',
        rows: [
          makeRow({ sessionRecordId: 'old', sessionStartedAt: new Date(nowMs - 14 * dayMs).toISOString() }),
          makeRow({ sessionRecordId: 'new', sessionStartedAt: new Date(nowMs - dayMs).toISOString() }),
        ],
      },
    ], nowMs);
    const stats = service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'all');

    expect(stats.costBucketSizeMs).toBe(dayMs);
    expect(stats.bucketSizeMs).toBe(dayMs);
    // Dense daily grid across the ~2-week span (14-16 local-day buckets).
    expect(stats.costSeries.length).toBeGreaterThanOrEqual(14);
    expect(stats.costSeries.length).toBeLessThanOrEqual(16);
  });

  it('a day drill bounds BOTH reads to the local day and re-scopes the range at hourly granularity', () => {
    const nowMs = Date.now();
    const dayMs = 24 * 3_600_000;
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }], nowMs);

    // Drill into 3 local days ago (any ms within the day is accepted).
    const target = new Date(nowMs - 3 * dayMs);
    const dayStartMs = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
    const dayEndMs = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1).getTime();
    const stats = service.getDashboardStats(
      { kind: 'project', projectId: 'p1' },
      'all',
      { dayStartMs: dayStartMs + 5 * 3_600_000 },
    );

    const totalsCall = readerCalls.find((call) => call.method === 'getUsageTotals');
    const groupCall = readerCalls.find((call) => call.method === 'listTurnGroups');
    // Without the upper bound a past day's read would include every later session.
    expect(totalsCall?.sinceIso).toBe(new Date(dayStartMs).toISOString());
    expect(totalsCall?.untilIso).toBe(new Date(dayEndMs).toISOString());
    expect(groupCall?.sinceMs).toBe(dayStartMs);
    expect(groupCall?.untilMs).toBe(dayEndMs);

    expect(stats.rangeStartMs).toBe(dayStartMs);
    expect(stats.rangeEndMs).toBe(dayEndMs);
    // Today-style granularity inside the drilled day.
    expect(stats.costBucketSizeMs).toBe(3_600_000);
    expect(stats.bucketSizeMs).toBe(30 * 60_000);
    // A drill compares against the PRECEDING local day.
    expect(stats.previousKpis).not.toBeNull();
    const previousDayCall = readerCalls.find(
      (call) => call.method === 'getUsageTotals' && call.sinceIso === new Date(new Date(dayStartMs).setDate(new Date(dayStartMs).getDate() - 1)).toISOString(),
    );
    expect(previousDayCall?.untilIso).toBe(new Date(dayStartMs).toISOString());
  });

  it('the previous window reads totals + turn groups ONLY (previousKpis has no breakdowns or series)', () => {
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One', rows: [makeRow()] }]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    const currentSinceIso = computePeriodCutoff('today');
    const previousCalls = readerCalls.filter((call) => call.sinceIso !== undefined && call.sinceIso !== currentSinceIso);
    expect(previousCalls.length).toBeGreaterThan(0);
    expect(previousCalls.every((call) => call.method === 'getUsageTotals')).toBe(true);
    const previousGroupCalls = readerCalls.filter(
      (call) => call.method === 'listTurnGroups' && call.costSinceIso !== currentSinceIso,
    );
    expect(previousGroupCalls).toHaveLength(1);
  });

  it('a custom month window bounds both reads, buckets daily, and compares against the preceding same-length window', () => {
    const nowMs = new Date(2026, 6, 10, 12).getTime();
    const sinceMs = new Date(2026, 3, 1).getTime();
    const untilMs = new Date(2026, 5, 1).getTime();
    const { service, readerCalls } = makeService(
      [{ id: 'p1', name: 'One', rows: [makeRow({ sessionStartedAt: new Date(2026, 3, 10).toISOString() })] }],
      nowMs,
    );
    const stats = service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'month', null, { sinceMs, untilMs });

    // Current-window reads carry the window's bounds.
    const totalsCall = readerCalls.find((call) => call.method === 'getUsageTotals' && call.sinceIso === new Date(sinceMs).toISOString());
    expect(totalsCall?.untilIso).toBe(new Date(untilMs).toISOString());
    // The range clamps to the (fully past) window at daily granularity
    // (61-day span stays under the weekly-widening threshold).
    expect(stats.rangeStartMs).toBe(sinceMs);
    expect(stats.rangeEndMs).toBe(untilMs);
    expect(stats.bucketSizeMs).toBe(24 * 3_600_000);
    expect(stats.costBucketSizeMs).toBe(24 * 3_600_000);
    // Deltas compare against the same-length window immediately preceding.
    const spanMs = untilMs - sinceMs;
    const previousTotalsCall = readerCalls.find(
      (call) => call.method === 'getUsageTotals' && call.sinceIso === new Date(sinceMs - spanMs).toISOString(),
    );
    expect(previousTotalsCall?.untilIso).toBe(new Date(sinceMs).toISOString());
    expect(stats.previousKpis).not.toBeNull();
  });

  it('ships previousKpis for bounded periods and null for All Time', () => {
    const { service } = makeService([{ id: 'p1', name: 'One', rows: [makeRow()] }]);
    expect(service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'week').previousKpis).not.toBeNull();
    expect(service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'all').previousKpis).toBeNull();
  });

  it('returns an all-zero payload when no project has data', () => {
    const nowMs = Date.now();
    const { service } = makeService([{ id: 'p1', name: 'One' }], nowMs);
    const stats = service.getDashboardStats({ kind: 'all' }, 'all');

    expect(stats.kpis.totalTokens).toBe(0);
    expect(stats.kpis.burnRateTokensPerHour).toBeNull();
    expect(stats.byModel).toEqual([]);
    expect(stats.byAgent).toEqual([]);
    expect(stats.byEffort).toEqual([]);
  });
});

describe('usage-stats service: live session count overlay', () => {
  // The originally-reported gap was specifically the SESSIONS KPI/Live view
  // undercounting live agents, so the live merge is scoped to `sessionCount`
  // ONLY (both the headline kpis and each perProject entry). Cost/tokens stay
  // purely ledger-derived: KpiTiles layers live cost/tokens itself client-side
  // (useLiveUsageAggregate, fed by pushed usage events with zero IPC
  // round-trip, required for instant reactivity) - merging them here too
  // would double-count against that client-side overlay.

  it('adds a live session (different id) to sessionCount, without touching cost/tokens', () => {
    const { service } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow({ sessionRecordId: 'finalized-1', totalInputTokens: 100, totalOutputTokens: 40, totalCostUsd: 1 })] },
    ]);
    const stats = service.getDashboardStats(
      { kind: 'project', projectId: 'p1' },
      'today',
      null,
      null,
      [makeLiveSession({ sessionRecordId: 'live-1', projectId: 'p1', inputTokens: 500, outputTokens: 200, costUsd: 5 })],
    );

    expect(stats.kpis.sessionCount).toBe(2);
    expect(stats.kpis.totalInputTokens).toBe(100);
    expect(stats.kpis.totalOutputTokens).toBe(40);
    expect(stats.kpis.totalCostUsd).toBe(1);
  });

  it('does NOT double-count a live session already snapshotted into the ledger for the same id', () => {
    const { service } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow({ sessionRecordId: 'shared-id' })] },
    ]);
    const stats = service.getDashboardStats(
      { kind: 'project', projectId: 'p1' },
      'today',
      null,
      null,
      [makeLiveSession({ sessionRecordId: 'shared-id', projectId: 'p1' })],
    );

    expect(stats.kpis.sessionCount).toBe(1);
  });

  it('dedups against the ledger via the windowed COUNT, not an unbounded one', () => {
    const { service, readerCalls } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow({ sessionRecordId: 'shared-id' })] },
    ]);
    service.getDashboardStats(
      { kind: 'project', projectId: 'p1' },
      'today',
      null,
      null,
      [makeLiveSession({ sessionRecordId: 'shared-id', projectId: 'p1' })],
    );

    const dedupCall = readerCalls.find((call) => call.method === 'countSessionsRepresented');
    expect(dedupCall?.sessionRecordIds).toEqual(['shared-id']);
    expect(dedupCall?.sinceIso).toBe(computePeriodCutoff('today'));
  });

  it('skips the dedup query entirely when a project has no live sessions', () => {
    const { service, readerCalls } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow()] },
    ]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    expect(readerCalls.some((call) => call.method === 'countSessionsRepresented')).toBe(false);
  });

  it('scopes live sessions to the matching project in an app-wide rollup, and rolls up into the headline count', () => {
    const { service } = makeService([
      { id: 'p1', name: 'One', rows: [] },
      { id: 'p2', name: 'Two', rows: [] },
    ]);
    const stats = service.getDashboardStats(
      { kind: 'all' },
      'today',
      null,
      null,
      [makeLiveSession({ sessionRecordId: 'live-p1', projectId: 'p1' })],
    );

    const p1Summary = stats.perProject?.find((project) => project.projectId === 'p1');
    const p2Summary = stats.perProject?.find((project) => project.projectId === 'p2');
    expect(p1Summary?.sessionCount).toBe(1);
    expect(p2Summary?.sessionCount).toBe(0);
    expect(stats.kpis.sessionCount).toBe(1);
  });

  it('defaults to no live overlay when liveSessions is omitted (MCP command handler call shape)', () => {
    const { service } = makeService([
      { id: 'p1', name: 'One', rows: [makeRow({ sessionRecordId: 'finalized-1' })] },
    ]);
    const stats = service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    expect(stats.kpis.sessionCount).toBe(1);
  });
});
