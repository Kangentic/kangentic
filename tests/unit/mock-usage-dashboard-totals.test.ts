/**
 * The mock's default `usage.getDashboardStats` payload feeds every Usage dashboard UI spec, and
 * those specs assert the tiles against it. This pins the payload's own arithmetic, so a spec that
 * checks the headline Cost against a breakdown is reading a fixture that agrees with itself:
 * each breakdown sums to the headline cost, and each burn rate times the range reproduces the
 * tile it sits beside.
 */
import { describe, it, expect } from 'vitest';
import { loadMockElectronApi, plain } from './helpers/load-mock-electron-api';

interface CostRow {
  costUsd: number;
}

interface DashboardStats {
  kpis: Record<string, number>;
  byModel: CostRow[];
  byAgent: CostRow[];
  byEffort: CostRow[];
  rangeStartMs: number;
  rangeEndMs: number;
}

interface UsageBridge {
  usage: {
    getDashboardStats: (scope: unknown, period: string, drill: unknown, customWindow: unknown) => Promise<DashboardStats>;
  };
}

function sumCost(rows: CostRow[]): number {
  return rows.reduce((runningTotal, row) => runningTotal + row.costUsd, 0);
}

describe('the mock usage dashboard payload', () => {
  it('has a headline Cost equal to each breakdown, and burn-rate lines that reproduce their own tile', async () => {
    const { electronApi } = loadMockElectronApi<UsageBridge>();
    const stats = plain(await electronApi.usage.getDashboardStats(
      { kind: 'project', projectId: 'mock-project' }, 'week', null, null,
    ));
    const hours = (stats.rangeEndMs - stats.rangeStartMs) / 3_600_000;
    const headline = stats.kpis.totalCostUsd;

    expect(sumCost(stats.byModel)).toBeCloseTo(headline, 6);
    expect(sumCost(stats.byAgent)).toBeCloseTo(headline, 6);
    expect(sumCost(stats.byEffort)).toBeCloseTo(headline, 6);
    // Each rate times the range reproduces the tile it sits beside, which is only true when both
    // lines share one denominator and each numerator is the field its own tile renders.
    expect(stats.kpis.burnRateUsdPerHour * hours).toBeCloseTo(headline, 6);
    expect(stats.kpis.burnRateTokensPerHour * hours)
      .toBeCloseTo(stats.kpis.turnInputTokens + stats.kpis.turnOutputTokens, 6);
  });
});
