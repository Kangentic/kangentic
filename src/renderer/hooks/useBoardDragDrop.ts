import { useCallback, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
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
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { useBoardStore } from '../stores/board-store';
import { useToastStore } from '../stores/toast-store';
import type { Task, Swimlane as SwimlaneType } from '../../shared/types';

interface UseBoardDragDropParams {
  swimlanes: SwimlaneType[];
  tasks: Task[];
  archivedTasks: Task[];
}

interface UseBoardDragDropResult {
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: CollisionDetection;
  handleDragStart: (event: DragStartEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragEnd: (event: DragEndEvent) => Promise<void>;
  handleDragCancel: () => void;
  activeTask: Task | null;
  sortableColumnIds: string[];
}

/**
 * Determine the insertion index for a cross-column drop by comparing
 * the pointer position to the over-element's midpoint.
 */
function getInsertionIndex(
  event: DragOverEvent | DragEndEvent,
  laneTasks: Task[],
  swimlaneIds: Set<string>,
): number {
  const { over } = event;
  if (!over) return 0;
  const overId = String(over.id);

  // Over a swimlane container (empty column) → append
  if (swimlaneIds.has(overId)) return laneTasks.length;

  // Over a task → check above/below midpoint
  const overIndex = laneTasks.findIndex((task) => task.id === overId);
  if (overIndex === -1) return laneTasks.length;

  const overRect = over.rect;
  const midY = overRect.top + overRect.height / 2;

  // Use the actual pointer position - directly reflects user intent
  let pointerY: number;
  if (event.activatorEvent instanceof PointerEvent) {
    pointerY = event.activatorEvent.clientY + event.delta.y;
  } else {
    // Keyboard drag fallback: use translated rect center
    const translated = event.active.rect.current.translated;
    pointerY = translated
      ? translated.top + translated.height / 2
      : overRect.top;
  }

  return pointerY < midY ? overIndex : overIndex + 1;
}

export function useBoardDragDrop({ swimlanes, tasks, archivedTasks }: UseBoardDragDropParams): UseBoardDragDropResult {
  const moveTask = useBoardStore((s) => s.moveTask);
  const setCompletingTask = useBoardStore((s) => s.setCompletingTask);
  const reorderSwimlanes = useBoardStore((s) => s.reorderSwimlanes);
  const reorderTaskInColumn = useBoardStore((s) => s.reorderTaskInColumn);

  const [activeTask, setActiveTask] = useState<Task | null>(null);

  // Ref-based drop highlight: avoids React re-renders during drag
  const hoveringSwimlaneIdRef = useRef<string | null>(null);

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
    () => swimlanes.map((swimlane) => `column:${swimlane.id}`),
    [swimlanes],
  );

  const swimlaneIds = useMemo(
    () => new Set(swimlanes.map((swimlane) => swimlane.id)),
    [swimlanes],
  );

  const doneLaneId = useMemo(
    () => swimlanes.find((swimlane) => swimlane.role === 'done')?.id ?? null,
    [swimlanes],
  );

  /** O(1) taskId → swimlaneId lookup covering both active and archived tasks. */
  const taskToSwimlane = useMemo(() => {
    const map = new Map<string, string>();
    for (const activeTask of tasks) map.set(activeTask.id, activeTask.swimlane_id);
    for (const archived of archivedTasks) map.set(archived.id, archived.swimlane_id);
    return map;
  }, [tasks, archivedTasks]);

  /** Resolve which swimlane a draggable/droppable ID belongs to. */
  const findSwimlane = useCallback((id: string): string | undefined => {
    if (swimlaneIds.has(id)) return id;
    return taskToSwimlane.get(id);
  }, [swimlaneIds, taskToSwimlane]);

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    // Column drags: closestCorners (unchanged)
    if (String(args.active.id).startsWith('column:')) {
      return closestCorners(args);
    }

    // Done column: check with pointerWithin first (docs' "trash bin" pattern).
    // pointerWithin checks pointer coordinates, not the draggable's full rect,
    // so dragging to adjacent Review doesn't falsely match Done.
    if (doneLaneId) {
      const doneCollisions = pointerWithin({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => String(c.id) === doneLaneId,
        ),
      });
      if (doneCollisions.length > 0) return doneCollisions;
    }

    // Two-tier collision detection for task drags:
    // Tier 1: rectIntersection on column sortable containers (full visual column rects)
    // Tier 2: closestCenter scoped to the detected column (precise insertion positioning)
    const activeColumn = findSwimlane(String(args.active.id));
    const swimlaneContainers = args.droppableContainers.filter((container) => {
      const containerId = String(container.id);
      return !containerId.startsWith('column:') && swimlaneIds.has(containerId);
    });

    // Tier 1: which column does the card overlap?
    // Uses column: sortable containers (full visual column rects) rather than
    // swimlane droppables (inner task-list area only) for earlier activation.
    const columnContainers = args.droppableContainers.filter((container) => {
      const containerId = String(container.id);
      if (!containerId.startsWith('column:')) return false;
      const laneId = containerId.slice(7);
      return swimlaneIds.has(laneId) && laneId !== doneLaneId;
    });
    const columnHits = rectIntersection({ ...args, droppableContainers: columnContainers });

    if (columnHits.length > 0) {
      const targetId = String(columnHits[0].id).slice(7);
      const isSameColumn = targetId === activeColumn;

      // Tier 2: closestCenter among tasks in that column.
      // Include the swimlane container only for cross-column drags (empty-column target).
      // Exclude it for same-column drags so the container's large rect can't
      // outcompete task cards during within-column reordering.
      const inColumn = args.droppableContainers.filter((container) => {
        const containerId = String(container.id);
        if (containerId.startsWith('column:')) return false;
        if (swimlaneIds.has(containerId)) return !isSameColumn && containerId === targetId;
        return findSwimlane(containerId) === targetId;
      });
      return closestCenter({ ...args, droppableContainers: inColumn });
    }

    // Fallback: pointer in gap between columns - closestCenter against other swimlanes
    return closestCenter({
      ...args,
      droppableContainers: swimlaneContainers.filter(
        (container) => String(container.id) !== activeColumn,
      ),
    });
  }, [findSwimlane, doneLaneId, swimlaneIds]);

  /** Toggle .drop-highlight class on swimlane DOM elements without React re-render. */
  const updateDropHighlight = useCallback((targetId: string | null) => {
    const previousId = hoveringSwimlaneIdRef.current;
    if (previousId === targetId) return;
    if (previousId) {
      const previousElement = document.querySelector(`[data-swimlane-id="${previousId}"]`);
      previousElement?.classList.remove('drop-highlight');
    }
    if (targetId) {
      const targetElement = document.querySelector(`[data-swimlane-id="${targetId}"]`);
      targetElement?.classList.add('drop-highlight');
    }
    hoveringSwimlaneIdRef.current = targetId;
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    if (!id.startsWith('column:')) {
      const swimlaneId = taskToSwimlane.get(id);
      if (swimlaneId) {
        const state = useBoardStore.getState();
        const task = state.tasks.find((candidate) => candidate.id === id)
          ?? state.archivedTasks.find((candidate) => candidate.id === id);
        if (task) {
          setActiveTask(task);
          dragOriginRef.current = task.swimlane_id;
        }
      }
      document.documentElement.classList.add('dragging');
    }
  }, [taskToSwimlane]);

  // Track which swimlane the pointer is hovering over for column highlights.
  // Done is excluded - it has its own drop-zone animation (green spinning border)
  // via useDroppable's isOver, so the generic blue ring would conflict.
  // Uses ref + direct DOM class toggling to avoid React re-renders on every mouse move.
  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      updateDropHighlight(null);
      return;
    }

    const activeId = String(event.active.id);
    if (activeId.startsWith('column:')) return;

    const targetLane = findSwimlane(String(event.over.id)) ?? null;
    updateDropHighlight(targetLane === doneLaneId ? null : targetLane);
  }, [findSwimlane, doneLaneId, updateDropHighlight]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    const originalSwimlane = dragOriginRef.current;
    dragOriginRef.current = null;
    setActiveTask(null);
    updateDropHighlight(null);
    document.documentElement.classList.remove('dragging');

    if (!over) {
      // Cancelled - reload from DB to restore original positions
      if (originalSwimlane) useBoardStore.getState().loadBoard();
      return;
    }

    try {
    const activeId = active.id as string;

    // --- Column reorder ---
    if (activeId.startsWith('column:')) {
      const overId = over.id as string;
      if (!overId.startsWith('column:')) return;
      if (activeId === overId) return;

      const fromSwimlaneId = activeId.slice(7); // strip 'column:'
      const toSwimlaneId = overId.slice(7);

      // Backlog and Done are locked in place
      const draggedCol = swimlanes.find((swimlane) => swimlane.id === fromSwimlaneId);
      if (!draggedCol || draggedCol.role === 'backlog') return;

      const fromIdx = swimlanes.findIndex((swimlane) => swimlane.id === fromSwimlaneId);
      const toIdx = swimlanes.findIndex((swimlane) => swimlane.id === toSwimlaneId);
      if (fromIdx === -1 || toIdx === -1) return;

      // arrayMove handles directional offset correctly for dnd-kit
      const ordered = arrayMove([...swimlanes], fromIdx, toIdx);

      // Validate constraints: Backlog must be first
      const backlogIdx = ordered.findIndex((swimlane) => swimlane.role === 'backlog');

      const toast = useToastStore.getState().addToast;
      if (backlogIdx !== 0) { toast({ message: 'Backlog must remain the first column', variant: 'warning' }); return; }

      await reorderSwimlanes(ordered.map((swimlane) => swimlane.id));
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
    const archivedTask = state.archivedTasks.find((candidate) => candidate.id === taskId);
    if (archivedTask) {
      // Dropped back on Done column - no-op
      const doneLane = swimlanes.find((swimlane) => swimlane.role === 'done');
      if (doneLane && targetSwimlaneId === doneLane.id) return;

      await state.unarchiveTask({ id: taskId, targetSwimlaneId });
      return;
    }

    // --- Same-column reorder ---
    if (originalSwimlane === targetSwimlaneId) {
      if (over.data.current?.type !== 'task') {
        useBoardStore.getState().loadBoard();
        return;
      }
      await reorderTaskInColumn(taskId, targetSwimlaneId, active.id as string, over.id as string);
      return;
    }

    const currentTasks = state.tasks;
    const laneTasks = currentTasks
      .filter((task) => task.swimlane_id === targetSwimlaneId && task.id !== taskId)
      .sort((a, b) => a.position - b.position);
    const targetPosition = getInsertionIndex(event, laneTasks, swimlaneIds);

    // Done target: defer moveTask and fly the card into the drop zone
    const doneLane = swimlanes.find((swimlane) => swimlane.role === 'done');
    if (doneLane && targetSwimlaneId === doneLane.id && originalSwimlane) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      // Capture where the DragOverlay was at drop time
      const initialRect = active.rect.current.initial;
      if (!initialRect) {
        // DOM element was destroyed mid-drag - skip animation, move directly
        await moveTask({ taskId, targetSwimlaneId, targetPosition });
        return;
      }
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

    } catch (err) {
      console.error('handleDragEnd error:', err);
      await useBoardStore.getState().loadBoard();
      useToastStore.getState().addToast({
        message: `Drag failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  }, [moveTask, setCompletingTask, findSwimlane, swimlanes, swimlaneIds, reorderSwimlanes, reorderTaskInColumn, updateDropHighlight]);

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    updateDropHighlight(null);
    document.documentElement.classList.remove('dragging');
    dragOriginRef.current = null;
    useBoardStore.getState().loadBoard();
  }, [updateDropHighlight]);

  return {
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeTask,
    sortableColumnIds,
  };
}
