import { EventType, IdleReason } from '../../../shared/types';
import type { ActivityState, ActivityReason, SessionEvent } from '../../../shared/types';
import {
  DEFAULT_BG_SHELL_ESCAPE_HATCH_MS,
  DEFAULT_BG_SHELL_ONLY_GRACE_MS,
  DEFAULT_STALE_THINKING_TIMEOUT_MS,
  DEFAULT_IDLE_STABILITY_WINDOW_MS,
  RECENT_TRANSITIONS_RING_SIZE,
  PTY_CHUNK_BUCKET_MS,
  PTY_CHUNK_WINDOW_MS,
  LOG_ONLY_EVENTS,
  TURN_INITIATING_EVENTS,
  TURN_ENDING_EVENTS,
} from './shapes';
import type {
  ActivityEngineOptions,
  ActivityEngineCallbacks,
  ActivityStatsSnapshot,
  SessionEngineState,
  TransitionRecord,
  TransitionTrigger,
} from './shapes';
import { snapshotCounters, formatCounterDelta } from './counter-snapshot';
import { createSessionEngineState } from './state-factory';
import { derivePredicate, deriveReason, deriveActivityAndReason, idleHintEndsTurn } from './predicate';
import { updateCounters, updatePermissionFlag } from './event-handlers';
import { buildWatchdogHolds, findActiveWatchdogHold } from './watchdog';
import type { WatchdogHold } from './watchdog';

/**
 * Single-predicate activity engine.
 *
 * The state is `'thinking'` IFF:
 *   - permissionPending is false (permission is reported as `'permission'`)
 *   - AND any of:
 *     - turnActive (a thinking event fired and no idle event has fired since)
 *     - subagentDepth > 0
 *     - activeBackgroundShellIds.size + anonymousBackgroundShellCount > 0
 *
 * `Idle` events explicitly clear `turnActive` and re-evaluate the
 * predicate. If counters still hold, the session stays thinking. When
 * all counters clear, the predicate returns idle (subject to the
 * stability window).
 *
 * Background shells that exit naturally without firing a hook are
 * reclaimed by the bg-shell sole-holder grace (30s, `timer:bg-shell-hatch`,
 * anchored to `bgShellHoldSince`). The process-tree watcher (Subsystem B)
 * reports natural exits much faster via
 * `markBackgroundShellEnded(sessionId, shellId?)`, and conversely keeps a
 * genuinely-running bg shell active by refreshing the anchor via
 * `markBackgroundShellsAlive` on each cycle it still sees the shell alive.
 * The 5-min `bgShellEscapeHatchMs` now backs only the stuck-pending-tools
 * hatch.
 */
export class ActivityEngine {
  private readonly states = new Map<string, SessionEngineState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly callbacks: ActivityEngineCallbacks;
  private readonly idleStabilityWindowMs: number;
  private readonly bgShellOnlyGraceMs: number;
  private readonly now: () => number;
  private readonly watchdogConfig: readonly WatchdogHold[];
  private disposed = false;

  constructor(callbacks: ActivityEngineCallbacks, options: ActivityEngineOptions = {}) {
    this.callbacks = callbacks;
    this.idleStabilityWindowMs = options.idleStabilityWindowMs ?? DEFAULT_IDLE_STABILITY_WINDOW_MS;
    this.bgShellOnlyGraceMs = options.bgShellOnlyGraceMs ?? DEFAULT_BG_SHELL_ONLY_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.watchdogConfig = buildWatchdogHolds({
      bgShellEscapeHatchMs: options.bgShellEscapeHatchMs ?? DEFAULT_BG_SHELL_ESCAPE_HATCH_MS,
      bgShellOnlyGraceMs: this.bgShellOnlyGraceMs,
      staleThinkingTimeoutMs: options.staleThinkingTimeoutMs ?? DEFAULT_STALE_THINKING_TIMEOUT_MS,
    });
  }

  // ==== Lifecycle ====

  initSession(sessionId: string): void {
    if (this.disposed) return;
    this.clearTimer(sessionId);
    const state = createSessionEngineState();
    state.idleTimestamp = this.now();
    this.states.set(sessionId, state);
    this.callbacks.onActivityChange(sessionId, 'idle', deriveReason(state));
  }

  deleteSession(sessionId: string): void {
    this.clearTimer(sessionId);
    this.states.delete(sessionId);
  }

  /**
   * Tear down all per-session state and timers. Idempotent. Used by
   * `SessionTelemetry.dispose()` and tests.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.states.clear();
  }

  getOrCreateState(sessionId: string): SessionEngineState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = createSessionEngineState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  getState(sessionId: string): SessionEngineState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * Iterate all sessions for read-only scans (idle-timeout sweep).
   * State is exposed as `Readonly` so callers cannot bypass the engine
   * by mutating fields directly.
   */
  forEachState(
    callback: (sessionId: string, state: Readonly<SessionEngineState>) => void,
  ): void {
    for (const [sessionId, state] of this.states) {
      callback(sessionId, state);
    }
  }

  /** Snapshot of just the activity field for IPC callers. */
  getActivityCache(): Record<string, ActivityState> {
    const result: Record<string, ActivityState> = {};
    for (const [sessionId, state] of this.states) {
      result[sessionId] = state.activity;
    }
    return result;
  }

  /** Latest reason for a single session, or null if the session is unknown. */
  getActivityReason(sessionId: string): ActivityReason | null {
    const state = this.states.get(sessionId);
    if (!state) return null;
    return deriveReason(state);
  }

  /**
   * Rich state snapshot for the debug overlay (Subsystem E). Includes
   * raw counters, ring buffer of recent transitions, and pending-idle
   * armed flag. Returns null if the session is unknown.
   */
  getStatsSnapshot(sessionId: string): ActivityStatsSnapshot | null {
    const state = this.states.get(sessionId);
    if (!state) return null;
    const lastSignalAt = state.lastSignalAt;
    const lastPtyOutputAt = state.lastPtyOutputAt;
    return {
      sessionId,
      activity: state.activity,
      reason: deriveReason(state),
      pendingToolCount: state.pendingToolCount,
      subagentDepth: state.subagentDepth,
      backgroundShellIds: Array.from(state.activeBackgroundShellIds),
      anonymousBackgroundShellCount: state.anonymousBackgroundShellCount,
      turnActive: state.turnActive,
      permissionPending: state.permissionPending,
      msSinceLastSignal: lastSignalAt === null ? null : this.now() - lastSignalAt,
      lastSignalAt,
      lastPtyOutputAt,
      msSincePtyOutput: lastPtyOutputAt === null ? null : this.now() - lastPtyOutputAt,
      pendingIdleArmed: state.pendingIdleAt !== null,
      recentTransitions: state.recentTransitions.slice(),
      compensationCounters: { ...state.compensationCounters },
      recentPtyChunks: state.recentPtyChunks.slice(),
    };
  }

  // ==== Main event processing ====

  processEvent(sessionId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const state = this.getOrCreateState(sessionId);

    // Snapshot counters before any mutation so we can render an audit
    // log entry showing what changed during this step.
    const before = snapshotCounters(state);

    updateCounters(state, event);
    updatePermissionFlag(state, event);

    // Refresh the liveness anchor for every non-log-only event. ToolEnd is
    // deliberately NOT log-only (see LOG_ONLY_EVENTS): a PostToolUse hook is
    // proof the agent is alive, so a long foreground tool that ends while the
    // turn continues hands the stale-thinking hold a fresh anchor instead of
    // the frozen tool_start one.
    if (!LOG_ONLY_EVENTS.has(event.type)) {
      state.lastSignalAt = this.now();
    }

    if (TURN_INITIATING_EVENTS.has(event.type)) {
      state.turnActive = true;
      // A fresh thinking signal cancels any pending stability-window idle.
      state.pendingIdleAt = null;
    } else if (TURN_ENDING_EVENTS.has(event.type)) {
      // A subagent's inner-loop Stop arrives as `Idle` while the parent is
      // still blocked on the live subagent (subagentDepth > 0): it must NOT end
      // the PARENT's turn - the parent has not finished, it is about to consume
      // the subagent's result. (Verified against raw hook payloads: a
      // subagent-context Stop carries agent_id while the main agent's Stop does
      // not, so a Stop seen while a subagent is live is the subagent's, not the
      // parent's.) `Interrupted` is a hard abort, so this arm clears turnActive
      // regardless of depth: applyInterruptedBypass below resets the counters
      // and commits idle immediately but does NOT touch turnActive, so this is
      // the only path that clears it for an interrupt (without it, an interrupt
      // at subagentDepth > 0 would leave turnActive stuck true).
      if (event.type === EventType.Interrupted || state.subagentDepth === 0) {
        state.turnActive = false;
      }
    } else if (event.type === EventType.IdleHint && idleHintEndsTurn(state)) {
      // The agent signaled it is waiting for input and nothing else is
      // holding the turn (no pending tools, subagents, bg shells, or
      // permission). Clear turnActive so the predicate flips to idle through
      // the normal stability window - instead of waiting out the 180s
      // stale-thinking watchdog because the Stop/Idle hook was dropped.
      state.turnActive = false;
    }

    // A permission pause just resolved: its depth-0 wake signal cleared
    // permissionPending and the agent is resuming its turn. The resolving
    // event (e.g. an AskUserQuestion / ExitPlanMode tool_end) emits no fresh
    // prompt/tool_start hook, so restore turnActive here. Otherwise the
    // predicate sees no holder and drops to idle until the PTY force-thinking
    // net catches up seconds later. Genuine turn-enders (Idle/Interrupted)
    // are excluded - they legitimately end the turn.
    if (
      before.permissionPending
      && !state.permissionPending
      && !TURN_ENDING_EVENTS.has(event.type)
    ) {
      state.turnActive = true;
      state.pendingIdleAt = null;
    }

    if (event.type === EventType.Interrupted) {
      this.applyInterruptedBypass(sessionId, state, before);
      return;
    }

    const trigger: TransitionTrigger = event.detail !== undefined && event.detail !== ''
      ? `event:${event.type}:${event.detail}`
      : `event:${event.type}`;
    const delta = formatCounterDelta(before, snapshotCounters(state));
    this.reevaluate(sessionId, state, trigger, delta);
  }

  /**
   * Interrupted forces immediate idle, bypassing the stability window.
   * User pressed Esc (or our renderer's Ctrl+C synthesizer fired) - reset
   * all counters and clear pending state. Matches forceIdle semantics:
   * a hard abort that should leave the session in a clean idle state
   * regardless of mid-flight tools or detached background work.
   */
  private applyInterruptedBypass(
    sessionId: string,
    state: SessionEngineState,
    before: ReturnType<typeof snapshotCounters>,
  ): void {
    state.pendingIdleAt = null;
    state.pendingToolCount = 0;
    state.pendingToolStack.length = 0;
    state.subagentDepth = 0;
    state.activeBackgroundShellIds.clear();
    state.anonymousBackgroundShellCount = 0;
    state.currentTool = null;
    // permissionPending and permissionAwaitedToolId are already cleared by
    // updatePermissionFlag, which processEvent runs before this bypass
    // (Interrupted is a permission-clearing signal).
    const delta = formatCounterDelta(before, snapshotCounters(state));
    this.commitTransition(sessionId, state, 'idle', 'interrupted', delta);
  }

  // ==== External force paths (PTY tracker, heartbeat recovery) ====

  /**
   * Force a transition to `'thinking'`. Used by the PTY tracker (PTY
   * data while idle) and heartbeat recovery (status.json tokens-up
   * while idle). Sets `turnActive=true` to match the semantics of an
   * external "agent is alive" signal.
   */
  forceThinking(sessionId: string): void {
    if (this.disposed) return;
    const state = this.getOrCreateState(sessionId);
    const before = snapshotCounters(state);
    state.turnActive = true;
    state.lastSignalAt = this.now();
    state.permissionPending = false;
    state.permissionAwaitedToolId = null;
    state.pendingIdleAt = null;
    state.compensationCounters.forceThinking += 1;
    const delta = formatCounterDelta(before, snapshotCounters(state));
    this.commitTransition(sessionId, state, 'thinking', 'force-thinking', delta);
  }

  /**
   * Force a transition to `'idle'`. Used by the PTY tracker (silence
   * timer or prompt detection). Resets all counters - the PTY's
   * "definitive idle" overrides our event-based bookkeeping.
   */
  forceIdle(sessionId: string): void {
    if (this.disposed) return;
    const state = this.getOrCreateState(sessionId);
    const before = snapshotCounters(state);
    state.turnActive = false;
    state.permissionPending = false;
    state.permissionAwaitedToolId = null;
    state.lastSignalAt = null;
    state.lastPtyOutputAt = null;
    state.pendingToolCount = 0;
    state.pendingToolStack.length = 0;
    state.subagentDepth = 0;
    state.activeBackgroundShellIds.clear();
    state.anonymousBackgroundShellCount = 0;
    state.currentTool = null;
    state.pendingIdleAt = null;
    state.compensationCounters.forceIdle += 1;
    const delta = formatCounterDelta(before, snapshotCounters(state));
    this.commitTransition(sessionId, state, 'idle', 'force-idle', delta);
  }

  /**
   * Reset `lastSignalAt` without firing a transition. Used by paths
   * that observe the agent is alive but don't want to flip state
   * (e.g. the status-file heartbeat keeping a thinking session warm
   * for the stale-thinking watchdog). Note: the bg-shell grace anchors
   * to `bgShellHoldSince`, NOT `lastSignalAt`, so this signal
   * deliberately cannot push that deadline out.
   */
  markThinkingSignal(sessionId: string): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (state) {
      state.lastSignalAt = this.now();
      if (state.activity === 'thinking') {
        this.scheduleTimer(sessionId, state);
      }
    }
  }

  /**
   * Watcher liveness keep-alive (Subsystem B). The process-tree watcher
   * confirmed every engine-tracked bg shell is still present in the OS tree
   * this cycle (no deficit). Unlike `markThinkingSignal` - which moves only
   * `lastSignalAt` and so cannot touch the bg-shell grace - this DELIBERATELY
   * advances the `bgShellHoldSince` anchor so a genuinely-running long bg
   * shell (e.g. a 10-min E2E whose `BackgroundShellEnd` hook was dropped) is
   * not false-idled at the 30s sole-holder grace.
   *
   * Safety rests on the watcher's gating, not the engine: the watcher fires
   * this ONLY on a no-deficit cycle, so a phantom (process gone) shows a
   * deficit, never refreshes, and is still reclaimed at the grace. Here we
   * no-op unless the bg-shell sole-holder hold is the active deadline
   * (`bgShellHoldSince !== null`, which `scheduleTimer` stamps only for that
   * hold), so a confirmation that races ahead of the hold cannot keep a
   * `turnActive` / pending-tools session warm.
   */
  markBackgroundShellsAlive(sessionId: string): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.activity !== 'thinking') return;
    // bgShellHoldSince is non-null exactly when the bg-shell sole-holder hold
    // is the active deadline. Write the anchor directly (scheduleTimer only
    // stamps it when null, so it would not advance an already-set anchor).
    if (state.bgShellHoldSince === null) return;
    state.bgShellHoldSince = this.now();
    this.scheduleTimer(sessionId, state);
  }

  /**
   * Record a PTY output chunk for the `signal-or-pty-output` watchdog
   * holds (Subsystem B/fix). Production behavior - NOT dev-gated, unlike
   * `markPtyChunk`. Called on every PTY chunk from the spawn flow,
   * independent of `PtyActivityTracker` suppression (which silences PTY
   * activity detection for hooks-based agents like Claude). The single
   * timestamp write lets the stuck-pending-tools hold treat streaming TUI
   * output as proof the foreground tool is still running, so a long quiet
   * test run (events and status-heartbeat both silent for >5 min while the
   * tool streams output) is no longer force-idled.
   *
   * Deliberately does NOT reschedule the watchdog timer: at ~60Hz that
   * would be wasteful churn. The armed timer re-reads the base time when it
   * fires and re-arms if the threshold has not been reached (see
   * `onTick`), so a forward-moving base is honored without per-chunk work.
   * The bg-shell holds ignore this field by design (they anchor on
   * `bgShellHoldSince`); stale-thinking, stuck-pending-tools, and
   * stuck-subagent all read it via the `signal-or-pty-output` anchor.
   *
   * No-op if the session is unknown.
   */
  markPtyOutput(sessionId: string): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    state.lastPtyOutputAt = this.now();
  }

  /**
   * Record a PTY chunk arrival for the timeline-overlay visualization.
   * Chunks are aggregated into 100ms buckets so the ring stays small
   * (~1200 entries for the 120s window). Does NOT affect engine state -
   * this is observation-only, separate from the PtyActivityTracker
   * which decides whether a chunk is activity-worthy.
   *
   * Dev-only: the body is dead-code-eliminated in production builds
   * via `__KANGENTIC_DEV__`. The PTY data path runs at ~60Hz across
   * every session, so paying for the bucket bookkeeping in shipped
   * binaries (where `recentPtyChunks` is never read) is wasted work.
   *
   * No-op if the session is unknown. Older buckets are evicted on
   * each insert so the array length is bounded.
   */
  markPtyChunk(sessionId: string): void {
    if (!__KANGENTIC_DEV__) return;
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    const now = this.now();
    const bucket = Math.floor(now / PTY_CHUNK_BUCKET_MS) * PTY_CHUNK_BUCKET_MS;
    const ring = state.recentPtyChunks;
    const last = ring[ring.length - 1];
    if (last && last.tsBucket === bucket) {
      last.count += 1;
    } else {
      ring.push({ tsBucket: bucket, count: 1 });
    }
    // Evict buckets older than the window. Cheap because additions
    // are append-only and the array is sorted by tsBucket.
    const cutoff = now - PTY_CHUNK_WINDOW_MS;
    let removeCount = 0;
    while (removeCount < ring.length && ring[removeCount].tsBucket < cutoff) {
      removeCount += 1;
    }
    if (removeCount > 0) {
      ring.splice(0, removeCount);
    }
  }

  /**
   * Subsystem B/C entry point: external caller (process-tree watcher
   * or BashOutput hook) reports that a background shell ended.
   *
   * If `shellId` matches a tracked id in `activeBackgroundShellIds`,
   * remove it. Otherwise (anonymous bg shell), decrement
   * `anonymousBackgroundShellCount`. Re-evaluates the predicate -
   * may emit idle.
   */
  markBackgroundShellEnded(sessionId: string, shellId?: string): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    const before = snapshotCounters(state);
    if (shellId !== undefined) {
      // Identity-aware decrement. If the shell isn't tracked under
      // this id, treat as no-op - the caller named a specific shell,
      // falling through would silently corrupt the anonymous count.
      if (!state.activeBackgroundShellIds.has(shellId)) return;
      state.activeBackgroundShellIds.delete(shellId);
    } else {
      // Anonymous decrement (count-based heuristic from the watcher).
      // The watcher saw N fewer descendants - SOMETHING ended. We drain
      // anonymous only; we do NOT fall back to draining a named entry,
      // because the watcher cannot prove the exit was a tracked named
      // shell vs. helper-process churn (MCP server, statusline worker).
      // Falling back would clobber a real, alive named bg shell every
      // time a helper exits. Genuinely stuck named entries are recovered
      // by the 5-min bg-shell escape hatch (watchdog.ts).
      if (state.anonymousBackgroundShellCount > 0) {
        state.anonymousBackgroundShellCount -= 1;
      } else {
        if (state.activeBackgroundShellIds.size > 0) {
          console.warn(
            `[activity-engine] ignoring ambiguous anonymous bg-shell decrement for ${sessionId}: ` +
            `anon=0, named=${state.activeBackgroundShellIds.size}`,
          );
        }
        return;
      }
    }
    const trigger: TransitionTrigger = shellId !== undefined
      ? `event:bg-shell-ended:${shellId}`
      : 'event:bg-shell-ended:watcher';
    const delta = formatCounterDelta(before, snapshotCounters(state));
    this.reevaluate(sessionId, state, trigger, delta);
  }

  /**
   * Subsystem G entry point: on Kangentic restart with a resumed
   * session whose Claude CLI has surviving descendant processes, adopt
   * those as anonymous bg shells. The watcher then prunes them as
   * they exit naturally.
   */
  adoptAnonymousBackgroundShells(sessionId: string, count: number): void {
    if (this.disposed) return;
    if (count <= 0) return;
    const state = this.getOrCreateState(sessionId);
    const before = snapshotCounters(state);
    state.anonymousBackgroundShellCount += count;
    const delta = formatCounterDelta(before, snapshotCounters(state));
    this.reevaluate(sessionId, state, 'event:bg-shells-adopted', delta);
  }

  // ==== Internal: re-evaluate after state mutation ====

  /**
   * Re-evaluate predicate after a state mutation. If activity should
   * change, commit the transition. The stability window applies to
   * any thinking->idle transition reached through the predicate path
   * (Stop event, SubagentStop, BackgroundShellEnd, watcher's
   * markBackgroundShellEnded). Forced idle paths (Interrupted,
   * forceIdle) bypass reevaluate entirely so the window doesn't
   * apply to them.
   */
  private reevaluate(
    sessionId: string,
    state: SessionEngineState,
    trigger: TransitionTrigger,
    counterDelta?: string,
  ): void {
    const fromActivity = state.activity;
    // Cheap predicate-only check: avoids allocating an ActivityReason
    // object on the common no-transition path. The reason is built
    // lazily below (only when we actually log or commit).
    const newActivity = derivePredicate(state);
    if (newActivity === fromActivity) {
      // No state change. If counters mutated, log a non-transition
      // step so the audit log shows what events held the predicate
      // in this state.
      if (counterDelta) {
        const reason = deriveReason(state);
        this.recordTransition(state, fromActivity, fromActivity, reason.kind, trigger, counterDelta);
      }
      this.scheduleTimer(sessionId, state);
      return;
    }
    // Stability window: only apply to thinking->idle. Idle->thinking
    // and ->permission are always immediate.
    const shouldDelayIdle =
      newActivity === 'idle'
      && state.activity === 'thinking'
      && this.idleStabilityWindowMs > 0;

    if (shouldDelayIdle) {
      // Idle deferred by stability window. The counter change that
      // would have flipped the state is real and worth logging now -
      // when the timer fires later, the actual transition gets its
      // own audit entry.
      if (counterDelta) {
        const reason = deriveReason(state);
        this.recordTransition(state, fromActivity, fromActivity, reason.kind, trigger, counterDelta);
      }
      state.pendingIdleAt = this.now() + this.idleStabilityWindowMs;
      this.scheduleTimer(sessionId, state);
      return;
    }

    this.commitTransition(sessionId, state, newActivity, trigger, counterDelta);
  }

  private commitTransition(
    sessionId: string,
    state: SessionEngineState,
    newActivity: ActivityState,
    trigger: TransitionTrigger,
    counterDelta?: string,
  ): void {
    if (state.activity === newActivity) {
      // No transition - but if counters changed, still log the step.
      if (counterDelta) {
        const reason = deriveReason(state);
        this.recordTransition(state, state.activity, state.activity, reason.kind, trigger, counterDelta);
      }
      this.scheduleTimer(sessionId, state);
      return;
    }
    const fromActivity = state.activity;
    state.activity = newActivity;
    state.pendingIdleAt = null;
    if (newActivity === 'idle') {
      state.idleTimestamp = this.now();
    } else {
      state.idleTimestamp = null;
    }
    const reason = deriveReason(state);
    this.recordTransition(state, fromActivity, newActivity, reason.kind, trigger, counterDelta);
    this.callbacks.onActivityChange(sessionId, newActivity, reason);
    this.scheduleTimer(sessionId, state);
  }

  private recordTransition(
    state: SessionEngineState,
    from: ActivityState,
    to: ActivityState,
    reasonKind: ActivityReason['kind'],
    trigger: TransitionTrigger,
    counterDelta?: string,
  ): void {
    const record: TransitionRecord = { ts: this.now(), from, to, reasonKind, trigger };
    if (counterDelta) record.counterDelta = counterDelta;
    state.recentTransitions.push(record);
    if (state.recentTransitions.length > RECENT_TRANSITIONS_RING_SIZE) {
      state.recentTransitions.splice(0, state.recentTransitions.length - RECENT_TRANSITIONS_RING_SIZE);
    }
  }

  // ==== Timers: stability window, bg-shell sole-holder grace, stale-thinking watchdog ====

  /**
   * The anchor time a watchdog hold's deadline is measured from. Single
   * source of truth shared by `scheduleTimer` (arming) and `onTick`
   * (firing) so the two cannot drift.
   *
   * - bg-shell holds: `bgShellHoldSince` (signal-only keep-alives like
   *   `markThinkingSignal` cannot push it out; only a watcher-confirmed
   *   `markBackgroundShellsAlive` advances the anchor, so a phantom is
   *   still reclaimed at its threshold).
   * - `signal-or-pty-output` holds (stuck-pending-tools, stuck-subagent,
   *   stale-thinking): the FRESHER of `lastSignalAt` and `lastPtyOutputAt` -
   *   streaming TUI output keeps a genuinely-running turn from being
   *   force-idled even when hooks and the status heartbeat are both silent.
   * - `signal`: `lastSignalAt` only. Currently unused by any hold.
   *
   * `fallback` is returned when the relevant anchor(s) are null.
   */
  private watchdogBaseTime(
    state: SessionEngineState,
    hold: WatchdogHold,
    fallback: number,
  ): number {
    switch (hold.anchor) {
      case 'bg-shell-hold-since':
        return state.bgShellHoldSince ?? fallback;
      case 'signal-or-pty-output': {
        const signals = [state.lastSignalAt, state.lastPtyOutputAt]
          .filter((timestamp): timestamp is number => timestamp !== null);
        return signals.length > 0 ? Math.max(...signals) : fallback;
      }
      case 'signal':
        return state.lastSignalAt ?? fallback;
    }
  }

  private scheduleTimer(sessionId: string, state: SessionEngineState): void {
    this.clearTimer(sessionId);
    if (this.disposed) return;

    const hold = state.activity === 'thinking'
      ? findActiveWatchdogHold(state, this.watchdogConfig)
      : undefined;

    // Maintain the bg-shell anchor before any early return, so it clears the
    // instant the bg-shell-only hold ends (another holder appears, or bg count
    // hits zero). Stamped here only when null, so signal-only keep-alives
    // (`markThinkingSignal`) re-run scheduleTimer but never advance it - that
    // immovability is what fixed the phantom-pin bug. The one path that DOES
    // advance it is `markBackgroundShellsAlive` (the watcher, on a confirmed-
    // alive cycle), which writes the anchor directly before calling this.
    // A fresh BackgroundShellStart re-arms it: that event sets turnActive, so
    // the hold predicate briefly goes false (clearing the anchor here), then
    // the following Idle drops turnActive and the next scheduleTimer re-stamps.
    if (hold?.anchor === 'bg-shell-hold-since') {
      if (state.bgShellHoldSince === null) state.bgShellHoldSince = this.now();
    } else {
      state.bgShellHoldSince = null;
    }

    // Priority 1: pending stability-window idle has the soonest deadline.
    if (state.pendingIdleAt !== null) {
      const delay = Math.max(10, state.pendingIdleAt - this.now());
      this.armTimer(sessionId, delay);
      return;
    }

    if (state.activity !== 'thinking' || !hold) return;

    const baseTime = this.watchdogBaseTime(state, hold, this.now());
    const delay = Math.max(50, hold.thresholdMs - (this.now() - baseTime));
    this.armTimer(sessionId, delay);
  }

  private armTimer(sessionId: string, delayMs: number): void {
    const timer = setTimeout(() => this.onTick(sessionId), delayMs);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(sessionId);
    }
  }

  private onTick(sessionId: string): void {
    this.timers.delete(sessionId);
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;

    // Stability-window idle commit.
    if (state.pendingIdleAt !== null && this.now() >= state.pendingIdleAt) {
      // Re-derive: if a new counter became active during the window, suppress.
      const { activity: derived } = deriveActivityAndReason(state);
      state.pendingIdleAt = null;
      if (derived === 'idle') {
        this.commitTransition(sessionId, state, 'idle', 'timer:stability');
      } else {
        this.scheduleTimer(sessionId, state);
      }
      return;
    }

    if (state.activity !== 'thinking') return;

    const hold = findActiveWatchdogHold(state, this.watchdogConfig);
    const baseTime = hold ? this.watchdogBaseTime(state, hold, 0) : 0;
    const sinceSignal = this.now() - baseTime;

    if (hold && sinceSignal >= hold.thresholdMs) {
      const before = snapshotCounters(state);
      this.emitSyntheticIdleTimeout(sessionId);
      hold.reset(state);
      // Tally the compensation. The trigger label is the canonical
      // discriminator so future watchdogs added to the table are
      // counted automatically as long as their trigger key matches.
      if (hold.trigger === 'timer:stale-thinking') {
        state.compensationCounters.staleThinking += 1;
      } else if (hold.trigger === 'timer:bg-shell-hatch') {
        state.compensationCounters.bgShellHatch += 1;
      } else if (hold.trigger === 'timer:stuck-pending-tools') {
        state.compensationCounters.stuckPendingTools += 1;
      } else if (hold.trigger === 'timer:stuck-subagent') {
        state.compensationCounters.stuckSubagent += 1;
      }
      const delta = formatCounterDelta(before, snapshotCounters(state));
      // Schedule the idle commit through the stability window unless
      // the hold opted out (stale-thinking watchdog wants instant
      // emission, no flicker risk because turnActive was the only
      // holder and we just cleared it).
      if (hold.applyStabilityWindow && this.idleStabilityWindowMs > 0) {
        state.pendingIdleAt = this.now() + this.idleStabilityWindowMs;
        this.scheduleTimer(sessionId, state);
      } else {
        this.commitTransition(sessionId, state, 'idle', hold.trigger, delta);
      }
      return;
    }

    // Conditions changed since we armed, or threshold not reached - re-arm.
    this.scheduleTimer(sessionId, state);
  }

  private emitSyntheticIdleTimeout(sessionId: string): void {
    if (!this.callbacks.onSyntheticEvent) return;
    const syntheticEvent: SessionEvent = {
      ts: this.now(),
      type: EventType.Idle,
      detail: IdleReason.Timeout,
    };
    this.callbacks.onSyntheticEvent(sessionId, syntheticEvent);
  }

  /**
   * Predicate for `session-telemetry.ts:maybeSuppressPtyTracker` -
   * "is this event a thinking-initiating event?". Replaces the
   * vestigial `EventTypeActivity` map.
   */
  static isTurnInitiatingEvent(eventType: EventType): boolean {
    return TURN_INITIATING_EVENTS.has(eventType);
  }
}
