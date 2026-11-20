import type { SessionManager } from '../pty/session-manager';
import type {
  CommandDelivery,
  CommandVerifier,
  InjectionCommand,
  InjectionOutcome,
  SubmitKeystrokesResult,
  TerminalSubmit,
} from '../pty/terminal-submit';
import type { AutoCommandMode } from '../../shared/types';
import { waitForTurnCompletion, type TurnCompletionResult } from './turn-completion';

/**
 * Re-export so callers in injection-plan and slash-command-verifier can keep
 * importing these from the engine layer without reaching into
 * `pty/terminal-submit.ts` directly.
 */
export type {
  CommandVerifier,
  InjectionCommand,
  InjectionOutcome,
  InjectionVerifyMode,
} from '../pty/terminal-submit';

/**
 * How an auto_command's arrival is timed.
 *
 * Re-exported from `shared/types`, never redeclared. A second identical string
 * union assigns freely across every boundary a lane's `auto_command_mode`
 * crosses to reach `ScheduleKeystrokesOptions.mode`, so the two copies can only
 * be kept in step by hand - and when they do diverge, the error surfaces as a
 * baffling "AutoCommandMode is not assignable to AutoCommandMode".
 */
export type { AutoCommandMode };

/**
 * What actually happened to one scheduled injection. Every scheduled burst
 * ends in exactly one of these, delivered to `onOutcome`. The old scheduler
 * returned `void` and logged, so a caller could not observe failure at all.
 */
export interface InjectionReport {
  taskId: string;
  sessionId: string;
  commands: string[];
  outcome: InjectionOutcome | 'cancelled';
  /** Commands that were verifiable but never confirmed. */
  unconfirmedCommands: string[];
  /** Text cleared off the prompt to make room, if any. */
  discardedDraft: string | null;
  /** True when delivery interrupted a live turn. */
  interruptedTurn: boolean;
  /** True when delivery only succeeded by restarting the session. */
  escalated: boolean;
  /** Human-readable reason, set when the outcome is a failure. */
  reason?: string;
  /**
   * False when the delivery ended before writing anything to the agent: the
   * session was gone, never became ready, or exited first, or the command was
   * cancelled while it waited. Absent when typing began, or when the reporter
   * cannot tell. A held message reads it to go back to its hold rather than be
   * marked failed, since nothing of it reached the agent.
   */
  textReachedAgent?: false;
  /**
   * An Enter of this burst landed on a permission prompt the app had not
   * heard of yet (`SubmitKeystrokesResult.reachedPermissionPrompt`), so it may
   * have answered it. Its own outcome, never retried and never escalated.
   */
  reachedPermissionPrompt?: true;
}

/**
 * Restart the session and deliver `commands` as the CLI's prompt argument.
 *
 * Supplied by the caller rather than implemented here: the scheduler must not
 * know about spawn machinery, and routing this through the caller keeps every
 * spawn on its existing chokepoint (see `spawn-entry-point-parity.md`).
 * Resolves true when the restart was issued.
 */
export type EscalationHandler = (commands: string[]) => Promise<boolean>;

/** Options for `scheduleKeystrokes`. */
export interface ScheduleKeystrokesOptions {
  /**
   * True when the session was just spawned (or is `queued` waiting to spawn).
   * A fresh spawn waits for the CLI's first `'thinking'` or `'idle'`. A
   * queued resume waits for `'idle'` after it starts: its first `'thinking'`
   * is the PTY painting the boot screen, and keys typed then are lost.
   */
  freshlySpawned?: boolean;
  /** Per-command verifier; forwarded to TerminalSubmit.submitKeystrokes. */
  verifier?: CommandVerifier | null;
  /**
   * `immediate` (default) interrupts whatever the agent is doing.
   * `deferred` holds until the current turn genuinely completes.
   */
  mode?: AutoCommandMode;
  /**
   * Hard timeout for the wait after the session is running. When the CLI
   * never becomes ready (hung at startup), we cancel this task's pending
   * injection rather than wait forever. Default 120s. A card still queued
   * for a column slot does not consume this budget.
   */
  timeoutMs?: number;
  /**
   * Rung 3 of the delivery ladder. Invoked when keystroke delivery exhausts
   * its retries on a VERIFIABLE command, so the failure is real rather than
   * merely unobservable. Omit to disable escalation for this burst.
   */
  escalate?: EscalationHandler;
  /** Receives the terminal outcome. */
  onOutcome?: (report: InjectionReport) => void;
}

/**
 * Cadence of the verifier re-check while the escalation gate waits for the
 * turn to complete. Each poll is a `stat` against the shared transcript tail
 * cache unless the file grew, and the wait is bounded by the gate's own
 * timeout, so this stays cheap over a long turn. It only needs to be shorter
 * than the time a turn takes to write a full tail window past the entry.
 */
const LATE_CONFIRM_POLL_MS = 1_000;

/**
 * Resolve once `check` returns true. Never resolves on abort: the caller
 * races this against the turn-completion wait, which resolves `aborted` on the
 * same signal, so a rejection or a false here would only add a second way to
 * report the same abort. A stopped poll holds no timer.
 */
function pollUntilConfirmed(check: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    signal.addEventListener('abort', () => {
      if (timer) clearTimeout(timer);
    }, { once: true });
    const tick = async (): Promise<void> => {
      if (signal.aborted) return;
      let confirmed = false;
      try {
        confirmed = await check();
      } catch (caughtError) {
        console.error('[TerminalSubmitScheduler] late confirmation check threw:', caughtError);
      }
      if (signal.aborted) return;
      if (confirmed) {
        resolve();
        return;
      }
      timer = setTimeout(() => { void tick(); }, LATE_CONFIRM_POLL_MS);
    };
    void tick();
  });
}

/** A burst waiting its turn behind the one in flight. */
interface QueuedBurst {
  sessionId: string;
  commands: InjectionCommand[];
  opts: ScheduleKeystrokesOptions;
}

/** State for a task whose burst is in flight. */
interface ActiveBurst {
  controller: AbortController;
  /**
   * FIFO of follow-ups, NOT a single overwritable slot.
   *
   * The previous implementation kept one `next` and overwrote it, so dragging
   * a task through two auto_command columns in quick succession silently
   * dropped the middle command with no record anywhere. Each entry also
   * carries its OWN sessionId: the old stash dropped it and the drain
   * recursed with the original closure's id, which would misdeliver a burst
   * to a dead session the moment a respawn stopped taking the fresh-spawn
   * branch.
   */
  queue: QueuedBurst[];
}

/** State for a task waiting on a fresh-spawn or turn-completion signal. */
interface PendingDeferred {
  cleanup: () => void;
  /**
   * The burst this wait is holding.
   *
   * Kept so a supersede can REPORT the burst it drops. The record is also its
   * own identity token: every async continuation compares
   * `this.deferred.get(taskId) === entry` rather than calling `has(taskId)`,
   * because a presence check cannot tell its own wait from a newer one that
   * has since taken the slot.
   */
  burst: QueuedBurst;
}

/**
 * Why a burst held for a starting agent (`scheduleAfterLaunch`) was not sent
 * when the agent never came up. Shared with the paste paths, which wait the
 * same way (`agent-message-delivery.ts`).
 */
export const AGENT_NOT_STARTED_REASON = 'The agent had not started, so the message was not sent.';

/** Bursts held for a session whose agent is still starting (`scheduleAfterLaunch`). */
interface LaunchWait {
  /** The session the wait is on. A burst for another session never joins it. */
  sessionId: string;
  controller: AbortController;
  /** In arrival order; each runs through the existing-session decision once the agent is up. */
  bursts: QueuedBurst[];
}

/**
 * `TerminalSubmitScheduler` is the lifecycle wrapper for keystroke delivery.
 * Where `TerminalSubmit.submitKeystrokes` answers "HOW the bytes go out",
 * this class answers "WHEN", and reports what happened.
 *
 *   1. **Existing session, immediate mode** - delivers now, interrupting the
 *      agent if it is mid-turn. If a burst is already in flight for this
 *      task, the new request queues behind it; nothing is dropped.
 *
 *   2. **Existing session, deferred mode** - holds until the current turn
 *      genuinely completes (see `turn-completion.ts`), then delivers.
 *
 *   3. **Freshly spawned / queued session** - waits until the CLI can take
 *      keys. A fresh spawn delivers on the first `'thinking'` or `'idle'`.
 *      A queued session waits for `'idle'` after it starts: for a resume,
 *      its first `'thinking'` is the PTY painting the boot screen, and keys
 *      typed then are lost. 30s fallback delivers anyway if neither fires.
 *      The hard timeout (`opts.timeoutMs`, default 120s) caps the wait after
 *      the session is running, not the time spent queued for a column slot.
 *      A queued session paused or ended before it runs fails the burst.
 *
 *   4. **Existing session whose agent is still starting** - a session the
 *      caller did not flag as fresh, but whose agent is not on screen yet
 *      (`SessionManager.isAgentLaunching`). Held until it is, then decided as
 *      case 1 or 2. Later bursts for the task queue behind it. Measured: an
 *      exit row's message typed 1.4 s before the CLI started could never be
 *      confirmed, and failed its row.
 *
 * On a verifiable command exhausting its retries, delivery escalates to
 * `opts.escalate` (restart + deliver as the CLI prompt argument), which is
 * guaranteed by the spawn rather than by TUI timing. Escalation happens at
 * most once per injection and only once the turn-completion predicate is
 * satisfied, so it can never kill live work - and while that predicate is
 * awaited the verifier is re-polled against the burst's original watermark,
 * so a command that merely confirmed late is never run a second time.
 */
export class TerminalSubmitScheduler {
  private deferred = new Map<string, PendingDeferred>();
  private active = new Map<string, ActiveBurst>();
  private launchWaits = new Map<string, LaunchWait>();

  constructor(
    private sessionManager: SessionManager,
    private terminalSubmit: TerminalSubmit,
  ) {}

  /**
   * Schedule a keystroke sequence for a task's PTY session. Chained bursts
   * (e.g. `/effort Y` then the auto_command) pass them all in `commands[]` so
   * the whole burst is delivered as one unit.
   */
  scheduleKeystrokes(
    taskId: string,
    sessionId: string,
    commands: ReadonlyArray<InjectionCommand>,
    opts: ScheduleKeystrokesOptions = {},
  ): void {
    if (commands.length === 0) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[TerminalSubmitScheduler] No session ${sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)} -- skipping`);
      this.report(opts, {
        taskId,
        sessionId,
        commands: commands.map((command) => command.text),
        outcome: 'failed',
        unconfirmedCommands: commands.map((command) => command.text),
        discardedDraft: null,
        interruptedTurn: false,
        escalated: false,
        reason: 'The session was no longer running.',
        textReachedAgent: false,
      });
      return;
    }

    const freshlySpawned = opts.freshlySpawned ?? false;
    const isQueued = session.status === 'queued';
    const burst: QueuedBurst = { sessionId, commands: [...commands], opts };

    // Existing session. The caller's flag is not the only judge of readiness:
    // a session it did not just spawn may still be starting (an exit row's
    // message seconds after the column's spawn), and keys typed now would
    // reach the shell before the agent reads its input. Ask the session.
    if (!freshlySpawned && !isQueued) {
      const launchWait = this.launchWaits.get(taskId);
      if (launchWait?.sessionId === sessionId) {
        launchWait.bursts.push(burst);
        return;
      }
      // The task's session changed under a held burst: those keys were for a
      // session the task no longer uses, and this one is judged on its own.
      if (launchWait) this.dropLaunchWait(taskId, 'A newer command for this task replaced it before it was sent.');
      if (this.sessionManager.isAgentLaunching(sessionId)) {
        this.scheduleAfterLaunch(taskId, burst);
        return;
      }
      this.scheduleReady(taskId, burst);
      return;
    }

    // Fresh spawn or queued - wait for CLI to come alive, then start the burst.
    this.cancel(taskId, 'A newer command for this task replaced it before it was sent.');
    this.scheduleDeferred(taskId, burst, isQueued);
  }

  /**
   * The existing-session decision for a session whose agent is up: queue
   * behind a burst in flight, hold a deferred burst for the turn, or start now.
   */
  private scheduleReady(taskId: string, burst: QueuedBurst): void {
    const existing = this.active.get(taskId);
    if (existing) {
      existing.queue.push(burst);
      console.log(
        `[TerminalSubmitScheduler] Queued burst ${existing.queue.length} for task ${taskId.slice(0, 8)} (burst in flight)`,
      );
      return;
    }
    if ((burst.opts.mode ?? 'immediate') === 'deferred') {
      // A deferred wait can be long (a turn, up to the 120s cap), so a second
      // deferred burst for the same task routinely arrives while the first is
      // still waiting. Retire the older one explicitly - and report it - so
      // the two never race for the single `deferred` slot.
      this.supersedeDeferred(taskId);
      this.scheduleAfterTurn(taskId, burst);
      return;
    }
    this.startBurst(taskId, burst);
  }

  /**
   * Hold bursts for a session whose agent is still starting
   * (`SessionManager.isAgentLaunching`), then run each through the
   * existing-session decision in the order it arrived.
   *
   * Not `scheduleDeferred`, for two reasons. That path opens by cancelling the
   * task's other bursts, which is right for a new spawn and wrong here. And
   * its "alive" edge for a spawn that carries a prompt is the end of the
   * agent's whole first turn, which an immediate exit message would sit out
   * past the exit budget. Here the wait ends the moment the agent can read
   * keys, and the row's own mode then decides as on any live session.
   */
  private scheduleAfterLaunch(taskId: string, burst: QueuedBurst): void {
    const controller = new AbortController();
    const entry: LaunchWait = { sessionId: burst.sessionId, controller, bursts: [burst] };
    this.launchWaits.set(taskId, entry);
    const timeoutMs = burst.opts.timeoutMs ?? 120_000;
    console.log(
      `[TerminalSubmitScheduler] Session ${burst.sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)} is still starting, holding the burst`,
    );

    void this.sessionManager.awaitAgentLaunched(burst.sessionId, timeoutMs, controller.signal).then((launched) => {
      // Identity, as everywhere in this class: `cancel` may have dropped this
      // wait and a newer one taken the slot before this callback ran.
      if (this.launchWaits.get(taskId) !== entry) return;
      this.launchWaits.delete(taskId);
      const held = entry.bursts.splice(0);
      if (!launched) {
        const session = this.sessionManager.getSession(burst.sessionId);
        const reason = session?.status === 'running'
          ? AGENT_NOT_STARTED_REASON
          : 'The session exited before the command could be sent.';
        console.warn(`[TerminalSubmitScheduler] Task ${taskId.slice(0, 8)}: ${reason}`);
        for (const heldBurst of held) this.reportNotSent(taskId, heldBurst, 'failed', reason);
        return;
      }
      for (const heldBurst of held) this.scheduleReady(taskId, heldBurst);
    });
  }

  /**
   * Cancel any pending or in-flight injection for a specific task. Aborts the
   * AbortController plumbed through to TerminalSubmit so an in-flight burst
   * stops at the next write/wait boundary, and drops every queued follow-up.
   *
   * Each burst it drops before it ran is reported `cancelled`, as
   * `supersedeDeferred` reports one: no scheduled burst ends without an
   * outcome. An in-flight burst reports its own, from `runBurst`.
   */
  cancel(taskId: string, reason = 'The task moved on before the command was sent.'): void {
    this.dropLaunchWait(taskId, reason);
    const pending = this.dropDeferred(taskId);
    if (pending) this.reportCancelled(taskId, pending.burst, reason);
    const burst = this.active.get(taskId);
    if (burst) {
      const dropped = burst.queue.splice(0);
      burst.controller.abort();
      for (const queuedBurst of dropped) this.reportCancelled(taskId, queuedBurst, reason);
    }
  }

  /** Stop a launch wait and report each burst it held as cancelled. */
  private dropLaunchWait(taskId: string, reason: string): void {
    const launchWait = this.launchWaits.get(taskId);
    if (!launchWait) return;
    this.launchWaits.delete(taskId);
    launchWait.controller.abort();
    for (const heldBurst of launchWait.bursts.splice(0)) this.reportCancelled(taskId, heldBurst, reason);
  }

  /** Stop a waiting burst without reporting it, for a caller that reports its own outcome. */
  private dropDeferred(taskId: string): PendingDeferred | undefined {
    const pending = this.deferred.get(taskId);
    if (!pending) return undefined;
    this.deferred.delete(taskId);
    pending.cleanup();
    return pending;
  }

  private reportCancelled(taskId: string, burst: QueuedBurst, reason: string): void {
    this.reportNotSent(taskId, burst, 'cancelled', reason);
  }

  /** Report a burst that ended before any of it was typed. */
  private reportNotSent(taskId: string, burst: QueuedBurst, outcome: 'cancelled' | 'failed', reason: string): void {
    const commandTexts = burst.commands.map((command) => command.text);
    this.report(burst.opts, {
      taskId,
      sessionId: burst.sessionId,
      commands: commandTexts,
      outcome,
      unconfirmedCommands: commandTexts,
      discardedDraft: null,
      interruptedTurn: false,
      escalated: false,
      reason,
      textReachedAgent: false,
    });
  }

  /**
   * Whether a burst for this task is waiting or in flight. A message pasted
   * outside the scheduler (`pasteAgentMessageInBackground`) checks it after
   * the agent's turn ends, so it lands after keystrokes scheduled ahead of it
   * rather than in the middle of them.
   */
  hasPending(taskId: string): boolean {
    return this.deferred.has(taskId) || this.active.has(taskId) || this.launchWaits.has(taskId);
  }

  /** Cancel all pending injections. Called on `killAll`. */
  cancelAll(): void {
    for (const launchWait of this.launchWaits.values()) {
      launchWait.bursts.length = 0;
      launchWait.controller.abort();
    }
    this.launchWaits.clear();
    const pending = [...this.deferred.values()];
    this.deferred.clear();
    for (const entry of pending) entry.cleanup();
    for (const burst of this.active.values()) {
      burst.queue.length = 0;
      burst.controller.abort();
    }
  }

  private startBurst(taskId: string, burst: QueuedBurst): void {
    const entry: ActiveBurst = { controller: new AbortController(), queue: [] };
    this.active.set(taskId, entry);
    void this.runBurst(taskId, burst, entry);
  }

  private async runBurst(taskId: string, burst: QueuedBurst, entry: ActiveBurst): Promise<void> {
    const commandTexts = burst.commands.map((command) => command.text);
    let report: InjectionReport = {
      taskId,
      sessionId: burst.sessionId,
      commands: commandTexts,
      outcome: 'failed',
      unconfirmedCommands: commandTexts,
      discardedDraft: null,
      interruptedTurn: false,
      escalated: false,
    };

    try {
      // Read from the host's ledger, not main's mirror: a key the user typed
      // just before this burst reached the host on the renderer's port.
      const pendingDraft = await this.sessionManager.readPendingDraft(burst.sessionId);
      const activity = this.sessionManager.getActivityCache()[burst.sessionId];
      const result: SubmitKeystrokesResult = await this.terminalSubmit.submitKeystrokes(
        burst.sessionId,
        burst.commands,
        {
          freshlySpawned: burst.opts.freshlySpawned,
          pendingDraft,
          // activity-state-ok: granular - only a genuinely thinking agent is
          // being interrupted, which is what we report to the user.
          interruptingTurn: activity === 'thinking',
          verifier: burst.opts.verifier,
          signal: entry.controller.signal,
          source: `task:${taskId.slice(0, 8)}`,
        },
      );

      report = {
        ...report,
        outcome: result.outcome === 'aborted' ? 'cancelled' : result.outcome,
        unconfirmedCommands: result.unconfirmedCommands,
        discardedDraft: result.discardedDraft,
        interruptedTurn: result.interruptedTurn,
      };

      if (result.heldBy) {
        // The session could not take keys (a permission prompt, a tool call
        // with no end), so the burst stopped before the key that needed it. A
        // restart would kill the very work it waited on: no escalation.
        const typedNothing = result.deliveries.length === 0;
        report = {
          ...report,
          reason: `Not sent: ${result.heldBy}.`,
          ...(typedNothing ? { textReachedAgent: false as const } : {}),
        };
      } else if (result.reachedPermissionPrompt) {
        report = {
          ...report,
          outcome: 'failed',
          reason: 'An Enter reached a permission prompt, so it may have answered it.',
          reachedPermissionPrompt: true,
        };
      } else if (result.outcome === 'failed') {
        report = await this.escalate(taskId, burst, entry, report, result.deliveries);
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (message.includes('abort')) {
        report = { ...report, outcome: 'cancelled' };
      } else {
        console.error(`[TerminalSubmitScheduler] Burst failed for task ${taskId.slice(0, 8)}: ${message}`);
        report = { ...report, outcome: 'failed', reason: message };
      }
    }

    this.report(burst.opts, report);

    // The burst slot is still ours - drain the FIFO before releasing it.
    const current = this.active.get(taskId);
    if (current === entry && entry.queue.length > 0) {
      const nextBurst = entry.queue.shift();
      if (nextBurst) {
        // Fresh AbortController so the new burst is independently cancellable,
        // and the NEXT burst's own sessionId, never this one's.
        const next: ActiveBurst = { controller: new AbortController(), queue: entry.queue };
        this.active.set(taskId, next);
        void this.runBurst(taskId, nextBurst, next);
        return;
      }
    }
    if (current === entry) this.active.delete(taskId);
  }

  /**
   * Deferred mode on a live session: hold the burst until the agent's current
   * turn genuinely completes, then deliver.
   *
   * Uses the shared turn-completion predicate, so this waits out an API retry
   * backoff or a `Monitor` wait rather than firing into the middle of one -
   * both of which the activity engine reports as idle for minutes at a time.
   *
   * A timeout does NOT drop the command. Immediate mode is the fallback:
   * arriving late and interrupting is strictly better than never arriving,
   * and the interruption is reported to the user either way.
   */
  private scheduleAfterTurn(taskId: string, burst: QueuedBurst): void {
    const controller = new AbortController();
    const entry: PendingDeferred = { cleanup: (): void => controller.abort(), burst };
    this.deferred.set(taskId, entry);

    void waitForTurnCompletion(this.sessionManager, burst.sessionId, {
      signal: controller.signal,
      timeoutMs: burst.opts.timeoutMs,
    }).then((result) => {
      // Identity, NOT presence. `cancel()` aborts this wait synchronously, but
      // this callback only runs a microtask later - by which time a newer burst
      // may already hold the slot. A bare `has(taskId)` would then delete the
      // NEWER entry and strand it (its own continuation finds nothing and
      // returns silently), while delivering this stale burst in its place.
      // Same guard shape as `runBurst`'s `current === entry`.
      if (this.deferred.get(taskId) !== entry) return;
      this.deferred.delete(taskId);

      if (result === 'aborted') return;
      if (result === 'exited') {
        this.report(burst.opts, {
          taskId,
          sessionId: burst.sessionId,
          commands: burst.commands.map((command) => command.text),
          outcome: 'failed',
          unconfirmedCommands: burst.commands.map((command) => command.text),
          discardedDraft: null,
          interruptedTurn: false,
          escalated: false,
          reason: 'The session exited before its turn finished, so the command was not sent.',
          textReachedAgent: false,
        });
        return;
      }
      if (result === 'timeout') {
        console.warn(
          `[TerminalSubmitScheduler] Deferred wait timed out for task ${taskId.slice(0, 8)}, delivering immediately`,
        );
      }
      this.startBurst(taskId, burst);
    });
  }

  /**
   * Retire a deferred wait that a newer burst has replaced.
   *
   * The drop is reported as `cancelled` rather than being silent. A superseded
   * burst is still a command the board asked for and never sent, and the whole
   * point of the rebuild is that no delivery outcome is unobservable. It stays
   * quiet for the USER (`shouldNotify` treats `cancelled` as noise, since the
   * usual cause is their own second move) while landing in the durable record.
   */
  private supersedeDeferred(taskId: string): void {
    const pending = this.deferred.get(taskId);
    if (!pending) return;
    this.deferred.delete(taskId);
    pending.cleanup();
    const commandTexts = pending.burst.commands.map((command) => command.text);
    this.report(pending.burst.opts, {
      taskId,
      sessionId: pending.burst.sessionId,
      commands: commandTexts,
      outcome: 'cancelled',
      unconfirmedCommands: commandTexts,
      discardedDraft: null,
      interruptedTurn: false,
      escalated: false,
      reason: 'A newer command for this task replaced it before it was sent.',
      textReachedAgent: false,
    });
  }

  /**
   * Rung 3: keystrokes could not be confirmed, so restart the session and
   * deliver the commands as the CLI's prompt argument instead - a path whose
   * delivery is guaranteed by the spawn rather than by TUI timing.
   *
   * Gated on the SAME turn-completion predicate deferred mode uses, not a
   * bare idle check: restarting during a 529 retry backoff or a Monitor wait
   * would destroy live work, and both of those read as idle.
   *
   * The gate is also the last chance to notice the command already landed.
   * A restart re-runs it, and that shipped: every observed live injection of
   * a skill command was reported `failed` by the burst and then run a second
   * time by the restart (#682). So while the gate waits, the verifier is
   * re-polled against each command's ORIGINAL first-Enter watermark (its
   * delivery record's `firstSentAt`), and a confirmation anywhere in that wait, or on one last
   * check when the turn completes, cancels the restart. The poll runs DURING
   * the wait rather than only after it because the verifier reads a bounded
   * tail: a turn that writes more than the tail between the entry landing and
   * the turn ending would push the evidence out of reach of a single check at
   * the end. Turn completion on its own is never taken as evidence - the turn
   * that completes may be the one that was already running when the command
   * was typed, which says nothing about whether the command went in.
   *
   * Attempted at most once. If the restart itself does not deliver, the
   * outcome stays `failed` and the user is told.
   */
  private async escalate(
    taskId: string,
    burst: QueuedBurst,
    entry: ActiveBurst,
    report: InjectionReport,
    deliveries: ReadonlyArray<CommandDelivery>,
  ): Promise<InjectionReport> {
    const escalateHandler = burst.opts.escalate;
    if (!escalateHandler) {
      return { ...report, reason: 'The command could not be confirmed in the agent transcript.' };
    }

    // Only the USER's auto_command is worth a restart. An adapter-emitted
    // settings write must never ride along: joined into an argv prompt it stops
    // being a slash invocation and becomes literal text the agent reads as part
    // of the message. A settings change also has its own restart path, and
    // `--resume` preserves what was already applied, so a failed `/effort`
    // alone is not a reason to respawn a session.
    //
    // `escalatable !== false` is the CONFIRM-ONLY gate. An adapter that has not
    // proven its verifier end to end still gets one, because retry-on-Enter is
    // pure upside, but a false negative there would be a guess - and acting on
    // a guess here restarts a session and destroys live work. Those adapters
    // confirm and retry; they never authorize the restart.
    //
    // `unconfirmedCommands` holds one entry per unconfirmed DELIVERY, so each
    // entry is consumed by at most one command. A membership test would let
    // two identical commands both match a single unconfirmed entry when only
    // one of them failed: the confirmed twin would be re-sent by the restart,
    // and the count mismatch against the positional late checks below would
    // disable late confirmation for the whole burst.
    const unconsumedUnconfirmed = [...report.unconfirmedCommands];
    const escalatable = burst.commands
      .filter((command) => {
        if (command.verify !== 'submitted' || command.escalatable === false) return false;
        const unconfirmedIndex = unconsumedUnconfirmed.indexOf(command.text);
        if (unconfirmedIndex === -1) return false;
        unconsumedUnconfirmed.splice(unconfirmedIndex, 1);
        return true;
      })
      .map((command) => command.text);
    if (escalatable.length === 0) {
      return { ...report, reason: 'The command could not be confirmed in the agent transcript.' };
    }

    // Late confirmation needs the verifier and a first-Enter watermark for
    // EVERY escalatable command: a command with no watermark cannot be checked
    // and would still need the restart, so a partial check proves nothing.
    // Records are positional, so two identical commands each keep their own.
    const verifier = burst.opts.verifier ?? null;
    const lateChecks: Array<{ text: string; firstSentAt: number }> = [];
    for (const delivery of deliveries) {
      if (delivery.confirmed || !escalatable.includes(delivery.text)) continue;
      if (delivery.firstSentAt !== null) lateChecks.push({ text: delivery.text, firstSentAt: delivery.firstSentAt });
    }
    const canLateConfirm = verifier !== null && lateChecks.length === escalatable.length;
    // A throw from the verifier is a miss, never a verdict: the poll below
    // logs one and keeps going, and the final check at turn completion must
    // read it the same way, or the one path that authorizes the restart would
    // abandon it and a genuinely swallowed command would never be re-sent.
    const lateConfirm = async (): Promise<boolean> => {
      if (!canLateConfirm || verifier === null) return false;
      try {
        for (const check of lateChecks) {
          if (!(await verifier(check.text, check.firstSentAt, 'submitted'))) return false;
        }
        return true;
      } catch (caughtError) {
        console.error('[TerminalSubmitScheduler] late confirmation check threw:', caughtError);
        return false;
      }
    };

    // One gate signal for both waits: the burst's own abort ends them, and
    // whichever wait settles first aborts the other.
    const gate = new AbortController();
    const abortGate = (): void => gate.abort();
    if (entry.controller.signal.aborted) abortGate();
    else entry.controller.signal.addEventListener('abort', abortGate, { once: true });

    type GateOutcome =
      | { kind: 'completion'; completion: TurnCompletionResult }
      | { kind: 'late-confirm' };
    const waits: Promise<GateOutcome>[] = [
      waitForTurnCompletion(this.sessionManager, burst.sessionId, { signal: gate.signal })
        .then((completion): GateOutcome => ({ kind: 'completion', completion })),
    ];
    if (canLateConfirm) {
      waits.push(pollUntilConfirmed(lateConfirm, gate.signal).then((): GateOutcome => ({ kind: 'late-confirm' })));
    }
    const gateOutcome = await Promise.race(waits);
    abortGate();
    entry.controller.signal.removeEventListener('abort', abortGate);

    if (gateOutcome.kind === 'late-confirm') {
      return this.confirmedLate(taskId, report, lateChecks);
    }
    const completion = gateOutcome.completion;
    if (completion !== 'completed') {
      return {
        ...report,
        reason: `The command could not be confirmed, and the session was not safe to restart (${completion}).`,
      };
    }
    // The turn is over and the PTY is quiet: whatever the CLI was going to
    // write about the command is on disk now. One last look before a restart
    // that would run it again.
    if (await lateConfirm()) {
      return this.confirmedLate(taskId, report, lateChecks);
    }

    try {
      const restarted = await escalateHandler(escalatable);
      if (restarted) {
        console.log(
          `[TerminalSubmitScheduler] Escalated task ${taskId.slice(0, 8)}: restarted with the command as the prompt`,
        );
        // NOT `confirmed`. The handler resolving true means the restart was
        // ISSUED, not that a verifier saw the command land. Argv delivery is
        // guaranteed by the spawn, which is why this is not a failure either -
        // but claiming confirmation nothing checked would be the same silent
        // success this whole rebuild exists to remove.
        return { ...report, escalated: true, unconfirmedCommands: [] };
      }
      return { ...report, reason: 'The command could not be confirmed, and the session restart did not run.' };
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      return { ...report, reason: `The command could not be confirmed, and the retry failed: ${message}` };
    }
  }

  /**
   * The burst reported a command unconfirmed, but the transcript has since
   * proven it went in. No restart: the report becomes `confirmed` when nothing
   * else is outstanding, else it stays `failed` for the commands that are.
   */
  private confirmedLate(
    taskId: string,
    report: InjectionReport,
    confirmed: ReadonlyArray<{ text: string; firstSentAt: number }>,
  ): InjectionReport {
    const now = Date.now();
    for (const check of confirmed) {
      console.log(
        `[TerminalSubmitScheduler] Confirmed task ${taskId.slice(0, 8)} late: "${check.text}" landed `
          + `${now - check.firstSentAt}ms after the first Enter; no restart`,
      );
    }
    const confirmedTexts = confirmed.map((check) => check.text);
    const unconfirmedCommands = report.unconfirmedCommands.filter((text) => !confirmedTexts.includes(text));
    if (unconfirmedCommands.length === 0) {
      return { ...report, outcome: 'confirmed', unconfirmedCommands: [], escalated: false };
    }
    return { ...report, unconfirmedCommands, reason: 'The command could not be confirmed in the agent transcript.' };
  }

  /**
   * Wait for the right moment, then start the burst.
   *
   * Fresh spawn: wait for the CLI's first `'thinking'` or `'idle'` (it is
   * alive), with a 30s fallback for adapters that report neither and a hard
   * timeout for a genuinely hung startup.
   *
   * Queued: the same after the session starts. Do not type on the first
   * `'thinking'`: for a resume that types its prompt, that edge is the PTY
   * painting the boot screen. Wait for `'idle'` (the prompt). The hard
   * timeout starts only once the session is running, so a card waiting on
   * "one agent at a time" can sit in line longer than 120s without losing
   * the column's message.
   */
  private scheduleDeferred(taskId: string, burst: QueuedBurst, isQueued: boolean): void {
    const { sessionId, opts } = burst;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    // Identity, not presence. `entry` is created at the foot of this function,
    // before any listener or timer below can fire. A bare
    // `this.deferred.has(taskId)` is equally satisfied by a NEWER wait that has
    // since taken the slot, which would let this stale burst deliver in its
    // place and strand the new one. See `PendingDeferred.burst`.
    const isCurrent = (): boolean => this.deferred.get(taskId) === entry;

    const startHardTimer = (): void => {
      if (hardTimer) return;
      hardTimer = setTimeout(() => {
        console.warn(`[TerminalSubmitScheduler] Hard timeout (${timeoutMs}ms) for task ${taskId.slice(0, 8)} -- cancelling`);
        // This burst reports its own failure below; `cancel` stops the rest.
        if (isCurrent()) this.dropDeferred(taskId);
        this.cancel(taskId);
        this.report(opts, {
          taskId,
          sessionId,
          commands: burst.commands.map((command) => command.text),
          outcome: 'failed',
          unconfirmedCommands: burst.commands.map((command) => command.text),
          discardedDraft: null,
          interruptedTurn: false,
          escalated: false,
          reason: 'The agent never became ready, so the command was not sent.',
          textReachedAgent: false,
        });
      }, timeoutMs);
    };

    const startFallbackTimer = (): void => {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        if (!isCurrent()) return;
        console.log(`[TerminalSubmitScheduler] 30s fallback for task ${taskId.slice(0, 8)} -- delivering anyway`);
        detachAndDeliver();
      }, 30_000);
    };

    const beginWaitingForCli = (): void => {
      startFallbackTimer();
      startHardTimer();
    };

    const detachAndDeliver = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (hardTimer) clearTimeout(hardTimer);
      this.deferred.delete(taskId);
      this.startBurst(taskId, burst);
    };

    // Alive is a thinking edge, or the first idle. A fresh spawn that carries a
    // prompt is seeded thinking when it boots (`initSession`), before this
    // listener exists, so its only edge here is the idle its first turn ends
    // on; waiting for a thinking edge alone left a column's message on the 30s
    // fallback. A permission prompt is not alive enough: typed keys would
    // answer it. A queued resume's first thinking is the boot paint, so that
    // path waits for idle.
    const onActivity = (evtSessionId: string, activityState: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!isCurrent()) return;
      if (state !== 'waiting') return;
      if (activityState === 'idle') {
        detachAndDeliver();
        return;
      }
      if (!isQueued && activityState === 'thinking') detachAndDeliver();
    };

    // This burst reports its own failure; `cancel` stops the rest.
    const failBeforeDelivery = (reason: string): void => {
      this.dropDeferred(taskId);
      this.cancel(taskId);
      this.report(opts, {
        taskId,
        sessionId,
        commands: burst.commands.map((command) => command.text),
        outcome: 'failed',
        unconfirmedCommands: burst.commands.map((command) => command.text),
        discardedDraft: null,
        interruptedTurn: false,
        escalated: false,
        reason,
        textReachedAgent: false,
      });
    };

    const onSessionChanged = (evtSessionId: string, evtSession: { status: string }): void => {
      if (evtSessionId !== sessionId) return;
      if (!isCurrent()) return;
      if (state !== 'queued') return;
      if (evtSession.status === 'running') {
        state = 'waiting';
        beginWaitingForCli();
        return;
      }
      // A queued row that is paused never ran a PTY, so no 'exit' follows,
      // and the hard timer has not started: without this the burst would
      // wait, unreported, for a session that is gone.
      if (evtSession.status === 'suspended' || evtSession.status === 'exited') {
        console.log(`[TerminalSubmitScheduler] Queued session ${sessionId.slice(0, 8)} ${evtSession.status} before it ran -- cancelling injection for task ${taskId.slice(0, 8)}`);
        failBeforeDelivery('The session stopped before it started, so the command was not sent.');
      }
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!isCurrent()) return;
      console.log(`[TerminalSubmitScheduler] Session ${sessionId.slice(0, 8)} exited -- cancelling injection for task ${taskId.slice(0, 8)}`);
      failBeforeDelivery('The session exited before the command could be sent.');
    };

    this.sessionManager.on('activity', onActivity);
    this.sessionManager.on('session-changed', onSessionChanged);
    this.sessionManager.on('exit', onExit);

    if (!isQueued) beginWaitingForCli();

    const entry: PendingDeferred = {
      cleanup: (): void => {
        this.sessionManager.off('activity', onActivity);
        this.sessionManager.off('session-changed', onSessionChanged);
        this.sessionManager.off('exit', onExit);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (hardTimer) clearTimeout(hardTimer);
      },
      burst,
    };
    this.deferred.set(taskId, entry);
  }

  private report(opts: ScheduleKeystrokesOptions, report: InjectionReport): void {
    if (!opts.onOutcome) return;
    try {
      opts.onOutcome(report);
    } catch (caughtError) {
      console.error('[TerminalSubmitScheduler] onOutcome handler threw:', caughtError);
    }
  }
}
