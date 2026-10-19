/**
 * A complete `UsageKpis` and `UsageDashboardStats` payload for the unit tests
 * that mock `usageStatsService` and drive `handleGetUsageStats`.
 *
 * Every field is spelled out with a neutral default (three sessions costing
 * $12.34, no subagent traffic, no active-time tracking, every series empty), so
 * a test overrides only the fields its case is about. The root tsconfig does
 * not cover `tests/`, so nothing flags a fixture that is missing a field the
 * interface gained. Keeping the literal in one place makes that one edit here
 * instead of one per suite.
 */
import type { UsageDashboardStats, UsageKpis } from '../../../src/shared/types';

export function makeUsageKpis(overrides: Partial<UsageKpis> = {}): UsageKpis {
  return {
    totalCostUsd: 12.34,
    costKnown: true,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalTokens: 1500,
    sessionCount: 3,
    toolCallCount: 20,
    linesAdded: 10,
    linesRemoved: 5,
    filesChanged: 2,
    compactionCount: 0,
    totalDurationMs: 60000,
    activeMs: 0,
    activeSessionsCovered: 0,
    turnInputTokens: 1000,
    turnOutputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCacheCreationTokens: 0,
    subagentCacheReadTokens: 0,
    subagentTurnCount: 0,
    subagentCount: 0,
    subagentNestedCount: 0,
    burnRateTokensPerHour: null,
    burnRateUsdPerHour: null,
    ...overrides,
  };
}

export function makeUsageStats(overrides: Partial<UsageDashboardStats> = {}): UsageDashboardStats {
  return {
    scope: { kind: 'all' },
    period: 'all',
    rangeStartMs: 0,
    rangeEndMs: 1,
    bucketSizeMs: 1,
    costBucketSizeMs: 1,
    generatedAtMs: 1,
    kpis: makeUsageKpis(),
    previousKpis: null,
    tokenSeries: [],
    costSeries: [],
    byModel: [],
    byAgent: [],
    byEffort: [],
    bySubagentType: [],
    subagentBlindAgents: [],
    liveLedgerBaseline: { costUsd: 0 },
    earliestTurnMs: null,
    ...overrides,
  };
}
