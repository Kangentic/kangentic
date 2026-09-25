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
    // Four disjoint token types, the same split `claude_code.token.usage`
    // reports. NOT `totalInputTokens`/`totalTokens`, which are context-window
    // snapshots summed across sessions rather than tokens consumed.
    `  Tokens (main thread): ${formatTokens(kpis.turnInputTokens)} fresh input + ${formatTokens(kpis.turnOutputTokens)} output, ${formatTokens(kpis.cacheCreationTokens)} cache write, ${formatTokens(kpis.cacheReadTokens)} cache read`,
    `  Cost: $${kpis.totalCostUsd.toFixed(4)} (API-equivalent list price, not billed)${kpis.costKnown ? '' : ' - no agent reported cost in this range'}`,
  ];
  if (kpis.burnRateTokensPerHour !== null) {
    const usdPart = kpis.burnRateUsdPerHour !== null
      ? `$${kpis.burnRateUsdPerHour.toFixed(2)}/hr - `
      : '';
    lines.push(`  Burn rate over the whole range, idle included: ${usdPart}${formatTokens(Math.round(kpis.burnRateTokensPerHour))} tokens/hr`);
  }
  if (kpis.activeSessionsCovered > 0) {
    const avgActiveMs = Math.round(kpis.activeMs / kpis.activeSessionsCovered);
    lines.push(`  Active time: ${formatTokens(Math.round(kpis.activeMs / 60_000))} min total, ${Math.round(avgActiveMs / 60_000)} min avg over ${kpis.activeSessionsCovered} session(s) with activity tracking`);
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
  // Subagent traffic, reported separately from the turn tokens above because
  // those are the main thread by definition. On a fan-out range this is usually
  // the larger half, and it is what "this review cost $41.26" never showed.
  if (kpis.subagentTurnCount > 0) {
    const nested = kpis.subagentNestedCount > 0
      ? `, ${kpis.subagentNestedCount} of them spawned by another subagent`
      : '';
    lines.push(
      `  Subagents: ${kpis.subagentCount} across ${formatTokens(kpis.subagentTurnCount)} turn(s)${nested} - ${formatTokens(kpis.subagentInputTokens)} fresh input, ${formatTokens(kpis.subagentOutputTokens)} output, ${formatTokens(kpis.subagentCacheReadTokens)} cache read (additive to the turn tokens above; the session cost already covers them)`,
    );
    const topSubagents = stats.bySubagentType.slice(0, 3)
      .map((row) => `${row.agentType ?? '(unknown)'} (${formatTokens(row.inputTokens + row.outputTokens)} tokens, ${formatTokens(row.cacheReadTokens)} cache read, ${row.turnCount} turn(s))`);
    if (topSubagents.length > 0) lines.push(`  Top subagent types: ${topSubagents.join(', ')}`);
  }
  // Named explicitly so an empty breakdown is not read as a measurement. Only
  // Claude reports subagent usage today, so a Codex or Gemini range is blind
  // rather than quiet, and the two are indistinguishable without this line.
  if (stats.subagentBlindAgents.length > 0) {
    const blind = stats.subagentBlindAgents;
    lines.push(
      `  Not counted: ${blind.join(', ')} ${blind.length === 1 ? 'does not' : 'do not'} report subagent usage, so any fan-outs they ran are absent from the figures above`,
    );
  }
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
