import fs from 'node:fs';
import type {
  LiveSessionRow,
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
import {
  UsageHistoryRepository,
  type UsageCostGroupRow,
  type UsageRollupRow,
  type UsageWindowTotals,
} from '../db/repositories/usage-history-repository';
import { ConversationUsageStore, type GroupedTurnUsageRow } from '../retrieval/conversation/conversation-usage-store';
import {
  COST_GROUP_MS,
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
  mergeUsageTotals,
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
 * is synchronous) and merges per-project SQL AGGREGATES (one totals row, an
 * O(dimension-combos) rollup, and fine-grained UTC bucket groups per
 * project) before the global fold - the JS on the main thread is O(buckets),
 * never O(historical rows), so a long-lived install cannot stall the event
 * loop that owns the PTYs. Projects are separate SQLite files, so the N-way
 * merge itself must stay in JS. Missing project DB files are skipped WITHOUT
 * opening them - `getProjectDb` would otherwise CREATE and migrate a
 * database for a never-opened project - and a project whose read throws is
 * reported in `skippedProjects` instead of failing the whole payload.
 *
 * The optional `liveSessions` param (populated by the IPC handler from the
 * live `SessionManager`, empty for the MCP command handler) fixes the
 * SESSIONS KPI undercount: a running session has no `usage_history` row
 * until it finalizes, so the count of ledger rows alone misses it. This
 * layer ONLY affects `sessionCount` (here and in each `perProject` entry) -
 * cost/tokens/lines/files/burn-rate stay purely ledger-derived, computed
 * exactly as before. Two reasons the merge is deliberately this narrow:
 *
 * 1. The renderer's KpiTiles already gets instant-reactivity for cost/tokens
 *    from its own client-side live overlay (`useLiveUsageAggregate`, fed by
 *    pushed `session:usage` events with zero IPC round-trip) - correctly, and
 *    a pre-existing UI test (`use-value-pulse-reset-key.spec.ts`) pins that a
 *    local `sessionUsage` store mutation must repaint the Cost tile within a
 *    single animation frame. Folding live sessions into `totalCostUsd` here
 *    too would double-count against that client-side overlay.
 * 2. The originally-reported gap was specifically the SESSIONS KPI/Live view
 *    undercounting live agents - cost/tokens were never reported wrong.
 *
 * De-duped by `sessionRecordId` against the same window's ledger (a COUNT
 * query over the live ids), so a session already snapshotted into
 * `usage_history` by the periodic metrics timer is not counted twice.
 */

/** Per-project read surface; the DI seam the unit tests fake. Every method
 *  returns a SQL-side aggregate - the service never sees raw ledger rows. */
export interface ProjectUsageReader {
  /** One-row window aggregate of usage_history. */
  getUsageTotals(sinceIso: string | null, untilIso: string | null): UsageWindowTotals;
  /** GROUP BY (model, display name, agent, effort) rollup of usage_history. */
  listUsageRollup(sinceIso: string | null, untilIso: string | null): UsageRollupRow[];
  /** usage_history grouped to fixed UTC buckets of `groupMs` per model. */
  listUsageCostGroups(sinceIso: string | null, untilIso: string | null, groupMs: number): UsageCostGroupRow[];
  /**
   * Turn groups with SQL-side proportional cost allocation. `costSinceIso`/
   * `costUntilIso` MUST be the same usage_history window passed to the other
   * reads, so a turn group whose session has no in-window ledger row
   * allocates $0.
   */
  listTurnGroups(
    sinceMs: number | null,
    groupMs: number,
    untilMs: number | null,
    costSinceIso: string | null,
    costUntilIso: string | null,
  ): GroupedTurnUsageRow[];
  /** COUNT of the given live session record ids already in the window's ledger. */
  countSessionsRepresented(sinceIso: string | null, untilIso: string | null, sessionRecordIds: string[]): number;
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
    liveSessions?: LiveSessionRow[],
  ): UsageDashboardStats;
}

export function createUsageStatsService(deps: UsageStatsDeps): UsageStatsService {
  const now = deps.now ?? (() => Date.now());

  function summarizeProject(
    project: { id: string; name: string },
    totals: UsageWindowTotals,
    rollupRows: UsageRollupRow[],
    liveSessionCount: number,
  ): ProjectUsageSummary {
    // topAgent: the agent with the most fresh tokens. Rollup rows arrive
    // ordered by earliest session, and the strict > keeps the first-inserted
    // agent on a tie - the same tie-break the old row-by-row fold had.
    const tokensByAgent = new Map<string, number>();
    for (const row of rollupRows) {
      if (row.agent !== null) {
        tokensByAgent.set(row.agent, (tokensByAgent.get(row.agent) ?? 0) + row.inputTokens + row.outputTokens);
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
    const lastActiveParsed = totals.maxSessionStartedAt === null ? Number.NaN : Date.parse(totals.maxSessionStartedAt);
    return {
      projectId: project.id,
      projectName: project.name,
      inputTokens: totals.totalInputTokens,
      outputTokens: totals.totalOutputTokens,
      costUsd: totals.totalCostUsd,
      sessionCount: totals.sessionCount + liveSessionCount,
      toolCallCount: totals.toolCallCount,
      linesAdded: totals.linesAdded,
      linesRemoved: totals.linesRemoved,
      filesChanged: totals.filesChanged,
      totalDurationMs: totals.totalDurationMs,
      lastActiveMs: Number.isNaN(lastActiveParsed) ? null : lastActiveParsed,
      topAgent,
    };
  }

  function getDashboardStats(
    scope: UsageStatsScope,
    period: UsageTimePeriod,
    drill: UsageDayDrill | null = null,
    customWindow: UsageCustomWindow | null = null,
    liveSessions: LiveSessionRow[] = [],
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

    // Turn-series SQL grid: Live's fiveMinutes chart buckets need the
    // 5-minute grid; every other chart kind (halfHour and coarser, including
    // the drill / custom-window overrides applied above) nests on the
    // 15-minute grid, which cuts the group-row count 3x on wide ranges.
    const turnGroupMs = bucketing.tokenBucketKind === 'fiveMinutes' && !drill && !customWindow
      ? TURN_GROUP_MS
      : COST_GROUP_MS;

    const totalsList: UsageWindowTotals[] = [];
    const combinedRollup: UsageRollupRow[] = [];
    const combinedCostGroups: UsageCostGroupRow[] = [];
    const combinedGroups: GroupedTurnUsageRow[] = [];
    const previousTotalsList: UsageWindowTotals[] = [];
    const previousGroups: GroupedTurnUsageRow[] = [];
    const perProject: ProjectUsageSummary[] = [];
    const skippedProjects: Array<{ projectId: string; projectName: string }> = [];
    let liveSessionCountTotal = 0;

    for (const project of targets) {
      // A registered-but-never-opened (or externally deleted) project has no
      // DB file: legitimately zero usage, NOT an error - and opening it via
      // getProjectDb would mint an empty database.
      if (!deps.projectDbExists(project.id)) continue;
      try {
        const reader = deps.openReader(project.id);
        const totals = reader.getUsageTotals(sinceIso, untilIso);
        const rollup = reader.listUsageRollup(sinceIso, untilIso);
        const costGroups = reader.listUsageCostGroups(sinceIso, untilIso, COST_GROUP_MS);
        const groups = reader.listTurnGroups(sinceMs, turnGroupMs, untilMs, sinceIso, untilIso);
        totalsList.push(totals);
        combinedRollup.push(...rollup);
        combinedCostGroups.push(...costGroups);
        combinedGroups.push(...groups);
        if (previousWindow) {
          // The previous window feeds previousKpis only (no breakdowns or
          // series), so totals + turn groups suffice.
          previousTotalsList.push(reader.getUsageTotals(previousWindow.sinceIso, previousWindow.untilIso));
          previousGroups.push(...reader.listTurnGroups(
            previousWindow.sinceMs, turnGroupMs, previousWindow.untilMs,
            previousWindow.sinceIso, previousWindow.untilIso,
          ));
        }
        const liveForProject = liveSessions.filter((live) => live.projectId === project.id);
        // Live-session dedup: a running session already snapshotted into the
        // window's ledger by the periodic metrics timer must not be counted
        // twice on top of the ledger-derived session count.
        const projectLiveCount = liveForProject.length === 0
          ? 0
          : liveForProject.length - reader.countSessionsRepresented(
              sinceIso, untilIso, liveForProject.map((live) => live.sessionRecordId),
            );
        liveSessionCountTotal += projectLiveCount;
        if (scope.kind === 'all') perProject.push(summarizeProject(project, totals, rollup, projectLiveCount));
      } catch (error) {
        console.warn(`[usage-stats] Skipping unreadable project DB ${project.id}:`, error);
        skippedProjects.push({ projectId: project.id, projectName: project.name });
      }
    }

    const mergedTotals = mergeUsageTotals(totalsList);

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
      if (mergedTotals.minSessionStartedAt !== null) {
        const startedMs = Date.parse(mergedTotals.minSessionStartedAt);
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

    const kpis = computeKpis(mergedTotals, combinedGroups, rangeEndMs - rangeStartMs);
    // See the file-level JSDoc: live sessions are added to sessionCount only,
    // never to cost/tokens (those get instant client-side live layering from
    // KpiTiles' own sessionUsage overlay, which this would otherwise double).
    kpis.sessionCount += liveSessionCountTotal;

    const stats: UsageDashboardStats = {
      scope,
      period,
      rangeStartMs: tokenStarts[0] ?? bucketStartFor(rangeStartMs, tokenBucketKind),
      rangeEndMs,
      bucketSizeMs: NOMINAL_BUCKET_MS[tokenBucketKind],
      costBucketSizeMs: NOMINAL_BUCKET_MS[costBucketKind],
      generatedAtMs: nowMs,
      kpis,
      previousKpis: previousWindow
        ? computeKpis(
            mergeUsageTotals(previousTotalsList),
            previousGroups,
            previousWindow.untilMs - previousWindow.sinceMs,
          )
        : null,
      tokenSeries: foldTokenSeries(combinedGroups, tokenStarts, tokenBucketKind),
      costSeries: foldCostSeries(combinedCostGroups, costStarts, costBucketKind),
      byModel: buildModelBreakdown(combinedRollup),
      byAgent: buildAgentBreakdown(combinedRollup),
      byEffort: buildEffortBreakdown(combinedRollup),
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
      getUsageTotals: (sinceIso, untilIso) => usageHistory.getUsageTotals(sinceIso, untilIso),
      listUsageRollup: (sinceIso, untilIso) => usageHistory.listUsageRollup(sinceIso, untilIso),
      listUsageCostGroups: (sinceIso, untilIso, groupMs) => usageHistory.listUsageCostGroups(sinceIso, untilIso, groupMs),
      listTurnGroups: (sinceMs, groupMs, untilMs, costSinceIso, costUntilIso) =>
        turnUsage.getGroupedUsageSince(sinceMs, groupMs, untilMs, costSinceIso, costUntilIso),
      countSessionsRepresented: (sinceIso, untilIso, sessionRecordIds) =>
        usageHistory.countSessionsRepresented(sinceIso, untilIso, sessionRecordIds),
    };
  },
  listProjects: () => new ProjectRepository().list().map((project) => ({ id: project.id, name: project.name })),
  projectDbExists: (projectId) => fs.existsSync(PATHS.projectDb(projectId)),
});
