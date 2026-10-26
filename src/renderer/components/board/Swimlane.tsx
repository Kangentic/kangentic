import React, { useState, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { GripVertical, Pencil, ClipboardPlus } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { SwimlaneIcon } from '../../utils/swimlane-icons';
import { useBoardStore } from '../../stores/board-store';
import { useColumnWidthClass } from './column-width';
import { CountBadge } from '../CountBadge';
import { AutomationGlyph } from './AutomationGlyph';
import { Tooltip } from '../Tooltip';
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

  // Keyed on the ids, not on `tasks`: an edit to one card hands this lane a new
  // array with the same ids, and a new `items` array changes the SortableContext
  // value, which re-renders every card in the lane past TaskCard's React.memo.
  const taskIdsKey = tasks.map((task) => task.id).join(',');
  const taskIds = useMemo(() => (taskIdsKey === '' ? [] : taskIdsKey.split(',')), [taskIdsKey]);

  const role = swimlane.role;
  const isGhost = swimlane.is_ghost;
  const isSystemColumn = role !== null;
  const isDraggable = !!dragHandleProps && !isGhost;

  // The drop highlight's color (`.drop-highlight` in index.css), set here for
  // good rather than by the drag. A custom property is inherited, so writing
  // it on the lane at drag time restyled every element in the lane: 2,948 of
  // them, 10ms inside the drag-start task, for a To Do lane of 90 workflow
  // cards (`scripts/drag-perf-rig.mjs`, W100). The drag now toggles only the
  // class, and the var reads the same value it always did.
  const dropColorStyle = useMemo(
    () => (swimlane.color ? ({ '--drop-color': swimlane.color } as React.CSSProperties) : undefined),
    [swimlane.color],
  );

  // The lane is `overflow-clip` so its 2px accent bar follows the rounded
  // corners: a 2px box clamps its own 8px radius to 2px, so unclipped the bar
  // ran square past the curve, under the drop highlight's rounded outline.
  // `clip`, not `hidden`: the lane stays no scroll container, and the
  // fixed-position New Task dialog inside it still escapes the clip.
  return (
    // A ghost column says why it is greyed out wherever the pointer rests on it.
    <Tooltip label={isGhost ? 'Removed from team config. Move tasks to continue.' : ''}>
      <div
        data-testid="swimlane"
        data-swimlane-name={swimlane.name}
        data-swimlane-id={swimlane.id}
        className={`flex-shrink-0 ${widthClass} h-full flex flex-col rounded-lg overflow-clip ${
          isGhost ? 'opacity-50 border-2 border-dashed border-fg-disabled' : ''
        } ${
          isSystemColumn ? 'ring-1 ring-edge/50' : ''
        } ${isSystemColumn ? 'bg-surface-raised/70' : 'bg-surface-raised/50'}`}
        style={dropColorStyle}
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
            slip past that check and let a click light-dismiss a window. The column's
            description, when it has one, is the strip's tip. */}
        <Tooltip label={swimlane.description ?? ''}>
          <div
            className="px-3 py-2 flex items-center gap-2 border-b border-edge/50 w-full text-left hover:bg-surface-hover/30 transition-colors cursor-pointer select-none"
            onClick={() => openBoardManager(swimlane.id)}
            data-no-dismiss
          >
            {/* Drag handle for custom columns */}
            {isDraggable && (
              // `dragHandleProps` carries dnd-kit's attributes too (tabindex, role,
              // aria-*), so this is the column's one focus stop and the shared
              // keyboard sensor lifts the column from here. It draws no text, so it
              // names itself. Tooltip chains its own pointer handlers after
              // dnd-kit's, so the press that starts a drag still reaches the sensor.
              <Tooltip label="Drag to reorder">
                {/* select-none-ok: the handle draws a grip icon and no text, and it
                    inherits the header's `select-none` anyway. */}
                <div
                  {...dragHandleProps}
                  onClick={(event: React.MouseEvent) => event.stopPropagation()}
                  aria-label={`Reorder ${swimlane.name} column`}
                  data-testid="column-drag-handle"
                  className="text-fg-disabled hover:text-fg-muted cursor-grab active:cursor-grabbing transition-colors -ml-1"
                >
                  <GripVertical size={14} />
                </div>
              </Tooltip>
            )}

            {/* Role icon or color dot */}
            <SwimlaneIcon swimlane={swimlane} size={16} dotClassName="w-2.5 h-2.5 rounded-full flex-shrink-0" />

            {/* Column name, then its task count right after it. The pair takes
                the free width, so the glyph and edit button stay on the right. */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className={`text-sm font-medium truncate min-w-0 ${
                isSystemColumn ? 'text-fg' : 'text-fg-secondary'
              }`}>
                {swimlane.name}
              </span>
              <CountBadge count={tasks.length} variant="tinted" size="pill" className="shrink-0 text-fg-muted" testId="swimlane-task-count" />
            </div>

            <AutomationGlyph swimlaneId={swimlane.id} />

            <button
              type="button"
              data-testid="edit-column-btn"
              aria-label={`Edit ${swimlane.name} column`}
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                openBoardManager(swimlane.id);
              }}
              className="flex-shrink-0 p-0.5 text-fg-disabled hover:text-fg-muted transition-colors"
            >
              <Pencil size={12} />
            </button>
          </div>
        </Tooltip>

        {/* Task list. `relative` so the slot card below is placed in, scrolls
            with and is clipped by the list. */}
        <div
          ref={setNodeRef}
          data-swimlane-task-list={swimlane.id}
          className="relative flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] transition-colors"
        >
          {/* The slot a card dragged in from another column will drop into,
              filled with a dimmed copy of that card (`.drop-slot`,
              board-drop-preview.ts). The drag places, fills and shows it straight
              on the DOM, so it renders with no style, no attribute and no
              children the drag writes: this lane re-renders on every change of
              the drag's target. Absolutely positioned and the FIRST child, so it
              takes no space and never becomes the `:last-child` that
              `space-y-2` leaves without a margin. */}
          <div data-drop-slot aria-hidden="true" className="drop-slot" />
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
    </Tooltip>
  );
});
