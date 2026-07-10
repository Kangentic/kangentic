import type { UsageDashboardStats, UsageStatsScope, UsageTimePeriod } from '../../../shared/types';
import { usageStatsService } from '../../usage-stats/usage-stats-service';
import type { CommandHandler, CommandResponse } from './types';

const PERIODS: readonly UsageTimePeriod[] = ['live', 'today', 'week', 'month', 'all'];

const PERIOD_LABELS: Record<UsageTimePeriod, string> = {
  live: 'Live (trailing 2h)',
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  all: 'All Time',
};

function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

function formatUsageMessage(stats: UsageDashboardStats): string {
  const kpis = stats.kpis;
  const scopeLabel = stats.scope.kind === 'all' ? 'all projects' : 'project';
  const lines = [
    `Usage stats (${PERIOD_LABELS[stats.period]}, ${scopeLabel}):`,
    `  Tokens: ${formatTokens(kpis.totalInputTokens)} input + ${formatTokens(kpis.totalOutputTokens)} output = ${formatTokens(kpis.totalTokens)} total (finalized sessions; in-flight sessions are excluded until they finalize)`,
    `  Cost: $${kpis.totalCostUsd.toFixed(4)}${kpis.costKnown ? '' : ' (no agent reported cost in this range)'}`,
  ];
  if (kpis.burnRateTokensPerHour !== null) {
    const usdPart = kpis.burnRateUsdPerHour !== null
      ? `$${kpis.burnRateUsdPerHour.toFixed(2)}/hr (approx, API-equivalent) - `
      : '';
    lines.push(`  Burn rate: ${usdPart}${formatTokens(Math.round(kpis.burnRateTokensPerHour))} tokens/hr`);
  }
  lines.push(
    `  Sessions: ${kpis.sessionCount} - Tool calls: ${formatTokens(kpis.toolCallCount)} - Compactions: ${kpis.compactionCount}`,
    `  Lines: +${formatTokens(kpis.linesAdded)} / -${formatTokens(kpis.linesRemoved)} across ${formatTokens(kpis.filesChanged)} file(s)`,
  );
  const topModels = stats.byModel.slice(0, 3)
    .map((model) => `${model.modelDisplayName ?? model.modelId ?? '(unknown)'} (${formatTokens(model.inputTokens + model.outputTokens)} tokens, $${model.costUsd.toFixed(2)})`);
  if (topModels.length > 0) lines.push(`  Top models: ${topModels.join(', ')}`);
  const topAgents = stats.byAgent.slice(0, 3)
    .map((agent) => `${agent.agent ?? '(unknown)'} (${agent.sessionCount} session(s))`);
  if (topAgents.length > 0) lines.push(`  Top agents: ${topAgents.join(', ')}`);
  const topEfforts = stats.byEffort.slice(0, 3)
    .map((effort) => `${effort.effort ?? '(default)'} (${formatTokens(effort.inputTokens + effort.outputTokens)} tokens, $${effort.costUsd.toFixed(2)})`);
  if (topEfforts.length > 0) lines.push(`  By effort: ${topEfforts.join(', ')}`);
  if (stats.perProject) {
    const skipped = stats.skippedProjects?.length ?? 0;
    lines.push(`  Projects aggregated: ${stats.perProject.length}${skipped > 0 ? ` (${skipped} skipped, unreadable DB)` : ''}`);
  }
  return lines.join('\n');
}

/**
 * `get_usage_stats`: the MCP-facing entry to the usage-stats service (the
 * same service the dashboard's IPC endpoint reads, so both surfaces always
 * agree). The tool layer passes `projectId` explicitly (CommandContext does
 * not carry one); `allProjects` switches to the app-wide rollup and takes
 * precedence. `includeSeries` keeps the bucketed time series in `data`
 * (stripped by default: KPI/breakdown reads should stay cheap).
 */
export const handleGetUsageStats: CommandHandler = (params): CommandResponse => {
  const rawPeriod = typeof params.period === 'string' ? params.period : 'all';
  if (!PERIODS.includes(rawPeriod as UsageTimePeriod)) {
    return { success: false, error: `Invalid period "${rawPeriod}". Valid: ${PERIODS.join(', ')}` };
  }
  const period = rawPeriod as UsageTimePeriod;
  const allProjects = params.allProjects === true;
  const includeSeries = params.includeSeries === true;
  const projectId = typeof params.projectId === 'string' ? params.projectId : null;

  if (!allProjects && !projectId) {
    return { success: false, error: 'projectId is required unless allProjects is true' };
  }
  const scope: UsageStatsScope = allProjects
    ? { kind: 'all' }
    : { kind: 'project', projectId: projectId as string };

  const stats = usageStatsService.getDashboardStats(scope, period);
  const data = includeSeries
    ? stats
    : (() => {
        const { tokenSeries: _tokenSeries, costSeries: _costSeries, ...rest } = stats;
        return rest;
      })();
  return { success: true, message: formatUsageMessage(stats), data };
};
