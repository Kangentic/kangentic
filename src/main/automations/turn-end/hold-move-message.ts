import type { IpcContext } from '../../ipc/ipc-context';
import { holdTaskMessage } from '../../held-messages/held-messages';
import type { MoveMessageOutcome } from './move-message-outcome';

/** The two ways a hold ends. */
export type MoveMessageHoldOutcome = Extract<MoveMessageOutcome, { kind: 'held' | 'not-held' }>;

/**
 * Hold a moved task's message for its next agent and report which way it
 * went. The move delivery (`deliverMessageAfterMove`) and workflow recovery,
 * when it took the message and could not send it, both end here.
 *
 * Never throws: a hold that fails is reported as not held, so a run never
 * keeps saying the message waits. The caller logs, with its own reason.
 */
export function holdMoveMessage(
  context: IpcContext,
  input: { projectId: string; taskId: string; message: string },
  report: (outcome: MoveMessageOutcome) => void,
): MoveMessageHoldOutcome {
  let outcome: MoveMessageHoldOutcome;
  try {
    const held = holdTaskMessage(context, input);
    outcome = held.status === 'held' ? { kind: 'held' } : { kind: 'not-held', reason: held.error };
  } catch (error) {
    outcome = { kind: 'not-held', reason: error instanceof Error ? error.message : String(error) };
  }
  report(outcome);
  return outcome;
}
