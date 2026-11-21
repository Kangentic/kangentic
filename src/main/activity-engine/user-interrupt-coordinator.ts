import { EventType } from '../../shared/types';
import type { SessionEvent } from '../../shared/types';
import type { ActivityEngine, SessionEngineState } from './engine';

/**
 * Default settle window after a user Ctrl+C before the engine
 * forcibly commits to idle. Gives the agent's hooks
 * (PostToolUseFailure / Stop) a chance to fire and clear state
 * naturally. If they do, the synthetic Interrupted is a no-op
 * (engine state is already cool); if they don't, we recover within
 * this window instead of waiting for the 5-min stuck-pending-tools
 * watchdog.
 */
const DEFAULT_USER_INTERRUPT_SETTLE_MS = 3_000;

export interface UserInterruptCoordinatorOptions {
  engine: ActivityEngine;
  /**
   * Called with the synthetic Interrupted event so the activity log
   * shows why the engine transitioned. The coordinator does NOT call
   * `engine.processEvent` itself - it delegates that AND the audit-log
   * push to this callback's owner via the same pipe used for real
   * events. (We can't have the coordinator push directly to the
   * engine without bypassing telemetry's own logging.)
   */
  pushEvent: (sessionId: string, event: SessionEvent) => void;
  /** Override for tests. Default 3000ms. */
  settleMs?: number;
}

/**
 * Why a settle window was armed, sent as the synthetic Interrupted event's
 * `detail`. `user-ctrl-c` is a Ctrl+C in the terminal; `idle-prompt` is an
 * idle prompt drawn while the hooks still hold a turn open
 * (`AdapterRuntimeStrategy.idlePromptEndsOpenTurn`).
 */
export type UserInterruptReason = 'user-ctrl-c' | 'idle-prompt';

/**
 * Owns the per-session settle timers for interrupts the hooks never report:
 * a Ctrl+C in the terminal, or an idle prompt that says a turn ended.
 * Self-contained: takes the engine + a pushEvent pipe, exposes `notify`,
 * `cancelIdlePrompt`, `notePromptSubmitted` and `dispose`.
 *
 * Multiple Ctrl+C presses within the window collapse to one - the
 * existing settle timer is cleared and re-armed each time, since the
 * user clearly still wants to interrupt. A repeated idle prompt keeps the
 * first deadline, since the footer repaints. A Ctrl+C keeps its reason over a
 * later idle prompt. A prompt submitted after the Ctrl+C ends its window: the
 * interrupted turn is over and a new one is running (task #1149).
 */
export class UserInterruptCoordinator {
  private readonly engine: ActivityEngine;
  private readonly pushEvent: (sessionId: string, event: SessionEvent) => void;
  private readonly settleMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Why each armed window was armed, carried on the synthetic event's `detail`. */
  private readonly reasons = new Map<string, UserInterruptReason>();
  /** When each session's latest Ctrl+C armed its window, in epoch ms. */
  private readonly ctrlCArmedAt = new Map<string, number>();
  private disposed = false;

  constructor(options: UserInterruptCoordinatorOptions) {
    this.engine = options.engine;
    this.pushEvent = options.pushEvent;
    this.settleMs = options.settleMs ?? DEFAULT_USER_INTERRUPT_SETTLE_MS;
  }

  /**
   * Called when the user presses Ctrl+C in `sessionId`'s terminal, or
   * (`reason` `idle-prompt`) when an agent whose idle prompt paints only
   * between turns drew it while its hooks still hold a turn open
   * (`AdapterRuntimeStrategy.idlePromptEndsOpenTurn`). Schedules a settle
   * window before checking if the engine is still stuck and synthesizing an
   * Interrupted event if so. A Ctrl+C keeps its reason over a later prompt,
   * and an idle prompt never moves a deadline already armed: a footer that
   * repaints would otherwise hold the window off.
   */
  notify(sessionId: string, reason: UserInterruptReason = 'user-ctrl-c'): void {
    if (this.disposed) return;
    const existing = this.timers.get(sessionId);
    if (existing && reason === 'idle-prompt') return;
    if (existing) clearTimeout(existing);
    if (this.reasons.get(sessionId) !== 'user-ctrl-c') this.reasons.set(sessionId, reason);
    if (reason === 'user-ctrl-c') this.ctrlCArmedAt.set(sessionId, Date.now());
    const timer = setTimeout(() => {
      const firedReason = this.reasons.get(sessionId) ?? reason;
      this.clearWindow(sessionId);
      this.fireIfStillHot(sessionId, firedReason);
    }, this.settleMs);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  /**
   * The agent showed it is still working: one of its hooks wrote a line, or
   * its terminal printed new text after the prompt. A window an idle prompt
   * armed is dropped, since the turn the prompt seemed to end is running (a
   * footer painted just before the next turn's first hook, or the footer's
   * text inside a tool's output). A Ctrl+C window stays: the user asked for
   * the interrupt. Only a new prompt ends one (`notePromptSubmitted`).
   */
  cancelIdlePrompt(sessionId: string): void {
    if (this.reasons.get(sessionId) !== 'idle-prompt') return;
    this.clearWindow(sessionId);
  }

  /**
   * The agent's own hook reported a prompt stamped `promptTs`. Called before
   * the engine sees it. A prompt submitted after a Ctrl+C proves the turn the
   * Ctrl+C stopped is over and a new one is running, so its window ends. Fired,
   * the window would idle the live turn, and the turn end that follows would
   * read its transcript from past the prompt the user just sent (task #1149).
   * When the window would have fired, what the stopped turn left in flight
   * (pending tools, subagent slots) is discarded now, with no idle. When it
   * would not have (the hooks already settled the turn, or only a live subagent
   * holds it), nothing is discarded.
   *
   * Returns true when it discarded that work, so the caller can close the same
   * calls in its open-work ledger, as the synthetic `Interrupted` would have.
   *
   * The stopped turn's own prompt can arrive after the Ctrl+C, since its hook
   * line takes a moment to reach main. Its stamp is older than the Ctrl+C, so
   * it keeps the window. A Ctrl+C pressed faster than the hook's bridge starts
   * reads as a resubmit, and the turn waits for the agent's own hooks. A hook
   * stamped by another clock (a WSL distro after the host slept, a remote host)
   * can misorder either way. Each case falls back to the window or to no
   * window, as before this check.
   */
  notePromptSubmitted(sessionId: string, promptTs: number): boolean {
    if (this.reasons.get(sessionId) !== 'user-ctrl-c') return false;
    const armedAt = this.ctrlCArmedAt.get(sessionId);
    if (armedAt === undefined || promptTs <= armedAt) return false;
    this.clearWindow(sessionId);
    const state = this.engine.getState(sessionId);
    if (!state || !this.isStillHot(state, 'user-ctrl-c')) return false;
    this.engine.discardInterruptedTurnWork(sessionId);
    return true;
  }

  /** Idempotent. Clears all pending timers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.reasons.clear();
    this.ctrlCArmedAt.clear();
  }

  private clearWindow(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.reasons.delete(sessionId);
    this.ctrlCArmedAt.delete(sessionId);
  }

  private fireIfStillHot(sessionId: string, reason: UserInterruptReason): void {
    const state = this.engine.getState(sessionId);
    if (!state) return;
    if (!this.isStillHot(state, reason)) return;
    // Synthesize an Interrupted event so the engine's normal
    // bypass path runs. This clears all counters and emits idle
    // immediately (no stability window).
    const syntheticEvent: SessionEvent = {
      ts: Date.now(),
      type: EventType.Interrupted,
      detail: reason,
    };
    this.pushEvent(sessionId, syntheticEvent);
    this.engine.processEvent(sessionId, syntheticEvent);
  }

  /** Would a window of `reason` end this turn now? */
  private isStillHot(state: SessionEngineState, reason: UserInterruptReason): boolean {
    if (state.activity !== 'thinking') return false;
    // Hooks may have already recovered: pendingTools=0 and a non-stuck
    // turnActive means the engine is settling on its own.
    //
    // `turnActive` counts as "stuck" only when nothing self-recovering is
    // holding the turn. A live subagent (subagentDepth > 0) now KEEPS the
    // parent's turnActive set - its inner Stop no longer clears the parent turn
    // (see ActivityEngine.processEvent's turn-ending gate) - but it WILL
    // self-recover via its own SubagentStop, so synthesizing an Interrupted
    // here would force the engine to idle while the subagent is still running:
    // a false idle. Suppress that case and let the subagent's hooks settle it.
    const stillHot =
      state.pendingToolCount > 0 || (state.turnActive && state.subagentDepth === 0);
    if (!stillHot) return false;
    // A Ctrl+C ends a subagent's call too, because the user asked. An idle
    // prompt is only inferred, and a live subagent holds its parent's tool
    // open while it runs, so the prompt never ends a turn a subagent holds.
    return !(reason === 'idle-prompt' && state.subagentDepth > 0);
  }
}
