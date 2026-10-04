/**
 * The turn-end work in flight per task, kept apart from the runner so the move
 * path can stop it without importing the runner (which imports the move path).
 *
 * A move supersedes whatever turn-end work the task has going: a group still
 * running for the column the task just left, or a Move to column message still
 * waiting to reach the agent in the column it left before that. A Move to
 * column row's own move is the exception, and passes `exceptOwnGroup`: its
 * group ends with that move anyway, and aborting it would record the move that
 * just succeeded as interrupted.
 */
const groupControllers = new Map<string, AbortController>();
const followUpControllers = new Map<string, AbortController>();

/** Register the running group's controller for a task. Returns its release. */
export function trackTurnEndGroup(taskId: string, controller: AbortController): () => void {
  groupControllers.set(taskId, controller);
  return () => {
    if (groupControllers.get(taskId) === controller) groupControllers.delete(taskId);
  };
}

/** Register a message waiting to reach the agent after a Move to column move. */
export function trackTurnEndFollowUp(taskId: string, controller: AbortController): () => void {
  followUpControllers.get(taskId)?.abort();
  followUpControllers.set(taskId, controller);
  return () => {
    if (followUpControllers.get(taskId) === controller) followUpControllers.delete(taskId);
  };
}

/** Stop a task's turn-end work because the task is moving. */
export function supersedeTurnEndWork(taskId: string, options: { exceptOwnGroup?: boolean } = {}): void {
  if (!options.exceptOwnGroup) groupControllers.get(taskId)?.abort();
  followUpControllers.get(taskId)?.abort();
}
