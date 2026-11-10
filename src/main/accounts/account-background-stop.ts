import type { AgentAdapter } from '../agent/agent-adapter';
import { getAccountService } from './account-service';

/**
 * `AgentAdapter.stopBackgroundSession` under the account the session ran on (task #1057).
 *
 * A CLI lists only the background sessions of the home it runs under: Claude Code's
 * `claude agents` under one `CLAUDE_CONFIG_DIR` shows none of another's (measured on 2.1.319).
 * A `/bg` session started on a second account is therefore invisible to a stop run on the
 * default home, and the leftover reap would then kill it with no exit of its own. So the stop runs
 * on the session's own account, and where that is unknown, on each of the agent's accounts in
 * turn until one ran. It is reached only on evidence the conversation moved, so an ordinary
 * resume or reap runs no CLI. With no account service (unit tests, an agent without accounts)
 * the call is exactly the adapter's. Never throws.
 */
export async function stopBackgroundSessionOnAccount(
  adapter: AgentAdapter,
  options: { agentSessionId: string; cliPath: string },
  accountId?: string | null,
): Promise<boolean> {
  if (!adapter.stopBackgroundSession) return false;
  let envs: Array<Record<string, string> | undefined> = [undefined];
  try {
    envs = getAccountService()?.envsForBackgroundStop(adapter.name, accountId) ?? [undefined];
  } catch (error) {
    console.warn('[ACCOUNTS] Could not list the accounts to stop a background session on:', error);
  }
  for (const env of envs) {
    if (await adapter.stopBackgroundSession(env ? { ...options, env } : options)) return true;
  }
  return false;
}
