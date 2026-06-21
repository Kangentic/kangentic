import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type DropAnimation,
  type DropAnimationKeyframeResolver,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useBoardStore } from '../stores/board-store';
import { useToastStore } from '../stores/toast-store';
import { useProjectStore } from '../stores/project-store';
import { useConfigStore } from '../stores/config-store';
import { beginBoardDrag, endBoardDrag } from '../lib/session-update-coalescer';
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
  dropAnimation: DropAnimation;
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

/**
 * Compute the FlyingCard start rect from dnd-kit's measured initial rect plus
 * the drag delta, so the card mounts exactly where the DragOverlay was released.
 */
function rectFromInitial(
  initialRect: { left: number; top: number; width: number; height: number },
  delta: { x: number; y: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: initialRect.left + delta.x,
    top: initialRect.top + delta.y,
    width: initialRect.width,
    height: initialRect.height,
  };
}

export function useBoardDragDrop({ swimlanes, tasks, archivedTasks }: UseBoardDragDropParams): UseBoardDragDropResult {
  const moveTask = useBoardStore((s) => s.moveTask);
  const setCompletingTask = useBoardStore((s) => s.setCompletingTask);
  const addCompletingTaskId = useBoardStore((s) => s.addCompletingTaskId);
  const requestDoneConfirmAnimated = useBoardStore((s) => s.requestDoneConfirmAnimated);
  const requestDoneConfirmDirect = useBoardStore((s) => s.requestDoneConfirmDirect);
  const reorderSwimlanes = useBoardStore((s) => s.reorderSwimlanes);
  const reorderTaskInColumn = useBoardStore((s) => s.reorderTaskInColumn);

  const [activeTask, setActiveTask] = useState<Task | null>(null);

  // Whether the pointer is over the Done lane, tracked as a ref (never state) so
  // the value is correct at drop time without waiting on a React commit to land.
  // Updated synchronously in handleDragStart/handleDragOver; crossing the Done
  // boundary therefore never re-renders the board.
  const overDoneRef = useRef(false);

  // dnd-kit invokes this keyframe resolver as the overlay detaches on drop, so
  // reading overDoneRef here is race-free (no dependency on a React re-render of
  // a `dropAnimation` prop). Over Done we return two identical keyframes:
  // dnd-kit's createDefaultDropAnimation detects first === last and skips the
  // animation entirely, so the overlay detaches synchronously and the FlyingCard
  // owns the motion - no snap-back to the origin column. Everywhere else we
  // return dnd-kit's default transform tween, inheriting the default duration,
  // easing, and source-fade side effect via the config merge, so normal
  // cross-column moves keep their settle animation.
  const resolveDropKeyframes = useCallback<DropAnimationKeyframeResolver>(
    ({ transform }) =>
      overDoneRef.current
        ? [{ opacity: 0 }, { opacity: 0 }]
        : [
            { transform: CSS.Transform.toString(transform.initial) },
            { transform: CSS.Transform.toString(transform.final) },
          ],
    [],
  );
  const dropAnimation = useMemo<DropAnimation>(
    () => ({ keyframes: resolveDropKeyframes }),
    [resolveDropKeyframes],
  );

  // Ref-based drop highlight: avoids React re-renders during drag
  const hoveringSwimlaneIdRef = useRef<string | null>(null);

  // Track the original swimlane when drag starts (for proper transitions)
  const dragOriginRef = useRef<string | null>(null);

  // Snapshot the source card's bounding rect at drag start. dnd-kit's
  // `active.rect.current.initial` is sometimes null at drop time (re-render
  // during drag clears the measured rect), which used to force the Done
  // path to bypass setCompletingTask entirely - both the FlyingCard fly and
  // the grow-in animation got skipped even though the move still landed.
  // This ref guarantees we can still build a usable startRect for the
  // animation when dnd-kit's rect is gone.
  const dragStartRectRef = useRef<DOMRect | null>(null);

  // True between beginBoardDrag() and its paired endBoardDrag(). Read only by
  // the unmount cleanup below to recover the reload gate if the <DndContext>
  // unmounts mid-drag (dnd-kit fires no dragEnd/dragCancel in that case).
  const dragInFlightRef = useRef(false);

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

  /** O(1) swimlaneId → hex color lookup for drop highlight styling. */
  const swimlaneColorMap = useMemo(
    () => new Map(swimlanes.map((swimlane) => [swimlane.id, swimlane.color])),
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
      const previousElement = document.querySelector(`[data-swimlane-id="${previousId}"]`) as HTMLElement | null;
      if (previousElement) {
        previousElement.classList.remove('drop-highlight');
        previousElement.style.removeProperty('--drop-color');
      }
    }
    if (targetId) {
      const targetElement = document.querySelector(`[data-swimlane-id="${targetId}"]`) as HTMLElement | null;
      if (targetElement) {
        const color = swimlaneColorMap.get(targetId);
        if (color) {
          targetElement.style.setProperty('--drop-color', color);
        }
        targetElement.classList.add('drop-highlight');
      }
    }
    hoveringSwimlaneIdRef.current = targetId;
  }, [swimlaneColorMap]);

  // Clean up stale drop highlights on unmount (e.g. HMR replaces this component
  // mid-drag, so handleDragEnd/handleDragCancel never fire).
  useEffect(() => {
    return () => {
      updateDropHighlight(null);
    };
  }, [updateDropHighlight]);

  // Recover the reload gate if the <DndContext> unmounts mid-drag. AppLayout
  // mounts the board only while activeView === 'board', so switching to the
  // Backlog view (or tearing down on project switch) during a drag unmounts
  // this subtree with no dragEnd/dragCancel, stranding dragActive=true in the
  // coalescer and parking every agent-driven loadBoard() until the next drag.
  // The ref guard makes a StrictMode mount/cleanup/mount cycle a no-op, and
  // HMR teardown is handled separately by resetCoalescerForHmr() in App.tsx.
  useEffect(() => {
    return () => {
      if (dragInFlightRef.current) {
        dragInFlightRef.current = false;
        endBoardDrag();
      }
    };
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    // Reset for this drag. handleDragOver re-derives it before any drop fires,
    // so a stale value carried over between drags is harmless.
    overDoneRef.current = false;
    // Gate non-positional session-store updates for the duration of the drag so
    // an in-flight spawn can't re-render a sortable card and force dnd-kit to
    // re-measure on the pointer-move thread. Flushed in handleDragEnd/Cancel.
    beginBoardDrag();
    dragInFlightRef.current = true;
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
          const sourceElement = document.querySelector(`[data-task-id="${id}"]`);
          dragStartRectRef.current = sourceElement?.getBoundingClientRect() ?? null;
        }
      }
    }
  }, [taskToSwimlane]);

  // Track which swimlane the pointer is hovering over for column highlights.
  // Done is excluded - it has its own drop-zone animation (green spinning border)
  // via useDroppable's isOver, so the generic blue ring would conflict.
  // Uses ref + direct DOM class toggling to avoid React re-renders on every mouse move.
  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      updateDropHighlight(null);
      overDoneRef.current = false;
      return;
    }

    const activeId = String(event.active.id);
    if (activeId.startsWith('column:')) return; // column reorder: stays default

    const targetLane = findSwimlane(String(event.over.id)) ?? null;
    updateDropHighlight(targetLane === doneLaneId ? null : targetLane);
    // Record the live drop target so the keyframe resolver reads the right
    // value at drop time. dnd-kit fires onDragOver with the final `over` before
    // onDragEnd, so by drop time this ref reflects the real target.
    overDoneRef.current = targetLane !== null && targetLane === doneLaneId;
  }, [findSwimlane, doneLaneId, updateDropHighlight]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    const originalSwimlane = dragOriginRef.current;
    const stashedStartRect = dragStartRectRef.current;
    dragOriginRef.current = null;
    dragStartRectRef.current = null;
    setActiveTask(null);
    updateDropHighlight(null);
    // Flush deferred session updates now (synchronously, before any await) so
    // the held spawn/activity pushes apply immediately and the buffer stops
    // growing while the async drop resolves.
    dragInFlightRef.current = false;
    endBoardDrag();

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
      if (!draggedCol || draggedCol.role === 'todo') return;

      const fromIdx = swimlanes.findIndex((swimlane) => swimlane.id === fromSwimlaneId);
      const toIdx = swimlanes.findIndex((swimlane) => swimlane.id === toSwimlaneId);
      if (fromIdx === -1 || toIdx === -1) return;

      // arrayMove handles directional offset correctly for dnd-kit
      const ordered = arrayMove([...swimlanes], fromIdx, toIdx);

      // Validate constraints: To Do must be first
      const todoIndex = ordered.findIndex((swimlane) => swimlane.role === 'todo');

      const toast = useToastStore.getState().addToast;
      if (todoIndex !== 0) { toast({ message: 'To Do must remain the first column', variant: 'warning' }); return; }

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

    // Project this drop targets, captured synchronously before any await. A Done
    // drop defers its persist ~700ms (the FlyingCard flight) and is threaded
    // through the completion gate; direct moves below pass it straight through.
    // Either way the move routes to the right project even if the user switches
    // projects mid-flight. See task-slice.ts moveTask.
    const dropProjectId = useProjectStore.getState().currentProject?.id ?? null;

    // Done target: fly the card into the drop zone immediately, then persist.
    // Moving to Done deletes the local worktree directory, but the branch and
    // session records are preserved and restored on resume, so a clean move is
    // fully recoverable and needs no confirmation. We only confirm when the
    // worktree has uncommitted files or unpushed commits (or the probe fails),
    // since the directory delete would discard uncommitted work.
    const doneLane = swimlanes.find((swimlane) => swimlane.role === 'done');
    if (doneLane && targetSwimlaneId === doneLane.id && originalSwimlane) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;

      // Hide the card from its source column synchronously. On release dnd-kit
      // restores the original sortable card to full opacity in its source lane;
      // tasksPerLane filters completingTaskIds, so adding it now drops the card
      // from every lane this same tick. The guard is released after the move
      // settles (moveTask's finally) or on cancel (cancelCompletion). See
      // .claude/rules/board-completing-task-chokepoint.md.
      addCompletingTaskId(taskId);

      const directInput = { taskId, targetSwimlaneId, targetPosition };

      // Capture where the DragOverlay was at drop time. Prefer dnd-kit's
      // measured initial rect; fall back to the rect we snapshotted at drag
      // start. dnd-kit can clear `active.rect.current.initial` when the
      // source draggable re-renders mid-drag (e.g. structural-sharing
      // reshuffle, sort animation), and a null rect there would otherwise
      // force the Done drop to bypass setCompletingTask, silently skipping
      // both the FlyingCard fly and the grow-in animation.
      const initialRect = active.rect.current.initial ?? stashedStartRect;

      // No worktree: nothing destructive to confirm. Fly immediately and let
      // the move persist when the animation finishes (gate pre-approved).
      if (!task.worktree_path) {
        if (initialRect) {
          setCompletingTask({
            taskId,
            targetSwimlaneId,
            targetPosition,
            originSwimlaneId: originalSwimlane,
            task,
            startRect: rectFromInitial(initialRect, event.delta),
            projectId: dropProjectId,
          });
        } else {
          await moveTask(directInput, false, dropProjectId);
        }
        return;
      }

      // Worktree-backed: mount the FlyingCard NOW (gated) so there is no blank
      // window, then probe for unsaved work CONCURRENTLY with the fly. The gate
      // holds back persistence until the fly finishes AND the probe clears (or
      // the user confirms the dialog). The no-rect fallback can't animate, so it
      // awaits the probe before deciding, as before.
      const worktreePath = task.worktree_path;
      // Captured at drop time (interaction-time correct): whether the Done move
      // will force-delete the branch, plus the linked PR so the probe can tell
      // merged-and-safe commits from genuinely at-risk ones.
      const autoCleanup = useConfigStore.getState().config.git.autoCleanup;
      const probe = async () => {
        try {
          const result = await window.electronAPI.git.checkPendingChanges({
            checkPath: worktreePath,
            autoCleanup,
            prNumber: task.pr_number,
            prState: task.pr_state,
          });
          return { ...result, autoCleanup };
        } catch {
          // Treat git failures as "potentially has changes" - safer to ask
          // than to silently destroy. Mirrors the To Do path in task-slice.ts.
          return { uncommittedFileCount: 0, unpushedCommitCount: 0, hasPendingChanges: true, currentBranch: null, autoCleanup };
        }
      };

      if (!initialRect) {
        const pendingChanges = await probe();
        if (pendingChanges.hasPendingChanges) {
          requestDoneConfirmDirect(task, directInput, pendingChanges);
        } else {
          await moveTask(directInput, false, dropProjectId);
        }
        return;
      }

      const completing = {
        taskId,
        targetSwimlaneId,
        targetPosition,
        originSwimlaneId: originalSwimlane,
        task,
        startRect: rectFromInitial(initialRect, event.delta),
        projectId: dropProjectId,
      };
      setCompletingTask(completing, { gated: true });

      const pendingChanges = await probe();
      if (pendingChanges.hasPendingChanges) {
        // Dialog appears mid-flight; confirm approves the gate, cancel restores.
        requestDoneConfirmAnimated(completing, pendingChanges);
      } else {
        useBoardStore.getState().approveCompletion(taskId);
      }
      return;
    }

    // Persist the move (moveTask handles optimistic update, IPC, and reload)
    await moveTask({ taskId, targetSwimlaneId, targetPosition }, false, dropProjectId);

    } catch (err) {
      console.error('handleDragEnd error:', err);
      await useBoardStore.getState().loadBoard();
      useToastStore.getState().addToast({
        message: `Drag failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  }, [moveTask, setCompletingTask, addCompletingTaskId, requestDoneConfirmAnimated, requestDoneConfirmDirect, findSwimlane, swimlanes, swimlaneIds, reorderSwimlanes, reorderTaskInColumn, updateDropHighlight]);

  const handleDragCancel = useCallback(() => {
    // Flush any updates that were held while the drag was active.
    dragInFlightRef.current = false;
    endBoardDrag();
    setActiveTask(null);
    updateDropHighlight(null);
    dragOriginRef.current = null;
    dragStartRectRef.current = null;
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
    dropAnimation,
  };
}
