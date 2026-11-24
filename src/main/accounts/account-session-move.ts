import type { AgentAccount } from '../../shared/agent-accounts';
import { loginOf, sameLogin } from './account-identity';

/** Which kind of running session: each restarts in place its own way. */
export type RunningSessionKind = 'task' | 'command-terminal' | 'workflow';

/** A running agent session, as a move to another account needs it. */
export interface RunningSession {
  sessionId: string;
  kind: RunningSessionKind;
  projectId: string;
  /** The task, the Command Terminal's process tag, or the workflow the session belongs to. */
  ownerId: string;
  agent: string;
  /** The account it runs on. Null where accounts do not apply (a CLI in WSL): never moved. */
  accountId: string | null;
}

/**
 * Where a session stands for a restart now. `idle`: its turn is over and it waits on the user.
 * `between-tools`: mid-turn, between two tool calls, with every result written. Null: not now.
 */
export type SafePoint = 'idle' | 'between-tools' | null;

/**
 * How one restart ended: moved, not done, or failed. `deferred` means the session waits and is
 * looked at again: it left its safe point under its lock (every kind), its conversation id is not
 * recorded yet (a workflow agent), or nobody has used it yet (a Command Terminal). `failed` means
 * it is not tried again until the order changes: it stays where it was, or, for a Command
 * Terminal whose start failed after its end, its conversation waits in Earlier.
 */
export type RestartOutcome = 'moved' | 'deferred' | 'failed';

/**
 * Who asked for a move: Switch to, or Automatic order following its new top account. A switch to
 * Manual cancels only the second: Switch to itself sets the order to Manual.
 */
export type MoveOrigin = 'switch' | 'follow';

export interface SessionAccountMoverDependencies {
  /** Every running session of `agent`: task sessions, Command Terminals and workflow agents. */
  listRunning(agent: string): RunningSession[];
  /** A running session by id, or null once it is gone. */
  findRunning(sessionId: string): RunningSession | null;
  /** The agent's accounts, to tell two rows of one login apart from two logins. */
  accountsOf(agent: string): AgentAccount[];
  /** The usage-limit continuation is deciding the session or holds it waiting: it moves it. */
  isHandledElsewhere(sessionId: string): boolean;
  /**
   * Where the session stands (`SafePoint`): no tool in flight, no permission prompt or question
   * open, no background shell or subagent alive, no draft in its input box, and, mid-turn, every
   * result of the last tool call written to its transcript.
   */
  safePoint(sessionId: string): Promise<SafePoint>;
  /** A fresh read of the session's input box, taken right before the restart. */
  hasDraft(sessionId: string): Promise<boolean>;
  /**
   * Restarts the session in place on `accountId`, resuming its conversation. `point` is the safe
   * point it was found at: `between-tools` is told to continue, `idle` resumes with nothing sent.
   * `deferred` when, under its lock, it was no longer at that point.
   */
  restartOn(session: RunningSession, accountId: string, point: Exclude<SafePoint, null>): Promise<RestartOutcome>;
  /** A restart or a look threw. */
  reportFailure(error: unknown): void;
}

/** How a request ended for the sessions it named: moved now, waiting for a safe point, or failed. */
export interface MoveRequestOutcome {
  moved: number;
  pending: number;
  failed: number;
}

/**
 * When a session is looked at again after a tool call ends with nothing left open: Claude writes a
 * call's result to its transcript 130 ms to 2.4 s after the call's PostToolUse (task #1200), and
 * nothing announces it. The next tool start, a turn end or an idle cancels what is left.
 */
export const RECHECK_AFTER_TOOL_END_MS: readonly number[] = [150, 300, 600, 1200, 2500];

/** A session waiting to move: where to, for which agent, and who asked. */
interface PendingMove {
  target: string;
  agent: string;
  origin: MoveOrigin;
}

/**
 * Moves running sessions to another account, each at its first safe point (task #1200): Automatic
 * order's new top account, or the account Switch to named. An idle session moves as soon as it is
 * asked, with nothing sent to it. A working one moves between two tool calls, once every result
 * is written, or at its turn end, and is told to continue. A session with a draft in its input box
 * waits until the draft is sent or cleared, since a restart throws it away. Moves run one at a
 * time. A newer request for a session replaces the target it was waiting for, even one that lands
 * while its restart runs, and a session found on its target (or another row of the same login) is
 * no longer waiting.
 */
export class SessionAccountMover {
  /** Sessions waiting to move. */
  private readonly pending = new Map<string, PendingMove>();
  /** Sessions with a look queued behind the one running, so a burst of events queues one. */
  private readonly queued = new Set<string>();
  /** The re-checks after a tool end, per session. */
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>[]>();
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly dependencies: SessionAccountMoverDependencies) {}

  /**
   * Every running session of `agent` that is not on `targetAccountId` waits to move there, and
   * those at a safe point move now. Resolves once each has been looked at once.
   */
  request(agent: string, targetAccountId: string, origin: MoveOrigin = 'switch'): Promise<MoveRequestOutcome> {
    const named: string[] = [];
    const accounts = this.dependencies.accountsOf(agent);
    for (const session of this.dependencies.listRunning(agent)) {
      if (session.accountId === null) continue;
      if (this.isOnAccount(session, targetAccountId, accounts)) {
        // The order came back to the account it runs on: it no longer moves.
        this.forget(session.sessionId);
        continue;
      }
      this.pending.set(session.sessionId, { target: targetAccountId, agent, origin });
      named.push(session.sessionId);
    }
    return this.serial(async () => {
      const outcome: MoveRequestOutcome = { moved: 0, pending: 0, failed: 0 };
      for (const sessionId of named) {
        const result = await this.attempt(sessionId);
        if (result === 'moved') outcome.moved += 1;
        else if (result === 'failed') outcome.failed += 1;
        else if (result === 'pending') {
          outcome.pending += 1;
          // Asked between a tool's end and its result reaching the transcript: no later tool end
          // may come before the turn ends, so look again on the same schedule.
          this.scheduleRechecks(sessionId);
        }
      }
      return outcome;
    });
  }

  /**
   * Automatic order no longer leads the agent (Manual, or the agent stopped following it): the
   * moves it asked for and that still wait are dropped. Moves Switch to asked for stand.
   */
  cancelFollowing(agent: string): void {
    for (const [sessionId, move] of [...this.pending]) {
      if (move.agent === agent && move.origin === 'follow') this.forget(sessionId);
    }
  }

  /** Something about the session changed (an event, an idle, a turn end): look again if it waits. */
  check(sessionId: string): void {
    if (this.disposed || !this.pending.has(sessionId) || this.queued.has(sessionId)) return;
    this.queued.add(sessionId);
    void this.serial(async () => {
      this.queued.delete(sessionId);
      await this.attempt(sessionId);
    }).catch((error: unknown) => {
      // report-ok: handed to `reportFailure`, which the accounts handler binds to its chokepoint reporter.
      this.dependencies.reportFailure(error);
    });
  }

  /** A tool call ended: its result reaches the transcript a little later, so look a few times. */
  noteToolEnded(sessionId: string): void {
    this.scheduleRechecks(sessionId);
  }

  private scheduleRechecks(sessionId: string): void {
    if (this.disposed || !this.pending.has(sessionId)) return;
    this.clearRechecks(sessionId);
    const timers = RECHECK_AFTER_TOOL_END_MS.map((delayMs) => {
      const timer = setTimeout(() => this.check(sessionId), delayMs);
      timer.unref?.();
      return timer;
    });
    this.rechecks.set(sessionId, timers);
  }

  /** A tool call started, a prompt arrived, or the turn ended: the re-checks after the last tool end are spent. */
  dropRechecks(sessionId: string): void {
    this.clearRechecks(sessionId);
  }

  /** Whether the session is waiting to move. */
  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** The session ended or was replaced: nothing waits on it. */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.clearRechecks(sessionId);
  }

  /** Drops every waiting move and its timers (app quit). */
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    for (const sessionId of [...this.rechecks.keys()]) this.clearRechecks(sessionId);
  }

  private clearRechecks(sessionId: string): void {
    for (const timer of this.rechecks.get(sessionId) ?? []) clearTimeout(timer);
    this.rechecks.delete(sessionId);
  }

  /** Runs `work` after every look already queued, one at a time. */
  private serial<Result>(work: () => Promise<Result>): Promise<Result> {
    const next = this.chain.then(work);
    // report-ok: the caller awaits `next` and gets its rejection; this copy only keeps the queue going.
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The session already runs on the account, or on another row naming its login. */
  private isOnAccount(session: RunningSession, accountId: string, accounts?: AgentAccount[]): boolean {
    if (session.accountId === accountId) return true;
    const agentAccounts = accounts ?? this.dependencies.accountsOf(session.agent);
    const current = agentAccounts.find((account) => account.id === session.accountId);
    const target = agentAccounts.find((account) => account.id === accountId);
    return current !== undefined && target !== undefined && sameLogin(loginOf(current), loginOf(target));
  }

  /** One look at a waiting session. */
  private async attempt(sessionId: string): Promise<'moved' | 'pending' | 'failed' | 'dropped'> {
    const move = this.pending.get(sessionId);
    if (move === undefined || this.disposed) return 'dropped';
    const target = move.target;
    const session = this.dependencies.findRunning(sessionId);
    if (!session) {
      this.forget(sessionId);
      return 'dropped';
    }
    if (this.isOnAccount(session, target)) {
      this.forget(sessionId);
      return 'dropped';
    }
    if (this.dependencies.isHandledElsewhere(sessionId)) return 'pending';
    // A cheap first look: most sessions waiting mid-tool stop here, before the draft read.
    if ((await this.dependencies.safePoint(sessionId)) === null) return 'pending';
    if (await this.dependencies.hasDraft(sessionId)) return 'pending';
    // Read again after the awaits: the session may have ended, a newer request may have retargeted
    // it, or a tool may have started (the second look reuses a transcript answer it already has).
    const current = this.pending.get(sessionId);
    if (current === undefined || this.disposed) return 'dropped';
    if (current.target !== target) return 'pending';
    const point = await this.dependencies.safePoint(sessionId);
    if (point === null) return 'pending';
    let outcome: RestartOutcome;
    try {
      outcome = await this.dependencies.restartOn(session, target, point);
    } catch (error) {
      // report-ok: handed to `reportFailure`, which the accounts handler binds to its chokepoint reporter.
      this.dependencies.reportFailure(error);
      outcome = 'failed';
    }
    if (outcome === 'deferred') return 'pending';
    const after = this.pending.get(sessionId);
    if (after !== undefined && after.target !== target && outcome === 'moved') {
      // A newer request named another account while the restart ran. It named this session, which
      // is gone now; its replacement runs on `target` and was never named, so ask again for it.
      this.forget(sessionId);
      void this.request(after.agent, after.target, after.origin).catch((error: unknown) => {
        // report-ok: handed to `reportFailure`, which the accounts handler binds to its chokepoint reporter.
        this.dependencies.reportFailure(error);
      });
      return outcome;
    }
    // Moved or failed, the session it named is done with: a failed one stays where it is until the
    // order changes again, rather than restarting over and over. A failed one a newer request
    // retargeted keeps waiting for that target.
    if (after?.target === target) this.forget(sessionId);
    return outcome;
  }
}
