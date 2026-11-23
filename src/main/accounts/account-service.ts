import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { AgentAccount, AgentAccountStatus, AgentAccountsCard, AgentAccountsConfig } from '../../shared/agent-accounts';
import type { RateLimitWindow, ResumeAccountMatch } from '../../shared/types';
import type { AgentAccountRepository } from '../db/repositories/agent-account-repository';
import { accountsRootOf, provisionAccountFolder, type AccountFolderProblemCode } from './account-folder';
import { automaticOrder, keepFullWindows, topAccountWithRoom } from './account-order';
import { decideIdentity, duplicateLoginRows, loginFromRead, loginOf, NO_LOGIN, sameLogin, type IdentityDecision, type LoginIdentity } from './account-identity';
import { readKeyFile } from './key-file';
import { defaultHomeOrigin, type DefaultHomeOrigin } from './inherited-home-env';
import {
  EmptyUsageReadError,
  IdentityReadError,
  UnreadableUsageError,
  type AccountIdentity,
  type EmptyUsageReadReason,
} from './account-support';
import type { AccountProblem, AccountProblemFacts, AccountProblemTags } from './account-report';
import { cliVersionTag } from '../agent/shared/cli-version-tag';

/**
 * How many usage reads in a row an account's CLI run must fail before it is reported. One failed
 * run during a network drop is not a defect. A flag the CLI does not know fails every run, so it
 * still reports, one read later.
 */
const REPORTED_RUN_FAILURES = 2;

/** A child's exit code as a tag: the code itself in the range a shell reports, else `other`. */
function exitCodeTag(exitCode: number | null): string {
  return exitCode !== null && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? String(exitCode) : 'other';
}

/** The folder problems worth a report, by the name they are reported under. */
const REPORTABLE_FOLDER_PROBLEM: Partial<Record<AccountFolderProblemCode, AccountProblem>> = {
  'link-failed': 'folder-link-failed',
  'user-owned': 'folder-entry-user-owned',
  'kept-aside': 'folder-entries-kept-aside',
  'change-replaced': 'folder-change-replaced',
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

/**
 * True when the agent's usage reaches Kangentic: its sessions report rate limits, or its account
 * folders can be read idle. Only such an agent's list has resets for Automatic to sort by, so only
 * its order follows the global order mode.
 */
function adapterReportsUsage(adapter: AgentAdapter): boolean {
  const support = adapter.accounts;
  return adapter.reportsRateLimits === true || (support?.kind === 'folder' && support.readIdleUsage !== undefined);
}

/** The conversation a spawn resumes, for an adapter that carries files between homes. */
export interface SpawnResume {
  agentSessionId: string;
  cwd: string;
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
  /** The version that CLI printed at detection, for a report's tag. Absent: the tag reads `unknown`. */
  resolveCliVersion?: (agent: string) => Promise<string | null>;
  /** True when the agent's CLI runs somewhere account folders do not reach (a WSL distro). */
  usesRemoteTarget?: (agent: string) => Promise<boolean>;
  /** Saves the global accounts settings (a drag or Switch to sets Manual). */
  writeConfig?: (next: AgentAccountsConfig) => void;
  /** Called after any change the Accounts tab shows. */
  onChanged?: () => void;
  /** The environment Kangentic runs in, read for the card's line naming a variable that overrides its accounts. */
  environment?: () => NodeJS.ProcessEnv;
  /** Sends an account problem to error reporting (`account-report.ts`). Absent: nothing is sent. */
  reportProblem?: (problem: AccountProblem, agent: string, facts?: AccountProblemFacts, error?: unknown, tags?: AccountProblemTags) => void;
  /**
   * Reads the stale or missing readings among an agent's accounts before a spawn ranks them, in
   * either order mode (`AccountUsageRefresher.readBeforeRanking`). Must resolve within its own bound and
   * never reject. Absent: a spawn ranks on the stored readings.
   */
  readBeforeRanking?: (accounts: readonly AgentAccount[]) => Promise<void>;
  /**
   * The login in an account's home changed, so every live session running in that home now runs
   * as `toAccountId` (the home's own row, or the row that already names the login it holds). The
   * handler re-points each live session, so usage and the continuation follow the login, not the
   * home. Its record keeps the home it started in. Absent: sessions keep the account they started on.
   */
  repointSessions?: (homeAccountId: string, toAccountId: string) => void;
}

/** How a home whose login changed was reconciled, for the log and the `identity-changed` report. */
type IdentityChangeKind = 'to-listed' | 'to-new' | 'merged' | 'already-listed' | 'duplicate';

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
  /** Why each account's last usage read gave no windows, so a repeat is not logged again. */
  private readonly emptyUsageReasons = new Map<string, EmptyUsageReadReason>();
  /** How many usage reads in a row each account's CLI run has failed (`REPORTED_RUN_FAILURES`). */
  private readonly consecutiveRunFailures = new Map<string, number>();

  constructor(private readonly dependencies: AccountServiceDependencies) {}

  private nowSeconds(): number {
    return Math.floor((this.dependencies.now?.() ?? Date.now()) / 1000);
  }

  /**
   * Whether the agent's list follows the global order mode. An agent that reports no usage has no
   * reset to sort by, so its list is always the user's order, and a drag or Switch to on it leaves
   * the mode alone. An agent with no registered adapter keeps following the mode.
   */
  private followsOrderMode(agent: string): boolean {
    const adapter = this.dependencies.getAdapter(agent);
    return adapter === undefined || adapterReportsUsage(adapter);
  }

  /** The agent's accounts in run order: Automatic re-sorts by reset, Manual keeps positions. */
  ordered(agent: string): AgentAccount[] {
    const accounts = this.dependencies.repository.listForAgent(agent);
    const mode = this.dependencies.readConfig().orderMode;
    return mode === 'automatic' && this.followsOrderMode(agent) ? automaticOrder(accounts, this.nowSeconds()) : accounts;
  }

  /** Where Kangentic keeps a new folder account for `agent`. */
  nextFolderPath(agent: string): string {
    const base = path.join(accountsRootOf(this.dependencies.configDir), agent);
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
    const base = path.join(accountsRootOf(this.dependencies.configDir), agent);
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
      knownHomes: {
        builtinHome: support.builtinHome?.(),
        accountsRoot: accountsRootOf(this.dependencies.configDir),
      },
    });
    for (const problem of report.problems) {
      const reportable = REPORTABLE_FOLDER_PROBLEM[problem.code];
      if (!reportable) continue;
      // Fixed words only: the entry's name, what stood there and where a link pointed, as a
      // class. The detail holds the user's folder paths. The shape is the reason, so a file and
      // a link in one run each latch their own report.
      this.reportProblem(reportable, account.agent, {
        entry: problem.entry,
        blocksAccount: report.conversationLinkFailed,
        ...(problem.shape ? { reason: problem.shape, shape: problem.shape } : {}),
        ...(problem.linkTarget ? { link_target: problem.linkTarget } : {}),
        default_home: this.defaultHomeOrigin(account.agent),
      });
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
  reportProblem(problem: AccountProblem, agent: string, facts?: AccountProblemFacts, error?: unknown, tags?: AccountProblemTags): void {
    try {
      this.dependencies.reportProblem?.(problem, agent, facts, error, tags);
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
        reportsUsage: adapterReportsUsage(adapter),
        usageWindows: [...(support.usageWindows ?? [])],
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
   * Asks the CLI who is signed in to the account and stores the answer. A home that holds another
   * login than its row names is reconciled (`applyIdentity`), and any login two running rows name
   * is then set aside on one of them. A CLI that gives no answer changes nothing.
   */
  async refreshIdentity(accountId: string): Promise<AgentAccount | null> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account) return null;
    const read = await this.readIdentity(account);
    if (read === 'skipped') return account;
    if (read === 'no-answer') return this.dependencies.repository.getById(accountId);
    await this.applyIdentity(account, read.identity, read.linked);
    this.reconcileDuplicateLogins(account.agent);
    this.changed();
    return this.dependencies.repository.getById(accountId);
  }

  /**
   * Asks the CLI who is signed in to an account's home. `skipped` where nothing can be read (no
   * folder support, no CLI, a CLI in WSL for a folder account); `no-answer` when the CLI gave none,
   * which is logged and reported and changes nothing. A folder account's links are refreshed
   * first, so `link-failed` is never overwritten by a good sign-in.
   */
  private async readIdentity(account: AgentAccount): Promise<{ identity: AccountIdentity; linked: boolean } | 'skipped' | 'no-answer'> {
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (!support || support.kind !== 'folder' || account.kind === 'key-file') return 'skipped';
    const cliPath = await this.dependencies.resolveCliPath?.(account.agent);
    if (!cliPath) return 'skipped';
    // A CLI in a WSL distro keeps its one login: a read there would answer for that login, not
    // for this folder, so a folder account is left as it was.
    if (account.kind === 'folder' && (await this.usesRemoteTarget(account.agent))) return 'skipped';
    const linked = account.kind === 'default' || (await this.refreshFolder(account));
    try {
      return { identity: await support.identify(cliPath, account.folderPath), linked };
    } catch (error) {
      if (!(error instanceof IdentityReadError)) throw error;
      // No answer is not a signed-out answer: the account keeps the status it had. Marking it
      // signed out here parked a working account at the bottom of Automatic for days, since only
      // a sign-in read sets it back.
      console.warn(`[ACCOUNTS] Could not read who is signed in to a ${account.kind} account (${error.reason}); it keeps its status`);
      this.reportProblem('identity-read-failed', account.agent, { kind: account.kind, reason: error.reason });
      return 'no-answer';
    }
  }

  /**
   * Stores what a sign-in read found in `account`'s home. A home whose login is no longer the one
   * its row names is reconciled (`decideIdentity`) so that no login is listed twice and none is
   * dropped: the replaced login stays listed, set aside (`replaced`), one Sign in away.
   */
  private async applyIdentity(snapshot: AgentAccount, identity: AccountIdentity, linked: boolean): Promise<void> {
    const repository = this.dependencies.repository;
    // The row as it is now, not as it was before the CLI run: two reads of one home can overlap
    // (the tab's refresh and a turn end's check), and the second must see what the first wrote,
    // or both decide `to-new` and the replaced login is listed twice. Everything from here to the
    // first write runs with no await, so the second read always lands after the first's writes.
    const account = repository.getById(snapshot.id);
    if (!account) return;
    const status = statusFor(linked, identity);
    const found = loginFromRead(identity);
    if (!identity.signedIn || !found.email) {
      // Signed out, or signed in with no email to compare (an API key): nothing names another
      // login. A signed-out answer keeps the email the row had, so the row still says whose it was.
      this.noteStatusDrop(account, status);
      const keepsReplaced = account.status === 'replaced' && identity.signedIn;
      repository.updateIdentity(account.id, {
        email: account.email,
        orgId: account.orgId,
        plan: identity.signedIn ? identity.plan : account.plan,
        status: keepsReplaced ? 'replaced' : status,
      });
      return;
    }
    const agentAccounts = repository.listForAgent(account.agent);
    const rawDecision = decideIdentity(account, agentAccounts, found);
    // A user with one account sees no change anywhere: their list is whatever their CLI is signed
    // in to, as before accounts, so a new login there is the row's new login and adds no row.
    const decision: IdentityDecision = rawDecision.kind === 'to-new' && agentAccounts.length < 2 ? { kind: 'first-read' } : rawDecision;
    const takeFound = (rowId: string): void => {
      repository.updateIdentity(rowId, { email: found.email, orgId: found.orgId, plan: identity.plan, status });
    };
    switch (decision.kind) {
      case 'unchanged':
      case 'first-read': {
        this.noteStatusDrop(account, status);
        // The email as the CLI spells it now, and an org id a row from before them did not have.
        repository.updateIdentity(account.id, { email: found.email, orgId: found.orgId ?? account.orgId, plan: identity.plan, status });
        // A row set aside whose login is back in its home: its sessions run as it again.
        if (account.status === 'replaced') this.repointSessions(account.id, account.id);
        return;
      }
      case 'still-replaced':
        // Already set aside for this login: nothing is written or reported again.
        this.repointSessions(account.id, decision.listedId);
        return;
      case 'already-listed':
        this.setAside(account, NO_LOGIN);
        this.noteIdentityChanged(account, 'already-listed');
        this.repointSessions(account.id, decision.listedId);
        return;
      case 'to-listed':
        // The row keeps the login it named, set aside; the login its home holds now is the other
        // row's, and the sessions in this home run as that row.
        repository.updateStatus(account.id, 'replaced');
        repository.clearUsage(account.id);
        this.noteIdentityChanged(account, 'to-listed');
        this.repointSessions(account.id, decision.listedId);
        return;
      case 'merged': {
        // The set-aside row that named the new login takes the replaced one instead.
        takeFound(account.id);
        repository.clearUsage(account.id);
        this.setAside({ id: decision.replacedId, plan: account.plan }, loginOf(account));
        this.noteIdentityChanged(account, 'merged');
        this.repointSessions(account.id, account.id);
        return;
      }
      case 'to-new': {
        takeFound(account.id);
        repository.clearUsage(account.id);
        await this.keepReplacedLogin(account);
        this.noteIdentityChanged(account, 'to-new');
        this.repointSessions(account.id, account.id);
        return;
      }
    }
  }

  /**
   * The login a home held before it was replaced by one no row names: it moves to a new row with a
   * folder of its own, set aside (`replaced`), so its Sign in lands there and never replaces the
   * login the home holds now. Nothing on disk is moved or deleted.
   */
  private async keepReplacedLogin(previous: AgentAccount): Promise<void> {
    const support = this.dependencies.getAdapter(previous.agent)?.accounts;
    if (!support || support.kind !== 'folder') return;
    const folderPath = this.reserveFolder(previous.agent);
    const kept = this.dependencies.repository.insert({
      agent: previous.agent,
      kind: 'folder',
      folderPath,
      email: previous.email,
      orgId: previous.orgId,
      plan: previous.plan,
      status: 'replaced',
    });
    try {
      await this.refreshFolder(kept);
    } catch (error) {
      // The row stays listed either way; its links are made again before its sign-in and each spawn.
      this.reportProblem('folder-link-failed', previous.agent, { threw: true, kind: 'folder' }, error);
    }
    // `refreshFolder` sets a row whose links are in place to `ok`; this one has no login yet.
    if (this.dependencies.repository.getById(kept.id)?.status !== 'link-failed') {
      this.dependencies.repository.updateStatus(kept.id, 'replaced');
    }
  }

  /**
   * Sets a row aside (`replaced`) naming `login`, the login it keeps, or none, and forgets its
   * usage, which was read for a login it no longer runs as.
   */
  private setAside(row: Pick<AgentAccount, 'id' | 'plan'>, login: LoginIdentity): void {
    this.dependencies.repository.updateIdentity(row.id, { email: login.email, orgId: login.orgId, plan: row.plan, status: 'replaced' });
    this.dependencies.repository.clearUsage(row.id);
  }

  /** Logs a working row that a sign-in read found no longer working. */
  private noteStatusDrop(account: AgentAccount, status: AgentAccountStatus): void {
    if (account.status === 'ok' && status !== 'ok') console.warn(`[ACCOUNTS] A ${account.kind} account of ${account.agent} is now ${status}`);
  }

  /** Logs and reports a home whose login changed, with how it was reconciled and never the email. */
  private noteIdentityChanged(account: AgentAccount, change: IdentityChangeKind): void {
    console.warn(`[ACCOUNTS] The login in a ${account.kind} account's home of ${account.agent} changed (${change})`);
    this.reportProblem('identity-changed', account.agent, { kind: account.kind, change, default_home: this.defaultHomeOrigin(account.agent) });
  }

  /**
   * Where the agent's default home came from, as a fixed word for a report (`DefaultHomeOrigin`):
   * `builtin`, `inherited`, `login-shell`, or `inherited-ignored` for one that named a Kangentic
   * account folder and was dropped at boot. Never the path.
   */
  private defaultHomeOrigin(agent: string): DefaultHomeOrigin {
    const support = this.dependencies.getAdapter(agent)?.accounts;
    const homeEnvVars = support?.kind === 'folder' ? support.homeEnvVars : [];
    return defaultHomeOrigin(agent, homeEnvVars, this.dependencies.environment?.() ?? process.env);
  }

  private repointSessions(homeAccountId: string, toAccountId: string): void {
    try {
      this.dependencies.repointSessions?.(homeAccountId, toAccountId);
    } catch (error) {
      // The list is already right; a session left on its old row only draws usage there.
      console.warn('[ACCOUNTS] Could not move sessions to the login their home holds:', error instanceof Error ? error.name : 'unknown');
      const agent = this.dependencies.repository.getById(homeAccountId)?.agent ?? 'unknown';
      this.reportProblem('identity-changed', agent, { stage: 'repoint', default_home: this.defaultHomeOrigin(agent) }, error);
    }
  }

  /**
   * Rows that name a login another running row names (a list written before this check): all but
   * one are set aside with no email, since the login they held before cannot be known. Returns
   * true when anything changed.
   */
  reconcileDuplicateLogins(agent: string): boolean {
    const repository = this.dependencies.repository;
    const accounts = repository.listForAgent(agent);
    const yielding = duplicateLoginRows(accounts);
    for (const account of yielding) {
      const kept = accounts.find((other) => other.id !== account.id && !yielding.includes(other) && sameLogin(loginOf(other), loginOf(account)));
      this.setAside(account, NO_LOGIN);
      this.noteIdentityChanged(account, 'duplicate');
      if (kept) this.repointSessions(account.id, kept.id);
    }
    if (yielding.length > 0) this.changed();
    return yielding.length > 0;
  }

  /**
   * The cheap check of an account's home: reads the login the CLI's own files record
   * (`readHomeIdentity`, no CLI run), and only when it is not the row's own login asks the CLI
   * (`refreshIdentity`) before anything changes. Run at each turn end and session end, when a
   * home's login file changes, and on every scheduled pass. A file with no answer changes nothing.
   */
  async checkHomeIdentity(accountId: string): Promise<void> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.kind === 'key-file') return;
    const foundLogin = await this.homeLoginOf(account);
    if (!foundLogin) return;
    if (account.status !== 'replaced' && sameLogin(loginOf(account), foundLogin)) return;
    if (account.status === 'replaced') {
      // Still set aside for the same listed login: nothing to ask the CLI.
      const decision = decideIdentity(account, this.dependencies.repository.listForAgent(account.agent), foundLogin);
      if (decision.kind === 'still-replaced') return;
    }
    // Signed out rows are read too: a home signed in again outside Kangentic is noticed.
    await this.refreshIdentity(accountId);
  }

  /**
   * A usage read that gave no windows: the account keeps its last values, and the local log says
   * why each time the reason changes, so a read that keeps failing is one line, not one per pass.
   * Every reason is reported at once but two. A failed CLI run waits for the next read
   * (`reportRepeatedRunFailure`). A `no-cache` read on an account that never stored a reading is
   * the home before the CLI's first usage fetch (an API-key login, a CLI that has not shown its
   * usage yet), so it is logged and not reported: Sentry DESKTOP-4E took that state for a fault
   * and reported it on every launch. Once the account had a reading, losing the cache is reported.
   * A `no-windows` read carries the CLI version as a tag: Sentry DESKTOP-4E had none, so a plan
   * whose windows are all null could not be told from a CLI release that changed what it writes.
   */
  private async noteEmptyUsageRead(account: AgentAccount, reason: EmptyUsageReadReason, failure: EmptyUsageReadError | null = null): Promise<void> {
    if (this.emptyUsageReasons.get(account.id) !== reason) {
      console.warn(`[ACCOUNTS] A usage read for a ${account.kind} account of ${account.agent} gave no windows (${reason}); it keeps its last reading`);
    }
    this.emptyUsageReasons.set(account.id, reason);
    if (reason === 'run-failed') {
      await this.reportRepeatedRunFailure(account, failure);
      return;
    }
    // The run itself worked, so a failed run before it is not one of a row.
    this.consecutiveRunFailures.delete(account.id);
    if (reason === 'no-cache' && account.lastUsageAt === null) return;
    const tags: AccountProblemTags = reason === 'no-windows'
      ? { agent_cli_version: cliVersionTag(await this.cliVersionOf(account.agent)) }
      : {};
    this.reportProblem('usage-read-empty', account.agent, { kind: account.kind, reason }, undefined, tags);
  }

  /**
   * Counts a usage read whose CLI run failed, and reports it once it has failed
   * `REPORTED_RUN_FAILURES` reads in a row for this account. The report says how the run ended
   * and which CLI ran, as tags, and hands on the error the adapter caught: Sentry DESKTOP-4E was
   * one failed run with none of that, so a timeout, an offline moment and a CLI too old for a
   * flag all looked the same.
   */
  private async reportRepeatedRunFailure(account: AgentAccount, failure: EmptyUsageReadError | null): Promise<void> {
    const failedRuns = (this.consecutiveRunFailures.get(account.id) ?? 0) + 1;
    this.consecutiveRunFailures.set(account.id, failedRuns);
    if (failedRuns < REPORTED_RUN_FAILURES) return;
    const runFailure = failure?.runFailure ?? null;
    const tags: AccountProblemTags = {
      run_failure: runFailure?.kind ?? 'unknown',
      ...(runFailure?.kind === 'exit_code' ? { run_exit: exitCodeTag(runFailure.exitCode) } : {}),
      agent_cli_version: cliVersionTag(await this.cliVersionOf(account.agent)),
    };
    this.reportProblem('usage-read-empty', account.agent, { kind: account.kind, reason: 'run-failed' }, failure?.cause, tags);
  }

  /** The agent CLI's version as detection read it, or null when nothing can say. */
  private async cliVersionOf(agent: string): Promise<string | null> {
    try {
      return (await this.dependencies.resolveCliVersion?.(agent)) ?? null;
    } catch {
      // report-ok: the version is one tag on a report that is being sent either way, and it reads
      // `unknown` without it.
      return null;
    }
  }

  /**
   * Reads an account's usage with no session running on it (`readIdleUsage`) and stores it. False
   * when the adapter has no such read or it gave no windows; the account then keeps its last
   * values, and a read that gave none is logged and reported (a failed CLI run from its second
   * read in a row).
   */
  async refreshUsage(accountId: string): Promise<boolean> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.kind === 'key-file') return false;
    // A `replaced` row's home holds another login, whose usage is not this row's. A login the CLI
    // says has no subscription (an API key) has no plan windows to read.
    if (account.status === 'signed-out' || account.status === 'not-found' || account.status === 'replaced' || account.status === 'no-subscription') {
      console.debug(`[ACCOUNTS] Usage read skipped: a ${account.kind} account is ${account.status}`);
      return false;
    }
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (!support || support.kind !== 'folder' || !support.readIdleUsage) return false;
    const cliPath = await this.dependencies.resolveCliPath?.(account.agent);
    if (!cliPath) return false;
    if (account.kind === 'folder' && (await this.usesRemoteTarget(account.agent))) return false;
    let windows: RateLimitWindow[] | null;
    try {
      windows = await support.readIdleUsage(cliPath, account.folderPath);
    } catch (error) {
      if (error instanceof EmptyUsageReadError) {
        await this.noteEmptyUsageRead(account, error.reason, error);
        return false;
      }
      if (!(error instanceof UnreadableUsageError)) throw error;
      // The CLI ran and answered, in a shape the adapter does not know.
      this.consecutiveRunFailures.delete(accountId);
      this.reportProblem('usage-read-unreadable', account.agent, { keys: error.keys });
      return false;
    }
    // An empty list would replace good windows with none and still stamp the read as fresh.
    if (!windows || windows.length === 0) {
      await this.noteEmptyUsageRead(account, windows ? 'no-windows' : 'no-answer');
      return false;
    }
    // From here the run worked, whatever becomes of its reading.
    this.consecutiveRunFailures.delete(accountId);
    // The reading is the login the home holds now. When that is not the row's own login (a
    // `/login` replaced it), the reading belongs to another row: the home is reconciled instead.
    if (account.email) {
      const found = await this.homeLoginOf(account);
      if (found && !sameLogin(loginOf(account), found)) {
        await this.refreshIdentity(accountId);
        return false;
      }
    }
    this.emptyUsageReasons.delete(accountId);
    // A full window the row holds stays full until its reset (`keepFullWindows`). Read again: a
    // live report may have landed while the CLI ran.
    const stored = this.dependencies.repository.getById(accountId)?.lastUsage ?? [];
    this.dependencies.repository.updateUsage(accountId, keepFullWindows(stored, windows, this.nowSeconds()));
    this.changed();
    return true;
  }

  /**
   * Before a spawn ranks an agent's accounts: reads every account whose reading is missing or stale
   * (`needsReadBeforeRanking`), so the choice is never made from a reading that has run out.
   * Manual reads too: it skips a full account, and a reading from before the account filled says
   * it has room. Bounded by the reader. Nothing for an agent with one account, one that reports no
   * usage, or one whose accounts cannot be read idle.
   */
  private async readBeforeRanking(agent: string): Promise<void> {
    const readStaleAccounts = this.dependencies.readBeforeRanking;
    if (!readStaleAccounts || !this.followsOrderMode(agent)) return;
    const support = this.dependencies.getAdapter(agent)?.accounts;
    if (support?.kind !== 'folder' || !support.readIdleUsage) return;
    const accounts = this.dependencies.repository.listForAgent(agent);
    if (accounts.length < 2) return;
    await readStaleAccounts(accounts);
  }

  /** The CLI's own sign-in for a folder account, to run in a terminal. Null when it cannot run. */
  async loginCommand(accountId: string): Promise<AccountLoginCommand | null> {
    const account = this.dependencies.repository.getById(accountId);
    if (!account) return null;
    const isOwnHome = account.kind === 'default';
    if (!isOwnHome && (account.kind !== 'folder' || !account.folderPath)) return null;
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (!support || support.kind !== 'folder') return null;
    const cliPath = await this.dependencies.resolveCliPath?.(account.agent);
    if (!cliPath) return null;
    // A CLI in a WSL distro keeps its own login there: a sign-in run from this side would start in
    // a folder the distro does not use.
    if (isOwnHome && (await this.usesRemoteTarget(account.agent))) return null;
    // The row's own login, filled in on the sign-in page where the CLI takes it.
    const emailArgs = account.email && support.loginEmailArgs ? support.loginEmailArgs(account.email) : [];
    // The agent's own home signs in with no home variable, exactly as the user's own terminal
    // does: naming its folder would move where the CLI keeps its state.
    const homeFolder = isOwnHome ? null : account.folderPath;
    return {
      cliPath,
      args: [...support.loginArgs, ...emailArgs],
      env: homeFolder ? support.accountEnv(homeFolder, support.defaultHome()) : {},
      ...(support.loginIsInteractive ? { cwd: homeFolder ?? support.defaultHome() } : {}),
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
    const repository = this.dependencies.repository;
    const before = repository.getById(accountId);
    if (!before) return { account: null, duplicateOf: null };
    // A row made for this sign-in: it never named a login. Only such a row is ever removed here,
    // never the agent's own home or a row that named a login (a Sign in on a row set aside).
    if (before.kind === 'folder' && before.email === null && before.status === 'signed-out') return this.completeNewRowLogin(before);
    const account = await this.refreshIdentity(accountId);
    if (!account) return { account: null, duplicateOf: null };
    // A Sign in on a row that landed another login already listed (the browser held another
    // account): the row stays set aside, and the dialog names the row that login belongs to.
    if (account.status === 'replaced' && before.email) {
      const homeLogin = await this.homeLoginOf(account);
      const duplicateOf = homeLogin
        ? repository.listForAgent(account.agent).find((other) => other.id !== account.id && other.status !== 'replaced' && sameLogin(loginOf(other), homeLogin)) ?? null
        : null;
      return { account, duplicateOf };
    }
    return { account, duplicateOf: null };
  }

  /** `completeLogin` for a row made for this sign-in, which never named a login. */
  private async completeNewRowLogin(before: AgentAccount): Promise<{ account: AgentAccount | null; duplicateOf: AgentAccount | null }> {
    const repository = this.dependencies.repository;
    const read = await this.readIdentity(before);
    if (read === 'skipped' || read === 'no-answer') return { account: repository.getById(before.id), duplicateOf: null };
    if (!read.identity.signedIn) {
      repository.delete(before.id);
      this.changed();
      return { account: null, duplicateOf: null };
    }
    const found = loginFromRead(read.identity);
    const duplicateOf = repository.listForAgent(before.agent)
      .find((other) => other.id !== before.id && sameLogin(loginOf(other), found)) ?? null;
    if (duplicateOf?.status === 'replaced' && duplicateOf.kind === 'folder' && before.folderPath) {
      // The login of a row set aside, signed in again through Add account: that row takes this
      // folder, which now holds its login, so it is listed once and keeps its place. Its old
      // folder stays on disk. Written from this read, never through `refreshIdentity`: that would
      // re-point the sessions still running in the old folder, which holds another login, to it.
      repository.setFolderPath(duplicateOf.id, before.folderPath);
      repository.delete(before.id);
      repository.updateIdentity(duplicateOf.id, {
        email: found.email,
        orgId: found.orgId ?? duplicateOf.orgId,
        plan: read.identity.plan,
        status: statusFor(read.linked, read.identity),
      });
      this.changed();
      return { account: repository.getById(duplicateOf.id), duplicateOf: null };
    }
    if (duplicateOf?.status === 'replaced' && duplicateOf.kind === 'default') {
      // The agent's own home lost this login to a `/login` and holds another listed one. The
      // new folder now holds this login, so it keeps the row; the home's row stays set aside
      // with no email, as a home whose login is listed elsewhere reads.
      this.setAside(duplicateOf, NO_LOGIN);
      await this.applyIdentity(before, read.identity, read.linked);
      this.changed();
      return { account: repository.getById(before.id), duplicateOf: null };
    }
    if (duplicateOf) {
      // Already listed: nothing is added, and the dialog names the existing row.
      repository.delete(before.id);
      this.changed();
      return { account: null, duplicateOf };
    }
    await this.applyIdentity(before, read.identity, read.linked);
    this.changed();
    return { account: repository.getById(before.id), duplicateOf: null };
  }

  /**
   * The login an account's home records now, read with no CLI run. Null when it gives no answer,
   * and for a CLI in a WSL distro, whose login is not in the home this side can read.
   */
  private async homeLoginOf(account: AgentAccount): Promise<LoginIdentity | null> {
    const support = this.dependencies.getAdapter(account.agent)?.accounts;
    if (support?.kind !== 'folder' || !support.readHomeIdentity) return null;
    if (account.kind === 'folder' && !account.folderPath) return null;
    if (await this.usesRemoteTarget(account.agent)) return null;
    const found = await support.readHomeIdentity(account.kind === 'folder' ? account.folderPath : null);
    return found ? loginFromRead(found) : null;
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

  /**
   * A drag: the list takes this order and stays in it. For an agent whose list follows the order
   * mode, that sets Manual; any other agent's list is already the user's order.
   */
  reorder(agent: string, orderedIds: readonly string[]): void {
    this.dependencies.repository.reorder(agent, orderedIds);
    if (this.followsOrderMode(agent)) this.setManual();
    this.changed();
  }

  /**
   * Switch to: the account moves to the top and the list stays in that order (Manual, for an agent
   * whose list follows the order mode). Refused for an
   * account that cannot run (signed out, no plan, links missing): running sessions would be moved
   * onto a login the CLI will not accept.
   */
  switchTo(accountId: string): boolean {
    const account = this.dependencies.repository.getById(accountId);
    if (!account || account.status !== 'ok') return false;
    // From the order on screen, so the rest of the list keeps the places the user sees.
    const ids = this.ordered(account.agent).map((other) => other.id).filter((id) => id !== accountId);
    this.dependencies.repository.reorder(account.agent, [accountId, ...ids]);
    if (this.followsOrderMode(account.agent)) this.setManual();
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
   * leaves out keeps its last value, and a full window keeps 100 until its reset whatever a later
   * report says (`keepFullWindows`). Writes only on a change: status reports repeat every few
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
      // A row set aside names a login its home no longer holds: a report stamped with it is the
      // home's new login, which its own row reads once the session is re-pointed.
      if (!account || account.status === 'replaced') continue;
      const previous = account.lastUsage ?? [];
      const next = keepFullWindows(previous, mergeUsage(previous, reported), this.nowSeconds());
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
   * `resume` names the conversation being resumed, whose own files the adapter carries into the
   * chosen home (`carryConversation`).
   */
  async resolveForSpawn(agent: string, overrideAccountId?: string | null, conversationAccountId?: string | null, resume?: SpawnResume): Promise<ResolvedAccount | null> {
    const adapter = this.dependencies.getAdapter(agent);
    if (!adapter?.accounts) return null;
    // The agent's own login is account #1, so its sessions are recorded against it too and its
    // usage lands on its row. Its env is empty: the spawn is exactly what it was before accounts.
    this.ensureDefaultAccount(agent);
    // A named account needs no ranking. Otherwise what has run out is read first, in either order
    // mode, which also covers a spawn at boot, before the first scheduled read.
    if (!overrideAccountId) await this.readBeforeRanking(agent);
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
      await this.carryConversation(adapter, candidate, ordered, resume);
      return { id: candidate.id, agent, kind: candidate.kind, env };
    }
    // More than one account and none could be prepared: the spawn runs on the agent's own login,
    // which is the `default` row, with nothing added to its env.
    this.reportProblem('spawn-account-unresolved', agent, { accounts: ordered.length, named: Boolean(overrideAccountId) });
    const ownLogin = ordered.find((account) => account.kind === 'default');
    if (ownLogin) await this.carryConversation(adapter, ownLogin, ordered, resume);
    return ownLogin ? { id: ownLogin.id, agent, kind: 'default', env: {} } : null;
  }

  /**
   * Hands a resume to the adapter's `carryConversation`, with every home the agent has: the
   * conversation's own files may sit in any of them. Never throws.
   */
  private async carryConversation(adapter: AgentAdapter, account: AgentAccount, ordered: readonly AgentAccount[], resume: SpawnResume | undefined): Promise<void> {
    const support = adapter.accounts;
    if (!resume || support?.kind !== 'folder' || !support.carryConversation) return;
    const defaultHome = support.defaultHome();
    const toHome = account.kind === 'folder' ? account.folderPath : defaultHome;
    if (!toHome) return;
    const folderHomes = ordered.flatMap((candidate) => (candidate.kind === 'folder' && candidate.folderPath ? [candidate.folderPath] : []));
    try {
      await support.carryConversation({ ...resume, defaultHome, toHome, homes: [defaultHome, ...folderHomes] });
    } catch (error) {
      console.warn('[ACCOUNTS] Could not carry a resumed conversation\'s files:', error instanceof Error ? error.message : String(error));
    }
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
 * Whether a resume runs on the account its conversation was written on, for the
 * `resume_account` tag of a launch report. An override, or a conversation account
 * that is signed out, puts the resume on another account, whose own config folder
 * has no such conversation, and the CLI answers "No conversation found" (a cause
 * Sentry DESKTOP-2M's event could not rule in or out). `none` when there is no
 * account to compare: nothing resumed, or an agent with no accounts.
 */
export function resumeAccountMatch(
  conversationAccountId: string | null | undefined,
  resolved: Pick<ResolvedAccount, 'id' | 'kind'> | null | undefined,
): ResumeAccountMatch {
  if (!resolved || conversationAccountId === undefined) return 'none';
  // Null is the agent's own login, which every record from before accounts ran on.
  const same = conversationAccountId === null ? resolved.kind === 'default' : resolved.id === conversationAccountId;
  return same ? 'same' : 'changed';
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
export async function resolveSpawnAccount(
  agent: string,
  overrideAccountId?: string | null,
  conversationAccountId?: string | null,
  resume?: SpawnResume,
): Promise<ResolvedAccount | null> {
  try {
    return (await service?.resolveForSpawn(agent, overrideAccountId, conversationAccountId, resume)) ?? null;
  } catch (error) {
    // An account that cannot be prepared must not stop the spawn: it runs on the agent's own login.
    console.warn('[ACCOUNTS] Could not resolve an account for the spawn:', error);
    service?.reportProblem('spawn-account-unresolved', agent, { threw: true }, error);
    return null;
  }
}
