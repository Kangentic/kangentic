import type { BackgroundCallTotals, BackgroundModelCount } from '../../../shared/types';
import { baseModelLabel, parseModelId } from '../../../shared/model-id';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';
import { agentShortName } from '../../utils/agent-display-name';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';

/**
 * Display rules shared by the usage dashboard's Background card and its
 * "Background calls by day" table. Pure, so the "not reported" handling is
 * unit tested rather than read off a screenshot.
 *
 * A figure the agent did not report renders as null (the caller draws "-"),
 * never as 0 and never as an estimate: an agent whose CLI prints no usage is
 * stored with NULL tokens and cost, and a 0 here would claim the call was free.
 */

/** Fresh input plus output, the same "tokens" the Tokens tile means. */
export function backgroundTokens(totals: BackgroundCallTotals): number {
  return totals.inputTokens + totals.outputTokens;
}

/** The card's value for a set of calls in the selected metric, or null when
 *  no call in the set reported it. */
export function backgroundMetricText(totals: BackgroundCallTotals, metric: UsageMetricMode): string | null {
  if (metric === 'cost') return totals.costUsd === null ? null : formatCost(totals.costUsd);
  return totals.reportedCalls === 0 ? null : formatTokenCount(backgroundTokens(totals));
}

/** One model as a label: the base model's name (a context-window twin reads
 *  the same), or "<Agent> default" when the CLI reported none and none was
 *  asked for. */
export function backgroundModelLabel(model: BackgroundModelCount): string {
  return model.modelId === null
    ? `${agentShortName(model.agent)} default`
    : baseModelLabel(null, parseModelId(model.modelId).baseId);
}

/** Every model a set of calls ran on, most calls first, without repeats. */
export function backgroundModelLine(models: readonly BackgroundModelCount[]): string {
  return [...new Set(models.map(backgroundModelLabel))].join(', ');
}

/** "N calls", singular at 1, with count separators. */
export function formatCallCount(calls: number): string {
  return `${calls.toLocaleString()} ${calls === 1 ? 'call' : 'calls'}`;
}

/** Average wall time per call: tenths of a second under a minute (a check
 *  takes about 2 s, so whole seconds would hide the difference that matters),
 *  the session duration format above that. */
export function formatAverageCallTime(durationMs: number, calls: number): string {
  if (calls === 0) return '-';
  const averageMs = durationMs / calls;
  return averageMs < 60_000 ? `${(averageMs / 1000).toFixed(1)}s` : formatDuration(averageMs);
}

/**
 * The hover text for a set of calls: what the value line cannot hold. Names
 * which agents reported nothing, rather than suffixing the value, so the
 * value line stays one figure.
 */
export function backgroundCallsTitle(totals: BackgroundCallTotals, models: readonly BackgroundModelCount[]): string {
  if (totals.calls === 0) return 'No calls in this range';
  const parts = [
    totals.failedCalls > 0
      ? `${formatCallCount(totals.calls)}, ${totals.failedCalls.toLocaleString()} failed or timed out (still paid for).`
      : `${formatCallCount(totals.calls)}.`,
  ];
  if (totals.reportedCalls === 0) {
    const agents = [...new Set(models.map((model) => agentShortName(model.agent)))].join(', ');
    parts.push(`${agents || 'The agent'} reported no usage for these calls, so their tokens and cost are not known.`);
  } else {
    if (totals.reportedCalls < totals.calls) {
      parts.push(`Usage reported for ${totals.reportedCalls.toLocaleString()} of them.`);
    }
    parts.push(
      `${formatTokenCount(totals.inputTokens)} fresh input, ${formatTokenCount(totals.outputTokens)} output, `
      + `${formatTokenCount(totals.cacheCreationInputTokens)} cache write, ${formatTokenCount(totals.cacheReadInputTokens)} cache read.`,
    );
  }
  parts.push(`Average ${formatAverageCallTime(totals.durationMs, totals.calls)} per call.`);
  return parts.join(' ');
}
