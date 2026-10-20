import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  closestCorners,
  pointerWithin,
  rectIntersection,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
  type DropAnimation,
  type DropAnimationKeyframeResolver,
  type Modifier,
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
import { useWorkflowStore } from '../stores/workflow-store';
import { beginBoardDrag, endBoardDrag } from '../lib/session-update-coalescer';
import { IntentKeyboardSensor } from '../utils/intent-keyboard-sensor';
import { boardWorkflowNow, refusedBoardMove, showWorkflowRefusal } from '../utils/workflow-refusal';
import { isLockedOnBoard } from '../utils/board-workflow';
import {
  CARD_GAP_PX,
  applyDropGap,
  clearDropGapDom,
  closeDropGap,
  dropGapTarget,
  getInsertionIndex,
  laneTaskList,
  laneTasksForDrop,
  placeDropSlot,
  releaseDropSettle,
  settleDropGap,
} from '../utils/board-drop-preview';
import type { Task, Swimlane as SwimlaneType } from '../../shared/types';

/**
 * How long dnd-kit's sortable keeps `wasDragging` true after a drop
 * (`useSortable`'s 50ms timer), the window in which an index change animates
 * from the old rect. A settled drop gap is held past it (`settleDropGap`).
 */
const SORTABLE_WAS_DRAGGING_MS = 50;

/** A drop whose gap never sees its card land (a failed move that reloads) closes after this. */
const DROP_HANDOFF_FALLBACK_MS = 1000;

interface UseBoardDragDropParams {
  swimlanes: SwimlaneType[];
  tasks: Task[];
  archivedTasks: Task[];
}

interface UseBoardDragDropResult {
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: CollisionDetection;
  /** The DndContext's modifiers: a locked workflow card stays over its own column. */
  modifiers: Modifier[];
  handleDragStart: (event: DragStartEvent) => void;
  handleDragMove: (event: DragMoveEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragEnd: (event: DragEndEvent) => Promise<void>;
  handleDragCancel: () => void;
  /**
   * KanbanBoard calls this from a layout effect on `tasksPerLane`: once the
   * dropped card is in its lane, the drop gap hands over to it. `boardTasks` is
   * the unfiltered list, for a dropped card the board filter keeps out of
   * `lanes`.
   */
  settleDropHandoff: (lanes: ReadonlyMap<string, readonly Task[]>, boardTasks: readonly Task[]) => void;
  activeTask: Task | null;
  sortableColumnIds: string[];
  dropAnimation: DropAnimation;
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

  // The column a locked workflow card is held to for this drag (its workflow
  // runs and only the workflow moves it, `isLockedOnBoard`), or null. The
  // card can still be reordered there, so a person can regroup a column, but
  // the drag never reaches another column: collisions see only this column's
  // cards, and the card itself moves up and down only (`modifiers`). Set at
  // the drag's start; main refuses a cross-column move on its own as well.
  const lockedLaneRef = useRef<string | null>(null);

  const modifiers = useMemo<Modifier[]>(() => [
    ({ transform }) => (lockedLaneRef.current ? { ...transform, x: 0 } : transform),
  ], []);

  // True between beginBoardDrag() and its paired endBoardDrag(). Read only by
  // the unmount cleanup below to recover the reload gate if the <DndContext>
  // unmounts mid-drag (dnd-kit fires no dragEnd/dragCancel in that case).
  const dragInFlightRef = useRef(false);

  // The cross-column drop gap (board-drop-preview.ts): the lane whose cards are
  // parted for this drag and the slot they part at, or null. Refs and direct
  // DOM, like the drop highlight, so a pointer move never re-renders the board.
  const dropGapRef = useRef<{ laneId: string; slot: number } | null>(null);
  // Whether the workflow lock refuses this drag's card each lane, asked once per
  // lane per drag rather than on every pointer move.
  const refusalByLaneRef = useRef<Map<string, boolean>>(new Map());
  // The last target lane's drop order, kept while `tasks` is unchanged so a
  // pointer move does not re-filter and re-sort the board.
  const laneTasksCacheRef = useRef<{ tasks: Task[]; laneId: string; activeId: string; laneTasks: Task[] } | null>(null);
  // A drop whose gap stays open until the dropped card lands in its lane.
  const dropHandoffRef = useRef<{ laneId: string; taskId: string } | null>(null);
  const dropTimersRef = useRef<{
    fallback: ReturnType<typeof setTimeout> | null;
    settle: ReturnType<typeof setTimeout> | null;
    frame: number | null;
  }>({ fallback: null, settle: null, frame: null });

  // Never the stock KeyboardSensor: it arms on a mouse-focused card and cannot
  // end on a click. See intent-keyboard-sensor.ts and keyboard-drag-intent.md.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(IntentKeyboardSensor, {
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

    // A locked workflow card reorders among its own column's cards and reaches
    // nothing else. Held in Done (an archived card), it has nowhere to go.
    const lockedLane = lockedLaneRef.current;
    if (lockedLane) {
      if (lockedLane === doneLaneId) return [];
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => {
          const containerId = String(container.id);
          return !containerId.startsWith('column:') && !swimlaneIds.has(containerId) && findSwimlane(containerId) === lockedLane;
        }),
      });
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
    //
    // Cost, measured on the production build (2026-09-16 drag audit, event timing
    // on a 27-card board): the whole pointermove handler, this callback included,
    // runs under 0.2ms. The filter passes below are not worth caching across the
    // gesture; the one pass that was wasted on the common path (the lane list only
    // the fallback reads) now lives in that branch.
    const activeColumn = findSwimlane(String(args.active.id));

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
    const otherSwimlaneContainers = args.droppableContainers.filter((container) => {
      const containerId = String(container.id);
      return !containerId.startsWith('column:') && swimlaneIds.has(containerId) && containerId !== activeColumn;
    });
    return closestCenter({ ...args, droppableContainers: otherSwimlaneContainers });
  }, [findSwimlane, doneLaneId, swimlaneIds]);

  /**
   * Toggle .drop-highlight class on swimlane DOM elements without React re-render.
   * Only the class: the lane carries its `--drop-color` from render (Swimlane),
   * because writing that inherited property here restyled the whole lane.
   */
  const updateDropHighlight = useCallback((targetId: string | null) => {
    const previousId = hoveringSwimlaneIdRef.current;
    if (previousId === targetId) return;
    if (previousId) {
      document.querySelector(`[data-swimlane-id="${previousId}"]`)?.classList.remove('drop-highlight');
    }
    if (targetId) {
      document.querySelector(`[data-swimlane-id="${targetId}"]`)?.classList.add('drop-highlight');
    }
    hoveringSwimlaneIdRef.current = targetId;
  }, []);

  const cancelDropTimers = useCallback(() => {
    const timers = dropTimersRef.current;
    if (timers.fallback !== null) clearTimeout(timers.fallback);
    if (timers.settle !== null) clearTimeout(timers.settle);
    if (timers.frame !== null) cancelAnimationFrame(timers.frame);
    timers.fallback = null;
    timers.settle = null;
    timers.frame = null;
  }, []);

  /** Close the drop gap at once, wherever it is, and forget a pending handoff. */
  const clearDropGap = useCallback(() => {
    cancelDropTimers();
    dropHandoffRef.current = null;
    dropGapRef.current = null;
    clearDropGapDom();
  }, [cancelDropTimers]);

  /** The target lane's drop order, from the cache while `tasks` is unchanged. */
  const laneTasksFor = useCallback((laneId: string, activeId: string): Task[] => {
    const tasksNow = useBoardStore.getState().tasks;
    const cached = laneTasksCacheRef.current;
    if (cached && cached.tasks === tasksNow && cached.laneId === laneId && cached.activeId === activeId) {
      return cached.laneTasks;
    }
    const laneTasks = laneTasksForDrop(tasksNow, laneId, activeId);
    laneTasksCacheRef.current = { tasks: tasksNow, laneId, activeId, laneTasks };
    return laneTasks;
  }, []);

  /**
   * Part the target lane's cards at the slot the drop would use, and move its
   * blank slot card there. Runs from both handleDragOver and handleDragMove:
   * onDragOver fires only when `over` changes, and the slot can change under
   * the same `over` (past the last card, or cards of unequal height). The slot
   * is computed from event data alone; the DOM is touched only when the lane or
   * the slot changes.
   */
  const updateDropGap = useCallback((event: DragMoveEvent) => {
    const activeId = String(event.active.id);
    const originLaneId = dragOriginRef.current;
    const targetLaneId = event.over ? findSwimlane(String(event.over.id)) ?? null : null;

    let refused = false;
    if (targetLaneId && originLaneId && targetLaneId !== originLaneId && !activeId.startsWith('column:')) {
      const known = refusalByLaneRef.current.get(targetLaneId);
      if (known !== undefined) {
        refused = known;
      } else {
        // An archived card is not in `tasks`; its drop restores rather than
        // moves, and nothing refuses a restore.
        const movingTask = useBoardStore.getState().tasks.find((candidate) => candidate.id === activeId);
        refused = movingTask ? refusedBoardMove(movingTask, targetLaneId, swimlanes) !== null : false;
        refusalByLaneRef.current.set(targetLaneId, refused);
      }
    }

    const laneId = dropGapTarget({
      activeId,
      originLaneId,
      targetLaneId,
      doneLaneId,
      lockedLaneId: lockedLaneRef.current,
      refused,
    });
    const previous = dropGapRef.current;
    if (!laneId) {
      if (previous) {
        const previousList = laneTaskList(previous.laneId);
        if (previousList) closeDropGap(previousList);
        dropGapRef.current = null;
      }
      return;
    }

    const ghost = event.active.rect.current.translated;
    if (!ghost) return;
    const laneTasks = laneTasksFor(laneId, activeId);
    const slot = getInsertionIndex(event, laneTasks);
    if (previous && previous.laneId === laneId && previous.slot === slot) return;

    if (previous && previous.laneId !== laneId) {
      const previousList = laneTaskList(previous.laneId);
      if (previousList) closeDropGap(previousList);
    }
    const list = laneTaskList(laneId);
    if (!list) {
      dropGapRef.current = null;
      return;
    }
    applyDropGap(list, laneTasks, slot, ghost.height + CARD_GAP_PX);
    // The overlay's card is the card as it will land, so the slot shows it.
    placeDropSlot(list, laneTasks, slot, ghost.height, document.querySelector<HTMLElement>('.drag-overlay [data-task-id]'));
    dropGapRef.current = { laneId, slot };
  }, [findSwimlane, doneLaneId, swimlanes, laneTasksFor]);

  /** Keep the gap open until the dropped card lands in `laneId` (settleDropHandoff). */
  const beginDropHandoff = useCallback((laneId: string, taskId: string) => {
    cancelDropTimers();
    dropGapRef.current = null;
    dropHandoffRef.current = { laneId, taskId };
    dropTimersRef.current.fallback = setTimeout(() => {
      dropTimersRef.current.fallback = null;
      clearDropGap();
    }, DROP_HANDOFF_FALLBACK_MS);
  }, [cancelDropTimers, clearDropGap]);

  const settleDropHandoff = useCallback((lanes: ReadonlyMap<string, readonly Task[]>, boardTasks: readonly Task[]) => {
    const handoff = dropHandoffRef.current;
    if (!handoff) return;
    if (!lanes.get(handoff.laneId)?.some((task) => task.id === handoff.taskId)) {
      // In the lane, but not in its bucket: the board filter hides it. Done's
      // completed list ignores the filter, so a card it hides can be dragged out
      // of Done. It never takes the slot's place, so the gap closes now rather
      // than wait for the fallback.
      if (boardTasks.some((task) => task.id === handoff.taskId && task.swimlane_id === handoff.laneId)) clearDropGap();
      return;
    }
    dropHandoffRef.current = null;
    cancelDropTimers();
    settleDropGap();
    // Hold the settle past dnd-kit's `wasDragging` window, then two frames for
    // the derived transforms it set in that window to clear. Measured in the UI
    // tier: with no settle a parted card jumps 76px back toward its drag-start
    // place on the frame after the drop; the derived transform there cleared
    // within a frame, but it is cleared from a passive effect, which no frame
    // bounds, so the hold runs to the end of the window that can set one.
    const timers = dropTimersRef.current;
    timers.settle = setTimeout(() => {
      timers.settle = null;
      timers.frame = requestAnimationFrame(() => {
        timers.frame = requestAnimationFrame(() => {
          timers.frame = null;
          releaseDropSettle();
        });
      });
    }, SORTABLE_WAS_DRAGGING_MS);
  }, [cancelDropTimers, clearDropGap]);

  // Clean up stale drop highlights and drop gaps on unmount (e.g. HMR replaces
  // this component mid-drag, so handleDragEnd/handleDragCancel never fire).
  useEffect(() => {
    return () => {
      updateDropHighlight(null);
      clearDropGap();
    };
  }, [updateDropHighlight, clearDropGap]);

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
    // A drop gap left from the last drop (a handoff still waiting, or a settle
    // still held) goes now: a held settle pins cards to their resting transform
    // with no transition, which would freeze this drag's own reordering.
    clearDropGap();
    refusalByLaneRef.current = new Map();
    laneTasksCacheRef.current = null;
    // Park background reloads for the duration of the drag (session pushes still
    // apply; only a full reload re-measures a lane). Flushed in handleDragEnd/Cancel.
    beginBoardDrag();
    dragInFlightRef.current = true;
    const id = event.active.id as string;
    // A drag of another card ends the workflow links overlay, and a load of
    // one still in flight. A drag of the card whose links are up keeps them:
    // the overlay follows it every frame while it is reordered (KanbanBoard
    // passes it `dragging`).
    const workflowState = useWorkflowStore.getState();
    const draggingFocus = workflowState.linkFocus?.taskId === id;
    if (!draggingFocus && (workflowState.linkFocus || workflowState.linkFocusLoading)) workflowState.clearLinks();
    lockedLaneRef.current = null;
    if (!id.startsWith('column:')) {
      const swimlaneId = taskToSwimlane.get(id);
      if (swimlaneId) {
        const state = useBoardStore.getState();
        const task = state.tasks.find((candidate) => candidate.id === id)
          ?? state.archivedTasks.find((candidate) => candidate.id === id);
        if (task) {
          const workflow = task.workflow_id ? boardWorkflowNow(task) : null;
          lockedLaneRef.current = workflow && isLockedOnBoard(workflow) ? task.swimlane_id : null;
          setActiveTask(task);
          dragOriginRef.current = task.swimlane_id;
          const sourceElement = document.querySelector(`[data-task-id="${id}"]`);
          dragStartRectRef.current = sourceElement?.getBoundingClientRect() ?? null;
          // A worktree-backed card may be heading for Done, whose pending-changes
          // probe fetches remotes after the release (the sticky part of a Done drop:
          // 640 to 1150ms on the dogfooding instance against a 500ms fly). Start that
          // fetch now, under the gesture, so the probe either finds it cached or joins
          // it already in flight. Fire-and-forget and non-interactive; it cannot fail
          // the drag, and main skips it when background fetching is turned off.
          if (task.worktree_path) {
            void window.electronAPI.git.prefetchRemotes(task.worktree_path).catch(() => {});
          }
        }
      }
    }
  }, [taskToSwimlane, clearDropGap]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    updateDropGap(event);
  }, [updateDropGap]);

  // Track which swimlane the pointer is hovering over for column highlights.
  // Done is excluded - it has its own drop-zone animation (green spinning border)
  // via useDroppable's isOver, so the generic blue ring would conflict.
  // Uses ref + direct DOM class toggling to avoid React re-renders on every mouse move.
  const handleDragOver = useCallback((event: DragOverEvent) => {
    updateDropGap(event);
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
  }, [findSwimlane, doneLaneId, updateDropHighlight, updateDropGap]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    const originalSwimlane = dragOriginRef.current;
    const stashedStartRect = dragStartRectRef.current;
    lockedLaneRef.current = null;
    dragOriginRef.current = null;
    dragStartRectRef.current = null;
    setActiveTask(null);
    updateDropHighlight(null);
    // A drop into the lane whose cards are parted keeps the gap open until the
    // card lands there (settleDropHandoff), so the cards never close up for a
    // frame before it arrives. Every other ending closes it now. The gap only
    // exists for a move the drop below makes: not Done, not the card's own lane,
    // not a locked card, not a refused move.
    const dropGap = dropGapRef.current;
    if (dropGap && over && findSwimlane(String(over.id)) === dropGap.laneId) {
      beginDropHandoff(dropGap.laneId, String(active.id));
    } else {
      clearDropGap();
    }
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

      // Restored where the cards parted for it, by the same rule as a move.
      const position = getInsertionIndex(event, laneTasksForDrop(state.tasks, targetSwimlaneId, taskId));
      await state.unarchiveTask({ id: taskId, targetSwimlaneId, position });
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

    // --- A workflow's lock ---
    // Asked before anything moves or flies, with main's own predicate, so a
    // refused card goes back to its column (the reload undoes the drag-over
    // placement) and the reason shows with the card's links.
    const movingTask = state.tasks.find((candidate) => candidate.id === taskId);
    const refusal = movingTask ? refusedBoardMove(movingTask, targetSwimlaneId, swimlanes) : null;
    if (movingTask && refusal) {
      clearDropGap();
      useBoardStore.getState().loadBoard();
      showWorkflowRefusal(movingTask, refusal, () => useBoardStore.getState().setActiveView('workflows'));
      return;
    }

    // The same function the drop gap used, so the card lands where the gap was.
    const targetPosition = getInsertionIndex(event, laneTasksForDrop(state.tasks, targetSwimlaneId, taskId));

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

      // The card's own kept links followed it through the drag. Flying into
      // Done it has no card on the board to draw them to, so they end here
      // rather than leave the board dimmed with no lines for the flight.
      const workflowState = useWorkflowStore.getState();
      if (workflowState.linkFocus?.taskId === taskId) workflowState.clearLinks();

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
      clearDropGap();
      await useBoardStore.getState().loadBoard();
      useToastStore.getState().addToast({
        message: `Drag failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  }, [moveTask, setCompletingTask, addCompletingTaskId, requestDoneConfirmAnimated, requestDoneConfirmDirect, findSwimlane, swimlanes, reorderSwimlanes, reorderTaskInColumn, updateDropHighlight, beginDropHandoff, clearDropGap]);

  const handleDragCancel = useCallback(() => {
    // Flush any updates that were held while the drag was active.
    dragInFlightRef.current = false;
    endBoardDrag();
    setActiveTask(null);
    updateDropHighlight(null);
    clearDropGap();
    lockedLaneRef.current = null;
    dragOriginRef.current = null;
    dragStartRectRef.current = null;
    useBoardStore.getState().loadBoard();
  }, [updateDropHighlight, clearDropGap]);

  return {
    sensors,
    collisionDetection,
    modifiers,
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    settleDropHandoff,
    activeTask,
    sortableColumnIds,
    dropAnimation,
  };
}
