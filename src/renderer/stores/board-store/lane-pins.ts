import type { Task } from '../../../shared/types';
import { applyStructuralSharing } from './structural-sharing';

/**
 * A lane pin overrides which lane ONE task renders in, for the window between
 * an optimistic cross-lane move and the first server payload that reflects it.
 *
 * The problem it solves: `loadBoard()` has no staleness guard and replaces
 * `tasks` wholesale, and `taskContentsMatch` compares `swimlane_id` explicitly,
 * so the server row always wins over an optimistic move. `endBoardDrag()` runs
 * at the very top of `handleDragEnd`, ~190 lines BEFORE `moveTask` is called,
 * and it drains parked reloads synchronously - so a reload's `tasks.list()` is
 * issued strictly before the optimistic update is applied and before the move's
 * DB write lands. When it resolves it reports the pre-move lane and the card
 * visibly snaps back until the move's own reload corrects it.
 *
 * This is the same hazard the Done path already handles with `completingTaskIds`
 * at the `tasksPerLane` chokepoint. See `.claude/rules/board-completing-task-chokepoint.md`.
 */
export interface LanePin {
  /** Lane the card renders in while the pin holds (the move's target). */
  laneId: string;
  /**
   * Pre-move snapshot. The pin holds only while a payload still reports the
   * task at this exact lane AND this exact `updated_at` - i.e. the payload was
   * issued before our write. Anything else means the server has moved past our
   * snapshot and wins.
   */
  fromLaneId: string;
  fromUpdatedAt: string;
}

/**
 * Stable identity for "nothing pinned", so `tasksPerLane` (which takes
 * `lanePins` as a memo dependency) does not invalidate on every store write.
 */
export const EMPTY_LANE_PINS: ReadonlyMap<string, LanePin> = new Map<string, LanePin>();

/**
 * The one invariant: **a lane pin holds only while the server keeps telling us
 * the pre-move story.** The first payload that differs from the snapshot in any
 * of {presence, lane, `updated_at`} drops it.
 *
 * Why the `updated_at` clause is load-bearing rather than belt-and-braces:
 * matching on lane alone leaks forever if the server puts the task BACK at its
 * origin lane (an auto-move, or a genuinely rejected move). Lane would match,
 * the pin would never drop, and the card would be stuck in a phantom column -
 * strictly worse than the bug being fixed. `TaskRepository.move()` bumps
 * `updated_at` only on the moved row (the two position-shift UPDATEs deliberately
 * do not), so a sibling shifting position cannot spuriously drop a pin, and the
 * value round-trips byte-identical through `SELECT t.*` and structured clone.
 *
 * Ordering-proof by construction: a `tasks.list()` issued before the write
 * carries both the pre-move lane and the pre-move stamp, so it can never drop
 * the pin no matter how late it resolves.
 *
 * Returns the same reference when nothing changed.
 */
export function reconcileLanePins(
  pins: ReadonlyMap<string, LanePin>,
  payload: Task[],
): ReadonlyMap<string, LanePin> {
  if (pins.size === 0) return pins;
  const payloadById = new Map<string, Task>();
  for (const task of payload) payloadById.set(task.id, task);

  let next: Map<string, LanePin> | null = null;
  for (const [taskId, pin] of pins) {
    const row = payloadById.get(taskId);
    const stillPreMove = row !== undefined
      && row.swimlane_id === pin.fromLaneId
      && row.updated_at === pin.fromUpdatedAt;
    if (stillPreMove) continue;
    if (next === null) next = new Map(pins);
    next.delete(taskId);
  }
  return next ?? pins;
}

/**
 * Apply a full task-list payload, reconciling lane pins in the SAME `set()`.
 *
 * Every store site that replaces `tasks` from a server payload must go through
 * here. Folding the reconcile into the write (rather than a `useEffect` in
 * `KanbanBoard`) buys three things: the payload and the pin state commit
 * atomically so the store is never transiently self-inconsistent; the invariant
 * does not silently stop holding while the board is unmounted (backlog view,
 * project switch); and "there is one function every task payload goes through"
 * is mechanically enforceable, where "remember to add an effect" is not.
 */
export function applyTaskListPayload(
  state: { tasks: Task[]; lanePins: ReadonlyMap<string, LanePin> },
  nextTasks: Task[],
): { tasks: Task[]; lanePins: ReadonlyMap<string, LanePin> } {
  return {
    tasks: applyStructuralSharing(state.tasks, nextTasks),
    lanePins: reconcileLanePins(state.lanePins, nextTasks),
  };
}
