import type { AgentAccount } from '../../shared/agent-accounts';
import type { ChokepointReporter } from '../analytics/handled-report';
import type { AccountService } from './account-service';
import { multiAccountAgents } from './account-order';

/** How often idle accounts are read while the app runs. */
export const USAGE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** A reading this recent is not read again: a live session reported it, or a read just ran. */
export const USAGE_FRESH_MS = 60 * 1000;
/** Past this age a reading is stale for ranking: a scheduled pass should have replaced it. */
export const USAGE_STALE_FOR_RANKING_MS = USAGE_REFRESH_INTERVAL_MS + 5 * 60 * 1000;
/** How long a spawn waits for the reads it asked for before it ranks on the stored readings. */
export const READ_BEFORE_RANKING_TIMEOUT_MS = 10 * 1000;
/** A read a spawn asked for is not asked again this soon, so a read that keeps failing costs one run. */
const READ_BEFORE_RANKING_RETRY_MS = 60 * 1000;
/** How long after a window's reset its account is read, so the CLI's servers have rolled it over. */
const AFTER_RESET_MS = 30 * 1000;
/** The first read after the app opens, once startup's own work is out of the way. */
const STARTUP_DELAY_MS = 20 * 1000;

/**
 * True when the account's reading is no older than `maxAgeMs` and no window in it has reset since.
 * A window whose reset has passed is stale however recent the reading is.
 */
function readingIsCurrent(account: AgentAccount, nowMs: number, maxAgeMs: number): boolean {
  if (!account.lastUsageAt) return false;
  const readAt = Date.parse(account.lastUsageAt);
  if (!Number.isFinite(readAt) || nowMs - readAt > maxAgeMs) return false;
  return !(account.lastUsage ?? []).some((window) => window.resetsAt > 0 && window.resetsAt * 1000 <= nowMs);
}

/**
 * True when a spawn must read the account before it ranks it: it can run, and it has no reading,
 * a reading older than a scheduled pass should leave, or a window whose reset has passed since.
 * Ranking on such a reading puts the account after every account with a live one.
 */
export function needsReadBeforeRanking(account: AgentAccount, nowMs: number): boolean {
  if (account.kind === 'key-file' || account.status !== 'ok') return false;
  return !readingIsCurrent(account, nowMs, USAGE_STALE_FOR_RANKING_MS);
}

export interface AccountUsageRefresherOptions {
  listAccounts: () => AgentAccount[];
  now?: () => number;
  intervalMs?: number;
  startupDelayMs?: number;
  /** Reports a read that failed in a way the service did not handle. Absent: nothing is sent. */
  failureReporter?: Pick<ChokepointReporter, 'report'>;
  /**
   * Called once, before any account is read: at the start of the startup pass, or when the
   * startup delay runs out if a `startupGate` holds the pass back longer. The login file watch
   * starts here rather than at registration: registration reads no database, and this is the
   * first thing that does.
   */
  onStartup?: () => void;
  /**
   * Resolves when the startup pass may run. The pass starts a CLI per account, so main holds it
   * until the launch has settled (`boot-settle.ts`) instead of landing it on the seconds the
   * resumed agents are starting in. It is asked when the startup delay runs out, so a gate that
   * is already open never brings the pass forward. Absent: the pass runs at the delay.
   */
  startupGate?: () => Promise<void>;
  /**
   * Called after each account's usage read settles, read or failed, and after each pass, the
   * reset timer's included. Automatic order can change on any of them, the clock alone included
   * (a longest window that reset sorts its account last), so running sessions are re-placed here
   * (`AutomaticOrderFollower`). Never per `accounts:changed` push.
   */
  onReadSettled?: () => void;
}

/** Which accounts a pass reads, and whose sign-in it reads first. */
export type UsageRefreshScope = 'startup' | 'scheduled' | 'requested';

/**
 * Keeps every account's usage current with no session running on it and no input from the user:
 * when the app opens, when the Accounts tab opens, when a window's reset passes, every 15
 * minutes, before a switch, and before a spawn ranks an account whose reading ran out. One CLI
 * run at a time, a failed read keeps the last values, and nothing runs for an agent with a single
 * account except when the tab asks, so a one-account user's machine does nothing new.
 *
 * A sign-in read runs before the usage read where the status may be wrong: on the startup pass for
 * every account of an agent with two or more (a login can change while the app is closed), and on
 * each scheduled pass for such an account that is not `ok`. Without that, an account a failed
 * sign-in read marked signed out was never read again until the tab opened.
 */
export class AccountUsageRefresher {
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private readonly identityQueued = new Set<string>();
  /** Queued accounts whose read must run even when their reading is fresh. */
  private readonly forced = new Set<string>();
  /** Each account's latest usage read, queued or running, until it settles. */
  private readonly pendingReads = new Map<string, Promise<void>>();
  /** When a spawn last asked for each account's read. */
  private readonly rankingReadAt = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private startupAnnounced = false;

  constructor(
    private readonly service: Pick<AccountService, 'refreshUsage' | 'refreshIdentity' | 'checkHomeIdentity'>,
    private readonly options: AccountUsageRefresherOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Runs `onStartup` the first time it is asked, and never again. */
  private announceStartup(): void {
    if (this.startupAnnounced) return;
    this.startupAnnounced = true;
    this.options.onStartup?.();
  }

  start(): void {
    if (this.interval || this.disposed) return;
    const startupDelayMs = this.options.startupDelayMs ?? STARTUP_DELAY_MS;
    const gate = this.options.startupGate;
    if (gate) {
      // Never sooner than the delay, and then not before the gate opens. The login file watch
      // starts no process, so it starts at the delay either way. Only the reads wait.
      this.startupTimer = setTimeout(() => {
        this.announceStartup();
        void gate().then(() => {
          if (!this.disposed) void this.refreshAll('startup');
        });
      }, startupDelayMs);
    } else {
      this.startupTimer = setTimeout(() => void this.refreshAll('startup'), startupDelayMs);
    }
    this.startupTimer.unref?.();
    this.interval = setInterval(() => void this.refreshAll('scheduled'), this.options.intervalMs ?? USAGE_REFRESH_INTERVAL_MS);
    this.interval.unref?.();
  }

  /** Synchronous: clears the timers. A read in flight finishes on its own and is ignored. */
  dispose(): void {
    this.disposed = true;
    if (this.interval) clearInterval(this.interval);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.interval = null;
    this.startupTimer = null;
    this.resetTimer = null;
  }

  /**
   * Reads who is signed in to one account, behind any read already queued. `cheap` reads the
   * home's own files and runs the CLI only when they name another login than the row
   * (`checkHomeIdentity`), so a pass over working accounts costs no CLI run.
   */
  private identifyAccount(accountId: string, cheap = false): Promise<void> {
    if (this.disposed || this.identityQueued.has(accountId)) return this.queue;
    this.identityQueued.add(accountId);
    this.queue = this.queue.then(async () => {
      this.identityQueued.delete(accountId);
      if (this.disposed) return;
      try {
        if (cheap) await this.service.checkHomeIdentity(accountId);
        else await this.service.refreshIdentity(accountId);
      } catch (error) {
        // The service handles a sign-in read that gave no answer, so what reaches here is a defect.
        // The account keeps its status, and the next pass asks again.
        console.warn('[ACCOUNTS] A sign-in read failed:', error instanceof Error ? error.name : 'unknown');
        this.options.failureReporter?.report(error, { tags: { stage: 'sign_in_read' } });
      }
    });
    return this.queue;
  }

  /**
   * Compares an account's home with its row now (a turn ended or a session ended on it, or its
   * login file changed), behind any read already queued. The CLI runs only when they differ.
   */
  checkHome(accountId: string): Promise<void> {
    return this.identifyAccount(accountId, true);
  }

  /**
   * Reads one account, behind any read already queued. Resolves once it has been read or skipped.
   * `force` reads even a fresh reading, and holds when the account is already queued unforced: the
   * queued read becomes a forced one. Never rejects, so the queue behind it keeps running.
   */
  refreshAccount(accountId: string, force = false): Promise<void> {
    if (this.disposed) return this.queue;
    if (force) this.forced.add(accountId);
    const queuedRead = this.queued.has(accountId) ? this.pendingReads.get(accountId) : undefined;
    if (queuedRead) return queuedRead;
    this.queued.add(accountId);
    const read: Promise<void> = this.queue.then(async () => {
      this.queued.delete(accountId);
      const forced = this.forced.delete(accountId);
      if (this.disposed) return;
      try {
        const account = this.options.listAccounts().find((candidate) => candidate.id === accountId);
        if (!account || (!forced && readingIsCurrent(account, this.now(), USAGE_FRESH_MS))) return;
        await this.service.refreshUsage(accountId);
      } catch (error) {
        // The service handles a read that gave no windows, so what reaches here is a defect. The
        // account keeps its last values, and the next pass asks again.
        console.warn('[ACCOUNTS] A usage read failed:', error instanceof Error ? error.name : 'unknown');
        this.options.failureReporter?.report(error, { tags: { stage: 'usage_read' } });
      }
    }).finally(() => {
      // A read queued behind this one while it ran holds the entry now; leave that one.
      if (this.pendingReads.get(accountId) === read) this.pendingReads.delete(accountId);
      this.announceReadSettled();
    });
    this.pendingReads.set(accountId, read);
    this.queue = read;
    return read;
  }

  /**
   * Reads every account that is due. `scheduled` reads only agents with two or more accounts, and
   * reads the sign-in of any account that is not `ok` first. `startup` does the same with every
   * account's sign-in. `requested` (the Accounts tab opening, a switch about to be chosen) reads
   * every agent's usage; its caller reads the sign-ins itself.
   */
  async refreshAll(scope: UsageRefreshScope): Promise<void> {
    if (this.disposed) return;
    if (scope === 'startup') this.announceStartup();
    const accounts = this.options.listAccounts();
    const multiAccount = multiAccountAgents(accounts);
    for (const account of accounts) {
      if (scope !== 'requested' && !multiAccount.has(account.agent)) continue;
      if (account.kind !== 'key-file') {
        if (scope === 'startup' || (scope === 'scheduled' && account.status !== 'ok')) void this.identifyAccount(account.id);
        // A working account's login can be replaced by a `/login` in any session on its home:
        // each pass compares the home's own record with the row, with no CLI run.
        else if (scope === 'scheduled') void this.identifyAccount(account.id, true);
      }
      void this.refreshAccount(account.id);
    }
    await this.queue;
    this.armResetTimer();
    this.announceReadSettled();
  }

  /** `onReadSettled`, which must never throw into the read queue. */
  private announceReadSettled(): void {
    if (this.disposed) return;
    try {
      this.options.onReadSettled?.();
    } catch (error) {
      console.warn('[ACCOUNTS] Could not re-place running sessions after a usage read:', error instanceof Error ? error.name : 'unknown');
      this.options.failureReporter?.report(error, { tags: { stage: 'follow_order' } });
    }
  }

  /**
   * Before a spawn ranks `accounts`: reads each one whose reading is missing or
   * stale, then resolves. Resolves at `timeoutMs` either way, so a slow CLI delays a spawn by that
   * much at most, and the spawn then ranks on the stored readings. Never rejects.
   */
  async readBeforeRanking(accounts: readonly AgentAccount[], timeoutMs: number = READ_BEFORE_RANKING_TIMEOUT_MS): Promise<void> {
    if (this.disposed) return;
    const nowMs = this.now();
    const stale = accounts.filter((account) => needsReadBeforeRanking(account, nowMs));
    if (stale.length === 0) return;
    for (const account of stale) {
      const askedAt = this.rankingReadAt.get(account.id);
      // Asked within the minute: the read is queued already, or it ran and gave nothing.
      if (askedAt !== undefined && nowMs - askedAt < READ_BEFORE_RANKING_RETRY_MS) continue;
      this.rankingReadAt.set(account.id, nowMs);
      void this.refreshAccount(account.id, true);
    }
    // A spawn waits on these accounts' reads, whoever queued them: spawns at boot arrive together,
    // and a second one must not rank while the first one's read is still running. It never waits
    // on reads of other accounts, and a read that already ran costs nothing.
    const reads = stale.flatMap((account) => {
      const pending = this.pendingReads.get(account.id);
      return pending ? [pending] : [];
    });
    if (reads.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutSignal = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs);
      timer.unref?.();
    });
    // report-ok: refreshAccount reports a failed read itself (stage `usage_read`), and the spawn
    // ranks on the stored readings either way.
    const finished = Promise.all(reads).then(() => 'read' as const, () => 'read' as const);
    const result = await Promise.race([finished, timeoutSignal]);
    if (timer) clearTimeout(timer);
    if (result === 'timed-out') console.warn(`[ACCOUNTS] Usage reads before ranking ran past ${timeoutMs} ms; ranking on the stored readings`);
  }

  /** One timer for the soonest window reset among multi-account agents, re-armed after each pass. */
  private armResetTimer(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    if (this.disposed) return;
    const accounts = this.options.listAccounts();
    const multiAccount = multiAccountAgents(accounts);
    let soonestMs: number | null = null;
    for (const account of accounts) {
      if (!multiAccount.has(account.agent)) continue;
      for (const window of account.lastUsage ?? []) {
        const resetMs = window.resetsAt * 1000;
        if (resetMs > this.now() && (soonestMs === null || resetMs < soonestMs)) soonestMs = resetMs;
      }
    }
    if (soonestMs === null) return;
    const interval = this.options.intervalMs ?? USAGE_REFRESH_INTERVAL_MS;
    const delay = soonestMs + AFTER_RESET_MS - this.now();
    // Past the next scheduled pass, that pass covers it.
    if (delay > interval) return;
    this.resetTimer = setTimeout(() => void this.refreshAll('scheduled'), delay);
    this.resetTimer.unref?.();
  }
}
