import { useMemo } from 'react';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { DataTable, type DataTableColumn } from '../DataTable';
import type { ProjectUsageSummary } from '../../../shared/types';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatRelativeTime } from '../../lib/datetime';
import { agentShortName } from '../../utils/agent-display-name';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';

/**
 * Column keys. The two columns the Cost/Tokens toggle swaps keep ONE key each
 * across the flip (`metricValue` is Cost or Cache Read, `metricShare` is Cost
 * Share or Token Share): `DataTable` reads its default sort once, at mount, and
 * skips a sort level whose column is gone. With stable keys the default sort
 * follows the toggle, and a sort the user picked on another column stays.
 */
type ProjectColumnKey =
  | 'project'
  | 'tokensIn'
  | 'tokensOut'
  | 'metricValue'
  | 'metricShare'
  | 'lines'
  | 'files'
  | 'toolCalls'
  | 'avgActive'
  | 'topAgent'
  | 'lastActive'
  | 'sessions';

/** Row shape with the client-derived comparison ratios attached. */
interface ProjectComparisonRow extends ProjectUsageSummary {
  costShare: number;
  /** Share of fresh input plus output across all projects. */
  tokenShare: number;
  cacheReadTokens: number;
  avgActiveMs: number | null;
}

/** Inline mini-bar for a share column (value already 0..1). The number
 *  beside it keeps the value reachable without reading the bar. */
function ShareCell({ share }: { share: number }) {
  return (
    <span className="flex items-center gap-2 justify-end">
      <span className="w-14 h-1.5 rounded-full bg-edge/40 overflow-hidden flex-shrink-0" aria-hidden>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="tabular-nums w-10 text-right">{`${Math.round(share * 100)}%`}</span>
    </span>
  );
}

type ProjectColumn = DataTableColumn<ProjectComparisonRow, ProjectColumnKey>;

function costColumns(i18n: I18n): ProjectColumn[] {
  return [
    {
      key: 'metricValue',
      label: i18n._(msg`Cost`),
      align: 'right',
      headerTip: i18n._(msg`API-equivalent cost as reported by agents (subscription sessions may report $0)`),
      sortValue: (row) => row.costUsd,
      render: (row) => <span className="tabular-nums">{formatCost(row.costUsd)}</span>,
    },
    {
      key: 'metricShare',
      label: i18n._(msg`Cost Share`),
      align: 'right',
      headerTip: i18n._(msg`This project's share of the total cost across all projects in the range`),
      sortValue: (row) => row.costShare,
      render: (row) => <ShareCell share={row.costShare} />,
    },
  ];
}

function tokenColumns(i18n: I18n): ProjectColumn[] {
  return [
    {
      key: 'metricValue',
      label: i18n._(msg`Cache Read`),
      align: 'right',
      headerTip: i18n._(msg`Tokens served from the prompt cache, counted apart from Tokens In`),
      sortValue: (row) => row.cacheReadTokens,
      render: (row) => <span className="tabular-nums">{formatTokenCount(row.cacheReadTokens)}</span>,
    },
    {
      key: 'metricShare',
      label: i18n._(msg`Token Share`),
      align: 'right',
      headerTip: i18n._(msg`Share of fresh input plus output across all projects in the range`),
      sortValue: (row) => row.tokenShare,
      render: (row) => <ShareCell share={row.tokenShare} />,
    },
  ];
}

function leadingColumns(i18n: I18n): ProjectColumn[] {
  return [
    {
      key: 'project',
      label: i18n._(msg`Project`),
      headerTip: i18n._(msg`Registered project - click a row to view that project in the dashboard`),
      sortValue: (row) => row.projectName.toLowerCase(),
      render: (row) => <span className="text-fg-secondary">{row.projectName}</span>,
    },
    {
      key: 'tokensIn',
      label: i18n._(msg`Tokens In`),
      align: 'right',
      headerTip: i18n._(msg`Fresh input tokens across the turns in this range (cache reads counted separately)`),
      sortValue: (row) => row.inputTokens,
      render: (row) => <span className="tabular-nums">{formatTokenCount(row.inputTokens)}</span>,
    },
    {
      key: 'tokensOut',
      label: i18n._(msg`Tokens Out`),
      align: 'right',
      headerTip: i18n._(msg`Output tokens across the turns in this range`),
      sortValue: (row) => row.outputTokens,
      render: (row) => <span className="tabular-nums">{formatTokenCount(row.outputTokens)}</span>,
    },
  ];
}

function trailingColumns(i18n: I18n): ProjectColumn[] {
  return [
    {
      key: 'lines',
      label: i18n._(msg`Lines`),
      align: 'right',
      headerTip: i18n._(msg`Lines added / removed by agent sessions (git diff vs the base branch)`),
      sortValue: (row) => row.linesAdded + row.linesRemoved,
      render: (row) => (
        <span className="tabular-nums">
          <span className="text-green-400/70">{`+${formatTokenCount(row.linesAdded)}`}</span>
          {' / '}
          <span className="text-red-400/70">{`-${formatTokenCount(row.linesRemoved)}`}</span>
        </span>
      ),
    },
    {
      key: 'files',
      label: i18n._(msg`Files`),
      align: 'right',
      headerTip: i18n._(msg`Files changed by agent sessions (git diff vs the base branch)`),
      sortValue: (row) => row.filesChanged,
      render: (row) => <span className="tabular-nums">{formatTokenCount(row.filesChanged)}</span>,
    },
    {
      key: 'toolCalls',
      label: i18n._(msg`Tool Calls`),
      align: 'right',
      headerTip: i18n._(msg`Total tool calls across sessions in the range`),
      sortValue: (row) => row.toolCallCount,
      render: (row) => <span className="tabular-nums">{formatTokenCount(row.toolCallCount)}</span>,
    },
    {
      key: 'avgActive',
      label: i18n._(msg`Avg Active`),
      align: 'right',
      headerTip: i18n._(msg`Average time the agent was working per session, excluding idle. Covers only sessions with activity tracking, which is fewer than the Sessions column counts.`),
      sortValue: (row) => row.avgActiveMs ?? -1,
      render: (row) => (
        <span className="tabular-nums">{row.avgActiveMs !== null ? formatDuration(row.avgActiveMs) : '-'}</span>
      ),
    },
    {
      key: 'topAgent',
      label: i18n._(msg`Top Agent`),
      align: 'right',
      headerTip: i18n._(msg`Agent with the most tokens in this project over the range`),
      sortValue: (row) => (row.topAgent !== null ? agentShortName(row.topAgent) : ''),
      render: (row) => (
        <span className="text-fg-secondary">{row.topAgent !== null ? agentShortName(row.topAgent) : '-'}</span>
      ),
    },
    {
      key: 'lastActive',
      label: i18n._(msg`Last Active`),
      align: 'right',
      headerTip: i18n._(msg`Most recent session start in the range`),
      sortValue: (row) => row.lastActiveMs ?? 0,
      render: (row) => (
        <span className="text-fg-muted">{row.lastActiveMs !== null ? formatRelativeTime(row.lastActiveMs) : '-'}</span>
      ),
    },
    {
      key: 'sessions',
      label: i18n._(msg`Sessions`),
      align: 'right',
      headerTip: i18n._(msg`Finalized sessions in the range`),
      sortValue: (row) => row.sessionCount,
      render: (row) => <span className="tabular-nums">{row.sessionCount.toLocaleString()}</span>,
    },
  ];
}

/** The table's columns for each view of the Cost/Tokens toggle, in the session's language. */
function buildColumnsByMetric(i18n: I18n): Record<UsageMetricMode, ProjectColumn[]> {
  const leading = leadingColumns(i18n);
  const trailing = trailingColumns(i18n);
  return {
    cost: [...leading, ...costColumns(i18n), ...trailing],
    tokens: [...leading, ...tokenColumns(i18n), ...trailing],
  };
}

/** Per-project comparison table for the All-Projects scope, sortable on every
 *  column. Ratios (cost share, token share, avg active) derive here from the
 *  payload sub-totals. Clicking a row re-scopes the dashboard to that project
 *  (without switching the app's current project). The Tokens view swaps Cost
 *  and Cost Share for Cache Read and Token Share.
 *
 *  There is no blended $/Mtok column. Cost reaches back to a project's first
 *  session while per-turn token capture starts later, so the ratio divided a
 *  full-range numerator by a partial-range denominator and read high by a
 *  multiple that varied per project. */
export function PerProjectTable({
  projects,
  metric,
  onProjectClick,
}: {
  projects: ProjectUsageSummary[];
  metric: UsageMetricMode;
  onProjectClick?: (projectId: string) => void;
}) {
  const { t, i18n } = useLingui();
  const columnsByMetric = useMemo(() => buildColumnsByMetric(i18n), [i18n]);
  const rows = useMemo<ProjectComparisonRow[]>(() => {
    const totalCost = projects.reduce((sum, project) => sum + project.costUsd, 0);
    const totalTokens = projects.reduce((sum, project) => sum + project.inputTokens + project.outputTokens, 0);
    return projects.map((project) => {
      return {
        ...project,
        tokenShare: totalTokens > 0 ? (project.inputTokens + project.outputTokens) / totalTokens : 0,
        cacheReadTokens: project.cacheReadTokens ?? 0,
        // Defensive: a payload cached from an older shape (or a dev server
        // mid-upgrade) may lack the newer fields - never render NaN.
        toolCallCount: project.toolCallCount ?? 0,
        linesAdded: project.linesAdded ?? 0,
        linesRemoved: project.linesRemoved ?? 0,
        filesChanged: project.filesChanged ?? 0,
        totalDurationMs: project.totalDurationMs ?? 0,
        activeMs: project.activeMs ?? 0,
        activeSessionsCovered: project.activeSessionsCovered ?? 0,
        lastActiveMs: project.lastActiveMs ?? null,
        topAgent: project.topAgent ?? null,
        costShare: totalCost > 0 ? project.costUsd / totalCost : 0,
        // Active time per COVERED session, matching the Avg Active tile. The
        // denominator is the interval ledger's own session count, not
        // `sessionCount`: the two ledgers cover different session populations,
        // and mixing them under-reports every historical range.
        avgActiveMs: (project.activeSessionsCovered ?? 0) > 0
          ? (project.activeMs ?? 0) / project.activeSessionsCovered
          : null,
      };
    });
  }, [projects]);

  return (
    <div className="bg-surface-raised border border-edge rounded-lg p-2" data-testid="per-project-table">
      <DataTable
        columns={columnsByMetric[metric]}
        data={rows}
        rowKey={(row) => row.projectId}
        onRowClick={onProjectClick ? (row) => onProjectClick(row.projectId) : undefined}
        // By share: cost in the Cost view, fresh input plus output in the
        // Tokens view, through the one stable key.
        defaultSortKey="metricShare"
        defaultSortDirection="desc"
        emptyMessage={t`No project usage recorded yet`}
        rowTestId="per-project-row"
      />
    </div>
  );
}
