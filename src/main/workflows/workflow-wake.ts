/**
 * Wake the workflow engine from a write the board bus does not announce: a
 * task or link delete, a workflow started, resumed or edited.
 *
 * A module of its own, holding only a callback the engine sets when it
 * registers, so a handler that deletes a task does not import the engine (and
 * the move path the engine imports) to say so.
 */
let wakeCallback: (() => void) | null = null;

export function setWorkflowWake(callback: (() => void) | null): void {
  wakeCallback = callback;
}

export function wakeWorkflowEngine(): void {
  wakeCallback?.();
}
