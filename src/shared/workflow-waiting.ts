/**
 * What a workflow task's footer says while it waits in To Do, worded once for
 * every card that shows it: the board card (from the workflow summaries), the
 * Workflows canvas card (from the workflow's detail), and the phone (which
 * reads the same summaries' `waitingFor`). Two copies of this drifted once: the
 * board said a task was blocked while the canvas said it was queued.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';

/**
 * A blocker the read could not name: its link holds, but its project's database
 * would not open, so its number is unknown. A blocker that is provably gone is
 * not one of these: the engine drops its link (`linkEndState`). English: it
 * crosses to the phone inside `waitingFor`.
 */
export const UNNAMED_BLOCKER_LABEL = 'a task';

/**
 * `pending` names what the task waits for that is not done ("#413", or
 * `UNNAMED_BLOCKER_LABEL`); `paused` is its workflow's pause, or its own
 * automations' (the engine starts neither). `label` is a message: resolve it
 * where it shows.
 */
export function waitingLabel(pending: readonly string[], paused: boolean): { label: MessageDescriptor; paused: boolean } {
  // A whole message, so a translation never carries the English placeholder.
  if (pending.length === 1 && pending[0] === UNNAMED_BLOCKER_LABEL) return { label: msg`Blocked by a task...`, paused: false };
  if (pending.length === 1) return { label: { ...msg({ message: 'Blocked by {blocker}...' }), values: { blocker: pending[0] } }, paused: false };
  if (pending.length > 1) {
    return { label: { ...msg({ message: '{count, plural, one {Blocked by # task...} other {Blocked by # tasks...}}' }), values: { count: pending.length } }, paused: false };
  }
  if (paused) return { label: msg({ message: 'Paused', context: 'workflow state' }), paused: true };
  return { label: msg`Queued...`, paused: false };
}
