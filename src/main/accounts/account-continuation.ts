import type { AgentAccount, AgentAccountsConfig } from '../../shared/agent-accounts';
import { firstReset, hasRoom, isNearFull, nextAccountWithRoom, topAccountWithRoom } from './account-order';
import { accountsReporter } from './account-report';

/** What a continued session is told, so the turn the limit cut short is picked up. */
export const CONTINUE_PROMPT = 'Continue.';

/** The session a limit stopped, as the continuation needs it. */
export interface LimitedSession {
  sessionId: string;
  taskId: string;
  projectId: string;
  agent: string;
  accountId: string;
  /** The session resumed an earlier conversation, rather than starting one. */
  resuming?: boolean;
}

export interface AccountContinuationDependencies {
  readConfig: () => AgentAccountsConfig;
  /** A running task session by id. Null for anything else (a Command Terminal, a workflow agent). */
  findTaskSession: (sessionId: string) => LimitedSession | null;
  /** Whether the agent's sessions can move to another account at all. */
  canContinue: (agent: string) => boolean;
  /** The adapter's own reading of a failed turn's detail: is it a usage limit? */
  isUsageLimitFailure: (agent: string, detail: string) => boolean;
  /** The agent's accounts in run order. */
  ordered: (agent: string) => AgentAccount[];
  /** Reads one account's usage from its CLI now. Resolves when read; a failed read keeps the last values. */
  readUsageNow: (accountId: string) => Promise<void>;
  /**
   * The prompt the session was started with, from its record. Null when it started with none.
   * A session moved at its start never had that prompt answered, so the move carries it.
   */
  openingPrompt: (session: LimitedSession) => string | null;
  /**
   * Restarts the task's session on `accountId` with `prompt`, or resumes it idle with none. False
   * when it did not restart.
   */
  continueOn: (session: LimitedSession, accountId: string, prompt: string | undefined) => Promise<boolean>;
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
 * one has reset. Task sessions only; a Command Terminal or a workflow's agent at its limit waits
 * as it always has.
 *
 * A resumed session that starts on a full account is decided the same way, from its SessionStart
 * (`onSessionStarted`), since such a resume can end with no failed turn at all.
 */
export class AccountContinuation {
  /** Sessions being decided or restarted now, so a second failure event does not start a second pass. */
  private readonly inFlight = new Set<string>();
  /**
   * Sessions whose every account was full, with the prompt they continue with (none: resumed
   * idle): continued when one frees.
   */
  private readonly waiting = new Map<string, { session: LimitedSession; prompt: string | undefined }>();
  /** Sessions whose start was already checked: a later SessionStart (a compact, a clear) is not a start. */
  private readonly startChecked = new Set<string>();
  /** Agents already told that every account is full, until one has room again. */
  private readonly allFullNotified = new Set<string>();

  constructor(private readonly dependencies: AccountContinuationDependencies) {}

  private nowSeconds(): number {
    return Math.floor((this.dependencies.now?.() ?? Date.now()) / 1000);
  }

  /** A turn failed. Resolves once the session was continued, left waiting, or left alone. */
  async onTurnFailure(sessionId: string, detail: string): Promise<'continued' | 'waiting' | 'ignored'> {
    return this.reportingFailures(() => {
      if (!this.dependencies.readConfig().autoSwitchAtLimit) return 'ignored';
      const session = this.dependencies.findTaskSession(sessionId);
      if (!session || !this.dependencies.canContinue(session.agent)) return 'ignored';
      if (!this.dependencies.isUsageLimitFailure(session.agent, detail)) return 'ignored';
      // A session already waiting with its opening prompt keeps it: that prompt was never
      // answered, and `Continue.` would drop it. One waiting idle continues with `Continue.`.
      return this.decide(session, this.waiting.get(sessionId)?.prompt ?? CONTINUE_PROMPT);
    });
  }

  /**
   * A task session's agent started. A resume Claude refuses at a spent limit can end with no hook
   * but its SessionStart (task #1147, Claude Code 2.1.330), so no failed turn would ever bring it
   * here. A resumed session that started on an account its row shows full, or near full, is
   * decided as a limit would be, and a move carries its opening prompt, which was never answered.
   * Only the session's first start counts: a compact or a clear fires SessionStart mid-session. A
   * fresh session is left to its failed turn, which fires, and which a move here could cut short
   * before its conversation was written. An account well short of full costs nothing: no read runs.
   */
  async onSessionStarted(sessionId: string): Promise<'continued' | 'waiting' | 'ignored'> {
    return this.reportingFailures(() => {
      if (this.startChecked.has(sessionId)) return 'ignored';
      // Marked only for a live task session: a start that arrives after the session was removed
      // would otherwise leave its id here for good, since `forgetSession` already ran. Marked
      // before the setting is read, so a compact after the setting turns on is still not a start.
      const session = this.dependencies.findTaskSession(sessionId);
      if (!session) return 'ignored';
      this.startChecked.add(sessionId);
      if (!this.dependencies.readConfig().autoSwitchAtLimit) return 'ignored';
      if (!session.resuming || !this.dependencies.canContinue(session.agent)) return 'ignored';
      const sessionAccount = this.accountOf(session);
      const nowSeconds = this.nowSeconds();
      if (!sessionAccount || (hasRoom(sessionAccount, nowSeconds) && !isNearFull(sessionAccount, nowSeconds))) return 'ignored';
      return this.decide(session, this.dependencies.openingPrompt(session) ?? undefined);
    });
  }

  /** The session ended or was replaced: nothing waits on it any more. */
  forgetSession(sessionId: string): void {
    this.waiting.delete(sessionId);
    this.startChecked.delete(sessionId);
  }

  /** Usage changed somewhere. Continues waiting sessions whose agent has an account with room. */
  async recheck(): Promise<void> {
    for (const { session, prompt } of [...this.waiting.values()]) {
      const live = this.dependencies.findTaskSession(session.sessionId);
      if (!live) {
        this.waiting.delete(session.sessionId);
        continue;
      }
      const ordered = this.dependencies.ordered(live.agent);
      if (topAccountWithRoom(ordered, this.nowSeconds())) await this.decide(live, prompt);
    }
  }

  /** The account the session runs on, from the agent's current rows. */
  private accountOf(session: LimitedSession): AgentAccount | undefined {
    return this.dependencies.ordered(session.agent).find((account) => account.id === session.accountId);
  }

  /**
   * Runs an entry point whose checks before `decide` read the registry and the database, so a
   * throw there is reported instead of rejecting a promise its listener never awaits.
   */
  private async reportingFailures(
    entry: () => Promise<'continued' | 'waiting' | 'ignored'> | 'ignored',
  ): Promise<'continued' | 'waiting' | 'ignored'> {
    try {
      return await entry();
    } catch (error) {
      console.warn('[ACCOUNTS] Could not check a session for its usage limit:', error);
      accountsReporter.report(error, { tags: { stage: 'continuation' } });
      return 'ignored';
    }
  }

  /**
   * Reads the session's account and, when it is full, moves the session to the next account with
   * room, restarting it with `prompt`: `Continue.` for a turn a limit cut short, the opening
   * prompt for a session moved at its start, or none to resume it idle.
   */
  private async decide(session: LimitedSession, prompt: string | undefined): Promise<'continued' | 'waiting' | 'ignored'> {
    if (this.inFlight.has(session.sessionId)) return 'ignored';
    this.inFlight.add(session.sessionId);
    try {
      if (this.dependencies.ordered(session.agent).length < 2) return 'ignored';
      await this.dependencies.readUsageNow(session.accountId);
      const sessionAccount = this.accountOf(session);
      if (!sessionAccount) return 'ignored';
      if (hasRoom(sessionAccount, this.nowSeconds())) {
        // Not full after all: a momentary limit the CLI retries by itself.
        if (!this.waiting.has(session.sessionId)) return 'ignored';
        // It was waiting for room and its own account is the one that freed: it continues there.
        const resumed = await this.dependencies.continueOn(session, sessionAccount.id, prompt);
        if (!resumed) return 'ignored';
        this.waiting.delete(session.sessionId);
        this.allFullNotified.delete(session.agent);
        return 'continued';
      }

      // Each candidate is read before it is chosen. One that turns out full is passed over.
      const tried = new Set<string>([sessionAccount.id]);
      for (;;) {
        const candidate = nextAccountWithRoom(
          this.dependencies.ordered(session.agent).filter((account) => account.id === sessionAccount.id || !tried.has(account.id)),
          sessionAccount.id,
          this.nowSeconds(),
        );
        if (!candidate) break;
        tried.add(candidate.id);
        await this.dependencies.readUsageNow(candidate.id);
        const fresh = this.dependencies.ordered(session.agent).find((account) => account.id === candidate.id);
        if (!fresh || !hasRoom(fresh, this.nowSeconds())) continue;
        const continued = await this.dependencies.continueOn(session, fresh.id, prompt);
        if (!continued) return 'ignored';
        this.waiting.delete(session.sessionId);
        this.allFullNotified.delete(session.agent);
        this.dependencies.notifySwitched(session, fresh);
        return 'continued';
      }

      this.waiting.set(session.sessionId, { session, prompt });
      if (!this.allFullNotified.has(session.agent)) {
        this.allFullNotified.add(session.agent);
        this.dependencies.notifyAllFull(session.agent, firstReset(this.dependencies.ordered(session.agent), this.nowSeconds()));
      }
      return 'waiting';
    } catch (error) {
      console.warn('[ACCOUNTS] Could not continue a session at its usage limit:', error);
      // The session stalls at its limit with nothing on screen to say why.
      accountsReporter.report(error, { tags: { stage: 'continuation' } });
      return 'ignored';
    } finally {
      this.inFlight.delete(session.sessionId);
    }
  }
}
