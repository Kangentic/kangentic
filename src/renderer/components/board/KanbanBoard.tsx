import React, { useMemo, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { AlertTriangle, X } from 'lucide-react';
import { Swimlane, type SwimlaneProps } from './Swimlane';
import { DoneSwimlane } from './DoneSwimlane';
import { TaskCard } from './TaskCard';
import { BoardDialogs } from './BoardDialogs';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { useBoardStore } from '../../stores/board-store';
import { useBoardDragDrop } from '../../hooks/useBoardDragDrop';
import { useHmrGeneration } from '../../utils/hmr-generation';
import { parseTicketQuery, matchesTicketPrefix } from '../../../shared/ticket-query';
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

  // Custom columns only: `Swimlane` renders the grip that takes these props and
  // `DoneSwimlane` renders none, so handle props for the Done lane would be a
  // focus stop with nothing to land on.
  const isDraggable = swimlane.role === null;

  // dnd-kit's `attributes` (tabindex, role, aria-*) travel WITH the listeners to
  // the header grip, never to this wrapper. On the wrapper they made every
  // column an invisible `outline-none` focus stop: a click on empty lane space
  // landed focus on it, a screen reader announced it as sortable, and the grip
  // that actually sorts was unreachable from the keyboard. With both on the
  // grip, Tab reaches it and the shared keyboard sensor lifts the column.
  // Memoized because both inputs are stable across renders (dnd-kit memoizes
  // them) and every sortable re-renders on each drag move: a fresh object here
  // would re-render the memoized lane, and every card in it, per move.
  const dragHandleProps = useMemo(
    () => (isDraggable ? { ...attributes, ...listeners } : undefined),
    [isDraggable, attributes, listeners],
  );

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition || undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  if (swimlane.role === 'done') {
    return (
      <div ref={setNodeRef} style={style} className="h-full">
        <DoneSwimlane
          swimlane={swimlane}
          tasks={tasks}
          dragHandleProps={dragHandleProps}
        />
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="h-full">
      <Swimlane
        swimlane={swimlane}
        tasks={tasks}
        dragHandleProps={dragHandleProps}
      />
    </div>
  );
});

/** Fixed-position card that flies from the drop position into the Done drop zone.
 *  Animates compositor-friendly transform + opacity only (never left/top/all),
 *  so the motion stays on the GPU and does not fight the board reflow that fires
 *  when setCompletingTask removes the task from its source column. Over Done the
 *  DragOverlay's keyframe resolver returns identical keyframes so dnd-kit skips
 *  the settle animation (see useBoardDragDrop's resolveDropKeyframes), so this is
 *  the only element in motion on release - there is no snap-back-to-origin
 *  overlay clone competing with it.
 *
 *  Frame 0 matches the DragOverlay's last frame exactly (rotate(3deg) at opacity
 *  0.9, see `.drag-overlay-tilt` in index.css) so the overlay->FlyingCard handoff
 *  has no visible tilt/dim step; the fly un-rotates as part of the motion.
 *
 *  This card mounts the instant a Done drop is detected (setCompletingTask runs
 *  before the worktree probe), but the move does NOT persist here. The card only
 *  REPORTS that its fly finished via markCompletionAnimationDone; the completion
 *  gate joins that with move approval (probe clean / dialog confirmed) and
 *  persists once both land. The fallback timer guarantees the animation-done
 *  signal fires even when onTransitionEnd never does (drop zone not in DOM,
 *  propertyName mismatch, element scrolled offscreen), so a missed transitionend
 *  can never leave completingTask set forever with the card stuck on screen. */
function FlyingCard() {
  const completingTask = useBoardStore((s) => s.completingTask);
  const markCompletionAnimationDone = useBoardStore((s) => s.markCompletionAnimationDone);
  // null while the card sits on its start frame; once the fly begins, the
  // translate vector from the start rect to the Done drop-zone center ({0, 0}
  // when the drop zone is not in the DOM). One value rather than a boolean
  // plus a delta ref: the delta is measured on the frame that flips, so layout
  // is never read during render and nothing needs a ref. The instance is keyed
  // per completion by the parent, so a fresh drop always starts at null.
  const [flight, setFlight] = React.useState<{ dx: number; dy: number } | null>(null);
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
    const { startRect } = completingTask;

    // Trigger transition on next frame so browser paints at start position first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // The delta is computed from the start top-left (translate is
        // evaluated in untransformed pixels, before scale), preserving the
        // original -20 landing offset above the drop-zone center.
        const dropZone = document.querySelector('[data-done-drop-zone]');
        const targetRect = dropZone?.getBoundingClientRect();
        setFlight(targetRect
          ? {
            dx: targetRect.left + targetRect.width / 2 - startRect.width / 2 - startRect.left,
            dy: targetRect.top + targetRect.height / 2 - 20 - startRect.top,
          }
          : { dx: 0, dy: 0 });
        // When the drop zone isn't in the DOM, no transition will run and
        // onTransitionEnd will never fire. Signal animation-done immediately so
        // the gate can persist (once approved) and the card unmounts. Otherwise
        // arm a 700ms fallback (500ms transition + 200ms safety margin).
        if (!targetRect) {
          markCompletionAnimationDone(completingTask.taskId);
        } else {
          fallbackTimerRef.current = setTimeout(() => {
            fallbackTimerRef.current = null;
            markCompletionAnimationDone(completingTask.taskId);
          }, 700);
        }
      });
    });

    return clearFallback;
  }, [completingTask, markCompletionAnimationDone, clearFallback]);

  if (!completingTask) return null;

  const { task, startRect } = completingTask;
  // Reduced motion (OS preference or the in-app Appearance toggle, which adds
  // .no-motion to the root) collapses the fly to a short opacity fade. The
  // .no-motion class only zeroes CSS keyframe durations, not inline
  // transitions, so it must be checked here in JS rather than relied on via CSS.
  const reduceMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || document.documentElement.classList.contains('no-motion');
  const flying = flight !== null;
  const delta = flight ?? { dx: 0, dy: 0 };

  // Static box: position/size never change. Only transform + opacity animate, so
  // the motion is GPU-composited. The transition string is identical across both
  // flying states because Chromium will not start a transition declared on the
  // same render as the property change - the start frame must already carry it.
  const style: React.CSSProperties = {
    position: 'fixed',
    left: startRect.left,
    top: startRect.top,
    width: startRect.width,
    zIndex: 9999,
    pointerEvents: 'none',
    willChange: 'transform, opacity',
    // Frame 0 (flying === false) matches `.drag-overlay-tilt` exactly (opacity
    // 0.9, rotate(3deg)) so the overlay->FlyingCard swap shows no step; the fly
    // then un-rotates and shrinks toward the Done drop zone.
    opacity: flying ? 0 : 0.9,
    transition: reduceMotion
      ? 'opacity 150ms ease-out'
      : 'transform 500ms cubic-bezier(0.4, 0, 0.2, 1), opacity 500ms ease-in',
    transform: reduceMotion
      ? undefined
      : flying
        ? `translate3d(${delta.dx}px, ${delta.dy}px, 0) scale(0.6) rotate(0deg)`
        : 'translate3d(0, 0, 0) scale(1) rotate(3deg)',
  };

  return (
    <div
      className="flying-card"
      style={style}
      onTransitionEnd={(e) => {
        // Transform and opacity share a duration and finish together in the
        // full-motion path; the reduced-motion path animates opacity only.
        // markCompletionAnimationDone is idempotent (no-op once the gate's
        // animationDone flag is set), so a double fire is harmless.
        if (e.propertyName === 'transform' || e.propertyName === 'opacity') {
          clearFallback();
          markCompletionAnimationDone(completingTask.taskId);
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
  // Remount FlyingCard per completion so its `flying`/delta/timer state never
  // leaks across drops. Without a fresh instance, the second card mounts at the
  // prior fly's end frame (opacity:0) and flies invisibly. Keying on the task id
  // also covers dropping a new task on Done while the previous one is still
  // flying (the id changes task1 -> task2 without settling at idle).
  const completingTaskId = useBoardStore((s) => s.completingTask?.taskId);
  // Tasks mid-completion (dropped on Done, flying into the dropzone). Excluded
  // from every lane below so a loadBoard() racing the ~700ms fly can't re-inject
  // the task into its source column for a frame. See tasksPerLane.
  const completingTaskIds = useBoardStore((s) => s.completingTaskIds);
  // Tasks with an optimistic cross-lane move still in flight. The SECOND guard
  // read by tasksPerLane below: completingTaskIds excludes a task from every
  // lane, lanePins redirects one to a different lane. Both exist because
  // loadBoard() has no staleness guard and the server row otherwise wins over
  // an optimistic move. See tasksPerLane and stores/board-store/lane-pins.ts.
  const lanePins = useBoardStore((s) => s.lanePins);
  // Board filter values live in the board store (board-filter-slice) so the
  // toolbar controls in ViewToggle and this filtering chokepoint share one
  // instance. The popover/search UI itself lives in ViewToggle.
  const priorityFilters = useBoardStore((s) => s.priorityFilters);
  const labelFilters = useBoardStore((s) => s.labelFilters);
  const boardSearchQuery = useBoardStore((s) => s.boardSearchQuery);
  const normalizedSearch = boardSearchQuery.trim().toLowerCase();
  // A `#<digits>` query filters by ticket number (display_id, prefix) instead of
  // substring-matching title/description. Parsed once here so tasksPerLane can
  // branch per task. See src/shared/ticket-query.ts.
  const ticketDigits = parseTicketQuery(boardSearchQuery);

  // New Task hotkey (task.create): a nonce increments in the board store; we open
  // a board-level New Task dialog targeting the first actionable (non-Done) lane,
  // defaulting to the To Do column. This mirrors the per-lane "+" button without
  // coupling the global shortcut to any one lane's local state.
  const newTaskRequestNonce = useBoardStore((s) => s.newTaskRequestNonce);
  const newTaskDismissNonce = useBoardStore((s) => s.newTaskDismissNonce);
  const dismissNewTask = useBoardStore((s) => s.dismissNewTask);
  // Derived from BOTH counters in one expression, so whichever was bumped last wins
  // regardless of any effect ordering. Two separate effects once made "close everything,
  // then open this" - exactly what the onboarding walkthrough does when it advances into
  // the create-a-task step - resolve as close-then-close, and the dialog never appeared.
  // The dialog's own close bumps the dismiss counter rather than a local flag, so there
  // is one source of truth and no state to sync.
  const newTaskOpen = newTaskRequestNonce > newTaskDismissNonce;
  const newTaskLaneId = useMemo(() => {
    return (
      swimlanes.find((lane) => lane.role === 'todo')?.id
      ?? swimlanes.find((lane) => lane.role !== 'done')?.id
      ?? swimlanes[0]?.id
      ?? null
    );
  }, [swimlanes]);

  const {
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeTask,
    sortableColumnIds,
    dropAnimation,
  } = useBoardDragDrop({ swimlanes, tasks, archivedTasks });

  // Re-key DndContext on HMR to remount dnd-kit with a clean manager.
  // See src/renderer/utils/hmr-generation.ts; constant 0 in production.
  const hmrGeneration = useHmrGeneration();

  // Stabilize per-lane array identity across renders. When the `tasks` array
  // reference changes (every loadBoard / optimistic update / structural-share
  // pass), we still want lanes whose contents are unchanged to keep the same
  // array reference so that `Swimlane`'s React.memo can bail out. Without
  // this, every store update re-renders all lanes regardless of which one
  // actually changed.
  //
  // The ref is read and written inside the memo, which react-hooks/refs
  // forbids. The compiler-approved alternative (hold the previous map in state
  // and set it during render) costs a second render pass on every board update
  // for the same identities, on the hottest path in the app, so the cache stays
  // a ref. The result is the same on every re-execution: only array identity
  // is reused, never content.
  const stableLanesRef = useRef<Map<string, Task[]>>(new Map());

  /* eslint-disable react-hooks/refs -- structural-sharing cache; see the comment above */
  const tasksPerLane = useMemo(() => {
    const fresh = new Map<string, Task[]>();
    for (const lane of swimlanes) fresh.set(lane.id, []);
    for (const task of tasks) {
      // A completing task belongs to the FlyingCard, not any lane. Skipping it
      // here (the single lane-bucketing chokepoint) keeps it out of both its
      // source column and Done for the whole flight, even if a mid-flight
      // loadBoard() re-injects it at its source swimlane_id from the DB.
      if (completingTaskIds.has(task.id)) continue;
      if (priorityFilters.size > 0 && !priorityFilters.has(task.priority)) continue;
      if (labelFilters.size > 0 && !(task.labels ?? []).some((label) => labelFilters.has(label))) continue;
      if (ticketDigits !== null) {
        // `#<digits>` filters by ticket number (prefix), not text.
        if (!matchesTicketPrefix(task.display_id, ticketDigits)) continue;
      } else if (normalizedSearch) {
        const title = task.title.toLowerCase();
        const description = (task.description ?? '').toLowerCase();
        if (!title.includes(normalizedSearch) && !description.includes(normalizedSearch)) continue;
      }
      // A task whose optimistic move is still in flight renders at its pinned
      // destination, not the lane the server last reported. Without this, a
      // reload issued before the move's DB write (endBoardDrag flushes parked
      // reloads at the top of handleDragEnd, well before moveTask runs) puts
      // the card back in its source column until the move's own reload lands.
      // Falling back to swimlane_id is not cosmetic: if the pinned column was
      // deleted mid-move, `fresh.get(pinnedLaneId)` is undefined and the card
      // would vanish from the board entirely rather than degrade gracefully.
      const pinnedLaneId = lanePins.get(task.id)?.laneId;
      const arr = (pinnedLaneId !== undefined ? fresh.get(pinnedLaneId) : undefined)
        ?? fresh.get(task.swimlane_id);
      if (arr) arr.push(task);
    }
    for (const arr of fresh.values()) arr.sort((a, b) => a.position - b.position);

    const stable = new Map<string, Task[]>();
    const previous = stableLanesRef.current;
    for (const [laneId, freshArray] of fresh) {
      const previousArray = previous.get(laneId);
      if (
        previousArray &&
        previousArray.length === freshArray.length &&
        previousArray.every((task, index) => task === freshArray[index])
      ) {
        stable.set(laneId, previousArray);
      } else {
        stable.set(laneId, freshArray);
      }
    }
    stableLanesRef.current = stable;
    return stable;
  }, [swimlanes, tasks, priorityFilters, labelFilters, normalizedSearch, ticketDigits, completingTaskIds, lanePins]);
  /* eslint-enable react-hooks/refs */

  if (!hydrated) return null;

  return (
    <div className="relative h-full overflow-x-auto overflow-y-hidden flex flex-col">
      <ConfigWarningBanner />
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
      <DndContext
        key={hmrGeneration}
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

        {/* Default settle for normal moves; over Done the resolver returns
            identical keyframes so dnd-kit skips the animation and the FlyingCard
            owns the motion (no snap-back). The resolver reads the live target at
            drop time, so a fast release can't race a stale prop. See
            useBoardDragDrop's resolveDropKeyframes. */}
        <DragOverlay dropAnimation={dropAnimation} style={{ pointerEvents: 'none', willChange: 'transform' }}>
          {activeTask ? (
            // Two layers on purpose. dnd-kit measures the overlay's FIRST CHILD
            // (`getMeasurableNode`) for the collision rect and the drop
            // animation, so `.drag-overlay` carries no transform: with the tilt
            // on it the measured box sat 1.6px left and 7px above the card, the
            // keyboard coordinate getter's "to the right of" test then admitted
            // every same-column sibling, and ArrowRight landed on the card below
            // instead of the next column. Appearance (opacity 0.9, rotate(3deg))
            // lives on `.drag-overlay-tilt` (index.css) so the FlyingCard frame 0
            // can match it exactly.
            <div className="drag-overlay">
              <div className="drag-overlay-tilt">
                <TaskCard task={activeTask} isDragOverlay />
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <FlyingCard key={completingTaskId ?? 'idle'} />
      </div>

      {newTaskOpen && newTaskLaneId && (
        <NewTaskDialog swimlaneId={newTaskLaneId} onClose={dismissNewTask} />
      )}

      <BoardDialogs />
    </div>
  );
}
