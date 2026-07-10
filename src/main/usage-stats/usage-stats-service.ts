import fs from 'node:fs';
import type {
  ProjectUsageSummary,
  UsageCustomWindow,
  UsageDashboardStats,
  UsageDayDrill,
  UsageStatsScope,
  UsageTimePeriod,
} from '../../shared/types';
import { PATHS } from '../config/paths';
import { getProjectDb } from '../db/database';
import { ProjectRepository } from '../db/repositories/project-repository';
import { UsageHistoryRepository, type UsageHistoryRow } from '../db/repositories/usage-history-repository';
import { ConversationUsageStore, type GroupedTurnUsageRow } from '../retrieval/conversation/conversation-usage-store';
import {
  NOMINAL_BUCKET_MS,
  TURN_GROUP_MS,
  buildAgentBreakdown,
  buildBucketStarts,
  buildEffortBreakdown,
  buildModelBreakdown,
  bucketStartFor,
  computeKpis,
  foldCostSeries,
  foldTokenSeries,
  resolveAllTimeBucketKinds,
  resolveBucketing,
  resolvePreviousWindow,
} from './bucketing';

/**
 * Single source of truth for usage statistics: the composite payload consumed
 * by BOTH the `usage:getDashboardStats` IPC handler (the dashboard) and the
 * `kangentic_get_usage_stats` MCP command handler. Reads the two durable,
 * agent-agnostic ledgers (`usage_history` per-session totals and
 * `conversation_turn_usage` per-turn time series) and aggregates in the pure
 * functions of ./bucketing.ts.
 *
 * App-wide scope loops every registered project SEQUENTIALLY (better-sqlite3
 * is synchronous) and concatenates raw rows/groups before a single global
 * fold, which keeps series merging trivially correct. Missing project DB
 * files are skipped WITHOUT opening them - `getProjectDb` would otherwise
 * CREATE and migrate a database for a never-opened project - and a project
 * whose read throws is reported in `skippedProjects` instead of failing the
 * whole payload.
 */

/** Per-project read surface; the DI seam the unit tests fake. */
export interface ProjectUsageReader {
  listUsageRows(sinceIso: string | null, untilIso: string | null): UsageHistoryRow[];
  listTurnGroups(sinceMs: number | null, groupMs: number, untilMs: number | null): GroupedTurnUsageRow[];
}

export interface UsageStatsDeps {
  openReader: (projectId: string) => ProjectUsageReader;
  listProjects: () => Array<{ id: string; name: string }>;
  projectDbExists: (projectId: string) => boolean;
  now?: () => number;
}

export interface UsageStatsService {
  getDashboardStats(
    scope: UsageStatsScope,
    period: UsageTimePeriod,
    drill?: UsageDayDrill | null,
    customWindow?: UsageCustomWindow | null,
  ): UsageDashboardStats;
}

export function createUsageStatsService(deps: UsageStatsDeps): UsageStatsService {
  const now = deps.now ?? (() => Date.now());

  function summarizeProject(
    project: { id: string; name: string },
    rows: UsageHistoryRow[],
  ): ProjectUsageSummary {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let toolCallCount = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    let totalDurationMs = 0;
    let lastActiveMs: number | null = null;
    const tokensByAgent = new Map<string, number>();
    for (const row of rows) {
      inputTokens += row.totalInputTokens;
      outputTokens += row.totalOutputTokens;
      costUsd += row.totalCostUsd;
      toolCallCount += row.toolCallCount;
      linesAdded += row.linesAdded;
      linesRemoved += row.linesRemoved;
      totalDurationMs += row.totalDurationMs ?? 0;
      const startedMs = Date.parse(row.sessionStartedAt);
      if (!Number.isNaN(startedMs) && (lastActiveMs === null || startedMs > lastActiveMs)) {
        lastActiveMs = startedMs;
      }
      if (row.agent !== null) {
        tokensByAgent.set(row.agent, (tokensByAgent.get(row.agent) ?? 0) + row.totalInputTokens + row.totalOutputTokens);
      }
    }
    let topAgent: string | null = null;
    let topAgentTokens = -1;
    for (const [agent, tokens] of tokensByAgent) {
      if (tokens > topAgentTokens) {
        topAgent = agent;
        topAgentTokens = tokens;
      }
    }
    return {
      projectId: project.id,
      projectName: project.name,
      inputTokens,
      outputTokens,
      costUsd,
      sessionCount: rows.length,
      toolCallCount,
      linesAdded,
      linesRemoved,
      totalDurationMs,
      lastActiveMs,
      topAgent,
    };
  }

  function getDashboardStats(
    scope: UsageStatsScope,
    period: UsageTimePeriod,
    drill: UsageDayDrill | null = null,
    customWindow: UsageCustomWindow | null = null,
  ): UsageDashboardStats {
    const nowMs = now();
    const bucketing = resolveBucketing(period, nowMs);

    // A day drill re-scopes everything to [local midnight, next local
    // midnight) of the clicked day at Today-style granularity, overriding the
    // base period's window. The upper bound matters: without it a past day's
    // read would include every later session. A user-picked custom window
    // overrides the period the same way (drill wins over both, so a day
    // inside a custom window still drills).
    let sinceIso = bucketing.sinceIso;
    let sinceMs = bucketing.sinceMs;
    let untilIso: string | null = null;
    let untilMs: number | null = null;
    let boundedEndMs: number | null = null;
    if (drill) {
      const drillDay = new Date(drill.dayStartMs);
      const dayStartMs = new Date(drillDay.getFullYear(), drillDay.getMonth(), drillDay.getDate()).getTime();
      const dayEndMs = new Date(drillDay.getFullYear(), drillDay.getMonth(), drillDay.getDate() + 1).getTime();
      sinceMs = dayStartMs;
      sinceIso = new Date(dayStartMs).toISOString();
      untilMs = dayEndMs;
      untilIso = new Date(dayEndMs).toISOString();
      boundedEndMs = Math.min(dayEndMs, nowMs);
    } else if (customWindow) {
      sinceMs = customWindow.sinceMs;
      sinceIso = new Date(customWindow.sinceMs).toISOString();
      untilMs = customWindow.untilMs;
      untilIso = new Date(customWindow.untilMs).toISOString();
      boundedEndMs = Math.min(customWindow.untilMs, nowMs);
    }

    const targets = scope.kind === 'project'
      ? [{ id: scope.projectId, name: '' }]
      : deps.listProjects();

    // The comparison window for the "vs previous period" deltas ('all' has
    // none). A custom window compares against the same-length window
    // immediately preceding it (a July window reads "vs June" for free);
    // otherwise the start anchors on the current window's cutoff.
    let previousWindow: ReturnType<typeof resolvePreviousWindow> = null;
    if (!drill && customWindow) {
      const spanMs = customWindow.untilMs - customWindow.sinceMs;
      previousWindow = {
        sinceMs: customWindow.sinceMs - spanMs,
        untilMs: customWindow.sinceMs,
        sinceIso: new Date(customWindow.sinceMs - spanMs).toISOString(),
        untilIso: new Date(customWindow.sinceMs).toISOString(),
      };
    } else if (sinceMs !== null) {
      previousWindow = resolvePreviousWindow(period, sinceMs, drill !== null);
    }

    const combinedUsageRows: UsageHistoryRow[] = [];
    const combinedGroups: GroupedTurnUsageRow[] = [];
    const previousUsageRows: UsageHistoryRow[] = [];
    const previousGroups: GroupedTurnUsageRow[] = [];
    const perProject: ProjectUsageSummary[] = [];
    const skippedProjects: Array<{ projectId: string; projectName: string }> = [];

    for (const project of targets) {
      // A registered-but-never-opened (or externally deleted) project has no
      // DB file: legitimately zero usage, NOT an error - and opening it via
      // getProjectDb would mint an empty database.
      if (!deps.projectDbExists(project.id)) continue;
      try {
        const reader = deps.openReader(project.id);
        const rows = reader.listUsageRows(sinceIso, untilIso);
        const groups = reader.listTurnGroups(sinceMs, TURN_GROUP_MS, untilMs);
        combinedUsageRows.push(...rows);
        combinedGroups.push(...groups);
        if (previousWindow) {
          previousUsageRows.push(...reader.listUsageRows(previousWindow.sinceIso, previousWindow.untilIso));
          previousGroups.push(...reader.listTurnGroups(previousWindow.sinceMs, TURN_GROUP_MS, previousWindow.untilMs));
        }
        if (scope.kind === 'all') perProject.push(summarizeProject(project, rows));
      } catch (error) {
        console.warn(`[usage-stats] Skipping unreadable project DB ${project.id}:`, error);
        skippedProjects.push({ projectId: project.id, projectName: project.name });
      }
    }

    // Range: drill/window-bounded when overridden; cutoff-anchored for
    // bounded periods; earliest observed data for 'all' (now when empty,
    // yielding empty series).
    const rangeEndMs = boundedEndMs ?? nowMs;
    let rangeStartMs: number;
    let tokenBucketKind = bucketing.tokenBucketKind;
    let costBucketKind = bucketing.costBucketKind;
    if (drill) {
      rangeStartMs = sinceMs as number;
      tokenBucketKind = 'halfHour';
      costBucketKind = 'hour';
    } else if (customWindow) {
      rangeStartMs = customWindow.sinceMs;
      // A month reads daily; a long multi-month span widens to weekly (the
      // same adaptive rule as All Time).
      const adaptive = resolveAllTimeBucketKinds(rangeStartMs, rangeEndMs);
      tokenBucketKind = adaptive.tokenBucketKind;
      costBucketKind = adaptive.costBucketKind;
    } else if (sinceMs !== null) {
      rangeStartMs = sinceMs;
    } else {
      let earliest = Number.POSITIVE_INFINITY;
      for (const group of combinedGroups) earliest = Math.min(earliest, group.bucketStartMs);
      for (const row of combinedUsageRows) {
        const startedMs = Date.parse(row.sessionStartedAt);
        if (!Number.isNaN(startedMs)) earliest = Math.min(earliest, startedMs);
      }
      rangeStartMs = Number.isFinite(earliest) ? earliest : nowMs;
      // All Time granularity adapts to the actual data span (a 2-week history
      // at weekly buckets is three lonely bars; see resolveAllTimeBucketKinds).
      const adaptive = resolveAllTimeBucketKinds(rangeStartMs, rangeEndMs);
      tokenBucketKind = adaptive.tokenBucketKind;
      costBucketKind = adaptive.costBucketKind;
    }

    const tokenStarts = buildBucketStarts(rangeStartMs, rangeEndMs, tokenBucketKind);
    // Live's session-ledger series is meaningless inside a 2h trailing window,
    // but a drill or custom window bounds its own range - keep those.
    const costStarts = period === 'live' && !drill && !customWindow ? [] : buildBucketStarts(rangeStartMs, rangeEndMs, costBucketKind);
    const sessionCostUsd = new Map<string, number>(
      combinedUsageRows.map((row) => [row.sessionRecordId, row.totalCostUsd]),
    );

    const stats: UsageDashboardStats = {
      scope,
      period,
      rangeStartMs: tokenStarts[0] ?? bucketStartFor(rangeStartMs, tokenBucketKind),
      rangeEndMs,
      bucketSizeMs: NOMINAL_BUCKET_MS[tokenBucketKind],
      costBucketSizeMs: NOMINAL_BUCKET_MS[costBucketKind],
      generatedAtMs: nowMs,
      kpis: computeKpis(combinedUsageRows, combinedGroups, sessionCostUsd, rangeEndMs - rangeStartMs),
      previousKpis: previousWindow
        ? computeKpis(
            previousUsageRows,
            previousGroups,
            new Map<string, number>(previousUsageRows.map((row) => [row.sessionRecordId, row.totalCostUsd])),
            previousWindow.untilMs - previousWindow.sinceMs,
          )
        : null,
      tokenSeries: foldTokenSeries(combinedGroups, sessionCostUsd, tokenStarts, tokenBucketKind),
      costSeries: foldCostSeries(combinedUsageRows, costStarts, costBucketKind),
      byModel: buildModelBreakdown(combinedUsageRows),
      byAgent: buildAgentBreakdown(combinedUsageRows),
      byEffort: buildEffortBreakdown(combinedUsageRows),
    };
    if (scope.kind === 'all') {
      stats.perProject = perProject;
      if (skippedProjects.length > 0) stats.skippedProjects = skippedProjects;
    }
    return stats;
  }

  return { getDashboardStats };
}

/** The app-wired singleton used by the IPC and MCP handlers. */
export const usageStatsService = createUsageStatsService({
  openReader: (projectId) => {
    const db = getProjectDb(projectId);
    const usageHistory = new UsageHistoryRepository(db);
    const turnUsage = new ConversationUsageStore(db);
    return {
      listUsageRows: (sinceIso, untilIso) => usageHistory.listRowsAfter(sinceIso, untilIso),
      listTurnGroups: (sinceMs, groupMs, untilMs) => turnUsage.getGroupedUsageSince(sinceMs, groupMs, untilMs),
    };
  },
  listProjects: () => new ProjectRepository().list().map((project) => ({ id: project.id, name: project.name })),
  projectDbExists: (projectId) => fs.existsSync(PATHS.projectDb(projectId)),
});
