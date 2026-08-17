import type { SessionEngineState, TransitionTrigger } from './shapes';

/**
 * Declarative timer-anchor strategy for a watchdog hold: which timestamp the
 * hold's deadline is measured from. Co-located with the hold (rather than
 * inferred from `trigger` inside the engine) so a new hold must choose an
 * anchor explicitly, and a new anchor kind becomes a compile error in
 * `watchdogBaseTime` instead of a silent `lastSignalAt` fall-through.
 *
 * - `bg-shell-hold-since`: `state.bgShellHoldSince`. Signal-only keep-alives
 *   (`markThinkingSignal`) cannot move it; only a watcher-confirmed
 *   `markBackgroundShellsAlive` advances it, so a phantom is still reclaimed
 *   at its threshold. Also drives `scheduleTimer`'s stamp/clear maintenance.
 * - `signal-or-pty-output`: the FRESHER of `lastSignalAt` and
 *   `lastPtyOutputAt` - streaming TUI output keeps a genuinely-running turn
 *   alive even when hooks and the status heartbeat are silent, whether the
 *   turn is held by a foreground tool (stuck-pending-tools), a subagent
 *   (stuck-subagent), or tool-less generation (stale-thinking).
 * - `signal`: `lastSignalAt` only. Used as the `parkedAnchor` of stale-thinking
 *   (active while the agent is BELIEVED parked - `idleHintPending`,
 *   `turnForcedByHeartbeat` for a hook-less resume turn that can never fire an
 *   idle_hint (task #364), or `retryFailurePending` for a live `turn_retrying`
 *   hold (task #367)) and of stuck-subagent (narrowed by its own `parkedWhen`
 *   to `retryFailurePending` alone - task #532): once the agent is believed
 *   parked, parked-TUI statusline repaints stream PTY bytes that must NOT
 *   defer the net, so it ignores `lastPtyOutputAt`.
 */
export type WatchdogAnchor =
  | 'bg-shell-hold-since'
  | 'signal-or-pty-output'
  | 'signal';

/**
 * A "watchdog hold" describes a state shape where the engine could be
 * stuck in `thinking` because of one specific holder (bg shells, stuck
 * pending tools, or a hanging turnActive flag) and what to do if that
 * hold persists past its threshold.
 *
 * The holds are mutually exclusive in practice (each branch's predicate
 * partitions the state space), but the rules are no longer "exactly one
 * signal source non-zero" - the pending-tools hold allows turnActive to
 * be either value because Ctrl+C-induced hook drops leave both
 * `pendingToolCount > 0` AND `turnActive === true`. See each predicate
 * for the exact shape it matches.
 *
 * The bg-shell sole-holder case is split into TWO holds by evidence
 * quality (both labeled `timer:bg-shell-hatch`): a NAMED-present hold
 * (a `background_shell_start` hook positively declared the shell, so
 * absence of watcher confirmation extends the deadline to the long
 * 5-min cap) and an ANONYMOUS-only hold (heuristic resume-time
 * adoptions, reclaimed fast at the 30s grace). See the table below.
 */
export interface WatchdogHold {
  /** Returns true when the state matches this hold's "stuck" shape. */
  predicate(state: SessionEngineState): boolean;
  /** ms of silence before the hold counts as stuck. */
  thresholdMs: number;
  /**
   * Optional shortened threshold used INSTEAD of `thresholdMs` while
   * `state.idleHintPending` is set (the agent reported "waiting for your input"
   * but a counter is still stuck > 0 - the aborted/errored-turn signature). Only
   * the `stuck-subagent` and `stuck-pending-tools` holds set this. This field
   * shortens only the THRESHOLD; the anchor is chosen independently by
   * `parkedAnchor` / `parkedWhen`, so live work that keeps streaming PTY output
   * still defers the (now shorter) deadline - EXCEPT on `stuck-subagent` during
   * a live retry hold, where `parkedWhen` narrows the anchor to `signal` (task
   * #532). Undefined holds always use `thresholdMs`.
   */
  idleHintThresholdMs?: number;
  /**
   * Optional shortened threshold used INSTEAD of `thresholdMs` while
   * `state.turnForcedByHeartbeat` is set (a hook-less `--resume` resume-picker
   * turn the status heartbeat force-thought, never confirmed by a real
   * turn-initiating hook - task #331/#364). Checked before `idleHintThresholdMs`
   * in `effectiveThreshold`; only the stale-thinking hold sets it, since it is
   * the only hold whose predicate a heartbeat-forced turn (no pending tools, no
   * subagents, no bg shells) can match. Undefined holds always fall through to
   * `idleHintThresholdMs` / `thresholdMs`.
   */
  heartbeatForcedThresholdMs?: number;
  /** Audit-log label written to the transition record. */
  trigger: TransitionTrigger;
  /**
   * Which timestamp this hold's deadline is measured from. Read by
   * `watchdogBaseTime` (arming + firing) and, for `bg-shell-hold-since`,
   * by `scheduleTimer`'s `bgShellHoldSince` stamp/clear maintenance.
   */
  anchor: WatchdogAnchor;
  /**
   * Optional anchor used INSTEAD of `anchor` while the agent is BELIEVED
   * parked - `state.idleHintPending`, `state.turnForcedByHeartbeat` (parallel
   * to `idleHintThresholdMs` for the threshold, but broader: a hook-less resume
   * turn is genuinely parked yet can never fire an `idle_hint`, task #364), OR
   * `state.retryFailurePending` (a live `turn_retrying` hold whose parked-TUI
   * "retrying in Ns..." repaints must not defer the net, task #367).
   * stale-thinking and stuck-subagent both set it (`'signal'`), the latter
   * narrowed to `retryFailurePending` alone by its own `parkedWhen` below
   * (task #532): once the agent is believed parked, parked-TUI statusline
   * repaints (PTY bytes) must stop deferring the net, so the hold ignores
   * `lastPtyOutputAt` and anchors to `lastSignalAt` alone. A
   * live long-generation turn never fires `idle_hint` and is never
   * heartbeat-forced (it is thinking via a real turn hook), so its anchor stays
   * `signal-or-pty-output` and the PTY anchor still defers it (#246). Undefined
   * holds always use `anchor`.
   */
  parkedAnchor?: WatchdogAnchor;
  /**
   * Optional predicate replacing the DEFAULT believed-parked test for this
   * hold's `parkedAnchor`. Undefined holds use the default
   * (`idleHintPending || turnForcedByHeartbeat || retryFailurePending`) - see
   * `watchdogBaseTime`.
   *
   * Only `stuck-subagent` sets it, narrowing to `retryFailurePending` alone.
   * That hold must NOT narrow on `idleHintPending`: an idle_hint can fire
   * mid-subagent (task #237), and #237's guarantee is precisely that a live
   * subagent's streaming output keeps deferring the hold. Dropping
   * `lastPtyOutputAt` there would reintroduce the parallel-subagent false idle.
   * A live `turn_retrying` hold is the opposite case - the agent is believed
   * parked in backoff, and its "retrying in Ns..." repaints must not defer the
   * net forever if the error turns out to be terminal (task #532).
   */
  parkedWhen?(state: SessionEngineState): boolean;
  /** Mutates state to clear the stuck holder. Called once threshold fires. */
  reset(state: SessionEngineState): void;
  /**
   * If true, the synthesized idle goes through the stability window
   * (400ms) rather than committing immediately. Used by the
   * bg-shells/pending-tools hatches because they synthesize idle from
   * a long absence of signal - a stability window catches the rare
   * case where a delayed hook arrives within 400ms of the hatch.
   * Stale-thinking opts out: the hold predicate already requires
   * 180 sec of silence, so flicker risk is nil.
   */
  applyStabilityWindow: boolean;
}

export interface WatchdogConfig {
  /**
   * ms threshold for the stuck-pending-tools hatch (measured off
   * `max(lastSignalAt, lastPtyOutputAt)`) AND the long cap for the
   * named-bg-shell sole-holder hold. A hook-declared (named) shell is
   * positive evidence of real work, so it is reclaimed only at this long
   * cap when the watcher cannot confirm liveness, never at the short grace.
   */
  bgShellEscapeHatchMs: number;
  /**
   * ms grace for the ANONYMOUS-only bg-shell hatch. Anonymous shells are
   * heuristic resume-time adoptions (no `background_shell_start` hook), so
   * fast reclaim stays correct. Measured off `bgShellHoldSince` (when bg
   * shells became the sole holder) in the engine, NOT off `lastSignalAt` -
   * so signal-only keep-alive pulses cannot push it out. Only watcher-
   * confirmed liveness (`markBackgroundShellsAlive`, emitted on an in-sync
   * cycle) refreshes the anchor; a phantom shows a deficit and is reclaimed
   * at the grace. See `activity-engine.ts` scheduleTimer/onTick.
   */
  bgShellOnlyGraceMs: number;
  /** ms threshold for the stale-thinking hatch. */
  staleThinkingTimeoutMs: number;
  /**
   * Shortened threshold for the `stuck-subagent` and `stuck-pending-tools` holds
   * while `state.idleHintPending` is set. The agent signaled it is back at the
   * prompt, so a still-stuck counter is reclaimed on this short grace instead of
   * the 5-min `bgShellEscapeHatchMs` cap. The `signal-or-pty-output` anchor is
   * unchanged, so a genuinely-live subagent's streaming output still defers it.
   */
  staleAfterIdleHintMs: number;
  /**
   * ms threshold for the stale-thinking hold while `state.turnForcedByHeartbeat`
   * is set (a hook-less resume-picker turn, task #331/#364). The anchor is
   * unchanged (already narrowed to `signal` via `parkedAnchor` whenever
   * heartbeat-forced), so this only shortens HOW LONG the net waits once
   * `lastSignalAt` freezes.
   */
  staleAfterHeartbeatForcedMs: number;
}

/**
 * Build the canonical watchdog table (named-bg / anon-bg /
 * stuck-pending-tools / stale-thinking).
 */
export function buildWatchdogHolds(config: WatchdogConfig): readonly WatchdogHold[] {
  return [
    {
      // Held by a NAMED bg shell (alone). A `background_shell_start` hook
      // positively declared this shell, so absence of watcher confirmation
      // must EXTEND, not shorten, the hold: it is reclaimed only at the long
      // 5-min cap. Positive exit evidence (a `BackgroundShellEnd` event or a
      // Tier A PID-death from the watcher) reclaims it sooner via the normal
      // event path; a genuinely-running shell is held active by
      // `markBackgroundShellsAlive` refreshing the anchor each cycle the
      // watcher (Tier A) confirms its PID alive. Measured off
      // `bgShellHoldSince` so signal-only keep-alives cannot move it.
      // `anonymousBackgroundShellCount` may be > 0 here: any named shell
      // upgrades the whole hold to the long cap, and the reset clears both.
      predicate: (state) =>
        !state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && state.activeBackgroundShellIds.size > 0
        && !state.permissionPending,
      thresholdMs: config.bgShellEscapeHatchMs,
      trigger: 'timer:bg-shell-hatch',
      anchor: 'bg-shell-hold-since',
      reset: (state) => {
        state.activeBackgroundShellIds.clear();
        state.anonymousBackgroundShellCount = 0;
      },
      applyStabilityWindow: true,
    },
    {
      // Held by ANONYMOUS bg shells alone (no named shell present). These
      // are count-based heuristic adoptions (e.g. resume-time descendants
      // with no `background_shell_start` hook), so reclaiming fast at the
      // 30s grace is correct. Same anchor and reset as the named hold; the
      // only difference is the shorter threshold. Note the named->anon
      // transition (a named shell drains while anon remains): the anchor is
      // NOT reset (the trigger is unchanged), so the grace is measured from
      // when bg shells first became the sole holder and can fire promptly -
      // correct, since the anon shells have been unconfirmed that long.
      predicate: (state) =>
        !state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && state.activeBackgroundShellIds.size === 0
        && state.anonymousBackgroundShellCount > 0
        && !state.permissionPending,
      thresholdMs: config.bgShellOnlyGraceMs,
      trigger: 'timer:bg-shell-hatch',
      anchor: 'bg-shell-hold-since',
      reset: (state) => {
        state.activeBackgroundShellIds.clear();
        state.anonymousBackgroundShellCount = 0;
      },
      applyStabilityWindow: true,
    },
    {
      // Held by pending foreground tools (turnActive may be true or
      // false - both indicate stuck state). Fires after
      // `bgShellEscapeHatchMs` (5 min) of silence. Common cause: user
      // pressed Ctrl+C, Claude killed the bash, but PostToolUseFailure
      // didn't propagate. Without this hatch the engine is stuck in
      // 'thinking' forever - the stale-thinking watchdog requires
      // pendingToolCount=0 to fire, the bg-shell hatch requires
      // bg shells, and the Idle clamp only works if Idle actually
      // fires. Real long-running foreground tools rarely run 5 min in
      // total silence - they emit nested ToolStart/End from sub-tools
      // and subagents that refresh lastSignalAt.
      predicate: (state) =>
        state.pendingToolCount > 0
        && state.subagentDepth === 0
        && (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) === 0
        && !state.permissionPending,
      thresholdMs: config.bgShellEscapeHatchMs,
      // When the agent reported it is waiting for input but a tool is still
      // pending, its PostToolUse was lost in an aborted/errored turn - reclaim
      // on the short grace rather than the 5-min cap. Streaming PTY output from
      // a genuinely-running tool still defers it (anchor unchanged).
      idleHintThresholdMs: config.staleAfterIdleHintMs,
      trigger: 'timer:stuck-pending-tools',
      anchor: 'signal-or-pty-output',
      reset: (state) => {
        state.pendingToolCount = 0;
        state.pendingToolStack.length = 0;
        state.currentTool = null;
        // Also clear turnActive so the engine commits to idle - the
        // matching Idle/Stop hook for this turn was lost along with the
        // PostToolUse, so leaving turnActive set would leave the
        // session stuck even after the tools clear.
        state.turnActive = false;
        state.turnForcedByHeartbeat = false;
      },
      applyStabilityWindow: true,
    },
    {
      // Held by `turnActive` alone (a thinking event fired but the
      // matching Idle hook never arrived). Anchored to the FRESHER of
      // `lastSignalAt` and `lastPtyOutputAt`: a single heavy generation turn
      // can stream PTY output continuously for >180s with NO nested hook event
      // and a silent status heartbeat (Claude's `status.json` does not update
      // mid-generation), which would false-idle a demonstrably-live session
      // (task #246). `markPtyOutput` (called unconditionally on every PTY chunk)
      // keeps the anchor fresh, so streaming output defers this hold the same
      // way it defers stuck-pending-tools. A genuinely-finished turn sits at a
      // quiet prompt with no PTY data (the basis of the PtyActivityTracker's
      // silence detector), so the anchor freezes and the safety net still fires
      // at the threshold. A blinking cursor is xterm-rendered terminal state,
      // not PTY data, so it never calls `markPtyOutput` and cannot defer it.
      //
      // Exception: once the agent is BELIEVED parked (`idleHintPending`, OR
      // `turnForcedByHeartbeat` - a hook-less resume-picker turn that can never
      // fire an idle_hint, task #364), even genuine statusline-repaint PTY bytes
      // are noise, not liveness - a parked Claude TUI repaints its
      // rate-limit/context meter forever, which is exactly what kept this net
      // blinded past 180s (task #294, and via the heartbeat-only path, #364). So
      // while believed-parked the anchor narrows to `signal` (lastSignalAt
      // only), ignoring `lastPtyOutputAt`; with the heartbeat's
      // `markThinkingSignal` gated off under the same condition (and its
      // output-growth gate, task #331), lastSignalAt freezes at the last genuine
      // hook / output growth and the net self-heals. A live long-generation turn
      // never idle-hints and is never heartbeat-forced (it is thinking via a
      // real turn hook), so it keeps the PTY anchor (#246).
      predicate: (state) =>
        state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) === 0
        && !state.permissionPending,
      thresholdMs: config.staleThinkingTimeoutMs,
      // Task #331/#364 follow-up: a hook-less resume-picker turn is already
      // anchored to `signal` (parkedAnchor below) once turnForcedByHeartbeat is
      // set, so lastSignalAt is already frozen at the moment output stopped
      // growing. Reclaim on this shorter budget instead of the general 180s -
      // see DEFAULT_STALE_AFTER_HEARTBEAT_FORCED_MS for the safety argument.
      heartbeatForcedThresholdMs: config.staleAfterHeartbeatForcedMs,
      trigger: 'timer:stale-thinking',
      anchor: 'signal-or-pty-output',
      parkedAnchor: 'signal',
      reset: (state) => {
        state.turnActive = false;
        state.turnForcedByHeartbeat = false;
      },
      applyStabilityWindow: false,
    },
    {
      // Held by `subagentDepth` alone: a subagent's NAMED terminal
      // `subagent_stop` was lost AFTER its empty-detail inner stop was
      // (correctly) ignored, so depth is stuck > 0. Every OTHER hold above
      // requires `subagentDepth === 0`, and the PTY-tracker forceIdle that
      // would otherwise zero depth is suppressed for hook-active agents
      // (see session-telemetry.ts:maybeSuppressPtyTracker), so nothing else
      // can reclaim this - without this hold the board would be stuck
      // `thinking` forever. Disjoint from the holds above by the
      // `subagentDepth > 0` predicate. A genuinely live subagent refreshes
      // the `signal-or-pty-output` anchor via its nested tool events and
      // streaming output, so this only fires after a real, long silence; the
      // long 5-min cap (matching stuck-pending-tools) keeps it conservative.
      predicate: (state) =>
        state.subagentDepth > 0
        && state.pendingToolCount === 0
        && (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) === 0
        && !state.permissionPending,
      thresholdMs: config.bgShellEscapeHatchMs,
      // When the agent reported it is waiting for input but subagentDepth is
      // still > 0, the named terminal subagent_stop was lost in an
      // aborted/errored turn - reclaim on the short grace rather than the 5-min
      // cap. A genuinely-live subagent keeps streaming output and emits its
      // named stops within tens of seconds, both of which defer this (anchor
      // unchanged), so #237's parallel-subagent false-idle is not reintroduced.
      idleHintThresholdMs: config.staleAfterIdleHintMs,
      trigger: 'timer:stuck-subagent',
      anchor: 'signal-or-pty-output',
      // Task #532 made this hold reachable during a live `turn_retrying` for
      // the first time (the retry hold now preserves `subagentDepth` instead of
      // zeroing it, so this hold arbitrates where `stale-thinking` used to).
      // Without a narrowing of its own, a parked TUI repainting "retrying in
      // Ns..." streams real PTY bytes that would defer this net forever, which
      // is exactly what #367 closed for `stale-thinking`. `parkedWhen` scopes
      // the narrowing to the retry hold ONLY, so #237's idle_hint case keeps
      // the full `signal-or-pty-output` anchor. Safe because ANY non-LOG_ONLY
      // event refreshes `lastSignalAt` - the narrowed anchor itself - not just
      // the turn-initiating ones (`tool_start` / `subagent_start`, which
      // additionally clear `retryFailurePending` outright). `tool_end` and a
      // plain `idle` qualify too; only `idle_hint` and `subagent_stop` are
      // LOG_ONLY. So a wedged CLI emitting nothing but repaints is what is left
      // to the cap - 5 min, or the 180s `staleAfterIdleHintMs` budget once an
      // `idle_hint` has also fired (a combination task #532 made reachable
      // here for the first time).
      parkedAnchor: 'signal',
      parkedWhen: (state) => state.retryFailurePending,
      reset: (state) => {
        state.subagentDepth = 0;
        // The matching named SubagentStop was lost along with, most likely,
        // the parent's own Stop, so clear turnActive too - otherwise the
        // predicate would still read thinking after depth zeroes.
        state.turnActive = false;
        state.turnForcedByHeartbeat = false;
      },
      applyStabilityWindow: true,
    },
  ];
}

/**
 * Find the (first) hold whose predicate matches the given state, or
 * undefined when no hold is active. Used by `scheduleTimer` to pick
 * the right deadline AND by `onTick` to know which hold's reset to
 * invoke.
 */
export function findActiveWatchdogHold(
  state: SessionEngineState,
  holds: readonly WatchdogHold[],
): WatchdogHold | undefined {
  for (const hold of holds) {
    if (hold.predicate(state)) return hold;
  }
  return undefined;
}
