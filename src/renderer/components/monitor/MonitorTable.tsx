import { useMemo } from 'react';
import { CirclePause, Check, SquareTerminal } from 'lucide-react';
import type { MonitorSessionRow } from '../../../shared/types';
import { ActivityMark } from '../ActivityMark';
import { DataTable, type DataTableColumn } from '../DataTable';
import { ElapsedTime } from '../terminal/ElapsedTime';
import { formatActivityReasonText } from '../board/ActivityReasonTooltip';
import { agentDisplayName } from '../../utils/agent-display-name';
import { BUCKET_LABELS, bucketOf, formatMonitorStatus, needsUser } from './monitor-view-model';

/**
 * The dense layout: one line per session, sortable, in the shared DataTable.
 *
 * Columns deliberately declare NO width. Under DataTable's `w-full table-fixed`
 * that splits the container evenly at any width, which is the app's proven way to
 * fill a 2560px screen with a list (PerProjectTable does the same with 13
 * columns). The backlog's fixed-px convention is deliberately NOT copied: there
 * the surplus all pools into one title column and the rest of the screen sits
 * empty, which is the exact failure this view exists to avoid.
 *
 * Sorting here is the table's own column sort, which intentionally overrides the
 * toolbar's sort while this layout is active - clicking a header should do what
 * it says.
 */

function StateCell({ row }: { row: MonitorSessionRow }) {
  const bucket = bucketOf(row);
  const title = row.activityReason ? formatActivityReasonText(row.activityReason) : BUCKET_LABELS[bucket];
  // Switch on the BUCKET, not a second derivation. `bucketOf` already decides
  // which section and summary count this row lands in, and re-deriving the glyph
  // from `isWorking` disagreed with it: a running session that has not reported
  // activity yet (a freshly spawned agent, or a Command Terminal, which has no
  // activity engine at all) buckets as `working` but fails `isActive`, so it was
  // counted under Active while its own row drew the paused glyph.
  // The two ACTIVITY states use the shared branding marks, the same vocabulary a
  // board card shows; only the non-activity states (finished, paused) stay lucide.
  if (bucket === 'needs-you') return <ActivityMark mark="agent-idle" size={15} className="text-attention" aria-label={title} />;
  if (bucket === 'working') return <ActivityMark mark="agent-working" size={15} className="text-active" aria-label={title} />;
  if (bucket === 'finished') return <Check size={14} className="text-fg-disabled" aria-label="Finished" />;
  return <CirclePause size={14} className="text-fg-faint" aria-label="Paused" />;
}

export function MonitorTable({
  rows, onOpen, hideProjectColumn = false,
}: {
  rows: MonitorSessionRow[];
  onOpen: (row: MonitorSessionRow) => void;
  /** Set when the tables are already grouped BY project, where a Project column
   *  would just repeat the group's own heading on every row. */
  hideProjectColumn?: boolean;
}) {
  const columns = useMemo<DataTableColumn<MonitorSessionRow>[]>(() => [
    {
      key: 'state',
      label: '',
      sortValue: (row) => BUCKET_LABELS[bucketOf(row)],
      render: (row) => <StateCell row={row} />,
      headerTitle: 'Whether the agent is working, waiting on you, paused, or finished',
    },
    ...(hideProjectColumn ? [] : [{
      key: 'project',
      label: 'Project',
      sortValue: (row: MonitorSessionRow) => row.projectName,
      render: (row: MonitorSessionRow) => <span className="truncate block text-fg-muted">{row.projectName}</span>,
    }]),
    {
      key: 'task',
      label: 'Task',
      sortValue: (row) => row.taskTitle,
      render: (row) => (
        <span className="flex items-center gap-1.5 min-w-0">
          {row.isCommandTerminal && (
            <SquareTerminal size={13} className="shrink-0 text-fg-muted" aria-hidden />
          )}
          {row.displayId !== null && (
            <span className="shrink-0 font-mono text-xs text-fg-muted">#{row.displayId}</span>
          )}
          <span className="truncate text-fg">{row.taskTitle}</span>
        </span>
      ),
    },
    {
      key: 'column',
      label: 'Column',
      sortValue: (row) => row.columnName,
      render: (row) => <span className="truncate block text-fg-muted">{row.columnName}</span>,
    },
    {
      key: 'agent',
      label: 'Agent',
      sortValue: (row) => agentDisplayName(row.agentName),
      render: (row) => <span className="truncate block text-fg-muted">{agentDisplayName(row.agentName)}</span>,
    },
    {
      key: 'model',
      label: 'Model',
      sortValue: (row) => row.modelDisplayName ?? '',
      render: (row) => <span className="truncate block text-fg-muted">{row.modelDisplayName ?? '-'}</span>,
    },
    {
      key: 'effort',
      label: 'Effort',
      sortValue: (row) => row.effort ?? '',
      render: (row) => <span className="truncate block text-fg-muted">{row.effort ?? '-'}</span>,
      headerTitle: 'Reasoning effort the session is running with',
    },
    {
      key: 'permission',
      label: 'Permission',
      sortValue: (row) => row.permissionMode ?? '',
      render: (row) => <span className="truncate block text-fg-muted">{row.permissionMode ?? '-'}</span>,
      headerTitle: 'Permission mode the session was spawned under',
    },
    {
      key: 'runtime',

      label: 'Runtime',
      align: 'right',
      sortValue: (row) => Date.parse(row.startedAt) || 0,
      render: (row) => (row.status === 'exited'
        ? <span className="text-fg-faint">-</span>
        : <ElapsedTime startedAt={row.startedAt} className="tabular-nums text-fg-muted" />),
    },
    {
      key: 'context',
      label: 'Context',
      align: 'right',
      sortValue: (row) => row.contextPercent ?? -1,
      render: (row) => (row.contextPercent === null
        ? <span className="text-fg-faint">-</span>
        : <span className="tabular-nums text-fg-muted">{Math.round(row.contextPercent)}%</span>),
    },
    {
      key: 'doing',
      label: 'Doing now',
      sortValue: (row) => formatMonitorStatus(row),
      render: (row) => (
        <span className={`truncate block ${needsUser(row) ? 'text-attention' : 'text-fg-tertiary'}`}>
          {formatMonitorStatus(row) || (row.lastEvent?.detail ?? '')}
        </span>
      ),
    },
  ], [hideProjectColumn]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      rowKey={(row) => row.sessionId}
      onRowClick={onOpen}
      rowTestId="monitor-table-row"
      emptyMessage="No sessions match the current filters."
      virtualized
    />
  );
}
