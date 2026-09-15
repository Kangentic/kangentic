/**
 * `handleGetUsageStats`'s subagent section of the CLI message
 * (src/main/agent/commands/usage-commands.ts, `formatUsageMessage`'s
 * `kpis.subagentTurnCount > 0` block).
 *
 * A stats payload carrying subagent traffic must render both a `Subagents: ...`
 * roll-up line and a `Top subagent types: ...` line; a payload with no subagent
 * traffic (`subagentTurnCount === 0`) must render neither. Both lines are gated
 * on the same condition, so a payload predating subagent capture (all
 * subagent* fields zero, `bySubagentType` empty) renders exactly like today's
 * message with no new noise.
 *
 * `usageStatsService` is a module-level singleton constructed from real
 * dependencies at import time (see usage-stats-service.ts), so the whole
 * module is mocked rather than instantiated - `handleGetUsageStats` only ever
 * calls `.getDashboardStats(scope, period)` on it, so a stubbed return value
 * is all the seam needs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { UsageDashboardStats, UsageKpis, SubagentUsageTotals } from '../../src/shared/types';

const { mockGetDashboardStats } = vi.hoisted(() => ({
  mockGetDashboardStats: vi.fn(),
}));

vi.mock('../../src/main/usage-stats/usage-stats-service', () => ({
  usageStatsService: { getDashboardStats: mockGetDashboardStats },
}));

import { handleGetUsageStats } from '../../src/main/agent/commands/usage-commands';

function makeKpis(overrides: Partial<UsageKpis> = {}): UsageKpis {
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

function makeStats(overrides: Partial<UsageDashboardStats> = {}): UsageDashboardStats {
  return {
    scope: { kind: 'all' },
    period: 'all',
    rangeStartMs: 0,
    rangeEndMs: 1,
    bucketSizeMs: 1,
    costBucketSizeMs: 1,
    generatedAtMs: 1,
    kpis: makeKpis(),
    previousKpis: null,
    tokenSeries: [],
    costSeries: [],
    byModel: [],
    byAgent: [],
    byEffort: [],
    bySubagentType: [],
    subagentBlindAgents: [],
    ...overrides,
  };
}

function makeContext(): CommandContext {
  return {} as unknown as CommandContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleGetUsageStats subagent message section', () => {
  it('renders the Subagents line and the Top subagent types line when subagentTurnCount > 0', () => {
    const bySubagentType: SubagentUsageTotals[] = [
      { agentType: 'review-finder', inputTokens: 400, outputTokens: 800, cacheCreationTokens: 10, cacheReadTokens: 5000, turnCount: 7, subagentCount: 2, nestedTurnCount: 0, nestedSubagentCount: 0, maxSpawnDepth: 1 },
      { agentType: 'test-builder', inputTokens: 50, outputTokens: 60, cacheCreationTokens: 0, cacheReadTokens: 300, turnCount: 3, subagentCount: 1, nestedTurnCount: 0, nestedSubagentCount: 0, maxSpawnDepth: 1 },
    ];
    mockGetDashboardStats.mockReturnValue(makeStats({
      kpis: makeKpis({
        subagentInputTokens: 450,
        subagentOutputTokens: 860,
        subagentCacheCreationTokens: 10,
        subagentCacheReadTokens: 5300,
        subagentTurnCount: 10,
        subagentCount: 3,
      }),
      bySubagentType,
    }));

    const response = handleGetUsageStats({ allProjects: true }, makeContext());

    expect(response.success).toBe(true);
    expect(response.message).toContain('Subagents: 3 across 10 turn(s)');
    expect(response.message).toContain('Top subagent types:');
    expect(response.message).toContain('review-finder');
    expect(response.message).toContain('test-builder');
  });

  it('renders neither line when subagentTurnCount is 0', () => {
    mockGetDashboardStats.mockReturnValue(makeStats());

    const response = handleGetUsageStats({ allProjects: true }, makeContext());

    expect(response.success).toBe(true);
    expect(response.message).not.toContain('Subagents:');
    expect(response.message).not.toContain('Top subagent types:');
    // No blind agents either, so no caveat: an all-Claude range measures
    // everything and must not imply otherwise.
    expect(response.message).not.toContain('Not counted:');
  });

  it('names agents that cannot report subagent usage, so an empty breakdown is not read as a measurement', () => {
    mockGetDashboardStats.mockReturnValue(makeStats({ subagentBlindAgents: ['codex'] }));

    const response = handleGetUsageStats({ allProjects: true }, makeContext());

    // Singular agent takes a singular verb.
    expect(response.message).toContain('Not counted: codex does not report subagent usage');
  });

  it('pluralizes the caveat for several blind agents', () => {
    mockGetDashboardStats.mockReturnValue(makeStats({ subagentBlindAgents: ['codex', 'gemini'] }));

    const response = handleGetUsageStats({ allProjects: true }, makeContext());

    expect(response.message).toContain('Not counted: codex, gemini do not report subagent usage');
  });
});
