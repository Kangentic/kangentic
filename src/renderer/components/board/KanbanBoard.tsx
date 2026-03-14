import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
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
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable';
import { AlertTriangle, X } from 'lucide-react';
import { Swimlane, type SwimlaneProps } from './Swimlane';
import { DoneSwimlane } from './DoneSwimlane';
import { TaskCard } from './TaskCard';
import { AddColumnButton } from './AddColumnButton';
import { WelcomeOverlay } from './WelcomeOverlay';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import type { Task, Swimlane as SwimlaneType } from '../../../shared/types';
import { useToastStore } from '../../stores/toast-store';

/** Wrapper that registers a column with @dnd-kit/sortable.
 *  All columns participate so dnd-kit knows their positions,
 *  but only custom columns (role === null) get a drag handle. */
const SortableSwimlane = React.memo(function SortableSwimlane({ swimlane, tasks, isDropTarget }: SwimlaneProps) {
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
        isDropTarget={isDropTarget}
      />
    </div>
  );
});

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
  const overIndex = laneTasks.findIndex((t) => t.id === overId);
  if (overIndex === -1) return laneTasks.length;

  const overRect = over.rect;
  const midY = overRect.top + overRect.height / 2;

  // Use the actual pointer position -- directly reflects user intent
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

/** Confirm dialog for board config changes, showing the project name. */
function ConfigChangeDialog({ projectId, onConfirm, onCancel }: {
  projectId: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const project = projects.find((p) => p.id === projectId);
  const projectName = project?.name ?? 'Unknown project';
  const isCrossProject = currentProject?.id !== projectId;
  const message = isCrossProject
    ? `Changes detected in kangentic.json for "${projectName}". Apply the updated board configuration? This will switch to that project.`
    : 'Changes detected in kangentic.json. Apply the updated board configuration?';

  return (
    <ConfirmDialog
      title="Board configuration changed"
      message={message}
      confirmLabel="Apply"
      cancelLabel="Dismiss"
      showDontAskAgain
      dontAskAgainLabel="Always apply automatically"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export function KanbanBoard() {
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const tasks = useBoardStore((s) => s.tasks);
  const moveTask = useBoardStore((s) => s.moveTask);
  const setCompletingTask = useBoardStore((s) => s.setCompletingTask);
  const reorderSwimlanes = useBoardStore((s) => s.reorderSwimlanes);
  const reorderTaskInColumn = useBoardStore((s) => s.reorderTaskInColumn);
  const pendingConfigChange = useBoardStore((s) => s.pendingConfigChange);
  const applyConfigChange = useBoardStore((s) => s.applyConfigChange);
  const dismissConfigChange = useBoardStore((s) => s.dismissConfigChange);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);
  const [hoveringSwimlaneId, setHoveringSwimlaneId] = useState<string | null>(null);

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

  const doneLaneId = useMemo(
    () => swimlanes.find((s) => s.role === 'done')?.id ?? null,
    [swimlanes],
  );

  const tasksPerLane = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const lane of swimlanes) map.set(lane.id, []);
    for (const task of tasks) {
      const arr = map.get(task.swimlane_id);
      if (arr) arr.push(task);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [swimlanes, tasks]);

  /** Resolve which swimlane a draggable/droppable ID belongs to. */
  const findSwimlane = useCallback((id: string): string | undefined => {
    if (swimlaneIds.has(id)) return id;
    const state = useBoardStore.getState();
    const task = state.tasks.find((t) => t.id === id)
      ?? state.archivedTasks.find((t) => t.id === id);
    return task?.swimlane_id;
  }, [swimlaneIds]);

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
    const swimlaneContainers = args.droppableContainers.filter((c) => {
      const cId = String(c.id);
      return !cId.startsWith('column:') && swimlaneIds.has(cId);
    });

    // Tier 1: which column does the card overlap?
    // Uses column: sortable containers (full visual column rects) rather than
    // swimlane droppables (inner task-list area only) for earlier activation.
    const columnContainers = args.droppableContainers.filter((c) => {
      const cId = String(c.id);
      if (!cId.startsWith('column:')) return false;
      const laneId = cId.slice(7);
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
      const inColumn = args.droppableContainers.filter((c) => {
        const cId = String(c.id);
        if (cId.startsWith('column:')) return false;
        if (swimlaneIds.has(cId)) return !isSameColumn && cId === targetId;
        return findSwimlane(cId) === targetId;
      });
      return closestCenter({ ...args, droppableContainers: inColumn });
    }

    // Fallback: pointer in gap between columns -- closestCenter against other swimlanes
    return closestCenter({
      ...args,
      droppableContainers: swimlaneContainers.filter(
        (c) => String(c.id) !== activeColumn,
      ),
    });
  }, [findSwimlane, doneLaneId, swimlaneIds]);

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

  // Track which swimlane the pointer is hovering over for column highlights.
  // Done is excluded -- it has its own drop-zone animation (green spinning border)
  // via useDroppable's isOver, so the generic blue ring would conflict.
  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      setHoveringSwimlaneId(null);
      return;
    }

    const activeId = String(event.active.id);
    if (activeId.startsWith('column:')) return;

    const targetLane = findSwimlane(String(event.over.id)) ?? null;
    setHoveringSwimlaneId(targetLane === doneLaneId ? null : targetLane);
  }, [findSwimlane, doneLaneId]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    const originalSwimlane = dragOriginRef.current;
    dragOriginRef.current = null;
    setActiveTask(null);
    setHoveringSwimlaneId(null);

    if (!over) {
      // Cancelled -- reload from DB to restore original positions
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
      // Dropped back on Done column -- no-op
      const doneLane = swimlanes.find((s) => s.role === 'done');
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
      .filter((t) => t.swimlane_id === targetSwimlaneId && t.id !== taskId)
      .sort((a, b) => a.position - b.position);
    const targetPosition = getInsertionIndex(event, laneTasks, swimlaneIds);

    // Done target: defer moveTask and fly the card into the drop zone
    const doneLane = swimlanes.find((s) => s.role === 'done');
    if (doneLane && targetSwimlaneId === doneLane.id && originalSwimlane) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      // Capture where the DragOverlay was at drop time
      const initialRect = active.rect.current.initial;
      if (!initialRect) {
        // DOM element was destroyed mid-drag -- skip animation, move directly
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
  }, [moveTask, setCompletingTask, findSwimlane, swimlanes, swimlaneIds, reorderSwimlanes, reorderTaskInColumn]);

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    setHoveringSwimlaneId(null);
    dragOriginRef.current = null;
    useBoardStore.getState().loadBoard();
  }, []);

  const handleConfigConfirm = useCallback((dontAskAgain: boolean) => {
    if (dontAskAgain) {
      updateConfig({ skipBoardConfigConfirm: true });
    }
    applyConfigChange();
  }, [applyConfigChange, updateConfig]);

  return (
    <div className="relative h-full overflow-x-auto overflow-y-hidden flex flex-col">
      <ConfigWarningBanner />
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
          <div className="flex gap-4 h-full">
            {swimlanes.map((swimlane) => (
              <SortableSwimlane
                key={swimlane.id}
                swimlane={swimlane}
                tasks={tasksPerLane.get(swimlane.id) ?? []}
                isDropTarget={hoveringSwimlaneId === swimlane.id}
              />
            ))}
            <AddColumnButton />
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

      {pendingConfigChange && (
        <ConfigChangeDialog
          projectId={pendingConfigChange}
          onConfirm={handleConfigConfirm}
          onCancel={dismissConfigChange}
        />
      )}
    </div>
  );
}
