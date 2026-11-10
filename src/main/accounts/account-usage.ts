import type { AgentAccount } from '../../shared/agent-accounts';
import type { AccountService } from './account-service';

/** How often idle accounts are read while the app runs. */
export const USAGE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** A reading this recent is not read again: a live session reported it, or a read just ran. */
export const USAGE_FRESH_MS = 60 * 1000;
/** How long after a window's reset its account is read, so the CLI's servers have rolled it over. */
const AFTER_RESET_MS = 30 * 1000;
/** The first read after the app opens, once startup's own work is out of the way. */
const STARTUP_DELAY_MS = 20 * 1000;

/** The agents with two or more accounts: the only ones whose usage is read on a schedule. */
function multiAccountAgents(accounts: readonly AgentAccount[]): Set<string> {
  const perAgent = new Map<string, number>();
  for (const account of accounts) perAgent.set(account.agent, (perAgent.get(account.agent) ?? 0) + 1);
  return new Set([...perAgent].filter(([, count]) => count >= 2).map(([agent]) => agent));
}

export interface AccountUsageRefresherOptions {
  listAccounts: () => AgentAccount[];
  now?: () => number;
  intervalMs?: number;
  startupDelayMs?: number;
}

/**
 * Keeps every account's usage current with no session running on it and no input from the user:
 * when the app opens, when the Accounts tab opens, when a window's reset passes, every 15
 * minutes, and before a switch. One read at a time (each is one short CLI run in the pty host), a
 * failed read keeps the last values, and nothing runs for an agent with a single account except
 * when the tab asks, so a one-account user's machine does nothing new.
 */
export class AccountUsageRefresher {
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  /** Queued accounts whose read must run even when their reading is fresh. */
  private readonly forced = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly service: Pick<AccountService, 'refreshUsage'>,
    private readonly options: AccountUsageRefresherOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    if (this.interval || this.disposed) return;
    this.startupTimer = setTimeout(() => void this.refreshAll('scheduled'), this.options.startupDelayMs ?? STARTUP_DELAY_MS);
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

  private isFresh(account: AgentAccount): boolean {
    if (!account.lastUsageAt) return false;
    const readAt = Date.parse(account.lastUsageAt);
    if (!Number.isFinite(readAt) || this.now() - readAt > USAGE_FRESH_MS) return false;
    // A window whose reset has passed since the reading is stale however recent the reading is.
    return !(account.lastUsage ?? []).some((window) => window.resetsAt > 0 && window.resetsAt * 1000 <= this.now());
  }

  /**
   * Reads one account, behind any read already queued. Resolves once it has been read or skipped.
   * `force` reads even a fresh reading, and holds when the account is already queued unforced: the
   * queued read becomes a forced one.
   */
  refreshAccount(accountId: string, force = false): Promise<void> {
    if (this.disposed) return this.queue;
    if (force) this.forced.add(accountId);
    if (this.queued.has(accountId)) return this.queue;
    this.queued.add(accountId);
    this.queue = this.queue.then(async () => {
      this.queued.delete(accountId);
      const forced = this.forced.delete(accountId);
      if (this.disposed) return;
      const account = this.options.listAccounts().find((candidate) => candidate.id === accountId);
      if (!account || (!forced && this.isFresh(account))) return;
      try {
        await this.service.refreshUsage(accountId);
      } catch (error) {
        console.warn('[ACCOUNTS] A usage read failed:', error);
      }
    });
    return this.queue;
  }

  /**
   * Reads every account that is due. `scheduled` reads only agents with two or more accounts;
   * `requested` (the Accounts tab opening, a switch about to be chosen) reads them all.
   */
  async refreshAll(scope: 'scheduled' | 'requested'): Promise<void> {
    if (this.disposed) return;
    const accounts = this.options.listAccounts();
    const multiAccount = multiAccountAgents(accounts);
    for (const account of accounts) {
      if (scope === 'scheduled' && !multiAccount.has(account.agent)) continue;
      void this.refreshAccount(account.id);
    }
    await this.queue;
    this.armResetTimer();
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
