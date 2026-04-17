import React, { useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { AlertTriangle, Filter, X } from 'lucide-react';
import { Swimlane, type SwimlaneProps } from './Swimlane';
import { DoneSwimlane } from './DoneSwimlane';
import { TaskCard } from './TaskCard';
import { BoardSearchBar } from './BoardSearchBar';
import { BoardDialogs } from './BoardDialogs';
import { WelcomeOverlay } from './WelcomeOverlay';
import { FilterPopover } from '../FilterPopover';
import { CountBadge } from '../CountBadge';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardDragDrop } from '../../hooks/useBoardDragDrop';
import { useBoardSearch } from '../../hooks/useBoardSearch';
import { useFilterPopover } from '../../hooks/useFilterPopover';
import type { Task } from '../../../shared/types';

/** Wrapper that registers a column with @dnd-kit/sortable.
 *  All columns participate so dnd-kit knows their positions,
 *  but only custom columns (role === null) get a drag handle. */
const SortableSwimlane = React.memo(function SortableSwimlane({ swimlane, tasks }: SwimlaneProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `column:${swimlane.id}`,
    data: { type: 'column' },
  });

  const isDraggable = swimlane.role !== 'todo';

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition || undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  if (swimlane.role === 'done') {
    return (
      <div ref={setNodeRef} style={style} {...attributes} className="h-full outline-none">
        <DoneSwimlane
          swimlane={swimlane}
          tasks={tasks}
          dragHandleProps={isDraggable ? listeners : undefined}
        />
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="h-full outline-none">
      <Swimlane
        swimlane={swimlane}
        tasks={tasks}
        dragHandleProps={isDraggable ? listeners : undefined}
      />
    </div>
  );
});

/** Fixed-position card that flies from the drop position into the Done drop zone.
 *  Fallback timer guarantees finalizeCompletion() fires even when
 *  onTransitionEnd never does (drop zone not in DOM, propertyName mismatch,
 *  element scrolled offscreen). Without this, a missed transitionend leaves
 *  completingTask set forever and the card stuck on screen. */
function FlyingCard() {
  const completingTask = useBoardStore((s) => s.completingTask);
  const finalizeCompletion = useBoardStore((s) => s.finalizeCompletion);
  const [flying, setFlying] = React.useState(false);
  const fallbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFallback = React.useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (!completingTask) {
      clearFallback();
      return;
    }

    setFlying(false);
    const hasTarget = document.querySelector('[data-done-drop-zone]') !== null;

    // Trigger transition on next frame so browser paints at start position first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setFlying(true);
        // When the drop zone isn't in the DOM, no transition will run and
        // onTransitionEnd will never fire. Finalize immediately so the move
        // still persists and the card unmounts. Otherwise arm a 700ms
        // fallback (500ms transition + 200ms safety margin).
        if (!hasTarget) {
          finalizeCompletion();
        } else {
          fallbackTimerRef.current = setTimeout(() => {
            fallbackTimerRef.current = null;
            finalizeCompletion();
          }, 700);
        }
      });
    });

    return clearFallback;
  }, [completingTask, finalizeCompletion, clearFallback]);

  if (!completingTask) return null;

  const { task, startRect } = completingTask;
  const dropZone = document.querySelector('[data-done-drop-zone]');
  const targetRect = dropZone?.getBoundingClientRect();

  const style: React.CSSProperties = flying && targetRect ? {
    position: 'fixed',
    left: targetRect.left + targetRect.width / 2 - startRect.width / 2,
    top: targetRect.top + targetRect.height / 2 - 20,
    width: startRect.width,
    transform: 'scale(0.01)',
    opacity: 0,
    transition: 'all 500ms ease-in',
    zIndex: 9999,
    pointerEvents: 'none',
  } : {
    position: 'fixed',
    left: startRect.left,
    top: startRect.top,
    width: startRect.width,
    opacity: 0.85,
    zIndex: 9999,
    pointerEvents: 'none',
  };

  return (
    <div
      style={style}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'transform') {
          clearFallback();
          finalizeCompletion();
        }
      }}
    >
      <TaskCard task={task} isDragOverlay />
    </div>
  );
}

/** Warning banner shown when kangentic.json has validation errors. */
function ConfigWarningBanner() {
  const configWarnings = useBoardStore((s) => s.configWarnings);
  const dismissConfigWarnings = useBoardStore((s) => s.dismissConfigWarnings);

  if (configWarnings.length === 0) return null;

  return (
    <div className="mx-4 mt-4 mb-0 flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-sm text-amber-400">
      <AlertTriangle size={16} className="flex-shrink-0" />
      <span className="flex-1">{configWarnings[0]}</span>
      <button
        type="button"
        onClick={dismissConfigWarnings}
        className="flex-shrink-0 p-0.5 hover:text-amber-300 transition-colors"
        aria-label="Dismiss warning"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** Module-level empty array constant to avoid new-reference memo defeats. */
const EMPTY_TASKS: Task[] = [];

export function KanbanBoard() {
  const hydrated = useBoardStore((s) => s.hydrated);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const tasks = useBoardStore((s) => s.tasks);
  const archivedTasks = useBoardStore((s) => s.archivedTasks);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const showBoardSearch = useConfigStore((s) => s.config.showBoardSearch);
  const priorities = useConfigStore((s) => s.config.backlog.priorities);
  const labelColors = useConfigStore((s) => s.config.backlog.labelColors);
  const searchQuery = useBoardStore((s) => s.searchQuery);

  // Filter state
  const {
    priorityFilters, labelFilters, hasActiveFilters,
    showFilterPopover, setShowFilterPopover,
    togglePriorityFilter, toggleLabelFilter, clearAllFilters,
    filterButtonRef, filterPopoverRef,
  } = useFilterPopover();

  const allLabels = useMemo(() => {
    const labelSet = new Set<string>();
    for (const task of tasks) {
      for (const label of (task.labels ?? [])) labelSet.add(label);
    }
    return [...labelSet].sort();
  }, [tasks]);

  const {
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeTask,
    sortableColumnIds,
  } = useBoardDragDrop({ swimlanes, tasks, archivedTasks });

  useBoardSearch(showBoardSearch, updateConfig);

  const tasksPerLane = useMemo(() => {
    const normalizedQuery = searchQuery ? searchQuery.toLowerCase() : '';
    const map = new Map<string, Task[]>();
    for (const lane of swimlanes) map.set(lane.id, []);
    for (const task of tasks) {
      if (normalizedQuery && !task.title.toLowerCase().includes(normalizedQuery) && !task.description.toLowerCase().includes(normalizedQuery)) continue;
      if (priorityFilters.size > 0 && !priorityFilters.has(task.priority)) continue;
      if (labelFilters.size > 0 && !(task.labels ?? []).some((label) => labelFilters.has(label))) continue;
      const arr = map.get(task.swimlane_id);
      if (arr) arr.push(task);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [swimlanes, tasks, searchQuery, priorityFilters, labelFilters]);

  /** Total visible task count (matching search + filters) for the search bar. */
  const searchMatchCount = useMemo(() => {
    if (!searchQuery && !hasActiveFilters) return tasks.length;
    let count = 0;
    for (const arr of tasksPerLane.values()) count += arr.length;
    return count;
  }, [searchQuery, hasActiveFilters, tasks.length, tasksPerLane]);

  const filterButtonElement = (
    <div className="relative">
      <button
        ref={filterButtonRef}
        type="button"
        onClick={() => setShowFilterPopover(!showFilterPopover)}
        className={`flex items-center gap-1 p-1 rounded transition-colors ${
          hasActiveFilters
            ? 'text-accent-fg'
            : 'text-fg-muted hover:text-fg'
        }`}
        data-testid="board-filter-btn"
        aria-label="Filter tasks"
      >
        <Filter size={14} />
        {hasActiveFilters && (
          <CountBadge count={priorityFilters.size + labelFilters.size} variant="solid" size="sm" />
        )}
      </button>

      {showFilterPopover && (
        <div
          ref={filterPopoverRef}
          className="absolute right-0 top-full mt-1 z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-2 w-[260px] max-h-[380px] overflow-y-auto"
        >
          <FilterPopover
            priorities={priorities}
            priorityFilters={priorityFilters}
            onTogglePriority={togglePriorityFilter}
            allLabels={allLabels}
            labelColors={labelColors}
            labelFilters={labelFilters}
            onToggleLabel={toggleLabelFilter}
            onClearAll={clearAllFilters}
            hasActiveFilters={hasActiveFilters}
          />
        </div>
      )}
    </div>
  );

  if (!hydrated) return null;

  return (
    <div className="relative h-full overflow-x-auto overflow-y-hidden flex flex-col">
      <ConfigWarningBanner />
      {showBoardSearch ? (
        <BoardSearchBar
          totalCount={tasks.length}
          matchCount={searchMatchCount}
          filterButton={filterButtonElement}
        />
      ) : null}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
      <WelcomeOverlay />
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableColumnIds} strategy={horizontalListSortingStrategy}>
          {/* Trailing pseudo-element ensures right-side scroll padding after the last column */}
          <div className="flex gap-4 h-full after:content-[''] after:flex-shrink-0 after:w-px">
            {swimlanes.map((swimlane) => (
              <SortableSwimlane
                key={swimlane.id}
                swimlane={swimlane}
                tasks={tasksPerLane.get(swimlane.id) ?? EMPTY_TASKS}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay style={{ pointerEvents: 'none', willChange: 'transform' }}>
          {activeTask ? (
            <div className="drag-overlay" style={{ opacity: 0.9 }}>
              <TaskCard task={activeTask} isDragOverlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <FlyingCard />
      </div>

      <BoardDialogs />
    </div>
  );
}
