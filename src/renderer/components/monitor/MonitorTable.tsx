import { useMemo } from 'react';
import { CirclePause, Check } from 'lucide-react';
import { DEFAULT_PERMISSIONS, getPermissionLabel } from '../../../shared/types';
import type { AgentDetectionInfo, MonitorSessionRow } from '../../../shared/types';
import { ActivityMark } from '../ActivityMark';
import { DataTable, type DataTableColumn } from '../DataTable';
import { ElapsedTime } from '../terminal/ElapsedTime';
import { formatActivityReasonText } from '../board/ActivityReasonTooltip';
import { AUTOMATIONS_DISABLED_TIP, AutomationsDisabledGlyph } from '../board/AutomationsDisabledStrip';
import { TicketNumber } from '../board/task-card-view';
import { Tooltip } from '../Tooltip';
import { WorkflowGlyph } from '../workflows/WorkflowStrip';
import { agentDisplayName } from '../../utils/agent-display-name';
import { modelRowLabel } from '../../utils/format-tokens';
import { useConfigStore } from '../../stores/config-store';
import { BUCKET_LABELS, bucketOf, formatMonitorStatus, monitorActivityMark, needsUser } from './monitor-view-model';

/**
 * The dense layout: one line per session, sortable, in the shared DataTable.
 *
 * LABELED columns deliberately declare NO width. Under DataTable's `w-full
 * table-fixed` that splits the container evenly at any width, which is the app's
 * proven way to fill a 2560px screen with a list (PerProjectTable does the same
 * with 13 columns). The backlog's fixed-px convention is deliberately NOT copied:
 * there the surplus all pools into one title column and the rest of the screen
 * sits empty, which is the exact failure this view exists to avoid. The one
 * exception is the unlabeled state-glyph column, pinned to the backlog's 40px
 * icon-column width: an even share hands a 15px glyph a couple hundred pixels of
 * dead air between it and the Task column.
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
  // activity yet buckets as `working` but fails `isActive`, so it was counted
  // under Active while its own row drew the paused glyph.
  // The two ACTIVITY states use the shared branding marks, the same vocabulary a
  // board card shows; only the non-activity states (finished, paused) stay lucide.
  if (bucket === 'needs-you' || bucket === 'working') {
    const needsYou = bucket === 'needs-you';
    // Terminal marks for a Command Terminal, as on MonitorCard: this glyph is
    // what distinguishes a terminal from a task agent, so it replaced the separate
    // lucide SquareTerminal that used to sit in the Task cell. One computed slot,
    // never conditional siblings (see MonitorCard's StateGlyph for why).
    return (
      <ActivityMark
        mark={monitorActivityMark(row, needsYou)}
        size={15}
        className={needsYou ? 'text-attention' : 'text-active'}
        aria-label={title}
      />
    );
  }
  if (bucket === 'finished') return <Check size={14} className="text-fg-disabled" aria-label="Finished" />;
  return <CirclePause size={14} className="text-fg-faint" aria-label="Paused" />;
}

/** The installed agents by name, built once per list so each cell is a map lookup. */
type AgentsByName = ReadonlyMap<string, AgentDetectionInfo>;

function agentInfoFor(agentsByName: AgentsByName, agentName: string | null): AgentDetectionInfo | undefined {
  return agentName ? agentsByName.get(agentName) : undefined;
}

/*
 * Agent, Model and Permission in the Column Manager's words (its overview table
 * computes them in `BoardManagerDialog`): the adapter's own display name, the
 * model's display name, and the agent's own permission label. Each agent words
 * its modes differently, so the lookup is per row. The list arrives from the
 * config store; before it loads, permission falls back to the default list.
 */
function agentLabel(agentsByName: AgentsByName, row: MonitorSessionRow): string {
  return agentInfoFor(agentsByName, row.agentName)?.displayName ?? agentDisplayName(row.agentName);
}

function modelLabel(agentsByName: AgentsByName, row: MonitorSessionRow): string | null {
  if (!row.modelDisplayName) return null;
  return modelRowLabel(row.modelDisplayName, agentInfoFor(agentsByName, row.agentName)?.capabilities?.modelDisplayNames ?? {});
}

function permissionLabel(agentsByName: AgentsByName, row: MonitorSessionRow): string | null {
  if (!row.permissionMode) return null;
  const permissions = agentInfoFor(agentsByName, row.agentName)?.permissions ?? DEFAULT_PERMISSIONS;
  return getPermissionLabel(permissions, row.permissionMode);
}

/**
 * The Automations column's sort: held tasks first, then the rest, and a Command
 * Terminal (no task, so no automations) last with the other blanks.
 */
function automationsSortValue(row: MonitorSessionRow): number | null {
  if (row.isCommandTerminal) return null;
  return row.automationsDisabled ? 0 : 1;
}

/** A cell value, or the Column Manager's faint "Default" where the agent's own default applies. */
function ValueOrDefault({ value }: { value: string | null }) {
  return value === null
    ? <span className="truncate block text-fg-faint">Default</span>
    : <span className="truncate block text-fg-muted">{value}</span>;
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
  const agentList = useConfigStore((state) => state.agentList);
  const showTaskNumbers = useConfigStore((state) => state.config.showTaskNumbers);
  const agentsByName = useMemo<AgentsByName>(
    () => new Map(agentList.map((agent) => [agent.name, agent])),
    [agentList],
  );
  const columns = useMemo<DataTableColumn<MonitorSessionRow>[]>(() => [
    {
      key: 'state',
      label: '',
      width: 'w-[40px]',
      sortValue: (row) => BUCKET_LABELS[bucketOf(row)],
      render: (row) => <StateCell row={row} />,
      headerTip: 'Whether the agent is working, waiting on you, paused, or finished',
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
          {/* Gated on the Ticket Numbers setting, as the card and the list row are. */}
          {showTaskNumbers && row.displayId !== null && (
            <TicketNumber displayId={row.displayId} testId="monitor-table-display-id" className="select-text" />
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
      // No track here: the Column cell beside it already says where the task is.
      key: 'workflow',
      label: 'Workflow',
      sortValue: (row) => row.workflow?.title ?? null,
      render: (row) => (row.workflow
        ? (
          <span className="flex items-center gap-[5px] min-w-0 text-fg-muted" data-testid="monitor-table-workflow">
            <WorkflowGlyph colorSlot={row.workflow.colorSlot} />
            <span className="truncate">{row.workflow.title}</span>
          </span>
        )
        : <span className="text-fg-faint">-</span>),
      headerTip: 'The workflow the task belongs to',
    },
    {
      // Disabled is the non-default value, so it gets the Column Manager's chip
      // for a value set on purpose; Enabled stays its faint, inherited text.
      key: 'automations',
      label: 'Automations',
      sortValue: automationsSortValue,
      render: (row) => {
        if (row.isCommandTerminal) return <span className="text-fg-disabled">-</span>;
        if (row.automationsDisabled) {
          return (
            <Tooltip label={AUTOMATIONS_DISABLED_TIP}>
              <span
                className="inline-flex h-[22px] max-w-full min-w-0 items-center gap-1 whitespace-nowrap rounded bg-surface-hover/50 px-2 font-medium text-fg"
                data-testid="monitor-table-automations-disabled"
              >
                <AutomationsDisabledGlyph />
                <span className="truncate">Disabled</span>
              </span>
            </Tooltip>
          );
        }
        return <span className="truncate block text-fg-faint">Enabled</span>;
      },
      headerTip: "Whether the column's automations run for the task",
    },
    {
      key: 'agent',
      label: 'Agent',
      sortValue: (row) => agentLabel(agentsByName, row),
      render: (row) => <span className="truncate block text-fg-muted">{agentLabel(agentsByName, row)}</span>,
    },
    {
      key: 'model',
      label: 'Model',
      sortValue: (row) => modelLabel(agentsByName, row),
      render: (row) => <ValueOrDefault value={modelLabel(agentsByName, row)} />,
    },
    {
      key: 'effort',
      label: 'Effort',
      sortValue: (row) => row.effort,
      render: (row) => <ValueOrDefault value={row.effort} />,
      headerTip: 'Reasoning effort the session is running with',
    },
    {
      key: 'permission',
      label: 'Permission',
      sortValue: (row) => permissionLabel(agentsByName, row),
      render: (row) => <ValueOrDefault value={permissionLabel(agentsByName, row)} />,
      headerTip: 'Permission mode the session was spawned under',
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
        <span className={`truncate block select-text ${needsUser(row) ? 'text-attention' : 'text-fg-tertiary'}`}>
          {formatMonitorStatus(row) || (row.lastEvent?.detail ?? '')}
        </span>
      ),
    },
  // `agentsByName` is a dependency: the labels change once the list loads, which
  // a popped-out monitor does after mount.
  ], [hideProjectColumn, agentsByName, showTaskNumbers]);

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
