/**
 * The usage-stats service orchestration (src/main/usage-stats/
 * usage-stats-service.ts) through its DI seam: which cutoffs reach the
 * readers, the app-wide project loop's guards, and the composite payload
 * shape. The math itself is covered by usage-stats-bucketing.test.ts; the
 * critical contract HERE is the missing-DB-file guard - `getProjectDb`
 * CREATES a database for a missing file, so the loop must never touch a
 * project whose DB file does not exist.
 */
import { describe, it, expect, vi } from 'vitest';
import { createUsageStatsService, type ProjectUsageReader } from '../../src/main/usage-stats/usage-stats-service';
import { LIVE_WINDOW_MS, TURN_GROUP_MS } from '../../src/main/usage-stats/bucketing';
import { computePeriodCutoff } from '../../src/shared/period-cutoff';
import type { UsageHistoryRow } from '../../src/main/db/repositories/usage-history-repository';
import type { GroupedTurnUsageRow } from '../../src/main/retrieval/conversation/conversation-usage-store';

function makeRow(overrides: Partial<UsageHistoryRow> = {}): UsageHistoryRow {
  return {
    sessionRecordId: 'session-1',
    sessionStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
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

function makeGroup(overrides: Partial<GroupedTurnUsageRow> = {}): GroupedTurnUsageRow {
  return {
    bucketStartMs: Math.floor((Date.now() - 30 * 60_000) / TURN_GROUP_MS) * TURN_GROUP_MS,
    sessionId: 'session-1',
    model: 'model-x',
    inputTokens: 50,
    outputTokens: 25,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turnCount: 1,
    ...overrides,
  };
}

interface FakeProject {
  id: string;
  name: string;
  exists?: boolean;
  rows?: UsageHistoryRow[];
  groups?: GroupedTurnUsageRow[];
  throws?: boolean;
}

function makeService(projects: FakeProject[], nowMs = Date.now()) {
  const readerCalls: Array<{
    projectId: string;
    sinceIso: string | null;
    untilIso: string | null;
    sinceMs: number | null;
    untilMs: number | null;
    groupMs: number;
  }> = [];
  const openReader = vi.fn((projectId: string): ProjectUsageReader => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    if (project.throws) throw new Error('corrupt database');
    return {
      listUsageRows: (sinceIso, untilIso) => {
        readerCalls.push({ projectId, sinceIso, untilIso, sinceMs: null, untilMs: null, groupMs: 0 });
        return project.rows ?? [];
      },
      listTurnGroups: (sinceMs, groupMs, untilMs) => {
        readerCalls.push({ projectId, sinceIso: null, untilIso: null, sinceMs, untilMs, groupMs });
        return project.groups ?? [];
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
  it('passes the ISO cutoff to usage rows and the epoch-ms cutoff to turn groups', () => {
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }]);
    service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'today');

    const rowCall = readerCalls.find((call) => call.sinceIso !== null || call.groupMs === 0);
    const groupCall = readerCalls.find((call) => call.groupMs > 0);
    expect(rowCall?.sinceIso).toBe(computePeriodCutoff('today'));
    expect(groupCall?.sinceMs).toBe(Date.parse(computePeriodCutoff('today')!));
    expect(groupCall?.groupMs).toBe(TURN_GROUP_MS);
  });

  it('live scopes both reads to the trailing window and returns an empty cost series', () => {
    const nowMs = Date.now();
    const { service, readerCalls } = makeService([{ id: 'p1', name: 'One' }], nowMs);
    const stats = service.getDashboardStats({ kind: 'project', projectId: 'p1' }, 'live');

    const groupCall = readerCalls.find((call) => call.groupMs > 0);
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

  it('concatenates every project before one global fold: KPIs sum, breakdowns merge', () => {
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

    const rowCall = readerCalls.find((call) => call.groupMs === 0);
    const groupCall = readerCalls.find((call) => call.groupMs > 0);
    // Without the upper bound a past day's read would include every later session.
    expect(rowCall?.sinceIso).toBe(new Date(dayStartMs).toISOString());
    expect(rowCall?.untilIso).toBe(new Date(dayEndMs).toISOString());
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
      (call) => call.groupMs === 0 && call.sinceIso === new Date(new Date(dayStartMs).setDate(new Date(dayStartMs).getDate() - 1)).toISOString(),
    );
    expect(previousDayCall?.untilIso).toBe(new Date(dayStartMs).toISOString());
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
    const rowCall = readerCalls.find((call) => call.groupMs === 0 && call.sinceIso === new Date(sinceMs).toISOString());
    expect(rowCall?.untilIso).toBe(new Date(untilMs).toISOString());
    // The range clamps to the (fully past) window at daily granularity
    // (61-day span stays under the weekly-widening threshold).
    expect(stats.rangeStartMs).toBe(sinceMs);
    expect(stats.rangeEndMs).toBe(untilMs);
    expect(stats.bucketSizeMs).toBe(24 * 3_600_000);
    expect(stats.costBucketSizeMs).toBe(24 * 3_600_000);
    // Deltas compare against the same-length window immediately preceding.
    const spanMs = untilMs - sinceMs;
    const previousRowCall = readerCalls.find(
      (call) => call.groupMs === 0 && call.sinceIso === new Date(sinceMs - spanMs).toISOString(),
    );
    expect(previousRowCall?.untilIso).toBe(new Date(sinceMs).toISOString());
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
