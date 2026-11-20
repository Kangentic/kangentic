import { EventType } from '../../shared/types';
import type { SessionEvent } from '../../shared/types';
import type { ActivityEngine } from './engine';

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
 * `cancelIdlePrompt` and `dispose`.
 *
 * Multiple Ctrl+C presses within the window collapse to one - the
 * existing settle timer is cleared and re-armed each time, since the
 * user clearly still wants to interrupt. A repeated idle prompt keeps the
 * first deadline, since the footer repaints. A Ctrl+C keeps its reason over a
 * later idle prompt.
 */
export class UserInterruptCoordinator {
  private readonly engine: ActivityEngine;
  private readonly pushEvent: (sessionId: string, event: SessionEvent) => void;
  private readonly settleMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Why each armed window was armed, carried on the synthetic event's `detail`. */
  private readonly reasons = new Map<string, UserInterruptReason>();
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
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      const firedReason = this.reasons.get(sessionId) ?? reason;
      this.reasons.delete(sessionId);
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
   * the interrupt.
   */
  cancelIdlePrompt(sessionId: string): void {
    if (this.reasons.get(sessionId) !== 'idle-prompt') return;
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.reasons.delete(sessionId);
  }

  /** Idempotent. Clears all pending timers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.reasons.clear();
  }

  private fireIfStillHot(sessionId: string, reason: UserInterruptReason): void {
    const state = this.engine.getState(sessionId);
    if (!state) return;
    if (state.activity !== 'thinking') return;
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
    if (!stillHot) return;
    // A Ctrl+C ends a subagent's call too, because the user asked. An idle
    // prompt is only inferred, and a live subagent holds its parent's tool
    // open while it runs, so the prompt never ends a turn a subagent holds.
    if (reason === 'idle-prompt' && state.subagentDepth > 0) return;
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
}
