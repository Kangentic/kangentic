import React, { useState, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { GripVertical, Pencil, Plus } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { EditColumnDialog } from '../dialogs/EditColumnDialog';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { useConfigStore } from '../../stores/config-store';
import type { Swimlane as SwimlaneType, Task } from '../../../shared/types';

export interface SwimlaneProps {
  swimlane: SwimlaneType;
  tasks: Task[];
  /** Event listeners for the drag handle (only for sortable/custom columns) */
  dragHandleProps?: Record<string, unknown>;
  /** Whether this column is the current drop target during a drag */
  isDropTarget?: boolean;
}

export const Swimlane = React.memo(function Swimlane({ swimlane, tasks, dragHandleProps, isDropTarget }: SwimlaneProps) {
  const [showNewTask, setShowNewTask] = useState(false);
  const [showEditColumn, setShowEditColumn] = useState(false);
  const { setNodeRef } = useDroppable({
    id: swimlane.id,
    data: { type: 'swimlane' },
  });

  const hasCompletedFirstRun = useConfigStore((state) => state.config.hasCompletedFirstRun);

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const role = swimlane.role;
  const isGhost = swimlane.is_ghost;
  const showFirstRunHint = role === 'backlog' && tasks.length === 0 && !hasCompletedFirstRun;
  const isSystemColumn = role !== null;
  const isDraggable = !!dragHandleProps && !isGhost;

  return (
    <div
      data-testid="swimlane"
      data-swimlane-name={swimlane.name}
      className={`flex-shrink-0 w-72 h-full flex flex-col rounded-lg ${
        isGhost ? 'opacity-50 border-2 border-dashed border-fg-disabled' : ''
      } ${
        isDropTarget ? 'ring-2 ring-accent/40' : isSystemColumn ? 'ring-1 ring-edge/50' : ''
      } ${isSystemColumn ? 'bg-surface-raised/70' : 'bg-surface-raised/50'}`}
      title={isGhost ? 'Removed from team config. Move tasks to continue.' : undefined}
    >
      {/* Accent bar */}
      <div
        className="h-0.5 rounded-t-lg"
        style={{ backgroundColor: swimlane.color }}
      />

      {/* Column header */}
      <div
        className="px-3 py-2 flex items-center gap-2 border-b border-edge/50 w-full text-left hover:bg-surface-hover/30 transition-colors cursor-pointer"
        onClick={() => setShowEditColumn(true)}
      >
        {/* Drag handle for custom columns */}
        {isDraggable && (
          <div
            {...dragHandleProps}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="text-fg-disabled hover:text-fg-muted cursor-grab active:cursor-grabbing transition-colors -ml-1"
          >
            <GripVertical size={14} />
          </div>
        )}

        {/* Role icon or color dot */}
        {(() => {
          const Icon = getSwimlaneIcon(swimlane);
          return Icon ? (
            <span style={{ color: swimlane.color }}><Icon size={16} strokeWidth={1.75} /></span>
          ) : (
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: swimlane.color }}
            />
          );
        })()}

        {/* Column name */}
        <span className={`text-sm font-medium truncate flex-1 min-w-0 ${
          isSystemColumn ? 'text-fg' : 'text-fg-secondary'
        }`}>
          {swimlane.name}
        </span>

        <span className="bg-surface-hover/40 rounded-full px-1.5 text-xs text-fg-faint tabular-nums leading-5">{tasks.length}</span>

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

      {/* Task list */}
      <div
        ref={setNodeRef}
        className={`flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] transition-colors ${
          isDropTarget ? 'bg-surface-hover/30' : ''
        }`}
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </SortableContext>

        {showFirstRunHint && (
          <button
            onClick={() => setShowNewTask(true)}
            className="w-full p-4 rounded-lg border-2 border-dashed border-accent/40 hover:border-accent hover:bg-accent/5 transition-colors cursor-pointer text-left"
            data-testid="first-run-hint"
          >
            <div className="flex items-center gap-2 text-sm text-fg font-medium mb-1.5">
              <Plus size={16} className="text-accent" />
              <span>Create your first task</span>
            </div>
            <p className="text-xs text-fg-muted pl-6 leading-relaxed">
              Describe what you want an agent to do, then drag it to a column to start a session.
            </p>
          </button>
        )}
      </div>

      {/* Add task button (hidden for ghost columns) */}
      {!isGhost && (
        <div className="p-2 border-t border-edge/50">
          <button
            onClick={() => setShowNewTask(true)}
            className="w-full text-sm text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover/50 rounded px-2 py-1 transition-colors text-left"
          >
            + Add task
          </button>
        </div>
      )}
      {isGhost && (
        <div className="px-3 py-2 border-t border-edge/50">
          <span className="text-xs text-fg-disabled italic">
            Removed from team config
          </span>
        </div>
      )}

      {showNewTask && (
        <NewTaskDialog
          swimlaneId={swimlane.id}
          onClose={() => setShowNewTask(false)}
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
});
