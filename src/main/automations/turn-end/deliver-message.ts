import type { AutoCommandMode } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import type { CommandVerifier } from '../../pty/terminal-submit';
import { resolveInjectionVerifier } from '../../ipc/helpers/agent-spawn';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { waitForTurnCompletion } from '../../transition-engine/turn-completion';
import { PAINT_GIVE_UP_MS } from '../../transition-engine/paint-give-up';
import {
  MOVE_FOLLOW_UP_HANDED_TO_RECOVERY,
  markMoveFollowUpSending,
  trackMessageDelivery,
  trackTurnEndFollowUp,
} from './turn-end-passes';
import { deliverAgentMessageAndWait } from './agent-message-delivery';
import { holdMoveMessage } from './hold-move-message';
import { workflowStepApplies } from '../../workflows/workflow-step';
import { moveMessageOutcomeDetail, type MoveMessageOutcome } from './move-message-outcome';

/**
 * Deliver an automation's message to a running session and WAIT for it to
 * land, choosing the delivery by what the message is.
 *
 * Keystrokes or a paste, by the one decision every delivery path shares
 * (`shouldPaste`, `agent-message-delivery.ts`). At a turn end the multi-line
 * case is the common one, not an edge: a Move to column row hands the next
 * column the reviewer's `{{agentReply}}`, a verdict of thousands of characters
 * across many lines. A paste here waits for the agent's turn to end first,
 * whatever the row's mode, because a paste into a running turn is a paste into
 * the middle of the agent's work.
 *
 * Bounded by `signal`, the automation run's own.
 */
export async function deliverMessageToSession(
  context: IpcContext,
  input: {
    taskId: string;
    sessionId: string;
    message: string;
    mode: AutoCommandMode;
    verifier: CommandVerifier | null;
    signal: AbortSignal;
    /**
     * A running workflow's held turn end, or a recovery nudge: a paste's turn
     * wait also takes a turn the agent ended whose session only background
     * work it left keeps thinking. Its agent sits at its prompt, and that work
     * may never drain.
     */
    acceptHeld?: boolean;
    /** A paste's turn wait takes an idle session that never goes quiet after this long (`waitForTurnCompletion`). */
    idleWithoutQuietMs?: number;
  },
): Promise<void> {
  await deliverAgentMessageAndWait(context, {
    ...input,
    turnWait: 'always',
    abortReason: 'The message was not delivered before the automation was stopped.',
  });
}

/** How long a moved task's message waits for the agent where the task lands. */
const FOLLOW_UP_WAIT_MS = 60 * 60_000;
/** A beat for the destination's own enter message to start its turn first. */
const FOLLOW_UP_SETTLE_MS = 3_000;

/**
 * Hand a message to the agent where a task just landed: a Move to column row's
 * Message, or `kangentic_move_task`'s `message`. Runs in the background, after
 * the move.
 *
 * It waits for that agent's turn to end, so it lands AFTER the destination
 * column's own On task enter rows (a message they sent starts a turn first),
 * and so a long first turn there never holds up the move that triggered it.
 *
 * The message is never dropped without a word (#804). Each way it ends is
 * logged, and on a row's run (`runId`) its detail is rewritten to say which:
 *
 * - **Delivered.** An idle agent whose CLI keeps painting its status line (its
 *   own background agents, after a resume) never gives the 1.5 s of quiet the
 *   wait asks for, so after `PAINT_GIVE_UP_MS` idle the turn counts as over,
 *   as a turn-end pass's does (`turnSettled`). A running workflow's task also
 *   takes a turn held only by background work its agent left, as its turn-end
 *   pass and recovery nudge do.
 * - **Held** for the task's next agent (src/main/held-messages): where no agent
 *   runs on the task (a column that starts none, a paused agent, a spawn that
 *   failed), the agent exits before its turn ends, its turn has not ended in
 *   `FOLLOW_UP_WAIT_MS`, or the delivery failed with the session gone. A hold
 *   with a live agent hands it over once that agent's turn ends. A move into
 *   Done holds nothing, so there it is logged and recorded as not held.
 * - **Superseded** by a move made meanwhile (`supersedeTurnEndWork`): the
 *   message was for a column the task left, so nothing is held.
 * - **Taken by workflow recovery**, which sends it in place of its nudge and
 *   records the outcome itself (`takeMoveFollowUpMessage`).
 * - **Failed** while the agent is still there: the error is recorded.
 */
export async function deliverMessageAfterMove(
  context: IpcContext,
  projectId: string,
  taskId: string,
  columnName: string,
  message: string,
  runId?: string,
): Promise<void> {
  const taskLabel = taskId.slice(0, 8);
  const report = (outcome: MoveMessageOutcome): void => {
    if (runId === undefined) return;
    try {
      getProjectRepos(context, projectId).automationRuns.updateDetail(runId, moveMessageOutcomeDetail(columnName, outcome));
    } catch (error) {
      console.error(`[move-message] Could not record what became of the message for ${columnName} (task ${taskLabel}):`, error);
    }
  };
  const hold = (why: string): void => {
    const outcome = holdMoveMessage(context, { projectId, taskId, message }, report);
    if (outcome.kind === 'held') {
      console.log(`[move-message] ${why}; the moved task's message for ${columnName} is held for the task's agent (task ${taskLabel}).`);
    } else {
      console.warn(`[move-message] ${why}, and the moved task's message for ${columnName} is not held (task ${taskLabel}): ${outcome.reason}`);
    }
  };
  const controller = new AbortController();
  const release = trackTurnEndFollowUp(taskId, controller, { message, report });
  /** A stop by a later move or by recovery: each says its own word. */
  const endIfStopped = (): boolean => {
    if (!controller.signal.aborted) return false;
    if (controller.signal.reason === MOVE_FOLLOW_UP_HANDED_TO_RECOVERY) {
      console.log(`[move-message] Workflow recovery took the moved task's message for ${columnName} to send in place of its nudge (task ${taskLabel}).`);
    } else {
      console.log(`[move-message] The moved task's message for ${columnName} was not delivered: the task moved on first (task ${taskLabel}).`);
      report({ kind: 'superseded' });
    }
    return true;
  };
  let sessionId: string | null = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_SETTLE_MS));
    if (endIfStopped()) return;
    const repos = getProjectRepos(context, projectId);
    const task = repos.tasks.getById(taskId);
    if (!task) {
      console.log(`[move-message] The moved task is gone, so its message for ${columnName} is not delivered (task ${taskLabel}).`);
      report({ kind: 'failed', reason: 'the task is gone.' });
      return;
    }
    // Liveness, not `task.session_id`: a paused agent's id can outlive its PTY.
    const liveSession = context.sessionManager.findLiveSessionByTaskId(taskId);
    sessionId = liveSession && context.sessionManager.isWritable(liveSession.id) ? liveSession.id : null;
    if (!sessionId) {
      hold(`No agent is running in ${columnName}`);
      return;
    }
    const acceptHeld = workflowStepApplies(task, projectId);
    const settled = await waitForTurnCompletion(context.sessionManager, sessionId, {
      signal: controller.signal,
      timeoutMs: FOLLOW_UP_WAIT_MS,
      acceptHeld,
      idleWithoutQuietMs: PAINT_GIVE_UP_MS,
    });
    if (endIfStopped()) return;
    if (settled === 'exited') {
      hold(`The agent in ${columnName} exited before its turn ended`);
      return;
    }
    if (settled === 'timeout') {
      hold(`The agent in ${columnName} did not end its turn within ${FOLLOW_UP_WAIT_MS / 60_000} minutes`);
      return;
    }
    const sessionRepo = new SessionRepository(getProjectDb(projectId));
    // Sending from here: recovery taking the message now would send it twice,
    // and its nudge holds off while a message is on its way.
    markMoveFollowUpSending(taskId, controller);
    const releaseDelivery = trackMessageDelivery(taskId, controller);
    try {
      await deliverMessageToSession(context, {
        taskId,
        sessionId,
        message,
        mode: 'immediate',
        verifier: resolveInjectionVerifier(task.agent, sessionRepo, taskId),
        signal: controller.signal,
        acceptHeld,
        idleWithoutQuietMs: PAINT_GIVE_UP_MS,
      });
    } finally {
      releaseDelivery();
    }
    console.log(`[move-message] Delivered the moved task's message to the agent in ${columnName} (task ${taskLabel}).`);
    report({ kind: 'delivered' });
  } catch (error) {
    if (endIfStopped()) return;
    console.error(`[move-message] The message for ${columnName} was not delivered (task ${taskLabel}):`, error);
    // A session that ended under the delivery took nothing: the next agent gets it.
    if (sessionId !== null && context.sessionManager.findLiveSessionByTaskId(taskId)?.id !== sessionId) {
      hold(`The agent in ${columnName} ended before the message reached it`);
      return;
    }
    report({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
  } finally {
    release();
  }
}
