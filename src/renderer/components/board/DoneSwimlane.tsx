import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight, Search, Pencil, ArrowDownToLine } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { EditColumnDialog } from '../dialogs/EditColumnDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import type { Swimlane as SwimlaneType, Task } from '../../../shared/types';

export interface DoneSwimlaneProps {
  swimlane: SwimlaneType;
  tasks: Task[];
  dragHandleProps?: Record<string, any>;
}

export function DoneSwimlane({ swimlane, tasks }: DoneSwimlaneProps) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [showEditColumn, setShowEditColumn] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const archivedTasks = useBoardStore((s) => s.archivedTasks);
  const deleteArchivedTask = useBoardStore((s) => s.deleteArchivedTask);
  const recentlyArchivedId = useBoardStore((s) => s.recentlyArchivedId);
  const clearRecentlyArchived = useBoardStore((s) => s.clearRecentlyArchived);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  // Auto-expand completed section when a task is archived
  useEffect(() => {
    if (recentlyArchivedId) {
      setExpanded(true);
    }
  }, [recentlyArchivedId]);

  const handleDeleteRequest = useCallback((taskId: string) => {
    if (skipDeleteConfirm) {
      deleteArchivedTask(taskId);
    } else {
      setPendingDeleteId(taskId);
      setDontAskAgain(false);
    }
  }, [skipDeleteConfirm, deleteArchivedTask]);

  const handleConfirmDelete = useCallback(() => {
    if (pendingDeleteId) {
      deleteArchivedTask(pendingDeleteId);
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId, dontAskAgain, deleteArchivedTask, updateConfig]);

  const { setNodeRef, isOver } = useDroppable({
    id: swimlane.id,
    data: { type: 'swimlane' },
  });

  const filteredArchived = useMemo(() => {
    if (!search.trim()) return archivedTasks;
    const q = search.toLowerCase();
    return archivedTasks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [archivedTasks, search]);

  return (
    <div
      data-testid="swimlane"
      data-swimlane-name={swimlane.name}
      className="flex-shrink-0 w-72 h-full flex flex-col rounded-lg bg-zinc-800/70 ring-1 ring-zinc-700/50"
    >
      {/* Accent bar */}
      <div
        className="h-0.5 rounded-t-lg"
        style={{ backgroundColor: swimlane.color }}
      />

      {/* Column header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-zinc-700/50 w-full text-left hover:bg-zinc-700/30 transition-colors group">
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
          <span className="text-sm font-medium truncate text-zinc-100">
            {swimlane.name}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setShowEditColumn(true)}
          className="flex-shrink-0"
        >
          <Pencil size={12} className="text-zinc-600 group-hover:text-zinc-400 transition-colors" />
        </button>
      </div>

      {/* Drop zone — droppable ref on the visual box */}
      <div className="p-2 flex-shrink-0">
        <div
          ref={setNodeRef}
          data-done-drop-zone
          className={`rounded-lg p-4 text-center min-h-[180px] flex items-center justify-center ${
            isOver
              ? 'drop-zone-active'
              : 'border-2 border-dashed border-zinc-700/50 text-zinc-600'
          }`}
          style={isOver ? { '--drop-color': swimlane.color, color: swimlane.color } as React.CSSProperties : undefined}
        >
          <div className="relative z-10 w-full">
            <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
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

      {/* Collapsible archive section — always visible */}
      <div className="flex-1 min-h-0 flex flex-col px-2 pb-2 border-t border-zinc-700/50 pt-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-700/20 hover:bg-zinc-700/40 rounded-md transition-colors w-full px-2 py-2 flex-shrink-0"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Completed ({archivedTasks.length})</span>
        </button>

        {expanded && (
          <div className="flex-1 min-h-0 flex flex-col mt-1.5 space-y-1.5">
            {archivedTasks.length > 0 && (
              /* Search */
              <div className="relative flex-shrink-0">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search..."
                  className="w-full bg-zinc-900/50 border border-zinc-700/50 rounded text-xs text-zinc-300 placeholder-zinc-600 pl-7 pr-2 py-1.5 outline-none focus:border-zinc-600"
                />
              </div>
            )}

            {/* Archived task list — scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
              {filteredArchived.map((task) => {
                const isGrowingIn = recentlyArchivedId === task.id;
                return isGrowingIn ? (
                  <div
                    key={task.id}
                    className="grow-in"
                    onAnimationEnd={clearRecentlyArchived}
                  >
                    <TaskCard task={task} compact onDelete={handleDeleteRequest} />
                  </div>
                ) : (
                  <TaskCard
                    key={task.id}
                    task={task}
                    compact
                    onDelete={handleDeleteRequest}
                  />
                );
              })}
              {filteredArchived.length === 0 && search && (
                <div className="text-xs text-zinc-600 text-center py-2">No matches</div>
              )}
              {filteredArchived.length === 0 && !search && (
                <div className="text-xs text-zinc-600 text-center py-2">No completed tasks yet</div>
              )}
            </div>
          </div>
        )}
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
          footerLeft={
            <label className="inline-flex items-center gap-2 cursor-pointer h-full">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
                className="rounded border-zinc-600 bg-zinc-900 accent-blue-500"
              />
              <span className="text-xs text-zinc-400">Don't ask again</span>
            </label>
          }
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
    </div>
  );
}
