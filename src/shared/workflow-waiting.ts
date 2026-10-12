/**
 * What a workflow task's footer says while it waits in To Do, worded once for
 * every card that shows it: the board card (from the workflow summaries), the
 * Workflows canvas card (from the workflow's detail), and the phone (which
 * reads the same summaries' `waitingFor`). Two copies of this drifted once: the
 * board said a task was blocked while the canvas said it was queued.
 */

/**
 * A blocker the read could not name: its link holds, but its project's database
 * would not open, so its number is unknown. A blocker that is provably gone is
 * not one of these: the engine drops its link (`linkEndState`).
 */
export const UNNAMED_BLOCKER_LABEL = 'a task';

/**
 * `pending` names what the task waits for that is not done ("#413", or
 * `UNNAMED_BLOCKER_LABEL`); `paused` is its workflow's pause.
 */
export function waitingLabel(pending: readonly string[], paused: boolean): { label: string; paused: boolean } {
  if (pending.length === 1) return { label: `Blocked by ${pending[0]}...`, paused: false };
  if (pending.length > 1) return { label: `Blocked by ${pending.length} tasks...`, paused: false };
  if (paused) return { label: 'Paused', paused: true };
  return { label: 'Queued...', paused: false };
}
