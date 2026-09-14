import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation } from '../../../../shared/automation-describe';
import type { AutomationAdapter } from '../../shared/automation-adapter';

/**
 * Send message to agent. This is what the column's `auto_command` field used to
 * be: the migration moves every existing message into one of these, so the
 * setting did not disappear, it became a row you can reorder, switch off, and
 * put more than one of.
 *
 * It is the only stable type that `needs` the agent, which is what makes the
 * engine start the agent before the first row that needs it, and what makes the
 * picker show it disabled on a column whose "Start an agent here" is off.
 */
export const sendMessageAdapter: AutomationAdapter = {
  id: 'send_message',
  manifest: AUTOMATION_MANIFEST.send_message,

  // Delegated so the row sentence has ONE definition: the renderer draws it
  // on every row in Board setup and cannot import this file.
  describe(config: AutomationConfig): string {
    return describeAutomation('send_message', config);
  },

  /**
   * When this row is the one that starts the agent, the message is better as
   * the agent's opening prompt than as keystrokes typed at a CLI that has not
   * spoken yet. `deliverToAgent` is told whether the slot was taken, so the
   * message is never delivered twice.
   */
  pendingPrompt(config: AutomationConfig): string | undefined {
    return readMessage(config) || undefined;
  },

  async execute(config, context) {
    const message = readMessage(config);
    // A row with no message is not a failure. The picker adds an automation
    // before it has one, and a user can save a draft they came back to later.
    if (!message) return { detail: 'No message to send.' };

    await context.deliverToAgent(message, config.mode ?? 'immediate', context.signal);
    // "Delivered" is deliberately not "Confirmed". Only Claude implements a
    // submission verifier today, so on every other agent a delivery can only be
    // unconfirmed, and the scheduler reports that outcome on its own channel.
    //
    // On exit the engine awaits the burst, so this line is reached only when
    // the keystrokes actually went out; a burst that was cancelled or failed
    // throws and the row records THAT. On enter the promise resolves as soon
    // as delivery is scheduled, which is the honest meaning of the word there.
    return { detail: 'Delivered' };
  },
};

/** `command` is the legacy `send_command` key, read so a migrated row still runs. */
function readMessage(config: AutomationConfig): string {
  return (config.message ?? config.command ?? '').trim();
}
