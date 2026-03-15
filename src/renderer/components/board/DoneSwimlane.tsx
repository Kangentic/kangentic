import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Search, Pencil, ArrowDownToLine, Maximize2, ClipboardList } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { EditColumnDialog } from '../dialogs/EditColumnDialog';
import { CompletedTasksDialog } from '../dialogs/CompletedTasksDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { Pill } from '../Pill';
import type { Swimlane as SwimlaneType, Task, SessionSummary } from '../../../shared/types';

export interface DoneSwimlaneProps {
  swimlane: SwimlaneType;
  tasks: Task[];
  dragHandleProps?: Record<string, unknown>;
}

export function DoneSwimlane({ swimlane, tasks }: DoneSwimlaneProps) {
  const [search, setSearch] = useState('');
  const [showEditColumn, setShowEditColumn] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [showCompletedDialog, setShowCompletedDialog] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});

  const archivedTasks = useBoardStore((state) => state.archivedTasks);
  const deleteArchivedTask = useBoardStore((state) => state.deleteArchivedTask);
  const recentlyArchivedId = useBoardStore((state) => state.recentlyArchivedId);
  const clearRecentlyArchived = useBoardStore((state) => state.clearRecentlyArchived);
  const skipDeleteConfirm = useConfigStore((state) => state.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // Fetch batch summaries (always, not gated on expand)
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

  const handleDeleteRequest = useCallback((taskId: string) => {
    if (skipDeleteConfirm) {
      deleteArchivedTask(taskId);
    } else {
      setPendingDeleteId(taskId);
    }
  }, [skipDeleteConfirm, deleteArchivedTask]);

  const handleConfirmDelete = useCallback((dontAskAgain: boolean) => {
    if (pendingDeleteId) {
      deleteArchivedTask(pendingDeleteId);
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId, deleteArchivedTask, updateConfig]);

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const { setNodeRef, isOver } = useDroppable({
    id: swimlane.id,
    data: { type: 'swimlane' },
  });

  const filteredArchived = useMemo(() => {
    if (!search.trim()) return archivedTasks;
    const query = search.toLowerCase();
    return archivedTasks.filter(
      (task) => task.title.toLowerCase().includes(query) || task.description.toLowerCase().includes(query),
    );
  }, [archivedTasks, search]);

  return (
    <div
      data-testid="swimlane"
      data-swimlane-name={swimlane.name}
      className="flex-shrink-0 w-72 h-full flex flex-col rounded-lg bg-surface-raised/70 ring-1 ring-edge/50"
    >
      {/* Accent bar */}
      <div
        className="h-0.5 rounded-t-lg"
        style={{ backgroundColor: swimlane.color }}
      />

      {/* Column header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-edge/50 w-full text-left hover:bg-surface-hover/30 transition-colors">
        {(() => {
          const Icon = getSwimlaneIcon(swimlane);
          return Icon ? (
            <span style={{ color: swimlane.color }}><Icon size={14} strokeWidth={1.75} /></span>
          ) : (
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: swimlane.color }}
            />
          );
        })()}

        <button
          type="button"
          onClick={() => setShowEditColumn(true)}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <span className="text-sm font-medium truncate text-fg">
            {swimlane.name}
          </span>
        </button>

        <Pill size="sm" className="bg-surface-hover/40 text-fg-faint tabular-nums leading-5">{tasks.length}</Pill>

        <button
          type="button"
          data-testid="edit-column-btn"
          aria-label={`Edit ${swimlane.name} column`}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            setShowEditColumn(true);
          }}
          className="flex-shrink-0 p-0.5 text-fg-disabled hover:text-fg-muted transition-colors"
        >
          <Pencil size={12} />
        </button>
      </div>

      {/* Drop zone */}
      <div className="p-2 flex-shrink-0">
        <div
          ref={setNodeRef}
          data-done-drop-zone
          className={`rounded-lg p-4 text-center min-h-[180px] flex items-center justify-center ${
            isOver
              ? 'drop-zone-active'
              : 'border-2 border-dashed border-edge/50 text-fg-disabled'
          }`}
          style={isOver ? { '--drop-color': swimlane.color, color: swimlane.color } as React.CSSProperties : undefined}
        >
          <div className="relative z-10 w-full">
            <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
              {tasks.length > 0 ? (
                <div className="space-y-2 w-full">
                  {tasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <ArrowDownToLine size={20} className="opacity-50" />
                  <span className="text-xs">Drop here to complete</span>
                </div>
              )}
            </SortableContext>
          </div>
        </div>
      </div>

      {/* Completed tasks section -- always visible */}
      <div className="flex-1 min-h-0 flex flex-col gap-1 px-2 py-2 border-t border-edge/50">
        {/* Section header */}
        <button
          type="button"
          onClick={archivedTasks.length > 0 ? () => setShowCompletedDialog(true) : undefined}
          disabled={archivedTasks.length === 0}
          className={`py-2 px-2.5 flex-shrink-0 flex items-center justify-between rounded-md transition-colors w-full text-left border ${archivedTasks.length > 0 ? 'border-edge/30 bg-surface-hover/20 hover:bg-surface-hover/40 hover:border-edge/50 cursor-pointer group' : 'border-transparent'}`}
          data-testid="expand-completed-btn"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium text-fg-muted">
            <ClipboardList size={14} />
            Completed ({archivedTasks.length})
          </span>
          {archivedTasks.length > 0 && (
            <Maximize2 size={14} className="text-fg-disabled group-hover:text-fg-muted transition-colors" />
          )}
        </button>

        {/* Search row */}
        {archivedTasks.length > 0 && (
          <div className="flex-shrink-0">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg-tertiary placeholder-fg-disabled pl-8 pr-2 py-2 outline-none focus:border-edge-input"
              />
            </div>
          </div>
        )}

        {/* Archived task list -- scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
          {filteredArchived.map((task) => {
            const isGrowingIn = recentlyArchivedId === task.id;
            return isGrowingIn ? (
              <div
                key={task.id}
                className="grow-in"
                onAnimationEnd={clearRecentlyArchived}
              >
                <TaskCard task={task} compact onDelete={handleDeleteRequest} summary={summaries[task.id]} />
              </div>
            ) : (
              <TaskCard
                key={task.id}
                task={task}
                compact
                onDelete={handleDeleteRequest}
                summary={summaries[task.id]}
              />
            );
          })}
          {filteredArchived.length === 0 && search && (
            <div className="text-xs text-fg-disabled text-center py-2">No matches</div>
          )}
          {filteredArchived.length === 0 && !search && (
            <div className="text-xs text-fg-disabled text-center py-3">No completed tasks yet</div>
          )}
        </div>
      </div>

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

      {showEditColumn && (
        <EditColumnDialog
          swimlane={swimlane}
          onClose={() => setShowEditColumn(false)}
        />
      )}

      {showCompletedDialog && (
        <CompletedTasksDialog
          onClose={() => setShowCompletedDialog(false)}
          summaries={summaries}
        />
      )}
    </div>
  );
}
