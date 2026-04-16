import { useMemo } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { formatRelativeTime } from '../../../lib/datetime';
import type { DataTableColumn } from '../../DataTable';
import { formatCost, formatDuration } from '../../../utils/format-session';
import { formatTokenCount } from '../../../utils/format-tokens';
import type { Task, Swimlane, SessionSummary } from '../../../../shared/types';
import { StaleTaskWarning } from './StaleTaskWarning';
import { RowActions } from './RowActions';

export type SortKey = 'select' | 'title' | 'cost' | 'duration' | 'tokens' | 'files' | 'lines' | 'completed' | 'actions';

export interface TaskRow {
  task: Task;
  summary: SessionSummary | undefined;
}

/**
 * Build the DataTable column definitions for the completed-tasks
 * table. Memoized against the pieces of state/action each column
 * closes over so re-renders don't churn the column identity.
 *
 * Owns the full column shape: select checkbox, title, cost/duration/
 * tokens/files/lines metrics, completed timestamp with
 * StalenessIndicator, and per-row actions.
 */
export function useCompletedColumns(input: {
  selectedIds: Set<string>;
  swimlanes: Swimlane[];
  restorePopoverId: string | null;
  toggleSelect: (taskId: string) => void;
  toggleSelectAll: (filteredRows: TaskRow[]) => void;
  toggleRestorePopover: (taskId: string) => void;
  closeRestorePopover: () => void;
  handleRestore: (taskId: string, swimlaneId: string) => Promise<void>;
  handleDelete: (taskId: string) => void;
  handleViewDetail: (taskId: string) => void;
}): DataTableColumn<TaskRow, SortKey>[] {
  const {
    selectedIds,
    swimlanes,
    restorePopoverId,
    toggleSelect,
    toggleSelectAll,
    toggleRestorePopover,
    closeRestorePopover,
    handleRestore,
    handleDelete,
    handleViewDetail,
  } = input;

  return useMemo(() => [
    {
      key: 'select' as SortKey,
      label: '',
      width: 'w-[40px]',
      render: (row) => (
        <label className="flex items-center justify-center p-1 cursor-pointer" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selectedIds.has(row.task.id)}
            onChange={() => toggleSelect(row.task.id)}
            className="w-3 h-3 accent-accent-fg cursor-pointer"
            data-testid="completed-task-checkbox"
          />
        </label>
      ),
      headerRender: (filteredRows: TaskRow[]) => (
        <label className="flex items-center justify-center p-1 cursor-pointer">
          <input
            type="checkbox"
            checked={filteredRows.length > 0 && filteredRows.every((row) => selectedIds.has(row.task.id))}
            onChange={() => toggleSelectAll(filteredRows)}
            className="w-3 h-3 accent-accent-fg cursor-pointer"
            data-testid="select-all-checkbox"
          />
        </label>
      ),
    },
    {
      key: 'title' as SortKey,
      label: 'Title',
      width: '',
      sortValue: (row) => row.task.title.toLowerCase(),
      render: (row) => (
        <div className="min-w-0">
          <div className="text-fg font-medium truncate">{row.task.title}</div>
          {row.task.description && (
            <div className="text-xs text-fg-faint truncate mt-0.5">{row.task.description}</div>
          )}
        </div>
      ),
    },
    {
      key: 'cost' as SortKey,
      label: 'Cost',
      align: 'right',
      width: 'w-[80px]',
      sortValue: (row) => row.summary?.totalCostUsd ?? -1,
      render: (row) =>
        row.summary && row.summary.totalCostUsd > 0 ? (
          <span className="tabular-nums text-fg-secondary">{formatCost(row.summary.totalCostUsd)}</span>
        ) : (
          <span className="text-fg-disabled">-</span>
        ),
    },
    {
      key: 'duration' as SortKey,
      label: 'Duration',
      align: 'right',
      width: 'w-[90px]',
      sortValue: (row) => row.summary?.durationMs ?? -1,
      render: (row) =>
        row.summary && row.summary.durationMs > 0 ? (
          <span className="tabular-nums text-fg-secondary">{formatDuration(row.summary.durationMs)}</span>
        ) : (
          <span className="text-fg-disabled">-</span>
        ),
    },
    {
      key: 'tokens' as SortKey,
      label: 'Tokens',
      align: 'right',
      width: 'w-[120px]',
      sortValue: (row) =>
        row.summary ? row.summary.totalInputTokens + row.summary.totalOutputTokens : -1,
      render: (row) =>
        row.summary && (row.summary.totalInputTokens > 0 || row.summary.totalOutputTokens > 0) ? (
          <span className="flex items-center justify-end gap-1.5 tabular-nums text-fg-secondary">
            <span className="flex items-center gap-0.5">
              <ArrowUp size={10} className="text-fg-faint" />
              {formatTokenCount(row.summary.totalInputTokens)}
            </span>
            <span className="text-fg-disabled">/</span>
            <span className="flex items-center gap-0.5">
              <ArrowDown size={10} className="text-fg-faint" />
              {formatTokenCount(row.summary.totalOutputTokens)}
            </span>
          </span>
        ) : (
          <span className="text-fg-disabled">-</span>
        ),
    },
    {
      key: 'files' as SortKey,
      label: 'Files',
      align: 'right',
      width: 'w-[60px]',
      sortValue: (row) => row.summary?.filesChanged ?? -1,
      render: (row) =>
        row.summary && row.summary.filesChanged > 0 ? (
          <span className="tabular-nums text-fg-secondary">{row.summary.filesChanged}</span>
        ) : (
          <span className="text-fg-disabled">-</span>
        ),
    },
    {
      key: 'lines' as SortKey,
      label: 'Lines',
      align: 'right',
      width: 'w-[100px]',
      sortValue: (row) =>
        row.summary ? row.summary.linesAdded + row.summary.linesRemoved : -1,
      render: (row) =>
        row.summary && (row.summary.linesAdded > 0 || row.summary.linesRemoved > 0) ? (
          <span className="flex items-center justify-end gap-1.5 tabular-nums">
            <span className="text-green-400/70">+{row.summary.linesAdded}</span>
            <span className="text-red-400/70">-{row.summary.linesRemoved}</span>
          </span>
        ) : (
          <span className="text-fg-disabled">-</span>
        ),
    },
    {
      key: 'completed' as SortKey,
      label: 'Completed',
      align: 'right',
      width: 'w-[140px]',
      sortValue: (row) => row.task.archived_at ?? row.task.updated_at,
      render: (row) =>
        row.task.archived_at ? (
          <span className="text-fg-faint text-xs flex items-center justify-end whitespace-nowrap">
            <StaleTaskWarning archivedAt={row.task.archived_at} />
            {formatRelativeTime(row.task.archived_at)}
          </span>
        ) : (
          <span className="text-fg-disabled">-</span>
        ),
    },
    {
      key: 'actions' as SortKey,
      label: '',
      width: 'w-[120px]',
      render: (row) => (
        <RowActions
          taskId={row.task.id}
          swimlanes={swimlanes}
          restorePopoverId={restorePopoverId}
          onToggleRestore={toggleRestorePopover}
          onCloseRestore={closeRestorePopover}
          onRestore={handleRestore}
          onDelete={handleDelete}
          onViewDetail={handleViewDetail}
        />
      ),
    },
  ], [
    selectedIds,
    swimlanes,
    restorePopoverId,
    toggleSelect,
    toggleSelectAll,
    toggleRestorePopover,
    closeRestorePopover,
    handleRestore,
    handleDelete,
    handleViewDetail,
  ]);
}
