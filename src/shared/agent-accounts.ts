import type { RateLimitWindow } from './types';

/**
 * Multiple accounts per agent (task #1057). One ordered list of accounts per agent; new sessions
 * start on the top account with room. Account #1 is the agent's own home (`default`), so a user
 * with one account sees no change. The design is docs/integrations/accounts.md.
 */

/**
 * A rate-limit window's identity across accounts: its id, scoped by the account that reported it.
 * Two accounts' `five-hour` windows are two windows, so main's ledger and the renderer's snapshot
 * merge both key by this, never by the id alone.
 */
export function rateLimitWindowKey(rateLimitWindow: Pick<RateLimitWindow, 'id' | 'accountId'>): string {
  return rateLimitWindow.accountId ? `${rateLimitWindow.accountId}:${rateLimitWindow.id}` : rateLimitWindow.id;
}

/**
 * How an account keeps itself apart from the agent's other accounts.
 * - `default`: the agent's own home folder (`~/.claude`, `~/.codex`, ...). Setup never moves,
 *   renames or overwrites anything in it.
 * - `folder`: a folder of Kangentic's holding only this account's login. Every other entry is a
 *   link or a copy back to the default home, so conversations stay in one place.
 * - `key-file`: an API key read from a file the user owns, put in the session's env at spawn.
 */
export type AgentAccountKind = 'default' | 'folder' | 'key-file';

/**
 * What the last check found. Only `ok` accounts take new sessions.
 * - `signed-out`: the folder exists but its login is gone or expired.
 * - `no-subscription`: signed in, but the CLI reports no plan.
 * - `not-found`: a key file or folder that no longer exists or cannot be read.
 * - `link-failed`: a conversation-bearing link could not be made, so a session there could write
 *   history Kangentic cannot read. Skipped until the link is made.
 */
export type AgentAccountStatus = 'ok' | 'signed-out' | 'no-subscription' | 'not-found' | 'link-failed';

export interface AgentAccount {
  id: string;
  agent: string;
  kind: AgentAccountKind;
  /** The account's home for a `folder` account, null for `default` (the agent's own) and `key-file`. */
  folderPath: string | null;
  /** The user's key file for a `key-file` account. Kangentic never stores the key itself. */
  keyFilePath: string | null;
  /** The variable names the key file holds, never their values. */
  keyNames: string[];
  /** The email the CLI reports, or null when it reports none (a key-file account). */
  email: string | null;
  /** The plan name the CLI reports (`Ultra`, `Pro`), as reported. */
  plan: string | null;
  status: AgentAccountStatus;
  /** 1-based place in the agent's list. Lower runs first. */
  position: number;
  /** This account's prompt history could not be shared (another drive), so it stays private. */
  historyPrivate: boolean;
  /** The last usage windows read for this account, exactly as the CLI reported them. */
  lastUsage: RateLimitWindow[] | null;
  /** UTC ISO time of `lastUsage`. */
  lastUsageAt: string | null;
  createdAt: string;
}

/**
 * The name an account goes by in a toast or a tip: its email, else its key file's name. Null when
 * it has neither (the agent's own login before its email is read, a folder with no sign-in yet).
 */
export function accountDisplayName(account: Pick<AgentAccount, 'email' | 'keyFilePath'>): string | null {
  return account.email ?? account.keyFilePath?.split(/[\\/]/).pop() ?? null;
}

export type AgentAccountOrderMode = 'automatic' | 'manual';

/** Global (System) settings for accounts: `AppConfig.agent.accounts`. */
export interface AgentAccountsConfig {
  /** Automatic sorts by the soonest reset; a drag or Switch to sets Manual. */
  orderMode: AgentAccountOrderMode;
  /** Sessions at 100% continue on the next account in the list. */
  autoSwitchAtLimit: boolean;
}

export const DEFAULT_AGENT_ACCOUNTS_CONFIG: AgentAccountsConfig = {
  orderMode: 'automatic',
  autoSwitchAtLimit: true,
};

/**
 * A credential in the environment that the CLI uses ahead of every account. Kangentic never
 * removes it; the card only names the variable that is set.
 */
export interface AgentAccountOverride {
  /** The variable's name, never its value. */
  variable: string;
  /** Where Kangentic found it: the environment it started from. */
  source: 'environment';
}

/** What starts a sign-in: a new account of `agent`, or the signed-out account `accountId` again. */
export type AgentAccountLoginRequest = { agent: string } | { accountId: string };

export type AgentAccountLoginStart =
  | { ok: true; loginId: string; accountId: string }
  /** `unsupported`: the agent has no folder accounts. `no-cli`: its CLI is not installed. */
  | { ok: false; reason: 'unsupported' | 'no-cli' | 'failed'; message?: string };

/** A sign-in's terminal ended. */
export interface AgentAccountLoginEnded {
  loginId: string;
  /** The account that is now signed in, or null when the sign-in did not finish. */
  account: AgentAccount | null;
  /** The account already in the list that this sign-in turned out to be. Nothing was added. */
  duplicateOf: AgentAccount | null;
  cancelled: boolean;
}

export type AgentAccountKeyFileResult =
  | { ok: true; account: AgentAccount }
  /** `no-keys`: the file sets none of the agent's key variables. */
  | { ok: false; reason: 'unsupported' | 'unreadable' | 'no-keys' | 'duplicate' };

/** How a Switch to ended, once the agent's running sessions have been moved or left. */
export interface AgentAccountSwitchResult {
  /** The account is now #1. False when it is no longer in the list. */
  ok: boolean;
  agent: string | null;
  /** The account as its row names it (its email, or its key file), when it has a name. */
  accountName: string | null;
  /** Running sessions restarted on the account. */
  moved: number;
  /** Running sessions that could not be restarted, and stay on the account they were on. */
  failed: number;
}

/** A task's session reached its account's usage limit and continues on another account. */
export interface AgentAccountSwitched {
  projectId: string;
  taskId: string;
  agent: string;
  /** The account it continues on, as its row names it. */
  accountName: string | null;
}

/** Every account of an agent is at its limit, so a session waits for the first reset. */
export interface AgentAccountsAllFull {
  agent: string;
  /** Epoch seconds of the reset that frees the first account, when one is known. */
  resetsAt: number | null;
}

/**
 * A usage window the agent's CLI always has, whether or not an account has opened it yet
 * (Claude reports its 5h window only once an account has run in it). The Accounts tab draws one
 * line per declared window on every row, so the rows are one height.
 */
export type AgentUsageWindowShape = Pick<RateLimitWindow, 'id' | 'label' | 'iconKind' | 'windowDurationSeconds'>;

/** One agent's card in Settings > Accounts. */
export interface AgentAccountsCard {
  agent: string;
  /** How this agent keeps accounts apart, or null when it cannot (the card says so). */
  kind: 'folder' | 'key-file' | null;
  /** In run order: Automatic re-sorts by reset, Manual keeps the saved order. */
  accounts: AgentAccount[];
  /** The account new sessions start on now: the first in the list with room. Null when none has. */
  activeAccountId: string | null;
  /** The agent reports usage windows, so its rows draw usage lines. */
  reportsUsage: boolean;
  /** The windows the agent always has, shortest first. Empty when it declares none. */
  usageWindows: AgentUsageWindowShape[];
  /** The sign-in happens on the CLI's own screen, which the user leaves when done. */
  signInIsInteractive: boolean;
  /** Switch to moves the agent's running sessions too. False where a conversation stays on its account. */
  switchMovesSessions: boolean;
  overrides: AgentAccountOverride[];
  /** The CLI runs in WSL, where account folders are not provisioned in this release. */
  unsupportedTarget: boolean;
}
