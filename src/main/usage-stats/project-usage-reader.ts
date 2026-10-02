import type Database from 'better-sqlite3';
import type { SubagentUsageTotals } from '../../shared/types';
import {
  UsageHistoryRepository,
  type UsageCostGroupRow,
  type UsageRollupRow,
  type UsageWindowTotals,
} from '../db/repositories/usage-history-repository';
import { ActivityIntervalStore } from '../activity-engine/activity-interval-store';
import { ConversationUsageStore, type GroupedTurnUsageRow } from '../retrieval/conversation/conversation-usage-store';

/**
 * One project's usage reads, each a SQL-side aggregate: the usage-stats
 * service never sees raw ledger rows. The retrieval worker runs them
 * (`localUsageReader` on its own connection), since over a long history they
 * aggregate a few hundred thousand turn rows; main calls them through the
 * worker, one call per read, so a question or a search is answered between
 * them. The unit tests fake the interface directly.
 */
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

export type UsageReadName = keyof ProjectUsageReader;

/** The same reads, each answered now or later (main's reads go to the worker). */
export type AsyncProjectUsageReader = {
  [Name in UsageReadName]: (
    ...args: Parameters<ProjectUsageReader[Name]>
  ) => ReturnType<ProjectUsageReader[Name]> | Promise<ReturnType<ProjectUsageReader[Name]>>;
};

/** The reads on a connection this process holds. */
export function localUsageReader(db: Database.Database): ProjectUsageReader {
  const usageHistory = new UsageHistoryRepository(db);
  const turnUsage = new ConversationUsageStore(db);
  return {
    getUsageTotals: (sinceIso, untilIso) => usageHistory.getUsageTotals(sinceIso, untilIso),
    listUsageRollup: (sinceIso, untilIso, sinceMs, untilMs) => usageHistory.listUsageRollup(sinceIso, untilIso, sinceMs, untilMs),
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
}
