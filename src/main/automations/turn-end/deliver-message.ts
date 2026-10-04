import type { AutoCommandMode } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import type { CommandVerifier } from '../../pty/terminal-submit';
import { deliverExitMessage } from '../../ipc/helpers/exit-message-delivery';
import { waitForTurnCompletion } from '../../transition-engine/turn-completion';

/**
 * Deliver an automation's message to a running session and WAIT for it to
 * land, choosing the delivery by what the message is.
 *
 * Keystrokes sanitize newlines and tabs to spaces (`sanitizeForPty`), so a
 * message with line breaks typed that way arrives as one line. That is the
 * common case here, not an edge: a Move to column row hands the next column the
 * reviewer's `{{agentReply}}`, a verdict of thousands of characters across many
 * lines. So:
 *
 * - **One line,** the keystroke burst every column message uses, which is also
 *   the only way a slash command runs (a pasted `/code-review` is literal text
 *   to the TUI).
 * - **More than one line, or long,** bracketed paste (`submitContent`), the
 *   path the MCP send tool and the phone use, which keeps the text whole. It
 *   waits for the agent's turn to end first, because a paste into a running
 *   turn is a paste into the middle of the agent's work.
 *
 * Bounded by `signal`, the automation run's own.
 */
const PASTE_THRESHOLD_CHARS = 1_000;
/** How long a paste waits for the agent's turn to end. */
const PASTE_TURN_WAIT_MS = 10 * 60_000;

export function needsPaste(message: string): boolean {
  return message.includes('\n') || message.length > PASTE_THRESHOLD_CHARS;
}

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
  if (!needsPaste(input.message)) {
    await deliverExitMessage(
      context,
      input.taskId,
      input.sessionId,
      input.message,
      input.mode,
      input.verifier,
      input.signal,
      'The message was not delivered before the automation was stopped.',
    );
    return;
  }

  const settled = await waitForTurnCompletion(context.sessionManager, input.sessionId, {
    signal: input.signal,
    timeoutMs: PASTE_TURN_WAIT_MS,
  });
  if (settled === 'exited') throw new Error('The agent exited before the message could be delivered.');
  if (settled === 'aborted') throw new Error('The message was not delivered before the automation was stopped.');
  if (settled === 'timeout') throw new Error("The agent's turn did not end in time to deliver the message.");
  await context.terminalSubmit.submitContent(input.sessionId, input.message, {
    source: 'automation',
    signal: input.signal,
  });
}
