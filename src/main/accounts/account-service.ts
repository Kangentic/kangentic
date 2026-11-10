import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { AgentAccount, AgentAccountStatus, AgentAccountsCard, AgentAccountsConfig } from '../../shared/agent-accounts';
import type { RateLimitWindow } from '../../shared/types';
import type { AgentAccountRepository } from '../db/repositories/agent-account-repository';
import { provisionAccountFolder, type AccountFolderProblemCode } from './account-folder';
import { automaticOrder, topAccountWithRoom } from './account-order';
import { readKeyFile } from './key-file';
import { UnreadableUsageError, type AccountIdentity } from './account-support';
import type { AccountProblem, AccountProblemFacts } from './account-report';

/** The folder problems worth a report, by the name they are reported under. */
const REPORTABLE_FOLDER_PROBLEM: Partial<Record<AccountFolderProblemCode, AccountProblem>> = {
  'link-failed': 'folder-link-failed',
  'user-owned': 'folder-entry-user-owned',
  'kept-aside': 'folder-entries-kept-aside',
};

/** True when `filePath` is a file this process can read. */
function isReadableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** An account's status from its links and what the CLI said about its sign-in. */
function statusFor(linked: boolean, identity: AccountIdentity): AgentAccountStatus {
  if (!linked) return 'link-failed';
  if (!identity.signedIn) return 'signed-out';
  return identity.hasSubscription === false ? 'no-subscription' : 'ok';
}

/** The account a spawn runs on, and the env that selects it. */
export interface ResolvedAccount {
  id: string;
  agent: string;
  kind: AgentAccount['kind'];
  /** Variables the spawn sets: the CLI's home variable, or the key file's keys. Empty for `default`. */
  env: Record<string, string>;
}

export interface AccountServiceDependencies {
  repository: AgentAccountRepository;
  getAdapter: (agent: string) => AgentAdapter | undefined;
  /** Kangentic's config folder; account folders live in `<configDir>/accounts/<agent>/<n>`. */
  configDir: string;
  readConfig: () => AgentAccountsConfig;
  now?: () => number;
  /** Every registered adapter, for the Accounts tab's cards. Absent: no cards. */
  listAdapters?: () => AgentAdapter[];
  /** The agent's CLI on this machine, or null when it is not installed. Absent: no CLI reads. */
  resolveCliPath?: (agent: string) => Promise<string | null>;
  /** True when the agent's CLI runs somewhere account folders do not reach (a WSL distro). */
  usesRemoteTarget?: (agent: string) => Promise<boolean>;
  /** Saves the global accounts settings (a drag or Switch to sets Manual). */
  writeConfig?: (next: AgentAccountsConfig) => void;
  /** Called after any change the Accounts tab shows. */
  onChanged?: () => void;
  /** The environment Kangentic runs in, read for the card's line naming a variable that overrides its accounts. */
  environment?: () => NodeJS.ProcessEnv;
  /** Sends an account problem to error reporting (`account-report.ts`). Absent: nothing is sent. */
  reportProblem?: (problem: AccountProblem, agent: string, facts?: AccountProblemFacts, error?: unknown) => void;
}

/** What runs an account's sign-in in a terminal: the CLI's own login, pointed at the account's home. */
export interface AccountLoginCommand {
  cliPath: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Where the terminal starts, when not the user's home folder (an interactive sign-in). */
  cwd?: string;
}

export type AddKeyFileResult =
  | { ok: true; account: AgentAccount }
  | { ok: false; reason: 'unsupported' | 'unreadable' | 'no-keys' | 'duplicate' };

/**
 * Chooses the account each spawn runs on and keeps account folders ready. The one place spawns
 * ask; every spawn chokepoint passes the result into `CommandOptions.account`.
 */
export class AccountService {
  constructor(private readonly dependencies: AccountServiceDependencies) {}

  private nowSeconds(): number {
    return Math.floor((this.dependencies.now?.() ?? Date.now()) / 1000);
  }

  /** The agent's accounts in run order: Automatic re-sorts by reset, Manual keeps positions. */
  ordered(agent: string): AgentAccount[] {
    const accounts = this.dependencies.repository.listForAgent(agent);
    const mode = this.dependencies.readConfig().orderMode;
    return mode === 'automatic' ? automaticOrder(accounts, this.nowSeconds()) : accounts;
  }

  /** Where Kangentic keeps a new folder account for `agent`. */
  nextFolderPath(agent: string): string {
    const base = path.join(this.dependencies.configDir, 'accounts', agent);
    let index = 2;
    while (fs.existsSync(path.join(base, String(index)))) index += 1;
    return path.join(base, String(index));
  }

  /**
   * Makes the next free folder for a new account of `agent` and returns it. The folder is created
   * here, synchronously and without `recursive`, so two calls that overlap can never be handed
   * the same one: the second finds it taken and moves on.
   */
  private reserveFolder(agent: string): string {
    const base = path.join(this.dependencies.configDir, 'accounts', agent);
    fs.mkdirSync(base, { recursive: true });
    for (let index = 2; ; index += 1) {
      const folderPath = path.join(base, String(index));
      try {
        fs.mkdirSync(folderPath);
        return folderPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }

  /**
   * Make sure an agent that supports accounts has its `default` row, so the list always shows
   * what the user already has as #1: the CLI's own login, or for a key-file agent whatever it
   * runs on with no key file. Idempotent.
   */
  ensureDefaultAccount(agent: string): AgentAccount | null {
    const adapter = this.dependencies.getAdapter(agent);
    if (!adapter?.accounts) return null;
    const existing = this.dependencies.repository.listForAgent(agent).find((account) => account.kind === 'default');
    return existing ?? this.dependencies.repository.insert({ agent, kind: 'default' });
  }

  /**
   * Refreshes a folder account's links and copies (before each spawn). A conversation-bearing
   * link that cannot be made marks the account `link-failed`, so it is skipped.
   */
  async refreshFolder(account: AgentAccount): Promise<boolean> {
    const adapter = this.dependencies.getAdapter(account.agent);
    const support = adapter?.accounts;
    if (!support || support.kind !== 'folder' || !account.folderPath) return false;
    const report = await provisionAccountFolder({
      accountFolder: account.folderPath,
      defaultHome: support.defaultHome(),
      entries: support.sharedEntries,
      accountDataSubfolder: support.accountDataSubfolder,
    });
    for (const problem of report.problems) {
      const reportable = REPORTABLE_FOLDER_PROBLEM[problem.code];
      // The entry's name only: the detail holds the user's folder paths.
      if (reportable) this.reportProblem(reportable, account.agent, { entry: problem.entry, blocksAccount: report.conversationLinkFailed });
    }
    if (report.historyPrivate !== account.historyPrivate) {
      this.dependencies.repository.setHistoryPrivate(account.id, report.historyPrivate);
    }
    if (report.conversationLinkFailed) {
      this.dependencies.repository.updateStatus(account.id, 'link-failed');
      return false;
    }
    if (account.status === 'link-failed') this.dependencies.repository.updateStatus(account.id, 'ok');
    return true;
  }

  private envFor(account: AgentAccount, adapter: AgentAdapter): Record<string, string> | null {
    const support = adapter.accounts;
    if (!support || account.kind === 'default') return {};
    if (account.kind === 'folder' && support.kind === 'folder' && account.folderPath) {
      return support.accountEnv(account.folderPath, support.defaultHome());
    }
    if (account.kind === 'key-file' && support.kind === 'key-file' && account.keyFilePath) {
      const keys = readKeyFile(account.keyFilePath, support.keyEnvVars);
      if (!keys) return null;
      return support.envFileVar ? { ...keys.values, [support.envFileVar]: account.keyFilePath } : keys.values;
    }
    return null;
  }

  /** Sends an account problem to error reporting, when this service was given a reporter. */
  reportProblem(problem: AccountProblem, agent: string, facts?: AccountProblemFacts, error?: unknown): void {
    try {
      this.dependencies.reportProblem?.(problem, agent, facts, error);
    } catch {
      // Reporting never breaks what it reports on.
    }
  }

  /**
   * A session on `accountId` started and its CLI said it is not signed in. The account is marked
   * signed out, so the next spawn passes over it and its row offers Sign in. For an agent whose
   * accounts are unproven it is also reported: the CLI may not have read the login Kangentic did.
   */
  noteSessionNotSignedIn(accountId: string): void {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.kind !== 'folder' || account.status !== 'ok') return;
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    this.dependencies.repository.updateStatus(accountId, 'signed-out');
    this.changed();
    if (support?.kind === 'folder' && support.unproven) this.reportProblem('session-not-signed-in', account.agent);
  }

  /** True when the agent's folder accounts were built without a real second account to run on. */
  isUnproven(agent: string): boolean {
    const support = this.dependencies.getAdapter(agent)?.accounts;
    return support?.kind === 'folder' && support.unproven === true;
  }

  private changed(): void {
    try {
      this.dependencies.onChanged?.();
    } catch (error) {
      console.warn('[ACCOUNTS] A change listener failed:', error);
    }
  }

  /** True when the agent's CLI runs where account folders do not reach. False when that cannot be told. */
  private async usesRemoteTarget(agent: string): Promise<boolean> {
    try {
      return (await this.dependencies.usesRemoteTarget?.(agent)) ?? false;
    } catch {
      return false;
    }
  }

  /** One card per installed agent that declares accounts, its accounts in run order. */
  async cards(): Promise<AgentAccountsCard[]> {
    const cards: AgentAccountsCard[] = [];
    const environment = this.dependencies.environment?.() ?? process.env;
    for (const adapter of this.dependencies.listAdapters?.() ?? []) {
      const support = adapter.accounts;
      if (!support) continue;
      const cliPath = await this.dependencies.resolveCliPath?.(adapter.name).catch(() => null);
      if (!cliPath) continue;
      this.ensureDefaultAccount(adapter.name);
      const accounts = this.ordered(adapter.name);
      cards.push({
        agent: adapter.name,
        kind: support.kind,
        accounts,
        activeAccountId: topAccountWithRoom(accounts, this.nowSeconds())?.id ?? null,
        reportsUsage: adapter.reportsRateLimits === true || (support.kind === 'folder' && support.readIdleUsage !== undefined),
        signInIsInteractive: support.kind === 'folder' && support.loginIsInteractive === true,
        switchMovesSessions: !(support.kind === 'folder' && support.conversationsStayOnAccount === true),
        overrides: support.overridingCredentialEnvVars
          .filter((variable) => (environment[variable] ?? '').trim() !== '')
          .map((variable) => ({ variable, source: 'environment' as const })),
        unsupportedTarget: await this.usesRemoteTarget(adapter.name),
      });
    }
    return cards;
  }

  /**
   * Asks the CLI who is signed in to the account and stores the answer. A folder account's links
   * are refreshed first, so `link-failed` is never overwritten by a good sign-in.
   */
  async refreshIdentity(accountId: string): Promise<AgentAccount | null> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account) return null;
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (!support || support.kind !== 'folder' || account.kind === 'key-file') return account;
    const cliPath = await this.dependencies.resolveCliPath?.(account.agent);
    if (!cliPath) return account;
    // A CLI in a WSL distro keeps its one login: a read there would answer for that login, not
    // for this folder, so a folder account is left as it was.
    if (account.kind === 'folder' && (await this.usesRemoteTarget(account.agent))) return account;
    const linked = account.kind === 'default' || (await this.refreshFolder(account));
    const identity = await support.identify(cliPath, account.folderPath);
    // A signed-out answer keeps the email the row had, so the row still says whose it was.
    this.dependencies.repository.updateIdentity(accountId, {
      email: identity.email ?? account.email,
      plan: identity.signedIn ? identity.plan : account.plan,
      status: statusFor(linked, identity),
    });
    this.changed();
    return this.dependencies.repository.getById(accountId);
  }

  /**
   * Reads an account's usage with no session running on it (`readIdleUsage`) and stores it. False
   * when the adapter has no such read or it failed; the account keeps its last values.
   */
  async refreshUsage(accountId: string): Promise<boolean> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.kind === 'key-file' || account.status === 'signed-out' || account.status === 'not-found') return false;
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (!support || support.kind !== 'folder' || !support.readIdleUsage) return false;
    const cliPath = await this.dependencies.resolveCliPath?.(account.agent);
    if (!cliPath) return false;
    if (account.kind === 'folder' && (await this.usesRemoteTarget(account.agent))) return false;
    let windows: RateLimitWindow[] | null;
    try {
      windows = await support.readIdleUsage(cliPath, account.folderPath);
    } catch (error) {
      if (!(error instanceof UnreadableUsageError)) throw error;
      this.reportProblem('usage-read-unreadable', account.agent, { keys: error.keys });
      return false;
    }
    if (!windows) return false;
    this.dependencies.repository.updateUsage(accountId, windows);
    this.changed();
    return true;
  }

  /** The CLI's own sign-in for a folder account, to run in a terminal. Null when it cannot run. */
  async loginCommand(accountId: string): Promise<AccountLoginCommand | null> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.kind !== 'folder' || !account.folderPath) return null;
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (!support || support.kind !== 'folder') return null;
    const cliPath = await this.dependencies.resolveCliPath?.(account.agent);
    if (!cliPath) return null;
    return {
      cliPath,
      args: support.loginArgs,
      env: support.accountEnv(account.folderPath, support.defaultHome()),
      ...(support.loginIsInteractive ? { cwd: account.folderPath } : {}),
    };
  }

  /**
   * Makes a new folder account, signed out, with its links in place, ready for its sign-in. The
   * row is at the bottom of the list and takes no session until `completeLogin` finds it signed in.
   */
  async createFolderAccount(agent: string): Promise<AgentAccount | null> {
    const support = this.dependencies.getAdapter(agent)?.accounts;
    if (!support || support.kind !== 'folder') return null;
    this.ensureDefaultAccount(agent);
    const folderPath = this.reserveFolder(agent);
    const account = this.dependencies.repository.insert({ agent, kind: 'folder', folderPath, status: 'signed-out' });
    await this.refreshFolder(account);
    return this.dependencies.repository.getById(account.id);
  }

  /**
   * After a sign-in's terminal ends: reads who signed in. An account already in the list (the
   * same email) is not added twice: the new row goes and the existing one is named. A sign-in
   * that did not finish removes a row that never had one, and keeps one that did (a Sign in on a
   * signed-out row). The folder is never deleted.
   */
  async completeLogin(accountId: string): Promise<{ account: AgentAccount | null; duplicateOf: AgentAccount | null }> {
    const before = this.dependencies.repository.getById(accountId);
    if (!before) return { account: null, duplicateOf: null };
    const account = await this.refreshIdentity(accountId);
    if (!account) return { account: null, duplicateOf: null };
    if (account.status === 'signed-out' && before.email === null) {
      this.dependencies.repository.delete(accountId);
      this.changed();
      return { account: null, duplicateOf: null };
    }
    const email = account.email?.toLowerCase() ?? null;
    const duplicateOf = email
      ? this.dependencies.repository.listForAgent(account.agent)
          .find((other) => other.id !== account.id && other.email?.toLowerCase() === email) ?? null
      : null;
    if (duplicateOf && before.email === null) {
      this.dependencies.repository.delete(accountId);
      this.changed();
      return { account: null, duplicateOf };
    }
    return { account, duplicateOf: null };
  }

  /** Adds a key-file account: the path and the variable names it holds, never a key. */
  addKeyFileAccount(agent: string, keyFilePath: string): AddKeyFileResult {
    const support = this.dependencies.getAdapter(agent)?.accounts;
    if (!support || support.kind !== 'key-file') return { ok: false, reason: 'unsupported' };
    const keys = readKeyFile(keyFilePath, support.keyEnvVars);
    // `readKeyFile` answers null for a file it cannot read and for one that sets none of the
    // agent's variables; the user is told which.
    if (!keys) return { ok: false, reason: isReadableFile(keyFilePath) ? 'no-keys' : 'unreadable' };
    const resolved = path.resolve(keyFilePath);
    if (this.dependencies.repository.listForAgent(agent).some((account) => account.keyFilePath && path.resolve(account.keyFilePath) === resolved)) {
      return { ok: false, reason: 'duplicate' };
    }
    const account = this.dependencies.repository.insert({ agent, kind: 'key-file', keyFilePath: resolved, keyNames: keys.names });
    this.changed();
    return { ok: true, account };
  }

  /**
   * Kangentic stops using the account for new sessions. Its folder and sign-in stay on disk, so
   * removing a row never signs anyone out. The agent's own login is not a Kangentic account and
   * cannot be removed.
   */
  remove(accountId: string): boolean {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.kind === 'default') return false;
    this.dependencies.repository.delete(accountId);
    this.changed();
    return true;
  }

  private setManual(): void {
    const config = this.dependencies.readConfig();
    if (config.orderMode !== 'manual') this.dependencies.writeConfig?.({ ...config, orderMode: 'manual' });
  }

  /** A drag: the list takes this order and stays in it (Manual). */
  reorder(agent: string, orderedIds: readonly string[]): void {
    this.dependencies.repository.reorder(agent, orderedIds);
    this.setManual();
    this.changed();
  }

  /**
   * Switch to: the account moves to #1 and the list stays in that order (Manual). Refused for an
   * account that cannot run (signed out, no plan, links missing): running sessions would be moved
   * onto a login the CLI will not accept.
   */
  switchTo(accountId: string): boolean {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.status !== 'ok') return false;
    // From the order on screen, so the rest of the list keeps the places the user sees.
    const ids = this.ordered(account.agent).map((other) => other.id).filter((id) => id !== accountId);
    this.dependencies.repository.reorder(account.agent, [accountId, ...ids]);
    this.setManual();
    this.changed();
    return true;
  }

  /**
   * The envs to reach an agent's own background sessions under, for a session on `accountId`.
   * A CLI lists only the background sessions of the home it runs under, so a known account is
   * that account's env alone, and an unknown one (a record from before accounts, an Earlier
   * conversation) is every account in turn, the agent's own login first. `undefined` is the
   * agent's own login: the call runs with no extra env.
   */
  envsForBackgroundStop(agent: string, accountId: string | null | undefined): Array<Record<string, string> | undefined> {
    const adapter = this.dependencies.getAdapter(agent);
    if (!adapter?.accounts) return [undefined];
    const accounts = this.dependencies.repository.listForAgent(agent);
    const known = accountId ? accounts.find((account) => account.id === accountId) : undefined;
    const candidates = known ? [known] : [...accounts].sort((first, second) => Number(second.kind === 'default') - Number(first.kind === 'default'));
    const envs: Array<Record<string, string> | undefined> = [];
    for (const account of candidates) {
      const env = this.envFor(account, adapter);
      if (env === null) continue;
      envs.push(Object.keys(env).length > 0 ? env : undefined);
    }
    if (!known && !envs.includes(undefined)) envs.unshift(undefined);
    return envs.length > 0 ? envs : [undefined];
  }

  /**
   * Keep each account's latest windows from a live report (stamped with `accountId` by main), so
   * the Accounts tab and Automatic order read usage with no session running. A window the report
   * leaves out keeps its last value. Writes only on a change: status reports repeat every few
   * seconds. Returns the ids of the accounts it changed.
   */
  recordUsage(windows: readonly RateLimitWindow[] | undefined): string[] {
    if (!windows || windows.length === 0) return [];
    const byAccount = new Map<string, RateLimitWindow[]>();
    for (const rateLimitWindow of windows) {
      if (!rateLimitWindow.accountId) continue;
      const list = byAccount.get(rateLimitWindow.accountId) ?? [];
      list.push(rateLimitWindow);
      byAccount.set(rateLimitWindow.accountId, list);
    }
    const changed: string[] = [];
    for (const [accountId, reported] of byAccount) {
      const account = this.dependencies.repository.getById(accountId);
      if (!account) continue;
      const previous = account.lastUsage ?? [];
      const next = mergeUsage(previous, reported);
      if (sameUsage(previous, next)) continue;
      this.dependencies.repository.updateUsage(accountId, next);
      changed.push(accountId);
    }
    if (changed.length > 0) this.changed();
    return changed;
  }

  /**
   * The account a new spawn of `agent` runs on. `overrideAccountId` is the continuation's choice
   * at a limit. `conversationAccountId` is the account the conversation being resumed last ran on
   * (null: the agent's own login; undefined: not a resume), which decides only for an agent whose
   * conversations stay on their account. Null for an agent that declares no accounts. When no
   * account can be prepared the spawn runs on the agent's own login and is recorded against its
   * `default` row, so its usage still lands on a row and a later limit can still move it.
   */
  async resolveForSpawn(agent: string, overrideAccountId?: string | null, conversationAccountId?: string | null): Promise<ResolvedAccount | null> {
    const adapter = this.dependencies.getAdapter(agent);
    if (!adapter?.accounts) return null;
    // The agent's own login is account #1, so its sessions are recorded against it too and its
    // usage lands on its row. Its env is empty: the spawn is exactly what it was before accounts.
    this.ensureDefaultAccount(agent);
    const ordered = this.ordered(agent);
    if (ordered.length === 1 && ordered[0].kind === 'default' && !overrideAccountId) {
      // One account: nothing to choose between.
      return { id: ordered[0].id, agent, kind: 'default', env: {} };
    }
    // A named account is taken only while it can run: a session moved onto a signed-out login
    // would start on a refusal.
    const override = overrideAccountId
      ? ordered.find((account) => account.id === overrideAccountId && account.status === 'ok')
      : undefined;
    // The account the conversation was written on, for an agent that can only resume it there.
    // Taken while it is signed in, even full: a limit is a wait, a refused resume is a dead end.
    const support = adapter.accounts;
    const conversationAccount = support.kind === 'folder' && support.conversationsStayOnAccount && conversationAccountId !== undefined
      ? ordered.find((account) => (conversationAccountId === null ? account.kind === 'default' : account.id === conversationAccountId) && account.status === 'ok')
      : undefined;
    const preferred = overrideAccountId
      ? [override ?? null]
      : [conversationAccount ?? null, topAccountWithRoom(ordered, this.nowSeconds()), ...ordered.filter((account) => account.status === 'ok')];
    // The same account can be named by more than one of those; each is tried once.
    const candidates = [...new Map(
      preferred.filter((account): account is AgentAccount => account !== null).map((account) => [account.id, account]),
    ).values()];
    for (const candidate of candidates) {
      try {
        if (candidate.kind === 'folder' && !(await this.refreshFolder(candidate))) continue;
      } catch (error) {
        // One account whose folder cannot be read must not cost the others their turn.
        this.reportProblem('spawn-account-unresolved', agent, { threw: true, kind: candidate.kind }, error);
        continue;
      }
      const env = this.envFor(candidate, adapter);
      if (!env) continue;
      return { id: candidate.id, agent, kind: candidate.kind, env };
    }
    // More than one account and none could be prepared: the spawn runs on the agent's own login,
    // which is the `default` row, with nothing added to its env.
    this.reportProblem('spawn-account-unresolved', agent, { accounts: ordered.length, named: Boolean(overrideAccountId) });
    const ownLogin = ordered.find((account) => account.kind === 'default');
    return ownLogin ? { id: ownLogin.id, agent, kind: 'default', env: {} } : null;
  }
}

/** What an account row keeps of a window: the window itself, without the per-report stamps. */
function storedWindow(rateLimitWindow: RateLimitWindow): RateLimitWindow {
  const { generation: _generation, agent: _agent, accountId: _accountId, ...kept } = rateLimitWindow;
  return kept;
}

function mergeUsage(previous: readonly RateLimitWindow[], reported: readonly RateLimitWindow[]): RateLimitWindow[] {
  const reportedById = new Map(reported.map((rateLimitWindow): [string, RateLimitWindow] => [rateLimitWindow.id, storedWindow(rateLimitWindow)]));
  const kept = previous.map((previousWindow) => {
    const reportedWindow = reportedById.get(previousWindow.id);
    reportedById.delete(previousWindow.id);
    return reportedWindow ?? previousWindow;
  });
  return [...kept, ...reportedById.values()];
}

/**
 * True when two readings would show and decide the same. A row shows whole percents and an account
 * is full at 100, so a report that moves a window by a fraction of a point is not a change: it
 * would otherwise cost a database write, a push and a re-list every few seconds of a turn.
 */
function sameUsage(first: readonly RateLimitWindow[], second: readonly RateLimitWindow[]): boolean {
  return first.length === second.length
    && first.every((rateLimitWindow, index) => rateLimitWindow.id === second[index].id
      && Math.round(rateLimitWindow.usedPercentage) === Math.round(second[index].usedPercentage)
      && (rateLimitWindow.usedPercentage >= 100) === (second[index].usedPercentage >= 100)
      && rateLimitWindow.resetsAt === second[index].resetsAt);
}

let service: AccountService | null = null;

/** Set once at startup (`register-all.ts`), where the config manager is known. */
export function setAccountService(next: AccountService | null): void {
  service = next;
}

/** The running service, or null in a process that never set one (unit tests, the pty host). */
export function getAccountService(): AccountService | null {
  return service;
}

/**
 * The account a conversation last ran on, from its task's session records: the argument a resume
 * hands `resolveSpawnAccount`. Undefined when nothing is being resumed, null for the agent's own
 * login (every record from before accounts).
 */
export function conversationAccountOf(
  records: ReadonlyArray<{ agent_session_id: string | null; account_id?: string | null }>,
  agentSessionId: string | null | undefined,
  resuming: boolean,
): string | null | undefined {
  if (!resuming || !agentSessionId) return undefined;
  return records.find((record) => record.agent_session_id === agentSessionId)?.account_id ?? null;
}

/**
 * A session's launch ended and its output reads as not signed in. On an account of its own, the
 * CLI did not find the login Kangentic read there, so that account is marked signed out. Nothing
 * for any other ending, or for a session with no account.
 */
export function noteLaunchNotSignedIn(outputClass: string | undefined, accountId: string | null | undefined): void {
  if (outputClass !== 'login_required' || !accountId) return;
  service?.noteSessionNotSignedIn(accountId);
}

/** Resolves a spawn's account when the service runs; null otherwise, which keeps today's spawn. */
export async function resolveSpawnAccount(agent: string, overrideAccountId?: string | null, conversationAccountId?: string | null): Promise<ResolvedAccount | null> {
  try {
    return (await service?.resolveForSpawn(agent, overrideAccountId, conversationAccountId)) ?? null;
  } catch (error) {
    // An account that cannot be prepared must not stop the spawn: it runs on the agent's own login.
    console.warn('[ACCOUNTS] Could not resolve an account for the spawn:', error);
    service?.reportProblem('spawn-account-unresolved', agent, { threw: true }, error);
    return null;
  }
}
