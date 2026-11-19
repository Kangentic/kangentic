import type { IpcContext } from '../ipc-context';
import type { LiveSessionFate } from './live-session-fate';
import { MOVE_MESSAGE_MAX_CHARS } from '../../agent/commands/move-message-limit';
import type { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import { holdTaskMessage } from '../../held-messages/held-messages';
import { createChokepointReporter } from '../../analytics/handled-report';
import { RefusalError } from '../../../shared/refusal';

/**
 * An exit row's message on a move that restarts the task's agent (kangentic.com #145).
 *
 * A move that changes the model or effort, or that finds its column full,
 * suspends the live session right after the exit group and resumes the same
 * conversation (`LiveSessionFate` `'restart'` and `'yield'`). A message typed
 * into the session now is cut off about a second later: the transcript shows
 * Claude's "No response requested.", the resumed session opens with no prompt,
 * and the run used to read "Delivered".
 *
 * So the exit hook types nothing and carries the message instead. Once the
 * session is suspended, it is held for the task (`src/main/held-messages`), and
 * the resume claims it into its opening message, after the destination
 * column's own message. Held only then: `holdTaskMessage` hands what it holds
 * to a live agent at once, and the session is still live during the exit group.
 *
 * The run log is English, because an agent reads it.
 */

/** A hold or a run-detail write that threw. Tag `stage`: `hold`, `record`. */
const exitMessageCarryReporter = createChokepointReporter('exit_message_carry');

/** The fates whose exit messages are carried: both resume the same conversation. */
export type CarryingFate = Extract<LiveSessionFate, { kind: 'restart' | 'yield' }>;

/** A message the exit hook kept back from a session the move restarts. */
export interface CarriedExitMessage {
  message: string;
  /** The exit row's run, whose detail is rewritten if the hold fails. */
  runId: string;
}

/** Whether this fate resumes the same conversation, so its exit messages are carried. */
export function fateCarriesExitMessages(fate: LiveSessionFate | null): fate is CarryingFate {
  return fate?.kind === 'restart' || fate?.kind === 'yield';
}

/** The run's detail once the message is carried. */
function carriedDetail(fate: CarryingFate, columnName: string): string {
  if (fate.kind === 'yield') {
    return `Held: ${columnName} is full, so the agent waits there, and the message goes in its resume prompt.`;
  }
  return `Held: moving to ${columnName} restarts the agent to change its ${fate.reason}, so the message goes in its resume prompt.`;
}

/**
 * The run's detail when the suspend threw. The agent may still be running
 * (the hold pastes it once the turn settles), or the suspend may have stopped
 * it or been superseded first (it waits for the task's next agent).
 */
function restartFailedDetail(columnName: string): string {
  return `Held: the restart for ${columnName} did not finish, so the message goes to the agent still running after its turn, or else to the task's next agent.`;
}

/** The run's detail when the hold itself failed. */
function holdFailedDetail(columnName: string, restartFailed: boolean, failure: string): string {
  return restartFailed
    ? `Not delivered: the restart for ${columnName} did not finish, and the message could not be held: ${failure}`
    : `Not delivered: moving to ${columnName} restarted the agent, and the message could not be held for it: ${failure}`;
}

/**
 * Check a message can be carried, then keep it back for `holdCarriedExitMessages`.
 * One longer than a held message may be is refused now, so the run fails with
 * the reason instead of claiming a hold that later fails.
 */
export function carryExitMessage(
  carried: CarriedExitMessage[],
  input: CarriedExitMessage & { fate: CarryingFate; columnName: string },
): string {
  if (input.message.length > MOVE_MESSAGE_MAX_CHARS) {
    throw new RefusalError(
      `Not delivered: moving to ${input.columnName} restarts the agent, and a message carried to its resume can be at most`
      + ` ${MOVE_MESSAGE_MAX_CHARS} characters. This one is ${input.message.length}.`,
    );
  }
  carried.push({ message: input.message, runId: input.runId });
  return carriedDetail(input.fate, input.columnName);
}

/**
 * Hold every carried message for the task, oldest first, once its session is
 * suspended. Takes them out of `carried`, so a second call holds nothing twice.
 * Never throws: a hold that fails rewrites its run's detail and the move goes on.
 * Called from a `finally`, so a suspend that threw (`restartFailed`) still holds
 * them, and each run's detail is rewritten to say the restart did not finish
 * instead of naming a resume.
 */
export function holdCarriedExitMessages(
  context: IpcContext,
  input: {
    projectId: string;
    taskId: string;
    columnName: string;
    carried: CarriedExitMessage[];
    automationRuns: Pick<AutomationRunRepository, 'updateDetail'>;
    restartFailed?: boolean;
  },
): void {
  const taskLabel = input.taskId.slice(0, 8);
  const restartFailed = input.restartFailed === true;
  const rewriteDetail = (runId: string, detail: string): void => {
    try {
      input.automationRuns.updateDetail(runId, detail);
    } catch (error) {
      exitMessageCarryReporter.report(error, { tags: { stage: 'record' } });
      console.error(`[TASK_MOVE] Could not record what became of an exit message for task ${taskLabel}:`, error);
    }
  };
  for (const { message, runId } of input.carried.splice(0)) {
    let failure: string | null = null;
    try {
      const outcome = holdTaskMessage(context, { projectId: input.projectId, taskId: input.taskId, message });
      if (outcome.status === 'refused') failure = outcome.error;
    } catch (error) {
      // A refusal comes back as a status. A throw is a defect or a database
      // failure: reported, then written to the run like a refusal.
      exitMessageCarryReporter.report(error, { tags: { stage: 'hold' } });
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure === null) {
      if (restartFailed) {
        console.warn(`[TASK_MOVE] The restart of task ${taskLabel} did not finish; its exit message is held for the task's agent`);
        rewriteDetail(runId, restartFailedDetail(input.columnName));
      } else {
        console.log(`[TASK_MOVE] Held an exit message for the restarted agent of task ${taskLabel}`);
      }
      continue;
    }
    console.warn(`[TASK_MOVE] An exit message for the restarted agent of task ${taskLabel} could not be held: ${failure}`);
    rewriteDetail(runId, holdFailedDetail(input.columnName, restartFailed, failure));
  }
}
