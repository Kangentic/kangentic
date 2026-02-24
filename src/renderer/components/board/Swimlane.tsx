import React, { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Lock, Pencil, GripVertical } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { EditColumnDialog } from '../dialogs/EditColumnDialog';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import type { Swimlane as SwimlaneType, Task } from '../../../shared/types';

export interface SwimlaneProps {
  swimlane: SwimlaneType;
  tasks: Task[];
  /** Event listeners for the drag handle (only for sortable/custom columns) */
  dragHandleProps?: Record<string, any>;
}

export function Swimlane({ swimlane, tasks, dragHandleProps }: SwimlaneProps) {
  const [showNewTask, setShowNewTask] = useState(false);
  const [showEditColumn, setShowEditColumn] = useState(false);
  const { setNodeRef, isOver } = useDroppable({
    id: swimlane.id,
    data: { type: 'swimlane' },
  });

  const role = swimlane.role;
  const isSystemColumn = role !== null;
  const isDraggable = !!dragHandleProps;

  return (
    <div
      data-testid="swimlane"
      data-swimlane-name={swimlane.name}
      className={`flex-shrink-0 w-72 h-full flex flex-col rounded-lg ${
        isSystemColumn ? 'bg-zinc-800/70 ring-1 ring-zinc-700/50' : 'bg-zinc-800/50'
      }`}
    >
      {/* Accent bar for system columns */}
      {isSystemColumn && (
        <div
          className="h-0.5 rounded-t-lg"
          style={{ backgroundColor: swimlane.color }}
        />
      )}

      {/* Column header */}
      <div
        className={`px-3 py-2 flex items-center gap-2 border-b border-zinc-700/50 w-full text-left hover:bg-zinc-700/30 transition-colors group ${
          isSystemColumn ? '' : 'rounded-t-lg'
        }`}
      >
        {/* Drag handle for custom columns */}
        {isDraggable && (
          <div
            {...dragHandleProps}
            className="text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing transition-colors -ml-1"
          >
            <GripVertical size={14} />
          </div>
        )}

        {/* Role icon or color dot */}
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

        {/* Clickable name area opens edit dialog */}
        <button
          type="button"
          onClick={() => setShowEditColumn(true)}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <span className={`text-sm font-medium truncate ${
            isSystemColumn ? 'text-zinc-100' : 'text-zinc-200'
          }`}>
            {swimlane.name}
          </span>
        </button>

        <span className="text-xs text-zinc-500 tabular-nums">{tasks.length}</span>

        {role === 'backlog' ? (
          <Lock size={12} className="flex-shrink-0 opacity-40" />
        ) : (
          <button
            type="button"
            onClick={() => setShowEditColumn(true)}
            className="flex-shrink-0"
          >
            <Pencil size={12} className="text-zinc-600 group-hover:text-zinc-400 transition-colors" />
          </button>
        )}
      </div>

      {/* Task list */}
      <div
        ref={setNodeRef}
        className={`flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] transition-colors ${
          isOver ? 'bg-zinc-700/30' : ''
        }`}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </SortableContext>
      </div>

      {/* Add task button */}
      <div className="p-2 border-t border-zinc-700/50">
        <button
          onClick={() => setShowNewTask(true)}
          className="w-full text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 rounded px-2 py-1 transition-colors text-left"
        >
          + Add task
        </button>
      </div>

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
}
