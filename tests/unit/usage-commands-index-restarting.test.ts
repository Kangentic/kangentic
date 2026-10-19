/**
 * `handleGetUsageStats` when the retrieval worker could not answer
 * (src/main/agent/commands/usage-commands.ts).
 *
 * Every usage read runs in the retrieval worker. When it is down the service
 * stops part way and flags the payload `indexRestarting`, so whatever figures
 * it carries are incomplete. The MCP tool must not hand those to an agent as a
 * success: an agent would quote the undercount as the real total. It answers
 * with the same restarting sentence the search tools use, which tells the
 * agent to retry.
 *
 * `usageStatsService` is a module-level singleton built from real dependencies
 * at import time, so the whole module is mocked, as in
 * usage-commands-background.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { UsageDashboardStats } from '../../src/shared/types';
import { makeUsageStats } from './helpers/usage-stats-fixture';

const { mockGetDashboardStats } = vi.hoisted(() => ({
  mockGetDashboardStats: vi.fn(),
}));

vi.mock('../../src/main/usage-stats/usage-stats-service', () => ({
  usageStatsService: { getDashboardStats: mockGetDashboardStats },
}));

import { handleGetUsageStats } from '../../src/main/agent/commands/usage-commands';

/** An app-wide payload: `perProject` is what prints the "Projects aggregated"
 *  line, so the clean case's "no skipped" check reads a line that exists. */
function makeStats(overrides: Partial<UsageDashboardStats> = {}): UsageDashboardStats {
  return makeUsageStats({ perProject: [], ...overrides });
}

function makeContext(): CommandContext {
  return {} as unknown as CommandContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleGetUsageStats with the retrieval worker down', () => {
  it('refuses with the index-restarting sentence instead of reporting incomplete figures', async () => {
    mockGetDashboardStats.mockResolvedValue(makeStats({ indexRestarting: true }));

    const response = await handleGetUsageStats({ allProjects: true }, makeContext());

    expect(response).toEqual({
      success: false,
      error: 'Usage stats were not read. The Knowledge Graph index is restarting. Try again in a moment.',
    });
  });

  it('answers normally when the payload is not flagged', async () => {
    mockGetDashboardStats.mockResolvedValue(makeStats());

    const response = await handleGetUsageStats({ allProjects: true }, makeContext());

    expect(response.success).toBe(true);
    expect(response.message).toContain('Usage stats (All Time, all projects):');
    expect(response.message).not.toContain('skipped');
  });
});
