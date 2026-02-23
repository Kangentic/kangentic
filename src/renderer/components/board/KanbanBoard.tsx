import React, { useCallback, useMemo, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  pointerWithin,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable';
import { Swimlane, type SwimlaneProps } from './Swimlane';
import { TaskCard } from './TaskCard';
import { AddColumnButton } from './AddColumnButton';
import { useBoardStore } from '../../stores/board-store';
import type { Task, Swimlane as SwimlaneType } from '../../../shared/types';

/** Wrapper that makes a column draggable via @dnd-kit/sortable */
function SortableSwimlane({ swimlane, tasks }: SwimlaneProps) {
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

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition || undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <Swimlane
        swimlane={swimlane}
        tasks={tasks}
        dragHandleProps={listeners}
      />
    </div>
  );
}

export function KanbanBoard() {
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const tasks = useBoardStore((s) => s.tasks);
  const moveTask = useBoardStore((s) => s.moveTask);
  const reorderSwimlanes = useBoardStore((s) => s.reorderSwimlanes);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);

  // Track the original swimlane when drag starts (for proper transitions)
  const dragOriginRef = useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Split into system (locked) and custom (sortable) columns
  const systemColumns = useMemo(
    () => swimlanes.filter((s) => s.position <= 2),
    [swimlanes],
  );
  const customColumns = useMemo(
    () => swimlanes.filter((s) => s.position > 2),
    [swimlanes],
  );
  const customColumnSortIds = useMemo(
    () => customColumns.map((s) => `column:${s.id}`),
    [customColumns],
  );

  const swimlaneIds = useMemo(
    () => new Set(swimlanes.map((s) => s.id)),
    [swimlanes],
  );

  const tasksForLane = useCallback(
    (swimlane: SwimlaneType) =>
      tasks
        .filter((t) => t.swimlane_id === swimlane.id)
        .sort((a, b) => a.position - b.position),
    [tasks],
  );

  /** Resolve which swimlane a draggable/droppable ID belongs to. */
  const findSwimlane = useCallback((id: string): string | undefined => {
    if (swimlaneIds.has(id)) return id;
    const currentTasks = useBoardStore.getState().tasks;
    return currentTasks.find((t) => t.id === id)?.swimlane_id;
  }, [swimlaneIds]);

  /**
   * Custom collision detection: use pointerWithin first (checks if cursor
   * is inside a droppable rect), fall back to rectIntersection.
   * For column drags, use closestCorners.
   */
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (String(args.active.id).startsWith('column:')) {
      return closestCorners(args);
    }
    const pointer = pointerWithin(args);
    if (pointer.length > 0) return pointer;
    return rectIntersection(args);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    if (!id.startsWith('column:')) {
      const task = tasks.find((t) => t.id === id);
      if (task) {
        setActiveTask(task);
        dragOriginRef.current = task.swimlane_id;
      }
    }
  }, [tasks]);

  /**
   * Fires continuously as the dragged item moves over different containers.
   * We transfer the task between SortableContext containers by updating
   * swimlane_id in the store (visual only, no IPC).
   */
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    if (activeId.startsWith('column:')) return;

    const activeContainer = findSwimlane(activeId);
    const overContainer = findSwimlane(String(over.id));

    if (!activeContainer || !overContainer || activeContainer === overContainer) return;

    // Move the task to the new container visually
    useBoardStore.setState((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== activeId) return t;
        const targetTasks = s.tasks.filter(
          (ot) => ot.swimlane_id === overContainer && ot.id !== activeId,
        );
        return { ...t, swimlane_id: overContainer, position: targetTasks.length };
      }),
    }));
  }, [findSwimlane]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    const originalSwimlane = dragOriginRef.current;
    dragOriginRef.current = null;
    setActiveTask(null);

    if (!over) {
      // Cancelled — reload from DB to restore original positions
      if (originalSwimlane) useBoardStore.getState().loadBoard();
      return;
    }

    const activeId = active.id as string;

    // --- Column reorder ---
    if (activeId.startsWith('column:')) {
      const overId = over.id as string;
      if (!overId.startsWith('column:')) return;
      if (activeId === overId) return;

      const fromSwimlaneId = activeId.slice(7); // strip 'column:'
      const toSwimlaneId = overId.slice(7);

      const oldIndex = customColumns.findIndex((s) => s.id === fromSwimlaneId);
      const newIndex = customColumns.findIndex((s) => s.id === toSwimlaneId);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(customColumns, oldIndex, newIndex);
      const newOrder = [
        ...systemColumns.map((s) => s.id),
        ...reordered.map((s) => s.id),
      ];
      await reorderSwimlanes(newOrder);
      return;
    }

    // --- Task move ---
    const taskId = activeId;

    // Determine the target swimlane from the drop target
    const targetSwimlaneId = findSwimlane(String(over.id));
    if (!targetSwimlaneId) {
      if (originalSwimlane) useBoardStore.getState().loadBoard();
      return;
    }

    // Determine position within the target container
    const currentTasks = useBoardStore.getState().tasks;
    const laneTasks = currentTasks.filter(
      (t) => t.swimlane_id === targetSwimlaneId && t.id !== taskId,
    );
    let targetPosition: number;

    const overData = over.data.current;
    if (overData?.type === 'task') {
      const overTask = currentTasks.find((t) => t.id === over.id);
      targetPosition = overTask ? overTask.position : laneTasks.length;
    } else {
      targetPosition = laneTasks.length;
    }

    // No-op check against the ORIGINAL swimlane (not the current one from onDragOver)
    if (originalSwimlane === targetSwimlaneId && targetPosition === (currentTasks.find((t) => t.id === taskId)?.position ?? -1)) {
      // Restore — nothing changed
      useBoardStore.getState().loadBoard();
      return;
    }

    // Persist the move (moveTask handles optimistic update, IPC, and reload)
    await moveTask({ taskId, targetSwimlaneId, targetPosition });
  }, [moveTask, findSwimlane, customColumns, systemColumns, reorderSwimlanes]);

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    dragOriginRef.current = null;
    useBoardStore.getState().loadBoard();
  }, []);

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden p-4">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex gap-4 h-full">
          {/* System columns (positions 0, 1, 2) — not draggable */}
          {systemColumns.map((swimlane) => (
            <Swimlane
              key={swimlane.id}
              swimlane={swimlane}
              tasks={tasksForLane(swimlane)}
            />
          ))}

          {/* Custom columns — sortable */}
          <SortableContext items={customColumnSortIds} strategy={horizontalListSortingStrategy}>
            {customColumns.map((swimlane) => (
              <SortableSwimlane
                key={swimlane.id}
                swimlane={swimlane}
                tasks={tasksForLane(swimlane)}
              />
            ))}
          </SortableContext>

          <AddColumnButton />
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="drag-overlay">
              <TaskCard task={activeTask} isDragOverlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
