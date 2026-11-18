import { accountDisplayName, type AgentAccount } from '../../shared/agent-accounts';
import { loginOf, sameLogin } from './account-identity';

/**
 * A task's agent moves its own session to another of the user's listed accounts (task #1113), so
 * it never needs to suggest `/login`, which would replace the login of the home it runs in. The
 * MCP tool `kangentic_switch_account` asks this; the accounts handler builds the switcher with
 * `createTaskAccountSwitcher`, since the restart needs the session manager and the task lock.
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

/** A task's live session, as the switcher needs it. */
export interface SwitchableSession {
  id: string;
  projectId: string;
  accountId: string | null;
}

/** What the switcher reads and drives, so tests run it with no session manager. */
export interface TaskAccountSwitcherDependencies {
  /** The task's live, non-transient, running session, or null when it has none. */
  liveSession(taskId: string): SwitchableSession | null;
  /** The agent a session runs. */
  agentOf(sessionId: string): string | undefined;
  /** Null when the agent has no accounts; false when its conversations stay on their account. */
  sessionsCanMove(agent: string): boolean | null;
  /** The agent's accounts in run order. */
  ordered(agent: string): AgentAccount[];
  /** Calls `listener` with each session whose turn ends; returns the unsubscribe. */
  onTurnEnded(listener: (sessionId: string) => void): () => void;
  /** Restarts the task's session in place on `accountId`, resuming its conversation. */
  restartOn(session: { sessionId: string; taskId: string; projectId: string }, accountId: string, prompt: string): Promise<boolean>;
  reportFailure(error: unknown): void;
  /** How long the switch waits for the turn to end before it restarts the session anyway. */
  turnEndBoundMs: number;
}

export interface TaskAccountSwitcherHandle {
  switchAccount: TaskAccountSwitcher;
  /** Drops every switch still waiting for its turn to end (app quit). */
  dispose(): void;
}

/**
 * The switcher behind `kangentic_switch_account`. The call answers first; the restart waits for
 * the session's turn to end, or `turnEndBoundMs` for an agent that keeps working. A later call for
 * the same task replaces one still waiting, so the last account asked for is the one it moves to.
 */
export function createTaskAccountSwitcher(dependencies: TaskAccountSwitcherDependencies): TaskAccountSwitcherHandle {
  const pending = new Map<string, () => void>();
  const cancelPending = (taskId: string): void => {
    pending.get(taskId)?.();
  };

  const switchAccount: TaskAccountSwitcher = async (taskId, requested) => {
    const live = dependencies.liveSession(taskId);
    if (!live) return { ok: false, reason: 'no-session', runnable: [], current: null };
    const agent = dependencies.agentOf(live.id);
    const canMove = agent ? dependencies.sessionsCanMove(agent) : null;
    if (!agent || canMove === null) return { ok: false, reason: 'no-accounts', runnable: [], current: null };
    const accounts = dependencies.ordered(agent);
    const nameOf = (account: AgentAccount): string => accountDisplayName(account) ?? 'the agent\'s own login';
    const currentAccount = accounts.find((account) => account.id === live.accountId) ?? null;
    const current = currentAccount ? nameOf(currentAccount) : null;
    const runnable = accounts.filter((account) => account.status === 'ok' && account.id !== currentAccount?.id).map(nameOf);
    if (!canMove) return { ok: false, reason: 'stays-on-account', runnable, current };
    const wanted = requested.toLowerCase();
    const named = accounts.filter((account) => (accountDisplayName(account) ?? '').toLowerCase() === wanted);
    if (named.length === 0) return { ok: false, reason: 'unknown-account', runnable, current };
    const isCurrentLogin = (account: AgentAccount): boolean =>
      currentAccount !== null && (currentAccount.id === account.id || sameLogin(loginOf(currentAccount), loginOf(account)));
    // One email can name two accounts, in two organizations: the one that can run and is not the
    // login this session already runs as.
    const target = named.find((account) => account.status === 'ok' && !isCurrentLogin(account))
      ?? named.find((account) => account.status === 'ok')
      ?? named[0];
    if (target.status !== 'ok') return { ok: false, reason: 'not-signed-in', runnable, current };
    if (isCurrentLogin(target)) {
      // Asked to stay: a switch still waiting for this task is dropped.
      cancelPending(taskId);
      return { ok: false, reason: 'already-on-account', runnable, current };
    }
    cancelPending(taskId);
    const targetName = nameOf(target);
    let stopListening = (): void => {};
    const cancel = (): void => {
      clearTimeout(bound);
      stopListening();
      if (pending.get(taskId) === cancel) pending.delete(taskId);
    };
    const restart = (): void => {
      cancel();
      // The session the agent asked from is gone (stopped, moved, or already restarted): there is
      // nothing to move.
      if (dependencies.liveSession(taskId)?.id !== live.id) return;
      const prompt = `Continue. This session now runs as ${targetName}, the account you switched to.`;
      void dependencies.restartOn({ sessionId: live.id, taskId, projectId: live.projectId }, target.id, prompt).catch((error: unknown) => {
        // report-ok: handed to `reportFailure`, which the accounts handler binds to its chokepoint reporter.
        dependencies.reportFailure(error);
      });
    };
    const bound = setTimeout(restart, dependencies.turnEndBoundMs);
    bound.unref?.();
    stopListening = dependencies.onTurnEnded((sessionId) => {
      if (sessionId === live.id) restart();
    });
    pending.set(taskId, cancel);
    return { ok: true, accountName: targetName, agent };
  };

  return {
    switchAccount,
    dispose: () => {
      for (const cancel of [...pending.values()]) cancel();
      pending.clear();
    },
  };
}
