import { forgetAbandonedTurnsForTask } from './abandoned-turns';

/**
 * The turn-end work in flight per task, and the background message deliveries,
 * kept apart from the runner so the move path can stop them without importing
 * the runner (which imports the move path).
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

/**
 * Stop a task's turn-end work because the task is moving. An abandoned turn
 * end kept for the column it is leaving goes too (`abandoned-turns.ts`).
 */
export function supersedeTurnEndWork(taskId: string, options: { exceptOwnGroup?: boolean } = {}): void {
  if (!options.exceptOwnGroup) groupControllers.get(taskId)?.abort();
  followUpControllers.get(taskId)?.abort();
  forgetAbandonedTurnsForTask(taskId);
}

/**
 * Column messages pasted in the background (`pasteAgentMessageInBackground`):
 * a multi-line On task enter message, or a re-run of one, waiting for the
 * agent's turn to end before it is pasted.
 *
 * A set per task, not the single slot `trackTurnEndFollowUp` keeps. One enter
 * group can hold two multi-line message rows, and a Move to column follow-up
 * lands after the destination's own enter rows, so registering one must never
 * cancel another.
 */
const messageDeliveryControllers = new Map<string, Set<AbortController>>();

/** Register a background message delivery for a task. Returns its release. */
export function trackMessageDelivery(taskId: string, controller: AbortController): () => void {
  let controllers = messageDeliveryControllers.get(taskId);
  if (!controllers) {
    controllers = new Set();
    messageDeliveryControllers.set(taskId, controllers);
  }
  controllers.add(controller);
  return () => {
    const current = messageDeliveryControllers.get(taskId);
    if (!current) return;
    current.delete(controller);
    if (current.size === 0) messageDeliveryControllers.delete(taskId);
  };
}

/**
 * Stop every background message delivery a task has waiting, because the task
 * left the column that sent them. `handleTaskMove` calls this once the move is
 * known to change columns, not for a reorder within one, which keeps the
 * column and so keeps its message.
 */
export function supersedeMessageDeliveries(taskId: string): void {
  const controllers = messageDeliveryControllers.get(taskId);
  if (!controllers) return;
  messageDeliveryControllers.delete(taskId);
  for (const controller of controllers) controller.abort();
}
