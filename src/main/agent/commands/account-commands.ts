import { switchTaskAccount, type TaskAccountSwitchResult } from '../../accounts/account-task-switch';
import type { CommandHandler, CommandResponse } from './types';

/** The accounts an agent can pick from, on one line. */
function runnableLine(runnable: readonly string[]): string {
  return runnable.length > 0 ? ` Accounts that can run: ${runnable.join(', ')}.` : ' No other account is signed in; the user adds one in Settings > Accounts.';
}

/** What the agent is told when the switch is refused, with what to do next. */
function refusalMessage(result: Extract<TaskAccountSwitchResult, { ok: false }>, requested: string): string {
  const current = result.current ? ` This session runs as ${result.current}.` : '';
  switch (result.reason) {
    case 'unavailable':
      return 'Accounts are not available in this Kangentic process.';
    case 'no-session':
      return 'This task has no running agent session to switch.';
    case 'no-accounts':
      return 'This agent has no accounts to switch between in Kangentic.';
    case 'stays-on-account':
      return `This agent's conversations stay on the account that started them, so the session cannot move.${current}`;
    case 'unknown-account':
      return `No listed account is named "${requested}".${current}${runnableLine(result.runnable)}`;
    case 'not-signed-in':
      return `"${requested}" is listed but cannot run now (signed out, or replaced in its folder). Ask the user to choose Sign in on its row in Settings > Accounts.${runnableLine(result.runnable)}`;
    case 'already-on-account':
      return `This session already runs as "${requested}". Nothing to switch.`;
  }
}

/**
 * `kangentic_switch_account`: restarts the calling task's own session on another listed account,
 * resuming its conversation, once its current turn ends. The task is the caller's, never a
 * parameter, so an agent can only move itself.
 */
export const handleSwitchAccount: CommandHandler = async (params, context): Promise<CommandResponse> => {
  const requested = typeof params.account === 'string' ? params.account.trim() : '';
  if (!requested) return { success: false, error: 'Name the account to switch to: its email as Settings > Accounts lists it.' };
  const taskId = context.callerTaskId ?? null;
  if (!taskId) return { success: false, error: 'Only a task\'s own agent can switch its account. This call came from outside a task session.' };
  const result = await switchTaskAccount(taskId, requested);
  if (!result.ok) return { success: false, error: refusalMessage(result, requested) };
  return {
    success: true,
    message: `Switching to ${result.accountName}. End your turn now: when it ends, Kangentic restarts this session on that account and resumes this conversation with a message that names the account.`,
  };
};
