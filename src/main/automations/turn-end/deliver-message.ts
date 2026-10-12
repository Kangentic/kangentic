import type { AutoCommandMode } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import type { CommandVerifier } from '../../pty/terminal-submit';
import { resolveInjectionVerifier } from '../../ipc/helpers/agent-spawn';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { waitForTurnCompletion } from '../../transition-engine/turn-completion';
import { trackTurnEndFollowUp } from './turn-end-passes';
import { deliverAgentMessageAndWait } from './agent-message-delivery';

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
 * and so a long first turn there never holds up the move that triggered it. A
 * move made meanwhile cancels it (`supersedeTurnEndWork`), and a column with
 * no agent has nobody to hand it to, which is logged and dropped.
 */
export async function deliverMessageAfterMove(
  context: IpcContext,
  projectId: string,
  taskId: string,
  columnName: string,
  message: string,
): Promise<void> {
  const controller = new AbortController();
  const release = trackTurnEndFollowUp(taskId, controller);
  try {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_SETTLE_MS));
    if (controller.signal.aborted) return;
    const repos = getProjectRepos(context, projectId);
    const task = repos.tasks.getById(taskId);
    if (!task?.session_id) {
      console.log(`[move-message] No agent in ${columnName} to receive the moved task's message (task ${taskId.slice(0, 8)}).`);
      return;
    }
    const sessionId = task.session_id;
    const settled = await waitForTurnCompletion(context.sessionManager, sessionId, {
      signal: controller.signal,
      timeoutMs: FOLLOW_UP_WAIT_MS,
    });
    if (settled !== 'completed') return;
    const sessionRepo = new SessionRepository(getProjectDb(projectId));
    await deliverMessageToSession(context, {
      taskId,
      sessionId,
      message,
      mode: 'immediate',
      verifier: resolveInjectionVerifier(task.agent, sessionRepo, taskId),
      signal: controller.signal,
    });
  } catch (error) {
    console.error(`[move-message] The message for ${columnName} was not delivered (task ${taskId.slice(0, 8)}):`, error);
  } finally {
    release();
  }
}
