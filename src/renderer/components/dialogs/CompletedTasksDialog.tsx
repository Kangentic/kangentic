import { useState, useMemo, useEffect, useCallback } from 'react';
import { Search, ClipboardList } from 'lucide-react';
import { BaseDialog } from './BaseDialog';
import { TaskDetailDialog } from './TaskDetailDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { DataTable } from '../DataTable';
import { formatCost } from '../../utils/format-session';
import { formatTokenCount } from '../../utils/format-tokens';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import type { Task, SessionSummary } from '../../../shared/types';
import { BulkToolbar } from './completed-tasks/BulkToolbar';
import { useCompletedColumns, type SortKey, type TaskRow } from './completed-tasks/useCompletedColumns';

interface CompletedTasksDialogProps {
  onClose: () => void;
}

export function CompletedTasksDialog({ onClose }: CompletedTasksDialogProps) {
  const archivedTasks = useBoardStore((state) => state.archivedTasks);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const unarchiveTask = useBoardStore((state) => state.unarchiveTask);
  const deleteArchivedTask = useBoardStore((state) => state.deleteArchivedTask);
  const bulkDeleteArchivedTasks = useBoardStore((state) => state.bulkDeleteArchivedTasks);
  const bulkUnarchiveTasks = useBoardStore((state) => state.bulkUnarchiveTasks);
  const skipDeleteConfirm = useConfigStore((state) => state.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [restorePopoverId, setRestorePopoverId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

  // Fetch summaries on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.sessions.listSummaries();
        if (!cancelled) setSummaries(result);
      } catch {
        // Ignore errors (e.g. in tests)
      }
    })();
    return () => { cancelled = true; };
  }, [archivedTasks.length]);

  // --- Selection helpers ---

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((filteredRows: TaskRow[]) => {
    setSelectedIds((previous) => {
      const filteredIds = filteredRows.map((row) => row.task.id);
      const allSelected = filteredIds.every((id) => previous.has(id));
      if (allSelected) {
        return new Set();
      }
      return new Set(filteredIds);
    });
  }, []);

  // --- Action handlers ---

  const handleRestore = useCallback(async (taskId: string, swimlaneId: string) => {
    setRestorePopoverId(null);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      next.delete(taskId);
      return next;
    });
    await unarchiveTask({ id: taskId, targetSwimlaneId: swimlaneId });
  }, [unarchiveTask]);

  const handleDelete = useCallback((taskId: string) => {
    if (skipDeleteConfirm) {
      deleteArchivedTask(taskId);
      setSelectedIds((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
    } else {
      setPendingDeleteId(taskId);
    }
  }, [skipDeleteConfirm, deleteArchivedTask]);

  const handleConfirmDelete = useCallback((dontAskAgain: boolean) => {
    if (pendingDeleteId) {
      deleteArchivedTask(pendingDeleteId);
      setSelectedIds((previous) => {
        const next = new Set(previous);
        next.delete(pendingDeleteId);
        return next;
      });
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId, deleteArchivedTask, updateConfig]);

  const handleBulkRestore = useCallback(async (swimlaneId: string) => {
    const archivedIdSet = new Set(archivedTasks.map((task) => task.id));
    const ids = [...selectedIds].filter((id) => archivedIdSet.has(id));
    if (ids.length === 0) return;
    setSelectedIds(new Set());
    await bulkUnarchiveTasks(ids, swimlaneId);
  }, [selectedIds, archivedTasks, bulkUnarchiveTasks]);

  const handleBulkDelete = useCallback(() => {
    if (skipDeleteConfirm) {
      const ids = [...selectedIds];
      setSelectedIds(new Set());
      bulkDeleteArchivedTasks(ids);
    } else {
      setPendingBulkDelete(true);
    }
  }, [selectedIds, skipDeleteConfirm, bulkDeleteArchivedTasks]);

  const handleConfirmBulkDelete = useCallback((dontAskAgain: boolean) => {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    bulkDeleteArchivedTasks(ids);
    if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    setPendingBulkDelete(false);
  }, [selectedIds, bulkDeleteArchivedTasks, updateConfig]);

  const toggleRestorePopover = useCallback((taskId: string) => {
    setRestorePopoverId((previous) => previous === taskId ? null : taskId);
  }, []);

  const closeRestorePopover = useCallback(() => {
    setRestorePopoverId(null);
  }, []);

  const handleViewDetail = useCallback((taskId: string) => {
    const task = archivedTasks.find((archivedTask) => archivedTask.id === taskId);
    if (task) setSelectedTask(task);
  }, [archivedTasks]);

  // --- Columns ---

  const columns = useCompletedColumns({
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
  });

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
        <div className="relative flex-1 min-h-0 flex flex-col">
          <DataTable<TaskRow, SortKey>
            columns={columns}
            data={filteredRows}
            rowKey={(row) => row.task.id}
            onRowClick={(row) => toggleSelect(row.task.id)}
            defaultSortKey="completed"
            defaultSortDirection="desc"
            emptyMessage={emptyMessage}
            rowTestId="completed-task-row"
            virtualized
          />
          {selectedIds.size > 0 && (
            <BulkToolbar
              selectedCount={selectedIds.size}
              swimlanes={swimlanes}
              onRestore={handleBulkRestore}
              onDelete={handleBulkDelete}
            />
          )}
        </div>
      </BaseDialog>

      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          initialEdit={false}
        />
      )}

      {pendingDeleteId && (
        <ConfirmDialog
          title="Delete completed task"
          message={<>
            <p>This will permanently delete the task, its session history, and any associated worktree.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {pendingBulkDelete && (
        <ConfirmDialog
          title={`Delete ${selectedIds.size} completed tasks`}
          message={<>
            <p>This will permanently delete {selectedIds.size} tasks, their session history, and any associated worktrees.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel={`Delete ${selectedIds.size} tasks`}
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      )}
    </>
  );
}
