import { forgetAbandonedTurnsForTask } from './abandoned-turns';
import { forgetWorkflowRecovery } from '../../workflows/workflow-recovery-state';
import type { MoveMessageOutcome } from './move-message-outcome';

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

/**
 * A moved task's message, as workflow recovery takes it: recovery then
 * reports what became of the message itself.
 */
export interface TakenMoveFollowUp {
  message: string;
  /** Records what became of the message (the row's run detail, and the log). */
  report: (outcome: MoveMessageOutcome) => void;
}

/** A moved task's message still waiting for the agent where the task landed. */
interface MoveFollowUp extends TakenMoveFollowUp {
  controller: AbortController;
  /** Its delivery has begun typing or pasting, so recovery may no longer take it. */
  sending: boolean;
}
const followUps = new Map<string, MoveFollowUp>();

/**
 * Why a moved task's message stopped waiting, as its signal's `reason`. The
 * delivery reads back only the hand-over to recovery; any other stop is a
 * later move.
 */
const MOVE_FOLLOW_UP_SUPERSEDED = 'move-follow-up:superseded';
export const MOVE_FOLLOW_UP_HANDED_TO_RECOVERY = 'move-follow-up:handed-to-recovery';

/** Register the running group's controller for a task. Returns its release. */
export function trackTurnEndGroup(taskId: string, controller: AbortController): () => void {
  groupControllers.set(taskId, controller);
  return () => {
    if (groupControllers.get(taskId) === controller) groupControllers.delete(taskId);
  };
}

/** Is a turn-end pass, a recovery attempt or a resume's catch-up acting on this task now? */
export function hasTurnEndGroup(taskId: string): boolean {
  return groupControllers.has(taskId);
}

/** Is a moved task's message still waiting for the agent where the task landed? */
export function hasMoveFollowUp(taskId: string): boolean {
  return followUps.has(taskId);
}

/**
 * Register a message waiting to reach the agent after a Move to column move.
 * A newer one for the same task replaces it: that move took the task on from
 * the column this one was for.
 */
export function trackTurnEndFollowUp(
  taskId: string,
  controller: AbortController,
  followUp: TakenMoveFollowUp,
): () => void {
  followUps.get(taskId)?.controller.abort(MOVE_FOLLOW_UP_SUPERSEDED);
  followUps.set(taskId, { controller, message: followUp.message, report: followUp.report, sending: false });
  return () => {
    if (followUps.get(taskId)?.controller === controller) followUps.delete(taskId);
  };
}

/**
 * The delivery registered with `controller` has begun typing or pasting its
 * message. A later move still stops it; recovery no longer takes it.
 */
export function markMoveFollowUpSending(taskId: string, controller: AbortController): void {
  const followUp = followUps.get(taskId);
  if (followUp?.controller === controller) followUp.sending = true;
}

/**
 * Take a moved task's waiting message for workflow recovery to send in place
 * of its nudge (#804): an agent recovery would ask to carry on has the move's
 * own instructions waiting for it. The waiting delivery stops and records
 * nothing; the taker reports what became of the message. Null when none waits,
 * and when its delivery is already sending it.
 */
export function takeMoveFollowUpMessage(taskId: string): TakenMoveFollowUp | null {
  const followUp = followUps.get(taskId);
  if (!followUp || followUp.sending) return null;
  followUps.delete(taskId);
  followUp.controller.abort(MOVE_FOLLOW_UP_HANDED_TO_RECOVERY);
  return { message: followUp.message, report: followUp.report };
}

/**
 * Stop a task's turn-end work because the task is moving. An abandoned turn
 * end kept for the column it is leaving goes too (`abandoned-turns.ts`), and
 * so does a workflow step's recovery there (`workflow-recovery.ts`).
 */
export function supersedeTurnEndWork(taskId: string, options: { exceptOwnGroup?: boolean } = {}): void {
  if (!options.exceptOwnGroup) groupControllers.get(taskId)?.abort();
  followUps.get(taskId)?.controller.abort(MOVE_FOLLOW_UP_SUPERSEDED);
  forgetAbandonedTurnsForTask(taskId);
  forgetWorkflowRecovery(taskId);
}

/**
 * Column messages pasted in the background (`pasteAgentMessageInBackground`):
 * a multi-line On task enter message, or a re-run of one, waiting for the
 * agent's turn to end before it is pasted. A moved task's message joins them
 * once its delivery starts sending (`deliverMessageAfterMove`).
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

/**
 * Whether a column message is still waiting to be pasted into the task's
 * agent: it is about to get work, so it is not one that is only waiting on
 * the user.
 */
export function hasPendingMessageDelivery(taskId: string): boolean {
  const controllers = messageDeliveryControllers.get(taskId);
  return controllers !== undefined && controllers.size > 0;
}
