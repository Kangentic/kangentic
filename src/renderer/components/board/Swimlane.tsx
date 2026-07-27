import React, { useState, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { GripVertical, Pencil, ClipboardPlus } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { useBoardStore } from '../../stores/board-store';
import { useColumnWidthClass } from './column-width';
import { CountBadge } from '../CountBadge';
import type { Swimlane as SwimlaneType, Task } from '../../../shared/types';

export interface SwimlaneProps {
  swimlane: SwimlaneType;
  tasks: Task[];
  /** Event listeners for the drag handle (only for sortable/custom columns) */
  dragHandleProps?: Record<string, unknown>;
}

export const Swimlane = React.memo(function Swimlane({ swimlane, tasks, dragHandleProps }: SwimlaneProps) {
  const [showNewTask, setShowNewTask] = useState(false);
  const openBoardManager = useBoardStore((state) => state.openBoardManager);
  const { setNodeRef } = useDroppable({
    id: swimlane.id,
    data: { type: 'swimlane' },
  });

  const widthClass = useColumnWidthClass();

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const role = swimlane.role;
  const isGhost = swimlane.is_ghost;
  const isSystemColumn = role !== null;
  const isDraggable = !!dragHandleProps && !isGhost;

  return (
    <div
      data-testid="swimlane"
      data-swimlane-name={swimlane.name}
      data-swimlane-id={swimlane.id}
      className={`flex-shrink-0 ${widthClass} h-full flex flex-col rounded-lg ${
        isGhost ? 'opacity-50 border-2 border-dashed border-fg-disabled' : ''
      } ${
        isSystemColumn ? 'ring-1 ring-edge/50' : ''
      } ${isSystemColumn ? 'bg-surface-raised/70' : 'bg-surface-raised/50'}`}
      title={isGhost ? 'Removed from team config. Move tasks to continue.' : undefined}
    >
      {/* Accent bar */}
      <div
        className="h-0.5 rounded-t-lg"
        style={{ backgroundColor: swimlane.color }}
      />

      {/* Column header. `data-no-dismiss`: the whole strip opens the board manager
          on click, so it is an action, not dead board space. The header itself has
          `cursor-pointer` (already excluded by the cursor check), but the marker is
          load-bearing for its drag-handle child, whose `cursor-grab` would otherwise
          slip past that check and let a click light-dismiss a window. */}
      <div
        className="px-3 py-2 flex items-center gap-2 border-b border-edge/50 w-full text-left hover:bg-surface-hover/30 transition-colors cursor-pointer"
        onClick={() => openBoardManager(swimlane.id)}
        title={swimlane.description ?? undefined}
        data-no-dismiss
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

        <CountBadge count={tasks.length} />

        <button
          type="button"
          data-testid="edit-column-btn"
          aria-label={`Edit ${swimlane.name} column`}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            openBoardManager(swimlane.id);
          }}
          className="flex-shrink-0 p-0.5 text-fg-disabled hover:text-fg-muted transition-colors"
        >
          <Pencil size={12} />
        </button>
      </div>

      {/* Task list */}
      <div
        ref={setNodeRef}
        data-swimlane-task-list={swimlane.id}
        className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] transition-colors"
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </SortableContext>
      </div>

      {/* Add task button (To Do only, hidden for ghost columns) */}
      {!isGhost && swimlane.role === 'todo' && (
        <button
          type="button"
          onClick={() => setShowNewTask(true)}
          className="flex items-center gap-1.5 px-3 py-2.5 border-t border-dashed border-edge/40 text-sm text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover/30 transition-colors w-full text-left cursor-pointer"
          data-testid="swimlane-add-task"
        >
          <ClipboardPlus size={16} />
          Add task
        </button>
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
    </div>
  );
});
