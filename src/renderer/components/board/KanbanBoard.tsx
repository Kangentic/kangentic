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
import { DoneSwimlane, type DoneSwimlaneProps } from './DoneSwimlane';
import { TaskCard } from './TaskCard';
import { AddColumnButton } from './AddColumnButton';
import { useBoardStore } from '../../stores/board-store';
import type { Task, Swimlane as SwimlaneType } from '../../../shared/types';
import { useToastStore } from '../../stores/toast-store';

/** Wrapper that registers a column with @dnd-kit/sortable.
 *  All columns participate so dnd-kit knows their positions,
 *  but only custom columns (role === null) get a drag handle. */
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

  const isDraggable = swimlane.role !== 'backlog';

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
}

/** Fixed-position card that flies from the drop position into the Done drop zone. */
function FlyingCard() {
  const completingTask = useBoardStore((s) => s.completingTask);
  const finalizeCompletion = useBoardStore((s) => s.finalizeCompletion);
  const [flying, setFlying] = React.useState(false);

  React.useEffect(() => {
    if (completingTask) {
      setFlying(false);
      // Trigger transition on next frame so browser paints at start position first
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFlying(true);
        });
      });
    }
  }, [completingTask]);

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
          finalizeCompletion();
        }
      }}
    >
      <TaskCard task={task} isDragOverlay />
    </div>
  );
}

export function KanbanBoard() {
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const tasks = useBoardStore((s) => s.tasks);
  const moveTask = useBoardStore((s) => s.moveTask);
  const setCompletingTask = useBoardStore((s) => s.setCompletingTask);
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

  // All columns participate in the sortable context so dnd-kit knows
  // their positions.  Only custom columns get drag handles (see SortableSwimlane).
  const sortableColumnIds = useMemo(
    () => swimlanes.map((s) => `column:${s.id}`),
    [swimlanes],
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
    const state = useBoardStore.getState();
    const task = state.tasks.find((t) => t.id === id)
      ?? state.archivedTasks.find((t) => t.id === id);
    return task?.swimlane_id;
  }, [swimlaneIds]);

  /**
   * Custom collision detection: use pointerWithin first (checks if cursor
   * is inside a droppable rect), fall back to rectIntersection.
   * For column drags, use closestCorners.
   * When multiple collisions are found, prioritize swimlane droppables
   * over sortable task items so the column drop zone always highlights.
   */
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (String(args.active.id).startsWith('column:')) {
      return closestCorners(args);
    }
    const pointer = pointerWithin(args);
    if (pointer.length > 0) {
      const containerMap = new Map<string, any>();
      for (const c of args.droppableContainers) {
        containerMap.set(String(c.id), c);
      }
      const swimlaneHits = pointer.filter((c) => {
        const container = containerMap.get(String(c.id));
        return container?.data?.current?.type === 'swimlane';
      });
      if (swimlaneHits.length > 0) return swimlaneHits;
      return pointer;
    }
    return rectIntersection(args);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    if (!id.startsWith('column:')) {
      const state = useBoardStore.getState();
      const task = state.tasks.find((t) => t.id === id)
        ?? state.archivedTasks.find((t) => t.id === id);
      if (task) {
        setActiveTask(task);
        dragOriginRef.current = task.swimlane_id;
      }
    }
  }, []);

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

    // Skip visual cross-container transfer for archived tasks — they aren't
    // in the `tasks` array. The DragOverlay shows the floating card and
    // handleDragEnd will call unarchiveTask on drop.
    const state = useBoardStore.getState();
    if (state.archivedTasks.some((t) => t.id === activeId)) return;

    const activeContainer = findSwimlane(activeId);
    const overContainer = findSwimlane(String(over.id));

    if (!activeContainer || !overContainer || activeContainer === overContainer) return;

    // Don't visually transfer to Done — the card stays in its current column
    // and shrinks in place when dropped
    const doneLane = useBoardStore.getState().swimlanes.find((s) => s.role === 'done');
    if (doneLane && overContainer === doneLane.id) return;

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

      // Backlog and Done are locked in place
      const draggedCol = swimlanes.find((s) => s.id === fromSwimlaneId);
      if (!draggedCol || draggedCol.role === 'backlog') return;

      const fromIdx = swimlanes.findIndex((s) => s.id === fromSwimlaneId);
      const toIdx = swimlanes.findIndex((s) => s.id === toSwimlaneId);
      if (fromIdx === -1 || toIdx === -1) return;

      // arrayMove handles directional offset correctly for dnd-kit
      const ordered = arrayMove([...swimlanes], fromIdx, toIdx);

      // Validate constraints: Backlog must be first
      const backlogIdx = ordered.findIndex((s) => s.role === 'backlog');

      const toast = useToastStore.getState().addToast;
      if (backlogIdx !== 0) { toast({ message: 'Backlog must remain the first column', variant: 'warning' }); return; }

      await reorderSwimlanes(ordered.map((s) => s.id));
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

    // --- Archived task: unarchive instead of move ---
    const state = useBoardStore.getState();
    const archivedTask = state.archivedTasks.find((t) => t.id === taskId);
    if (archivedTask) {
      // Dropped back on Done column — no-op
      const doneLane = swimlanes.find((s) => s.role === 'done');
      if (doneLane && targetSwimlaneId === doneLane.id) return;

      await state.unarchiveTask({ id: taskId, targetSwimlaneId });
      return;
    }

    // Determine position within the target container
    const currentTasks = state.tasks;
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

    // Done target: defer moveTask and fly the card into the drop zone
    const doneLane = swimlanes.find((s) => s.role === 'done');
    if (doneLane && targetSwimlaneId === doneLane.id && originalSwimlane) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      // Capture where the DragOverlay was at drop time
      const initialRect = active.rect.current.initial;
      const startRect = {
        left: initialRect.left + event.delta.x,
        top: initialRect.top + event.delta.y,
        width: initialRect.width,
        height: initialRect.height,
      };
      setCompletingTask({
        taskId,
        targetSwimlaneId,
        targetPosition,
        originSwimlaneId: originalSwimlane,
        task,
        startRect,
      });
      return;
    }

    // Persist the move (moveTask handles optimistic update, IPC, and reload)
    await moveTask({ taskId, targetSwimlaneId, targetPosition });
  }, [moveTask, setCompletingTask, findSwimlane, swimlanes, reorderSwimlanes]);

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
        <SortableContext items={sortableColumnIds} strategy={horizontalListSortingStrategy}>
          <div className="flex gap-4 h-full">
            {swimlanes.map((swimlane) => (
              <SortableSwimlane
                key={swimlane.id}
                swimlane={swimlane}
                tasks={tasksForLane(swimlane)}
              />
            ))}
            <AddColumnButton />
          </div>
        </SortableContext>

        <DragOverlay style={{ pointerEvents: 'none' }}>
          {activeTask ? (
            <div className="drag-overlay">
              <TaskCard task={activeTask} isDragOverlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <FlyingCard />
    </div>
  );
}
