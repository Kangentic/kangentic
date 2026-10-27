import { useState, useMemo, useEffect, useCallback } from 'react';
import { Search, ClipboardList, Loader2 } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { DataTable } from '../DataTable';
import { ArchivedTaskContextMenu } from '../board/ArchivedTaskContextMenu';
import { openCompletedTask } from './task-detail/open-completed-task';
import { formatCost } from '../../utils/format-session';
import { formatTokenCount } from '../../utils/format-tokens';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import type { Task, SessionSummary } from '../../../shared/types';
import { BulkToolbar } from './completed-tasks/BulkToolbar';
import { useCompletedColumns, type SortKey, type TaskRow } from './completed-tasks/useCompletedColumns';

interface CompletedTasksDialogProps {
  onClose: () => void;
}

export function CompletedTasksDialog({ onClose }: CompletedTasksDialogProps) {
  const { t } = useLingui();
  const archivedTasks = useBoardStore((state) => state.archivedTasks);
  const archivedTotalCount = useBoardStore((state) => state.archivedTotalCount);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const unarchiveTask = useBoardStore((state) => state.unarchiveTask);
  const deleteArchivedTask = useBoardStore((state) => state.deleteArchivedTask);
  const bulkDeleteArchivedTasks = useBoardStore((state) => state.bulkDeleteArchivedTasks);
  const bulkUnarchiveTasks = useBoardStore((state) => state.bulkUnarchiveTasks);
  const bulkDeleteProgress = useBoardStore((state) => state.bulkDeleteProgress);
  const skipDeleteConfirm = useConfigStore((state) => state.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);

  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});
  // "Still loading" is derived from the store's own loaded flag, with a failed
  // load for this project recorded so its spinner still stops; no effect sets
  // a loading flag, which the compiler rules forbid.
  const archivedFullyLoaded = useBoardStore((state) => state.archivedFullyLoaded);
  const [archiveLoadFailedFor, setArchiveLoadFailedFor] = useState<string | null>(null);
  const loadingFullArchive = !archivedFullyLoaded && archiveLoadFailedFor !== currentProjectId;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [restorePopoverId, setRestorePopoverId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; task: Task } | null>(null);

  // This dialog needs the FULL archive, not just the board's newest-N preview.
  // Refcount a viewer for the whole mount so board hydration keeps the full
  // list loaded (and reconciled) while the dialog is open.
  useEffect(() => {
    useBoardStore.getState().acquireArchiveView();
    return () => { useBoardStore.getState().releaseArchiveView(); };
  }, []);

  // Lazily fetch the full archive when it isn't loaded yet. Keyed on project id
  // so switching projects while the dialog is open reloads for the new project.
  // The preview rows render immediately; the full list replaces them in well
  // under a second.
  useEffect(() => {
    if (useBoardStore.getState().archivedFullyLoaded) return;
    let cancelled = false;
    useBoardStore.getState().loadArchivedTasks()
      // Keep the preview rows already on screen; just stop the spinner.
      .catch(() => { if (!cancelled) setArchiveLoadFailedFor(currentProjectId); });
    return () => { cancelled = true; };
  }, [currentProjectId]);

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

  // Open the archived task's detail as a managed window. The window renders
  // below this modal (z-40 < z-50), so close the list to reveal it; the user
  // reopens Completed Tasks to return to it.
  const handleViewDetail = useCallback((taskId: string) => {
    const task = archivedTasks.find((archivedTask) => archivedTask.id === taskId);
    if (!task) return;
    useSessionStore.getState().setDetailTaskId(taskId);
    onClose();
  }, [archivedTasks, onClose]);

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

  const emptyMessage = searchQuery ? t`No tasks match "${searchQuery}"` : t`No completed tasks yet`;
  const filteredCount = filteredRows.length;
  // A named local, so a translator reads {totalFilesChanged} and not {0}.
  const totalFilesChanged = aggregates.totalFilesChanged;
  const totalCostText = formatCost(aggregates.totalCost);
  const tokenCountText = formatTokenCount(aggregates.totalInputTokens + aggregates.totalOutputTokens);
  const selectedCount = selectedIds.size;
  const deleteCompleted = bulkDeleteProgress?.completed ?? 0;
  const deleteTotal = bulkDeleteProgress?.total ?? 0;
  const deleteFailureCount = bulkDeleteProgress?.failures.length ?? 0;

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
            <h3 className="text-base font-semibold text-fg flex items-center gap-2">
              <Trans>Completed Tasks ({archivedTotalCount})</Trans>
              {loadingFullArchive && (
                <Loader2 size={14} className="animate-spin text-fg-disabled" data-testid="archive-loading" />
              )}
            </h3>
            <div className="flex-1" />
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t`Search tasks...`}
                className="w-64 bg-surface/50 border border-edge/50 rounded-md text-sm text-fg placeholder-fg-muted pl-8 pr-3 py-1.5 outline-none focus:border-edge-input"
                data-testid="completed-tasks-search"
              />
            </div>
          </div>
        }
        footer={
          <div className="flex items-center gap-4 text-xs text-fg-muted tabular-nums bg-surface-inset/40 -mx-4 -my-3 px-4 py-3">
            <span>
              {filteredCount !== archivedTotalCount
                ? <Trans>{filteredCount} of <Plural value={archivedTotalCount} one="# task" other="# tasks" /></Trans>
                : <Plural value={filteredCount} one="# task" other="# tasks" />
              }
            </span>
            <span className="text-edge">|</span>
            <span><Trans>{totalCostText} total cost</Trans></span>
            <span className="text-edge">|</span>
            <span><Trans>{tokenCountText} tokens</Trans></span>
            <span className="text-edge">|</span>
            <span><Plural value={totalFilesChanged} one="# file changed" other="# files changed" /></span>
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
            onRowContextMenu={(row, event) => setContextMenu({
              position: { x: event.clientX, y: event.clientY },
              task: row.task,
            })}
            defaultSortKey="completed"
            defaultSortDirection="desc"
            emptyMessage={emptyMessage}
            rowTestId="completed-task-row"
            virtualized
          />
          {selectedIds.size > 0 && !bulkDeleteProgress && (
            <BulkToolbar
              selectedCount={selectedIds.size}
              swimlanes={swimlanes}
              onRestore={handleBulkRestore}
              onDelete={handleBulkDelete}
            />
          )}
          {bulkDeleteProgress && (
            <div
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-surface-raised border border-edge rounded-lg shadow-xl px-4 py-2.5 flex items-center gap-3 min-w-[280px]"
              data-testid="bulk-delete-progress"
              role="status"
              aria-live="polite"
            >
              <div className="w-4 h-4 border-2 border-edge border-t-accent rounded-full animate-spin" />
              <span className="text-sm text-fg-muted font-medium tabular-nums">
                <Trans>Deleting {deleteCompleted} of {deleteTotal}</Trans>
                {bulkDeleteProgress.failures.length > 0 && (
                  <span className="text-red-400 ml-2">
                    <Trans>({deleteFailureCount} failed)</Trans>
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      </BaseDialog>

      {contextMenu && (
        <ArchivedTaskContextMenu
          position={contextMenu.position}
          task={contextMenu.task}
          swimlanes={swimlanes}
          onOpen={() => handleViewDetail(contextMenu.task.id)}
          // The window opens on the board layer under this modal, so close the
          // list to reveal it, as Open does.
          onViewConversation={() => {
            openCompletedTask(contextMenu.task.id, 'conversation');
            onClose();
          }}
          onShowChanges={() => {
            openCompletedTask(contextMenu.task.id, 'changes');
            onClose();
          }}
          onRestoreTo={(targetSwimlaneId) => handleRestore(contextMenu.task.id, targetSwimlaneId)}
          onDelete={() => handleDelete(contextMenu.task.id)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pendingDeleteId && (
        <ConfirmDialog
          title={t`Delete completed task`}
          message={<>
            <p><Trans>This will permanently delete the task, its session history, and any associated worktree.</Trans></p>
            <p className="text-red-400 font-medium"><Trans>This action cannot be undone.</Trans></p>
          </>}
          confirmLabel={t`Delete`}
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {pendingBulkDelete && (
        <ConfirmDialog
          title={t`${plural(selectedCount, { one: 'Delete # completed task', other: 'Delete # completed tasks' })}`}
          message={<>
            <p>
              <Plural
                value={selectedCount}
                one="This will permanently delete # task, its session history, and any associated worktrees."
                other="This will permanently delete # tasks, their session history, and any associated worktrees."
              />
            </p>
            <p className="text-red-400 font-medium"><Trans>This action cannot be undone.</Trans></p>
          </>}
          confirmLabel={t`${plural(selectedCount, { one: 'Delete # task', other: 'Delete # tasks' })}`}
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      )}
    </>
  );
}
