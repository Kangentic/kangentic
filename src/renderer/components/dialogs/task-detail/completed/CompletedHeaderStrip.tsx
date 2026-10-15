import type { ReactNode } from 'react';
import { CheckCircle2, GitPullRequest, XCircle } from 'lucide-react';
import { formatCost, formatSpan } from '../../../../utils/format-session';
import { formatTokenCount } from '../../../../utils/format-tokens';
import { formatDateTime, formatMonthDay, formatMonthDayTime } from '../../../../lib/datetime';
import { prStatePresentation } from '../../../../lib/pr-state';
import { HoverTip } from '../../../HoverTip';
import type { Task, TaskReport } from '../../../../../shared/types';

/**
 * The strip under a completed task's header: when it ran, how long an agent
 * worked on it, what it changed, its pull request and its cost, then whether
 * the agent ended cleanly.
 *
 * Always one row. A container query on the strip gives ground in a fixed
 * order, each step keeping what it hides in a hover tip:
 *  1. under 1000px, Started and Ended drop their time;
 *  2. under 860px, the separators tighten, and Changes drops its file count
 *     and Pull request its state;
 *  3. under 760px, the status keeps its icon only (the label stays in the
 *     accessible name);
 *  4. under 640px, Started and Ended drop out, and Elapsed carries the span.
 * A task window can be scaled to about 520px, where seven metrics and the
 * status need about 720px: without step 4 the last of them were clipped.
 * Every class is a complete literal, since Tailwind reads source text.
 */
export function CompletedHeaderStrip({ task, report }: { task: Task; report: TaskReport }) {
  const { summary } = report;
  const startedMs = report.startedAt ? Date.parse(report.startedAt) : Number.NaN;
  const endedMs = report.endedAt ? Date.parse(report.endedAt) : Number.NaN;
  const elapsedMs = endedMs - startedMs;
  const hasChanges = summary !== null && (summary.linesAdded > 0 || summary.linesRemoved > 0 || summary.filesChanged > 0);
  const prLabel = prStatePresentation(task.pr_state).label;
  const exitedWithError = summary?.exitCode != null && summary.exitCode !== 0;
  const statusLabel = exitedWithError ? `Exited (${summary?.exitCode})` : 'Completed';

  const metrics: Metric[] = [];
  if (report.startedAt) metrics.push({ key: 'started', label: 'Started', value: <MomentValue value={report.startedAt} />, wideOnly: true });
  if (report.endedAt) metrics.push({ key: 'ended', label: 'Ended', value: <MomentValue value={report.endedAt} />, wideOnly: true });
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    metrics.push({
      key: 'elapsed',
      label: 'Elapsed',
      value: formatSpan(elapsedMs),
      tip: report.startedAt && report.endedAt ? `${formatDateTime(report.startedAt)} to ${formatDateTime(report.endedAt)}` : undefined,
    });
  }
  if (summary && summary.durationMs > 0) metrics.push({ key: 'agent-runtime', label: 'Agent runtime', value: formatSpan(summary.durationMs) });
  if (hasChanges && summary) {
    metrics.push({
      key: 'changes',
      label: 'Changes',
      value: (
        <>
          <HoverTip label={`${summary.linesAdded.toLocaleString()} lines added`}>
            <span className="text-green-400/80">+{formatTokenCount(summary.linesAdded)}</span>
          </HoverTip>
          <HoverTip label={`${summary.linesRemoved.toLocaleString()} lines removed`}>
            <span className="text-red-400/80">-{formatTokenCount(summary.linesRemoved)}</span>
          </HoverTip>
          {summary.filesChanged > 0 && (
            <span className="hidden text-[13px] font-normal text-fg-muted @[860px]:inline">{summary.filesChanged} {summary.filesChanged === 1 ? 'file' : 'files'}</span>
          )}
        </>
      ),
      tip: summary.filesChanged > 0 ? `${summary.filesChanged.toLocaleString()} ${summary.filesChanged === 1 ? 'file' : 'files'} changed` : undefined,
    });
  }
  if (task.pr_number != null) {
    const prUrl = task.pr_url;
    metrics.push({
      key: 'pull-request',
      label: 'Pull request',
      value: (
        <>
          {prUrl ? (
            <HoverTip label={prLabel ? `Open PR #${task.pr_number} (${prLabel})` : `Open PR #${task.pr_number}`}>
              <button
                type="button"
                onClick={() => { void window.electronAPI.shell.openExternal(prUrl); }}
                className="inline-flex items-center gap-[5px] rounded text-purple-400 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <GitPullRequest size={14} />
                #{task.pr_number}
              </button>
            </HoverTip>
          ) : (
            <HoverTip label={prLabel ? `PR #${task.pr_number} (${prLabel})` : ''}>
              <span className="inline-flex items-center gap-[5px] text-purple-400">
                <GitPullRequest size={14} />#{task.pr_number}
              </span>
            </HoverTip>
          )}
          {prLabel && <span className="hidden text-[13px] font-normal capitalize text-fg-muted @[860px]:inline">{prLabel}</span>}
        </>
      ),
    });
  }
  if (summary && summary.totalCostUsd > 0) metrics.push({ key: 'cost', label: 'Cost', value: formatCost(summary.totalCostUsd) });

  return (
    <div className="@container flex-shrink-0 border-b border-edge" data-testid="completed-header-strip">
      <div className="flex items-center overflow-hidden px-4 py-[11px]">
        {metrics.map((metric, index) => (
          <HoverTip key={metric.key} label={metric.tip ?? ''}>
            <div
              className={`${metric.wideOnly ? 'hidden @[640px]:flex' : 'flex'} min-w-0 flex-shrink-0 flex-col gap-[3px] ${
                index < metrics.length - 1 ? 'mr-3 border-r border-edge pr-3 @[860px]:mr-4 @[860px]:pr-4' : ''
              }`}
              data-testid={`completed-metric-${metric.key}`}
            >
              <span className="text-[11px] text-fg-muted">{metric.label}</span>
              <span className="flex items-center gap-1.5 whitespace-nowrap text-[15px] font-semibold tabular-nums text-fg">{metric.value}</span>
            </div>
          </HoverTip>
        ))}
        <HoverTip label={statusLabel}>
          <span
            className={`ml-auto flex flex-shrink-0 items-center gap-[5px] whitespace-nowrap pl-4 text-xs ${exitedWithError ? 'text-red-400' : 'text-green-400'}`}
            aria-label={statusLabel}
            data-testid="completed-status"
          >
            {exitedWithError ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
            <span className="hidden @[760px]:inline" aria-hidden="true">{statusLabel}</span>
          </span>
        </HoverTip>
      </div>
    </div>
  );
}

interface Metric {
  key: string;
  label: string;
  value: ReactNode;
  /** What a narrow strip hides from the value, kept as the metric's hover tip. */
  tip?: string;
  /** Dropped under 640px, where the strip keeps the figures and leaves the moments to Elapsed's tip. */
  wideOnly?: boolean;
}

/** A moment: date and time on a wide strip, the date alone on a narrow one, the full moment in the tip. */
function MomentValue({ value }: { value: string }) {
  return (
    <HoverTip label={formatDateTime(value)}>
      <span>
        <span className="hidden @[1000px]:inline">{formatMonthDayTime(value)}</span>
        <span className="@[1000px]:hidden">{formatMonthDay(value)}</span>
      </span>
    </HoverTip>
  );
}
