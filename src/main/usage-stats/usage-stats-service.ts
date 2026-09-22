import fs from 'node:fs';
import type {
  LiveSessionRow,
  ProjectUsageSummary,
  SubagentUsageTotals,
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
import { agentRegistry } from '../agent/agent-registry';
import { ActivityIntervalStore } from '../activity-engine/activity-interval-store';
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
  mergeSubagentTotals,
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
 * until it finalizes, so the count of ledger rows alone misses it.
 *
 * Cost and tokens are still NOT folded into the KPI totals here. The
 * renderer's KpiTiles gets instant reactivity for those from its own
 * client-side overlay (`useLiveUsageAggregate`, fed by pushed `session:usage`
 * events with zero IPC round-trip), and a UI test
 * (`use-value-pulse-reset-key.spec.ts`) pins that a local `sessionUsage`
 * mutation repaints the Cost tile within a single animation frame. Adding
 * live cost to `totalCostUsd` here would fight that overlay.
 *
 * What this layer DOES supply for cost/tokens is `liveLedgerBaseline`: how
 * much of the overlay's sessions the ledger already holds. The 45s metrics
 * timer upserts a running session's reading into `usage_history`, so the
 * overlay was double-counting it and the Cost tile floated above the
 * breakdowns, which have no overlay. The renderer subtracts the baseline
 * before layering, so the overlay contributes only the un-snapshotted delta.
 *
 * Both halves de-dupe by `sessionRecordId` against the same window's ledger
 * (a COUNT and a SUM over the live ids).
 */

/** Per-project read surface; the DI seam the unit tests fake. Every method
 *  returns a SQL-side aggregate - the service never sees raw ledger rows. */
export interface ProjectUsageReader {
  /** One-row window aggregate of usage_history. */
  getUsageTotals(sinceIso: string | null, untilIso: string | null): UsageWindowTotals;
  /**
   * GROUP BY (model, display name, agent, effort) rollup: cost from
   * usage_history, tokens from the per-turn ledger. Takes BOTH window forms
   * because the two ledgers key their windows differently.
   */
  listUsageRollup(
    sinceIso: string | null,
    untilIso: string | null,
    sinceMs: number | null,
    untilMs: number | null,
  ): UsageRollupRow[];
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
  /**
   * Cost/token totals the window's ledger already holds for those same live
   * ids - the baseline the renderer's overlay subtracts (see
   * `UsageDashboardStats.liveLedgerBaseline`).
   */
  sumSessionsRepresented(
    sinceIso: string | null,
    untilIso: string | null,
    sessionRecordIds: string[],
  ): { costUsd: number; inputTokens: number; outputTokens: number };
  /**
   * Subagent turn usage in the window, grouped by subagent type. Additive to
   * `listTurnGroups`, which is main-thread only: on a fan-out task this is most
   * of the traffic. Carries no cost - the session's reported cost already covers
   * the whole tree, so pricing these separately would double count.
   */
  listSubagentTotals(sinceMs: number | null, untilMs: number | null): SubagentUsageTotals[];
  /** Oldest turn timestamp in this project's turn ledger, or null when empty. */
  getEarliestTurnMs(): number | null;
  /**
   * Active (non-idle) milliseconds in the window and how many sessions the
   * interval ledger covers there. Feeds the Avg Active tile.
   */
  getActiveTotals(sinceMs: number | null, untilMs: number | null): {
    activeMs: number;
    sessionsCovered: number;
  };
}

export interface UsageStatsDeps {
  openReader: (projectId: string) => ProjectUsageReader;
  listProjects: () => Array<{ id: string; name: string }>;
  projectDbExists: (projectId: string) => boolean;
  /**
   * Whether the named agent can report subagent usage at all, so the dashboard
   * can tell "nothing fanned out" from "this agent's fan-outs are not measurable".
   * Both render as an empty breakdown otherwise.
   *
   * Takes the agent NAME as recorded on the session and answers from the adapter
   * registry, so the agent-name-to-capability mapping stays inside the adapters
   * (`agent-adapters-boundary.md`) and this service never compares one itself.
   */
  reportsSubagentUsage: (agent: string) => boolean;
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
    turnGroups: GroupedTurnUsageRow[],
    activeTotals: { activeMs: number; sessionsCovered: number },
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
    // Real per-turn tokens, summed from the groups this project already
    // fetched for the series (no extra query). The `usage_history` token
    // columns are context-window SNAPSHOTS, not consumption, so the table's
    // token columns read from the turn ledger like the Tokens tile does.
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    for (const group of turnGroups) {
      turnInputTokens += group.inputTokens;
      turnOutputTokens += group.outputTokens;
    }
    const lastActiveParsed = totals.maxSessionStartedAt === null ? Number.NaN : Date.parse(totals.maxSessionStartedAt);
    return {
      projectId: project.id,
      projectName: project.name,
      inputTokens: turnInputTokens,
      outputTokens: turnOutputTokens,
      costUsd: totals.totalCostUsd,
      sessionCount: totals.sessionCount + liveSessionCount,
      toolCallCount: totals.toolCallCount,
      linesAdded: totals.linesAdded,
      linesRemoved: totals.linesRemoved,
      filesChanged: totals.filesChanged,
      totalDurationMs: totals.totalDurationMs,
      activeMs: activeTotals.activeMs,
      activeSessionsCovered: activeTotals.sessionsCovered,
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
    const subagentTotalsList: SubagentUsageTotals[][] = [];
    const previousSubagentTotalsList: SubagentUsageTotals[][] = [];
    const perProject: ProjectUsageSummary[] = [];
    const skippedProjects: Array<{ projectId: string; projectName: string }> = [];
    let liveSessionCountTotal = 0;
    let earliestTurnMs: number | null = null;
    let activeMsTotal = 0;
    // Summed across projects: session ids are unique per project DB, so no
    // session can be counted twice.
    let activeSessionsCovered = 0;
    let previousActiveMsTotal = 0;
    let previousActiveSessionsCovered = 0;
    const liveLedgerBaseline = { costUsd: 0 };

    for (const project of targets) {
      // A registered-but-never-opened (or externally deleted) project has no
      // DB file: legitimately zero usage, NOT an error - and opening it via
      // getProjectDb would mint an empty database.
      if (!deps.projectDbExists(project.id)) continue;
      try {
        const reader = deps.openReader(project.id);
        const totals = reader.getUsageTotals(sinceIso, untilIso);
        const rollup = reader.listUsageRollup(sinceIso, untilIso, sinceMs, untilMs);
        const costGroups = reader.listUsageCostGroups(sinceIso, untilIso, COST_GROUP_MS);
        const groups = reader.listTurnGroups(sinceMs, turnGroupMs, untilMs, sinceIso, untilIso);
        totalsList.push(totals);
        combinedRollup.push(...rollup);
        combinedCostGroups.push(...costGroups);
        combinedGroups.push(...groups);
        subagentTotalsList.push(reader.listSubagentTotals(sinceMs, untilMs));
        const projectActive = reader.getActiveTotals(sinceMs, untilMs);
        activeMsTotal += projectActive.activeMs;
        activeSessionsCovered += projectActive.sessionsCovered;
        // Earliest across projects: the app-wide token coverage starts when
        // the FIRST project began capturing turns.
        const projectEarliestTurnMs = reader.getEarliestTurnMs();
        if (projectEarliestTurnMs !== null
          && (earliestTurnMs === null || projectEarliestTurnMs < earliestTurnMs)) {
          earliestTurnMs = projectEarliestTurnMs;
        }
        if (previousWindow) {
          // The previous window feeds previousKpis only (no breakdowns or
          // series), so totals + turn groups suffice.
          previousTotalsList.push(reader.getUsageTotals(previousWindow.sinceIso, previousWindow.untilIso));
          previousGroups.push(...reader.listTurnGroups(
            previousWindow.sinceMs, turnGroupMs, previousWindow.untilMs,
            previousWindow.sinceIso, previousWindow.untilIso,
          ));
          // Subagent totals too, not just the main-thread ones. `previousKpis`
          // is what the hero/compact tiles diff against, so a subagent field
          // left at 0 here would render as a full-size delta on every load
          // rather than the real period-over-period change.
          previousSubagentTotalsList.push(
            reader.listSubagentTotals(previousWindow.sinceMs, previousWindow.untilMs),
          );
          // Same reason as the subagent totals above: a zeroed active time
          // here would render as a full-size delta on the Avg Active tile
          // every load rather than the real period-over-period change.
          const previousActive = reader.getActiveTotals(previousWindow.sinceMs, previousWindow.untilMs);
          previousActiveMsTotal += previousActive.activeMs;
          previousActiveSessionsCovered += previousActive.sessionsCovered;
        }
        const liveForProject = liveSessions.filter((live) => live.projectId === project.id);
        // Live-session dedup: a running session already snapshotted into the
        // window's ledger by the periodic metrics timer must not be counted
        // twice on top of the ledger-derived session count.
        const liveRecordIds = liveForProject.map((live) => live.sessionRecordId);
        const projectLiveCount = liveForProject.length === 0
          ? 0
          : liveForProject.length - reader.countSessionsRepresented(sinceIso, untilIso, liveRecordIds);
        liveSessionCountTotal += projectLiveCount;
        // The cost/token half of the same dedup. The COUNT above kept the
        // Sessions tile honest; this keeps the Cost and Tokens tiles honest,
        // by telling the renderer how much of its overlay the ledger already
        // contains.
        if (liveRecordIds.length > 0) {
          liveLedgerBaseline.costUsd +=
            reader.sumSessionsRepresented(sinceIso, untilIso, liveRecordIds).costUsd;
        }
        if (scope.kind === 'all') {
          perProject.push(
            summarizeProject(project, totals, rollup, projectLiveCount, groups, projectActive),
          );
        }
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

    // The range the payload REPORTS, bucket-aligned. The burn rates divide by
    // this rather than by the raw `rangeStartMs`, so the hours a user can read
    // off the chart are the hours the rate was computed over. They differed by
    // up to one bucket width before, which on All Time is a whole week.
    const reportedRangeStartMs = tokenStarts[0] ?? bucketStartFor(rangeStartMs, tokenBucketKind);

    const bySubagentType = mergeSubagentTotals(subagentTotalsList);
    const kpis = computeKpis(
      mergedTotals,
      combinedGroups,
      rangeEndMs - reportedRangeStartMs,
      bySubagentType,
      { activeMs: activeMsTotal, sessionsCovered: activeSessionsCovered },
    );
    // See the file-level JSDoc: live sessions are added to sessionCount only,
    // never to cost/tokens (those get instant client-side live layering from
    // KpiTiles' own sessionUsage overlay, which this would otherwise double).
    kpis.sessionCount += liveSessionCountTotal;

    const stats: UsageDashboardStats = {
      scope,
      period,
      rangeStartMs: reportedRangeStartMs,
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
            mergeSubagentTotals(previousSubagentTotalsList),
            { activeMs: previousActiveMsTotal, sessionsCovered: previousActiveSessionsCovered },
          )
        : null,
      // Main-thread only, by construction and deliberately: see the UsageKpis
      // JSDoc. Subagent traffic is reported additively in the kpis' subagent*
      // fields and broken out below, never folded into these series.
      tokenSeries: foldTokenSeries(combinedGroups, tokenStarts, tokenBucketKind),
      costSeries: foldCostSeries(combinedCostGroups, costStarts, costBucketKind),
      byModel: buildModelBreakdown(combinedRollup),
      byAgent: buildAgentBreakdown(combinedRollup),
      byEffort: buildEffortBreakdown(combinedRollup),
      bySubagentType,
      // Derived from the agents that actually ran in this range, so a project
      // that has never run Codex never mentions Codex. A null agent (rows
      // predating the column) is not reported: it names no agent to explain.
      subagentBlindAgents: buildAgentBreakdown(combinedRollup)
        .map((row) => row.agent)
        .filter((agent): agent is string => agent !== null)
        .filter((agent) => !deps.reportsSubagentUsage(agent))
        .sort(),
      liveLedgerBaseline,
      earliestTurnMs,
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
      listUsageRollup: (sinceIso, untilIso, sinceMs, untilMs) =>
        usageHistory.listUsageRollup(sinceIso, untilIso, sinceMs, untilMs),
      listUsageCostGroups: (sinceIso, untilIso, groupMs) => usageHistory.listUsageCostGroups(sinceIso, untilIso, groupMs),
      listTurnGroups: (sinceMs, groupMs, untilMs, costSinceIso, costUntilIso) =>
        turnUsage.getGroupedUsageSince(sinceMs, groupMs, untilMs, costSinceIso, costUntilIso),
      countSessionsRepresented: (sinceIso, untilIso, sessionRecordIds) =>
        usageHistory.countSessionsRepresented(sinceIso, untilIso, sessionRecordIds),
      sumSessionsRepresented: (sinceIso, untilIso, sessionRecordIds) =>
        usageHistory.sumSessionsRepresented(sinceIso, untilIso, sessionRecordIds),
      listSubagentTotals: (sinceMs, untilMs) => turnUsage.getSubagentTotalsByType(sinceMs, untilMs),
      getEarliestTurnMs: () => turnUsage.getEarliestTurnMs(),
      getActiveTotals: (sinceMs, untilMs) => new ActivityIntervalStore(db).getActiveTotals(sinceMs, untilMs),
    };
  },
  listProjects: () => new ProjectRepository().list().map((project) => ({ id: project.id, name: project.name })),
  projectDbExists: (projectId) => fs.existsSync(PATHS.projectDb(projectId)),
  // The SAME pair of methods `ConversationIndexer.indexSubagentUsage` gates on,
  // read off the adapter rather than restated, so the dashboard's claim about an
  // agent cannot drift from whether the indexer actually writes its rows.
  //
  // `agent` is a LOOKUP KEY here, never compared: there is no `=== 'claude'` and
  // no per-agent branch, so adding a second adapter with these methods changes
  // this answer with no edit. That is what `agent-adapters-boundary.md` asks for
  // (declare a capability, read it generically), and it is why the registry
  // lookup is in this layer rather than an agent name being.
  reportsSubagentUsage: (agent) => {
    const adapter = agentRegistry.get(agent);
    return Boolean(adapter?.parseSubagentUsage && adapter.statSubagentTranscripts);
  },
});
