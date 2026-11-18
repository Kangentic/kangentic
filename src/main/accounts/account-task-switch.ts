/**
 * A task's agent moves its own session to another of the user's listed accounts (task #1113), so
 * it never needs to suggest `/login`, which would replace the login of the home it runs in. The
 * MCP tool `kangentic_switch_account` asks this; the accounts handler supplies the switcher, since
 * the restart needs the session manager and the task lock.
 */

export type TaskAccountSwitchResult =
  | { ok: true; accountName: string; agent: string }
  | {
      ok: false;
      reason: 'unavailable' | 'no-session' | 'no-accounts' | 'stays-on-account' | 'unknown-account' | 'not-signed-in' | 'already-on-account';
      /** The accounts that can run, as the Accounts tab names them, so the agent can pick one. */
      runnable: string[];
      /** The account the session runs as now, when known. */
      current: string | null;
    };

export type TaskAccountSwitcher = (taskId: string, account: string) => Promise<TaskAccountSwitchResult>;

let switcher: TaskAccountSwitcher | null = null;

/** Set once by the accounts handler; null in a process that never set one (unit tests). */
export function setTaskAccountSwitcher(next: TaskAccountSwitcher | null): void {
  switcher = next;
}

export function switchTaskAccount(taskId: string, account: string): Promise<TaskAccountSwitchResult> {
  if (!switcher) return Promise.resolve({ ok: false, reason: 'unavailable', runnable: [], current: null });
  return switcher(taskId, account);
}
