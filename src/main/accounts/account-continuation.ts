import type { AgentAccount, AgentAccountsConfig } from '../../shared/agent-accounts';
import { firstReset, hasRoom, nextAccountWithRoom, topAccountWithRoom } from './account-order';

/** What a continued session is told, so the turn the limit cut short is picked up. */
export const CONTINUE_PROMPT = 'Continue.';

/** The session a limit stopped, as the continuation needs it. */
export interface LimitedSession {
  sessionId: string;
  taskId: string;
  projectId: string;
  agent: string;
  accountId: string;
}

export interface AccountContinuationDependencies {
  readConfig: () => AgentAccountsConfig;
  /** A running task session by id. Null for anything else (a Command Terminal, a workflow agent). */
  findTaskSession: (sessionId: string) => LimitedSession | null;
  /** The adapter's own reading of a failed turn's detail: is it a usage limit? */
  isUsageLimitFailure: (agent: string, detail: string) => boolean;
  /** The agent's accounts in run order. */
  ordered: (agent: string) => AgentAccount[];
  /** Reads one account's usage from its CLI now. Resolves when read; a failed read keeps the last values. */
  readUsageNow: (accountId: string) => Promise<void>;
  /** Restarts the task's session on `accountId` with `prompt`. False when it did not restart. */
  continueOn: (session: LimitedSession, accountId: string, prompt: string) => Promise<boolean>;
  notifySwitched: (session: LimitedSession, account: AgentAccount) => void;
  notifyAllFull: (agent: string, firstFree: { account: AgentAccount; resetsAt: number } | null) => void;
  now?: () => number;
}

/**
 * Continues a session on the next account when its own reaches its usage limit (task #1057).
 *
 * The trigger is two facts together, never a percentage alone:
 * 1. The turn failed, and the adapter reads the failure as a usage limit. A session that is
 *    working is never touched, and neither is one whose turn ended on its own.
 * 2. A fresh read of the session's account, made then, shows it has no room. A CLI reports a
 *    momentary rate limit with the same error as a spent plan, and retries those by itself; only
 *    an account that is actually full is left.
 *
 * Then the next account in the list is read too, so a session is never moved onto an account that
 * filled since its last report. With no account free, the session waits where it is: it is noted
 * once, and continued when a later read shows room, on another account or on its own once that
 * one has reset. Task sessions only; a Command Terminal or a
 * workflow's agent at its limit waits as it always has.
 */
export class AccountContinuation {
  /** Sessions being decided or restarted now, so a second failure event does not start a second pass. */
  private readonly inFlight = new Set<string>();
  /** Sessions whose every account was full: continued when one frees. */
  private readonly waiting = new Map<string, LimitedSession>();
  /** Agents already told that every account is full, until one has room again. */
  private readonly allFullNotified = new Set<string>();

  constructor(private readonly dependencies: AccountContinuationDependencies) {}

  private nowSeconds(): number {
    return Math.floor((this.dependencies.now?.() ?? Date.now()) / 1000);
  }

  /** A turn failed. Resolves once the session was continued, left waiting, or left alone. */
  async onTurnFailure(sessionId: string, detail: string): Promise<'continued' | 'waiting' | 'ignored'> {
    if (!this.dependencies.readConfig().autoSwitchAtLimit) return 'ignored';
    const session = this.dependencies.findTaskSession(sessionId);
    if (!session || !this.dependencies.isUsageLimitFailure(session.agent, detail)) return 'ignored';
    return this.decide(session);
  }

  /** The session ended or was replaced: nothing waits on it any more. */
  forgetSession(sessionId: string): void {
    this.waiting.delete(sessionId);
  }

  /** Usage changed somewhere. Continues waiting sessions whose agent has an account with room. */
  async recheck(): Promise<void> {
    for (const session of [...this.waiting.values()]) {
      const live = this.dependencies.findTaskSession(session.sessionId);
      if (!live) {
        this.waiting.delete(session.sessionId);
        continue;
      }
      const ordered = this.dependencies.ordered(live.agent);
      if (topAccountWithRoom(ordered, this.nowSeconds())) await this.decide(live);
    }
  }

  private async decide(session: LimitedSession): Promise<'continued' | 'waiting' | 'ignored'> {
    if (this.inFlight.has(session.sessionId)) return 'ignored';
    this.inFlight.add(session.sessionId);
    try {
      if (this.dependencies.ordered(session.agent).length < 2) return 'ignored';
      await this.dependencies.readUsageNow(session.accountId);
      const own = this.dependencies.ordered(session.agent).find((account) => account.id === session.accountId);
      if (!own) return 'ignored';
      if (hasRoom(own, this.nowSeconds())) {
        // Not full after all: a momentary limit the CLI retries by itself.
        if (!this.waiting.has(session.sessionId)) return 'ignored';
        // It was waiting for room and its own account is the one that freed: it continues there.
        const resumed = await this.dependencies.continueOn(session, own.id, CONTINUE_PROMPT);
        if (!resumed) return 'ignored';
        this.waiting.delete(session.sessionId);
        this.allFullNotified.delete(session.agent);
        return 'continued';
      }

      // Each candidate is read before it is chosen. One that turns out full is passed over.
      const tried = new Set<string>([own.id]);
      for (;;) {
        const candidate = nextAccountWithRoom(
          this.dependencies.ordered(session.agent).filter((account) => account.id === own.id || !tried.has(account.id)),
          own.id,
          this.nowSeconds(),
        );
        if (!candidate) break;
        tried.add(candidate.id);
        await this.dependencies.readUsageNow(candidate.id);
        const fresh = this.dependencies.ordered(session.agent).find((account) => account.id === candidate.id);
        if (!fresh || !hasRoom(fresh, this.nowSeconds())) continue;
        const continued = await this.dependencies.continueOn(session, fresh.id, CONTINUE_PROMPT);
        if (!continued) return 'ignored';
        this.waiting.delete(session.sessionId);
        this.allFullNotified.delete(session.agent);
        this.dependencies.notifySwitched(session, fresh);
        return 'continued';
      }

      this.waiting.set(session.sessionId, session);
      if (!this.allFullNotified.has(session.agent)) {
        this.allFullNotified.add(session.agent);
        this.dependencies.notifyAllFull(session.agent, firstReset(this.dependencies.ordered(session.agent), this.nowSeconds()));
      }
      return 'waiting';
    } catch (error) {
      console.warn('[ACCOUNTS] Could not continue a session at its usage limit:', error);
      return 'ignored';
    } finally {
      this.inFlight.delete(session.sessionId);
    }
  }
}
