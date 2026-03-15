import React, { useState, useMemo } from 'react';
import { Search, ArrowUp, ArrowDown, ClipboardList } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { BaseDialog } from './BaseDialog';
import { TaskDetailDialog } from './TaskDetailDialog';
import { DataTable } from '../DataTable';
import type { DataTableColumn } from '../DataTable';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatTokenCount } from '../../utils/format-tokens';
import { useBoardStore } from '../../stores/board-store';
import type { Task, SessionSummary } from '../../../shared/types';

type SortKey = 'title' | 'cost' | 'duration' | 'tokens' | 'files' | 'lines' | 'completed';

interface CompletedTasksDialogProps {
  onClose: () => void;
  summaries: Record<string, SessionSummary>;
}

interface TaskRow {
  task: Task;
  summary: SessionSummary | undefined;
}

function buildColumns(): DataTableColumn<TaskRow, SortKey>[] {
  return [
    {
      key: 'title',
      label: 'Title',
      width: 'min-w-[280px]',
      sortValue: (row) => row.task.title.toLowerCase(),
      render: (row) => (
        <div>
          <div className="text-fg font-medium truncate max-w-[400px]">{row.task.title}</div>
          {row.task.description && (
            <div className="text-xs text-fg-faint truncate max-w-[400px] mt-0.5">{row.task.description}</div>
          )}
        </div>
      ),
    },
    {
      key: 'cost',
      label: 'Cost',
      align: 'right',
      width: 'w-[80px]',
      sortValue: (row) => row.summary?.totalCostUsd ?? -1,
      render: (row) =>
        row.summary && row.summary.totalCostUsd > 0 ? (
          <span className="tabular-nums text-fg-secondary">{formatCost(row.summary.totalCostUsd)}</span>
        ) : (
          <span className="text-fg-disabled">&mdash;</span>
        ),
    },
    {
      key: 'duration',
      label: 'Duration',
      align: 'right',
      width: 'w-[90px]',
      sortValue: (row) => row.summary?.durationMs ?? -1,
      render: (row) =>
        row.summary && row.summary.durationMs > 0 ? (
          <span className="tabular-nums text-fg-secondary">{formatDuration(row.summary.durationMs)}</span>
        ) : (
          <span className="text-fg-disabled">&mdash;</span>
        ),
    },
    {
      key: 'tokens',
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
          <span className="text-fg-disabled">&mdash;</span>
        ),
    },
    {
      key: 'files',
      label: 'Files',
      align: 'right',
      width: 'w-[60px]',
      sortValue: (row) => row.summary?.filesChanged ?? -1,
      render: (row) =>
        row.summary && row.summary.filesChanged > 0 ? (
          <span className="tabular-nums text-fg-secondary">{row.summary.filesChanged}</span>
        ) : (
          <span className="text-fg-disabled">&mdash;</span>
        ),
    },
    {
      key: 'lines',
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
          <span className="text-fg-disabled">&mdash;</span>
        ),
    },
    {
      key: 'completed',
      label: 'Completed',
      align: 'right',
      width: 'w-[120px]',
      sortValue: (row) => row.task.archived_at ?? row.task.updated_at,
      render: (row) =>
        row.task.archived_at ? (
          <span className="text-fg-faint text-xs">
            {formatDistanceToNow(new Date(row.task.archived_at), { addSuffix: true })}
          </span>
        ) : (
          <span className="text-fg-disabled">&mdash;</span>
        ),
    },
  ];
}

export function CompletedTasksDialog({ onClose, summaries }: CompletedTasksDialogProps) {
  const archivedTasks = useBoardStore((state) => state.archivedTasks);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const columns = useMemo(() => buildColumns(), []);

  const filteredRows: TaskRow[] = useMemo(() => {
    let filtered = archivedTasks;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (task) => task.title.toLowerCase().includes(query) || task.description.toLowerCase().includes(query),
      );
    }
    return filtered.map((task) => ({ task, summary: summaries[task.id] }));
  }, [archivedTasks, searchQuery, summaries]);

  // Aggregate stats
  const aggregates = useMemo(() => {
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalFilesChanged = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    for (const { summary } of filteredRows) {
      if (summary) {
        totalCost += summary.totalCostUsd;
        totalInputTokens += summary.totalInputTokens;
        totalOutputTokens += summary.totalOutputTokens;
        totalFilesChanged += summary.filesChanged;
        totalLinesAdded += summary.linesAdded;
        totalLinesRemoved += summary.linesRemoved;
      }
    }
    return { totalCost, totalInputTokens, totalOutputTokens, totalFilesChanged, totalLinesAdded, totalLinesRemoved };
  }, [filteredRows]);

  const emptyMessage = searchQuery ? `No tasks match "${searchQuery}"` : 'No completed tasks yet';

  return (
    <>
      <BaseDialog
        onClose={onClose}
        className="w-[90vw] max-w-[1400px] h-[85vh]"
        rawBody
        testId="completed-tasks-dialog"
        header={
          <div className="flex items-center gap-3 px-4 py-3">
            <ClipboardList size={18} className="text-fg-muted" />
            <h3 className="text-base font-semibold text-fg flex-1">
              Completed Tasks ({archivedTasks.length})
            </h3>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search tasks..."
                className="w-64 bg-surface/50 border border-edge/50 rounded-md text-sm text-fg placeholder-fg-disabled pl-8 pr-3 py-1.5 outline-none focus:border-edge-input"
                data-testid="completed-tasks-search"
              />
            </div>
          </div>
        }
        footer={
          <div className="flex items-center gap-4 text-xs text-fg-muted tabular-nums bg-surface-inset/40 -mx-4 -my-3 px-4 py-3">
            <span>
              {searchQuery.trim() && filteredRows.length !== archivedTasks.length
                ? `${filteredRows.length} of ${archivedTasks.length} tasks`
                : `${filteredRows.length} tasks`
              }
            </span>
            <span className="text-edge">|</span>
            <span>{formatCost(aggregates.totalCost)} total cost</span>
            <span className="text-edge">|</span>
            <span>{formatTokenCount(aggregates.totalInputTokens + aggregates.totalOutputTokens)} tokens</span>
            <span className="text-edge">|</span>
            <span>{aggregates.totalFilesChanged} files changed</span>
            <span className="text-edge">|</span>
            <span>
              <span className="text-green-400/70">+{aggregates.totalLinesAdded}</span>
              {' '}
              <span className="text-red-400/70">-{aggregates.totalLinesRemoved}</span>
            </span>
          </div>
        }
      >
        <DataTable<TaskRow, SortKey>
          columns={columns}
          data={filteredRows}
          rowKey={(row) => row.task.id}
          onRowClick={(row) => setSelectedTask(row.task)}
          defaultSortKey="completed"
          defaultSortDirection="desc"
          emptyMessage={emptyMessage}
          rowTestId="completed-task-row"
        />
      </BaseDialog>

      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          initialEdit={false}
        />
      )}
    </>
  );
}
