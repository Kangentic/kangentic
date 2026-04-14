import React, { useState, useEffect } from 'react';
import { DollarSign, Cpu, Wrench, CheckCircle2, XCircle, Hash, ArrowUp, ArrowDown, ArrowRight, Calendar, Clock, Hourglass, Fingerprint, GitBranch, FileCode, Copy, Check } from 'lucide-react';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatDuration, formatCost } from '../../utils/format-session';
import { formatShortDateTime, formatDurationBetween } from '../../lib/datetime';
import type { SessionSummary } from '../../../shared/types';

interface SessionSummaryPanelProps {
  taskId: string;
}

/**
 * Session summary section shown at the bottom of completed task dialogs.
 * Displays metrics (model, cost, tokens, duration, tool calls) and timeline.
 */
export function SessionSummaryPanel({ taskId }: SessionSummaryPanelProps) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.sessions.getSummary(taskId);
        if (!cancelled) setSummary(result);
      } catch {
        // Ignore errors (e.g. in tests)
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  if (loading) return null;

  // Empty state when no session metrics exist
  if (!summary) {
    return (
      <div className="flex-shrink-0 border-t border-edge" data-testid="session-summary">
        <div className="px-4 py-3 text-center text-xs text-fg-disabled">
          No session data available
        </div>
      </div>
    );
  }

  const exitSuccess = summary.exitCode === 0;
  const exitUnknown = summary.exitCode == null;
  // Tasks in Done are always "completed" even if the exit code is unknown (suspended path)
  const showCompleted = exitSuccess || exitUnknown;

  const metricRows: Array<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = [];

  metricRows.push({
    icon: <Fingerprint size={13} />,
    label: 'Session ID',
    value: (
      <button
        type="button"
        className="flex items-center gap-1.5 text-fg-secondary font-mono text-xs hover:text-fg transition-colors"
        title={`Click to copy: ${summary.sessionId}`}
        onClick={() => {
          navigator.clipboard.writeText(summary.sessionId);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {summary.sessionId}
        {copied
          ? <Check size={10} className="text-green-400" />
          : <Copy size={10} className="text-fg-disabled" />
        }
      </button>
    ),
  });

  // Timeline: task creation -> completion (full lifecycle)
  if (summary.taskCreatedAt) {
    const timelineStart = formatShortDateTime(summary.taskCreatedAt);
    metricRows.push({
      icon: <Calendar size={13} />,
      label: 'Timeline',
      value: summary.exitedAt
        ? (
          <span className="text-fg-secondary tabular-nums flex items-center gap-1.5">
            {timelineStart}
            <ArrowRight size={10} className="text-fg-disabled" />
            {formatShortDateTime(summary.exitedAt)}
          </span>
        )
        : <span className="text-fg-secondary tabular-nums">{timelineStart}</span>,
    });
  }

  if (summary.exitedAt && summary.taskCreatedAt) {
    metricRows.push({
      icon: <Clock size={13} />,
      label: 'Duration',
      value: (
        <span className="text-fg-secondary tabular-nums font-medium">
          {formatDurationBetween(summary.taskCreatedAt, summary.exitedAt)}
        </span>
      ),
    });
  }

  if (summary.durationMs > 0) {
    metricRows.push({
      icon: <Hourglass size={13} />,
      label: 'Agent',
      value: <span className="text-fg-secondary tabular-nums">{formatDuration(summary.durationMs)} active</span>,
    });
  }

  if (summary.modelDisplayName) {
    metricRows.push({
      icon: <Cpu size={13} />,
      label: 'Model',
      value: <span className="text-fg-secondary">{summary.modelDisplayName}</span>,
    });
  }

  if (summary.totalCostUsd > 0) {
    metricRows.push({
      icon: <DollarSign size={13} />,
      label: 'Cost',
      value: <span className="text-fg-secondary tabular-nums">{formatCost(summary.totalCostUsd)}</span>,
    });
  }

  if (summary.totalInputTokens > 0 || summary.totalOutputTokens > 0) {
    metricRows.push({
      icon: <Hash size={13} />,
      label: 'Tokens',
      value: (
        <span className="text-fg-secondary tabular-nums flex items-center gap-2">
          <span className="flex items-center gap-0.5">
            <ArrowUp size={10} className="text-fg-secondary" />
            {formatTokenCount(summary.totalInputTokens)}
          </span>
          <span className="text-fg-secondary">/</span>
          <span className="flex items-center gap-0.5">
            <ArrowDown size={10} className="text-fg-secondary" />
            {formatTokenCount(summary.totalOutputTokens)}
          </span>
        </span>
      ),
    });
  }

  if (summary.toolCallCount > 0) {
    metricRows.push({
      icon: <Wrench size={13} />,
      label: 'Tool calls',
      value: <span className="text-fg-secondary tabular-nums">{summary.toolCallCount}</span>,
    });
  }

  if (summary.filesChanged > 0) {
    metricRows.push({
      icon: <FileCode size={13} />,
      label: 'Files changed',
      value: <span className="text-fg-secondary tabular-nums">{summary.filesChanged}</span>,
    });
  }

  if (summary.linesAdded > 0 || summary.linesRemoved > 0) {
    metricRows.push({
      icon: <GitBranch size={13} />,
      label: 'Lines changed',
      value: (
        <span className="text-fg-secondary tabular-nums flex items-center gap-2">
          <span className="text-green-400/70">+{summary.linesAdded}</span>
          <span className="text-red-400/70">-{summary.linesRemoved}</span>
        </span>
      ),
    });
  }

  return (
    <div className="flex-shrink-0 border-t border-edge bg-surface-inset/40" data-testid="session-summary">
      {/* Header row with status */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
        <span className="text-xs font-semibold text-fg-muted tracking-wide uppercase">Session Summary</span>
        {showCompleted ? (
          <span className="flex items-center gap-1 text-xs text-green-400">
            <CheckCircle2 size={12} />
            Completed
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-red-400">
            <XCircle size={12} />
            Exited ({summary.exitCode})
          </span>
        )}
      </div>

      {/* Metric rows (includes timeline) */}
      {metricRows.length > 0 && (
        <div className="px-4 py-2 pb-3 grid grid-cols-[auto_auto] items-center justify-start gap-x-4 gap-y-2">
          {metricRows.map((row) => (
            <React.Fragment key={row.label}>
              <span className="flex items-center gap-1.5 text-xs text-fg-faint">
                {row.icon}
                {row.label}
              </span>
              <span className="flex items-center text-xs">{row.value}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
