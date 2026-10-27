import { useMemo } from 'react';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { DataTable, type DataTableColumn, type DataTableColumnGroup } from '../DataTable';
import { Tooltip } from '../Tooltip';
import type { BackgroundDayUsage } from '../../../shared/types';
import { BACKGROUND_CALL_JOB_LABELS, BACKGROUND_CALL_JOBS } from '../../../shared/background-call-jobs';
import { translateText } from '../../i18n/translate';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost } from '../../utils/format-session';
import { backgroundCallsTitle, backgroundModelLine, formatAverageCallTime } from './background-display';

type HistoryColumnKey =
  | 'day'
  | 'job'
  | 'model'
  | 'calls'
  | 'failed'
  | 'freshInput'
  | 'cacheWrite'
  | 'cacheRead'
  | 'output'
  | 'averageTime'
  | 'cost';

const JOB_ORDER = new Map(BACKGROUND_CALL_JOBS.map((job, index) => [job, index]));

/** A token figure, or a muted dash when no call in the row reported usage. */
function TokenCell({ row, value }: { row: BackgroundDayUsage; value: number }) {
  return row.reportedCalls === 0
    ? <span className="text-fg-faint">-</span>
    : <span className="tabular-nums">{formatTokenCount(value)}</span>;
}

/** Token sorts put a row with nothing reported below a real zero. */
function tokenSortValue(row: BackgroundDayUsage, value: number): number {
  return row.reportedCalls === 0 ? -1 : value;
}

/** The table's columns, their headers and tips in the session's language. */
function buildColumns(i18n: I18n): DataTableColumn<BackgroundDayUsage, HistoryColumnKey>[] {
  // The session's language, as src/renderer/lib/datetime.ts formats dates (an empty locale throws).
  const dateLocale = i18n.locale || undefined;
  return [
    {
      key: 'day',
      label: i18n._(msg`Day`),
      width: 'w-[110px]',
      sortValue: (row) => row.dayStartMs,
      render: (row) => (
        <span className="text-fg-muted">
          {new Date(row.dayStartMs).toLocaleDateString(dateLocale, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      ),
    },
    {
      key: 'job',
      label: i18n._(msg`Job`),
      width: 'w-[150px]',
      sortValue: (row) => JOB_ORDER.get(row.job) ?? 0,
      render: (row) => <span className="text-fg-secondary">{translateText(BACKGROUND_CALL_JOB_LABELS[row.job])}</span>,
    },
    {
      key: 'model',
      label: i18n._(msg`Model`),
      width: 'w-[130px]',
      headerTip: i18n._(msg`What the CLI reported answering with; with no report, the model Kangentic asked for, or the agent default`),
      sortValue: (row) => backgroundModelLine(row.models).toLowerCase(),
      render: (row) => {
        const line = backgroundModelLine(row.models);
        // The full line on hover: the column cuts it short.
        return (
          <Tooltip label={line}>
            <span className="text-fg-secondary truncate block">{line}</span>
          </Tooltip>
        );
      },
    },
    {
      key: 'calls',
      label: i18n._(msg`Calls`),
      align: 'right',
      width: 'w-[70px]',
      sortValue: (row) => row.calls,
      render: (row) => (
        <Tooltip label={backgroundCallsTitle(row, row.models)}>
          <span className="tabular-nums">{row.calls.toLocaleString()}</span>
        </Tooltip>
      ),
    },
    {
      key: 'failed',
      label: i18n._(msg`Failed`),
      align: 'right',
      width: 'w-[70px]',
      headerTip: i18n._(msg`Calls that errored or timed out. They still cost what the agent reported.`),
      sortValue: (row) => row.failedCalls,
      render: (row) => (
        <span className={`tabular-nums ${row.failedCalls > 0 ? 'text-attention' : 'text-fg-faint'}`}>
          {row.failedCalls.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'freshInput',
      label: i18n._(msg`Fresh in`),
      align: 'right',
      width: 'w-[90px]',
      sortValue: (row) => tokenSortValue(row, row.inputTokens),
      render: (row) => <TokenCell row={row} value={row.inputTokens} />,
    },
    {
      key: 'cacheWrite',
      label: i18n._(msg`Cache write`),
      align: 'right',
      width: 'w-[100px]',
      sortValue: (row) => tokenSortValue(row, row.cacheCreationInputTokens),
      render: (row) => <TokenCell row={row} value={row.cacheCreationInputTokens} />,
    },
    {
      key: 'cacheRead',
      label: i18n._(msg`Cache read`),
      align: 'right',
      width: 'w-[100px]',
      sortValue: (row) => tokenSortValue(row, row.cacheReadInputTokens),
      render: (row) => <TokenCell row={row} value={row.cacheReadInputTokens} />,
    },
    {
      key: 'output',
      label: i18n._(msg({ message: 'Output', context: 'Usage statistics' })),
      align: 'right',
      width: 'w-[80px]',
      sortValue: (row) => tokenSortValue(row, row.outputTokens),
      render: (row) => <TokenCell row={row} value={row.outputTokens} />,
    },
    {
      key: 'averageTime',
      label: i18n._(msg`Avg time`),
      align: 'right',
      width: 'w-[80px]',
      headerTip: i18n._(msg`Average wall time per call`),
      sortValue: (row) => (row.calls > 0 ? row.durationMs / row.calls : 0),
      render: (row) => <span className="tabular-nums text-fg-muted">{formatAverageCallTime(row.durationMs, row.calls)}</span>,
    },
    {
      key: 'cost',
      label: i18n._(msg`Cost`),
      align: 'right',
      width: 'w-[80px]',
      headerTip: i18n._(msg`API-equivalent cost as each agent reported it`),
      sortValue: (row) => row.costUsd ?? -1,
      render: (row) => (row.costUsd === null
        ? <span className="text-fg-faint">-</span>
        : <span className="tabular-nums">{formatCost(row.costUsd)}</span>),
    },
  ];
}

function buildColumnGroups(i18n: I18n): DataTableColumnGroup[] {
  return [
    { label: '', span: 5 },
    { label: i18n._(msg`Tokens`), span: 4 },
    { label: '', span: 2 },
  ];
}

/**
 * "Background calls by day": one row per local day and job, with the four
 * token types, cost and timing as each agent reported them. Follows the
 * period and project filters; a dash is a figure the agent did not report,
 * never a zero. Scrolls inside its own card past a few weeks of rows.
 */
export function BackgroundHistoryCard({ days }: { days: BackgroundDayUsage[] }) {
  const { t, i18n } = useLingui();
  const columns = useMemo(() => buildColumns(i18n), [i18n]);
  const columnGroups = useMemo(() => buildColumnGroups(i18n), [i18n]);
  // Newest day first and, within a day, the costliest job first. The table's
  // default sort is the day; its sort is stable, so this order holds inside a
  // day until the user picks another column.
  const rows = useMemo(
    () => [...days].sort((first, second) =>
      (second.dayStartMs - first.dayStartMs) || ((second.costUsd ?? -1) - (first.costUsd ?? -1))),
    [days],
  );
  return (
    <section
      aria-label={t`Background calls by day`}
      className="bg-surface-raised border border-edge rounded-lg p-4"
      data-testid="background-history"
    >
      <div className="mb-2">
        <div className="text-xs font-medium text-fg-muted"><Trans>Background calls by day</Trans></div>
        <div className="text-[11px] text-fg-faint mt-0.5"><Trans>Tokens and cost as each agent reported them</Trans></div>
      </div>
      <div className="flex flex-col max-h-96 overflow-x-auto">
        <div className="min-w-[1060px] flex flex-col min-h-0 flex-1">
          <DataTable
            columns={columns}
            columnGroups={columnGroups}
            data={rows}
            rowKey={(row) => `${row.dayStartMs}:${row.job}`}
            defaultSortKey="day"
            defaultSortDirection="desc"
            emptyMessage={t`No background calls in this range`}
            rowTestId="background-history-row"
            virtualized
          />
        </div>
      </div>
    </section>
  );
}
