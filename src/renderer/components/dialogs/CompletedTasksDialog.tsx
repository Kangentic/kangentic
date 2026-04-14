import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Search, ArrowUp, ArrowDown, ClipboardList, RotateCcw, Trash2, Eye } from 'lucide-react';
import { formatRelativeTime } from '../../lib/datetime';
import { BaseDialog } from './BaseDialog';
import { TaskDetailDialog } from './TaskDetailDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { DataTable } from '../DataTable';
import type { DataTableColumn } from '../DataTable';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatTokenCount } from '../../utils/format-tokens';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import type { Task, Swimlane, SessionSummary } from '../../../shared/types';

type SortKey = 'select' | 'title' | 'cost' | 'duration' | 'tokens' | 'files' | 'lines' | 'completed' | 'actions';

interface CompletedTasksDialogProps {
  onClose: () => void;
}

interface TaskRow {
  task: Task;
  summary: SessionSummary | undefined;
}

// --- Staleness indicator ---

type StalenessLevel = 'fresh' | 'aging' | 'stale';

function getStalenessLevel(archivedAt: string): StalenessLevel {
  const hoursAgo = (Date.now() - new Date(archivedAt).getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 24) return 'fresh';
  if (hoursAgo < 24 * 7) return 'aging';
  return 'stale';
}

function StalenessIndicator({ archivedAt }: { archivedAt: string }) {
  const level = getStalenessLevel(archivedAt);
  if (level === 'fresh') return null;
  const color = level === 'aging' ? 'bg-yellow-400/70' : 'bg-fg-disabled';
  const tooltip = level === 'aging' ? 'Session may need to be re-created' : 'Session may be expired';
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${color} mr-1.5 flex-shrink-0`}
      title={tooltip}
    />
  );
}

// --- Restore popover ---

function RestorePopover({
  triggerRef,
  swimlanes,
  onSelect,
  onClose,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  swimlanes: Swimlane[];
  onSelect: (swimlaneId: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, { mode: 'dropdown' });

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [onClose, triggerRef]);

  // Close on Escape (without closing the parent dialog)
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  const targets = swimlanes.filter((lane) => lane.role !== 'done' && !lane.is_archived && !lane.is_ghost);

  return (
    <div
      ref={popoverRef}
      style={popoverStyle}
      className="absolute z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[160px]"
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        Restore to
      </div>
      {targets.map((lane) => (
        <button
          key={lane.id}
          type="button"
          onClick={() => onSelect(lane.id)}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        >
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: lane.color }}
          />
          {lane.name}
        </button>
      ))}
    </div>
  );
}

// --- Bulk toolbar ---

function BulkToolbar({
  selectedCount,
  swimlanes,
  onRestore,
  onDelete,
}: {
  selectedCount: number;
  swimlanes: Swimlane[];
  onRestore: (swimlaneId: string) => void;
  onDelete: () => void;
}) {
  const [showRestorePicker, setShowRestorePicker] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={toolbarRef} className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-surface-raised border border-edge rounded-lg shadow-xl px-4 py-2.5 flex items-center gap-4">
      <span className="text-sm text-fg-muted font-medium tabular-nums">
        {selectedCount} selected
      </span>
      <div className="w-px h-5 bg-edge" />
      <button
        type="button"
        onClick={() => setShowRestorePicker(!showRestorePicker)}
        className="flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-restore-btn"
      >
        <RotateCcw size={14} />
        Restore
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-delete-btn"
      >
        <Trash2 size={14} />
        Delete
      </button>
      {showRestorePicker && (
        <RestorePopover
          triggerRef={toolbarRef}
          swimlanes={swimlanes}
          onSelect={(swimlaneId) => {
            setShowRestorePicker(false);
            onRestore(swimlaneId);
          }}
          onClose={() => setShowRestorePicker(false)}
        />
      )}
    </div>
  );
}

// --- Per-row actions cell (needs its own ref for the popover trigger) ---

function RowActions({
  taskId,
  swimlanes,
  restorePopoverId,
  onToggleRestore,
  onCloseRestore,
  onRestore,
  onDelete,
  onViewDetail,
}: {
  taskId: string;
  swimlanes: Swimlane[];
  restorePopoverId: string | null;
  onToggleRestore: (taskId: string) => void;
  onCloseRestore: () => void;
  onRestore: (taskId: string, swimlaneId: string) => void;
  onDelete: (taskId: string) => void;
  onViewDetail: (taskId: string) => void;
}) {
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = restorePopoverId === taskId;

  return (
    <div className="flex items-center justify-end gap-1.5 relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => onViewDetail(taskId)}
        className="p-2 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
        title="View details"
        data-testid="view-task-btn"
      >
        <Eye size={16} />
      </button>
      <div className="relative">
        <button
          ref={restoreButtonRef}
          type="button"
          onClick={() => onToggleRestore(taskId)}
          className="p-2 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
          title="Restore to board"
          data-testid="restore-task-btn"
        >
          <RotateCcw size={16} />
        </button>
        {isOpen && (
          <RestorePopover
            triggerRef={restoreButtonRef}
            swimlanes={swimlanes}
            onSelect={(swimlaneId) => onRestore(taskId, swimlaneId)}
            onClose={onCloseRestore}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => onDelete(taskId)}
        className="p-2 text-fg-disabled hover:text-red-400 hover:bg-surface-hover/40 rounded transition-colors"
        title="Delete task"
        data-testid="delete-task-btn"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
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

  const columns: DataTableColumn<TaskRow, SortKey>[] = useMemo(() => [
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
            <StalenessIndicator archivedAt={row.task.archived_at} />
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
  ], [selectedIds, toggleSelect, toggleSelectAll, restorePopoverId, swimlanes, toggleRestorePopover, closeRestorePopover, handleRestore, handleDelete, handleViewDetail]);

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
