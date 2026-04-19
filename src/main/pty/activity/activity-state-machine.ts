import { EventType, EventTypeActivity, IdleReason } from '../../../shared/types';
import type { ActivityState, SessionEvent } from '../../../shared/types';

/**
 * Per-session bookkeeping used by the activity state machine. All fields
 * for a single session live in one object so that lifecycle resets touch
 * a single entry instead of updating a dozen parallel Maps.
 */
export interface SessionTrackingState {
  /** Current derived activity state. */
  activity: ActivityState;
  /** Nesting depth of active subagents. */
  subagentDepth: number;
  /** In-flight tool calls (used by the stale-thinking heuristic). */
  pendingToolCount: number;
  /** Guard 2: a Stop-driven idle was deferred until the subagent finishes. */
  pendingIdleWhileSubagent: boolean;
  /** True iff the last idle transition was caused by PermissionRequest. */
  permissionIdle: boolean;
  /**
   * Pending permission requests that have not yet been balanced by tool_end.
   * Each `idle/permission` event increments; each `tool_end` decrements
   * (only while we are at depth <= 1, where the signal is unambiguous).
   * When the count returns to 0 we clear `permissionIdle` so the next
   * subagent tool_start can wake the activity state.
   */
  pendingPermissions: number;
  /** Epoch ms of the most recent idle transition. */
  idleTimestamp: number | null;
  /** Epoch ms of the most recent thinking signal (event or usage update). */
  lastThinkingSignal: number | null;
  /** Epoch ms of the first-ever thinking transition (nucleation window). */
  firstThinkingTimestamp: number | null;
  /** PR command detector: a `gh pr ...` bash tool_start is in flight. */
  pendingPRCommand: boolean;
  /**
   * Count of in-flight backgrounded Bash shells (run_in_background: true).
   * Incremented by `background_shell_start`, decremented by
   * `background_shell_end` (KillBash). Used by Guard 3 to suppress Idle
   * while a detached child is still owned by the agent. Over-estimates
   * when the background shell finishes naturally (no hook fires for
   * that) -- reset on session_end. See `tests/e2e/background-shell-
   * idle.spec.ts` for the bug this tracks.
   */
  activeBackgroundShells: number;
  /** Guard 3: a Stop-driven idle was deferred because a bg shell is active. */
  pendingIdleWhileBackgroundShell: boolean;
}

function createSessionTrackingState(): SessionTrackingState {
  return {
    activity: 'idle',
    subagentDepth: 0,
    pendingToolCount: 0,
    pendingIdleWhileSubagent: false,
    permissionIdle: false,
    pendingPermissions: 0,
    idleTimestamp: null,
    lastThinkingSignal: null,
    firstThinkingTimestamp: null,
    pendingPRCommand: false,
    activeBackgroundShells: 0,
    pendingIdleWhileBackgroundShell: false,
  };
}

export interface ActivityStateMachineCallbacks {
  /** Fired every time the activity state actually changes (not deduped). */
  onActivityChange(sessionId: string, activity: ActivityState, permissionIdle: boolean): void;
}

/**
 * Event-driven activity state machine.
 *
 * Consumes parsed `SessionEvent`s and maintains per-session activity state
 * (`thinking` vs `idle`) using two guards that model the subagent/permission
 * nuances of Claude Code's hook stream:
 *
 * - **Guard 1** (`suppressSubagentWakeDuringPermission`): when the parent
 *   is in permission idle and a subagent tool event arrives, do NOT wake
 *   the state to thinking. The user still owes a permission decision, so
 *   "thinking" would hide a pending prompt.
 *
 * - **Guard 2** (`deferStopUntilSubagentFinishes`): when the main agent
 *   fires Stop (idle) but a subagent is still running, defer the idle
 *   transition. Emit it when the subagent finishes. Permission idle
 *   bypasses this guard because permission prompts must be visible to
 *   the user immediately regardless of subagent state.
 *
 * The `pendingPermissions` counter tracks in-flight permission requests
 * at `depth <= 1` so that once all are balanced by `tool_end` events,
 * Guard 1 releases its grip and the next subagent tool_start cleanly
 * wakes the state. At `depth >= 2` the counter freezes (we cannot tell
 * which subagent's tool_end belongs to which permission) and the
 * conservative sticky behavior is preserved.
 */
export class ActivityStateMachine {
  private readonly states = new Map<string, SessionTrackingState>();
  private readonly callbacks: ActivityStateMachineCallbacks;

  constructor(callbacks: ActivityStateMachineCallbacks) {
    this.callbacks = callbacks;
  }

  // ==== Lifecycle ====

  /** Create a fresh state entry and emit the initial idle transition. */
  initSession(sessionId: string): void {
    const state = createSessionTrackingState();
    state.idleTimestamp = Date.now();
    this.states.set(sessionId, state);
    this.callbacks.onActivityChange(sessionId, 'idle', false);
  }

  /** Drop all state for a session (used by suspend / remove). */
  deleteSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /**
   * Lazily get or create a state entry. Callers that mutate state (PTY
   * tracker, stale-thinking timer, heartbeat recovery) use this to ensure
   * the entry exists before they touch it.
   */
  getOrCreateState(sessionId: string): SessionTrackingState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = createSessionTrackingState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  /** Read the state entry without creating one. */
  getState(sessionId: string): SessionTrackingState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * Iterate all sessions for read-only scans (idle timeout, stale thinking
   * watchdog, etc.). The state is exposed as `Readonly` so the compiler
   * prevents callers from bypassing the state machine by directly mutating
   * fields. Use the explicit mutation methods (`markThinkingSignal`,
   * `forceThinking`, `forceIdle`, `setPendingPRCommand`) instead.
   */
  forEachState(
    callback: (sessionId: string, state: Readonly<SessionTrackingState>) => void,
  ): void {
    for (const [sessionId, state] of this.states) {
      callback(sessionId, state);
    }
  }

  /**
   * Record a non-transitioning "thinking proof" signal. Used by paths
   * that observe the agent is alive but don't want to trigger a full
   * transition (e.g. the stale-thinking watchdog resetting its own
   * timer when tools are in flight, or a usage update with rising
   * token counts while the state is already thinking).
   */
  markThinkingSignal(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) state.lastThinkingSignal = Date.now();
  }

  /** Snapshot of just the activity field for IPC callers. */
  getActivityCache(): Record<string, ActivityState> {
    const result: Record<string, ActivityState> = {};
    for (const [sessionId, state] of this.states) {
      result[sessionId] = state.activity;
    }
    return result;
  }

  // ==== PR command detector accessors ====
  //
  // The PR command flag lives on SessionTrackingState for cache-locality
  // with the other per-session flags, but it is unrelated to the activity
  // state machine. These accessors keep the detector logic in UsageTracker
  // without letting it poke into the state object directly.

  hasPendingPRCommand(sessionId: string): boolean {
    return this.states.get(sessionId)?.pendingPRCommand === true;
  }

  setPendingPRCommand(sessionId: string, value: boolean): void {
    const state = this.getOrCreateState(sessionId);
    state.pendingPRCommand = value;
  }

  // ==== Main event processing ====

  /**
   * Apply a parsed SessionEvent to the state machine. Updates counters,
   * computes activity transitions through the two guards, and fires
   * `onActivityChange` when the activity actually changes.
   */
  processEvent(sessionId: string, event: SessionEvent): void {
    const state = this.getOrCreateState(sessionId);

    // Any event proves the agent is alive. Reset stale-thinking timer.
    if (state.activity === 'thinking') {
      state.lastThinkingSignal = Date.now();
    }

    this.updatePendingToolCount(state, event);
    this.updatePendingPermissions(state, event);
    this.updateSubagentDepth(sessionId, state, event);
    this.updateBackgroundShellCount(sessionId, state, event);

    const newActivity = EventTypeActivity[event.type];
    if (!newActivity) return;

    // Clear pending idle flag when the main agent resumes thinking
    // (prompt or subagent_start), even if deduped.
    if (newActivity === 'thinking'
        && (event.type === EventType.Prompt
            || event.type === EventType.SubagentStart
            || state.subagentDepth === 0)) {
      state.pendingIdleWhileSubagent = false;
    }

    if (state.activity === newActivity) return;

    if (this.suppressSubagentWakeDuringPermission(state, event, newActivity)) return;
    // Both guards must evaluate before returning so that when a Stop-driven
    // idle arrives while BOTH a subagent and a background shell are active,
    // both pending flags are set. Short-circuiting on Guard 2 would leave
    // pendingIdleWhileBackgroundShell unset, causing Guard 3 to miss the
    // deferred emission when the bg shell is later killed.
    const deferredByGuard2 = this.deferStopUntilSubagentFinishes(state, event, newActivity);
    const deferredByGuard3 = this.deferStopUntilBackgroundShellsFinish(state, event, newActivity);
    if (deferredByGuard2 || deferredByGuard3) return;

    // Clear stale pending idle when permission idle bypasses Guard 2.
    if (newActivity === 'idle' && event.detail === IdleReason.Permission) {
      state.pendingIdleWhileSubagent = false;
    }

    this.transition(sessionId, state, newActivity, event);
  }

  // ==== Transition helpers (public: used by PTY and timer paths) ====

  /**
   * Force a transition to 'thinking'. Used by the PTY tracker and the
   * heartbeat-recovery path when a non-event signal proves the agent
   * is working.
   */
  forceThinking(sessionId: string): void {
    const state = this.getOrCreateState(sessionId);
    state.activity = 'thinking';
    state.lastThinkingSignal = Date.now();
    if (state.firstThinkingTimestamp === null) {
      state.firstThinkingTimestamp = Date.now();
    }
    state.idleTimestamp = null;
    state.permissionIdle = false;
    this.callbacks.onActivityChange(sessionId, 'thinking', false);
  }

  /**
   * Force a transition to 'idle'. Used by the PTY tracker and the
   * stale-thinking timer. Does NOT set permissionIdle - the caller
   * indicates a synthetic or PTY-based reason, not a hook-driven
   * permission prompt.
   */
  forceIdle(sessionId: string): void {
    const state = this.getOrCreateState(sessionId);
    state.activity = 'idle';
    state.permissionIdle = false;
    state.idleTimestamp = Date.now();
    state.lastThinkingSignal = null;
    this.callbacks.onActivityChange(sessionId, 'idle', false);
  }

  // ==== Guards ====

  /**
   * Guard 1: prevent a subagent's tool event from waking the state to
   * 'thinking' while a permission prompt is still pending. Returns true
   * to signal the caller should skip the transition. See the
   * 'permission idle stays sticky -- subagent tool_start suppressed at
   * depth > 0' test for the base case and 'subagent resumes thinking
   * after parallel permissions resolve' for the recovery path.
   */
  private suppressSubagentWakeDuringPermission(
    state: SessionTrackingState,
    event: SessionEvent,
    newActivity: ActivityState,
  ): boolean {
    if (state.activity !== 'idle' || newActivity !== 'thinking') return false;
    if (event.type === EventType.Prompt) return false;
    if (event.type === EventType.SubagentStart) return false;
    if (state.subagentDepth === 0) return false;
    if (!state.permissionIdle) return false;
    return true;
  }

  /**
   * Guard 2: defer a Stop-triggered idle until the last subagent finishes.
   * Permission idle and interrupts bypass this guard because they must be
   * visible to the user immediately. Sets the pending flag so that a
   * subsequent SubagentStop emits the deferred idle.
   */
  private deferStopUntilSubagentFinishes(
    state: SessionTrackingState,
    event: SessionEvent,
    newActivity: ActivityState,
  ): boolean {
    if (state.activity !== 'thinking' || newActivity !== 'idle') return false;
    if (event.type === EventType.Interrupted) return false;
    if (event.detail === IdleReason.Permission) return false;
    if (state.subagentDepth === 0) return false;
    state.pendingIdleWhileSubagent = true;
    return true;
  }

  /**
   * Guard 3: defer a Stop-triggered idle while any backgrounded Bash is
   * still active. A backgrounded Bash (`run_in_background: true`) fires
   * a well-formed PreToolUse/PostToolUse pair when Claude returns the
   * handle, but the detached child keeps running real work (e.g. an E2E
   * test suite). When the agent narrates and yields, Stop fires. Without
   * this guard, the session would flip to idle even though there is
   * active background work, which breaks the task-card indicator,
   * auto-suspend, and column-move semantics.
   *
   * Interrupts and permission idle bypass this guard because they must
   * be visible to the user immediately regardless of background work.
   *
   * The pending flag is set so that a subsequent `background_shell_end`
   * (KillBash) that drops the counter to zero emits the deferred idle.
   * Natural completion of a background shell is NOT tracked (Claude
   * Code does not fire a hook for it), so in the common case the flag
   * stays pending until session_end -- that errs on the safe side.
   */
  private deferStopUntilBackgroundShellsFinish(
    state: SessionTrackingState,
    event: SessionEvent,
    newActivity: ActivityState,
  ): boolean {
    if (state.activity !== 'thinking' || newActivity !== 'idle') return false;
    if (event.type === EventType.Interrupted) return false;
    if (event.detail === IdleReason.Permission) return false;
    if (state.activeBackgroundShells === 0) return false;
    state.pendingIdleWhileBackgroundShell = true;
    return true;
  }

  // ==== Private state updaters (one per concern) ====

  /** Tool-call counter for stale-thinking detection. */
  private updatePendingToolCount(state: SessionTrackingState, event: SessionEvent): void {
    if (event.type === EventType.ToolStart) {
      state.pendingToolCount += 1;
    } else if (event.type === EventType.ToolEnd || event.type === EventType.Interrupted) {
      state.pendingToolCount = Math.max(0, state.pendingToolCount - 1);
    }
  }

  /**
   * Permission counter for Guard 1 release at depth <= 1. At depth >= 2
   * we cannot tell whose tool_end balances whose permission, so the
   * counter is frozen (sticky behavior preserved).
   *
   * The decrement path only clears `permissionIdle` when the counter
   * actually reaches 0 FROM A POSITIVE VALUE. A `tool_end` arriving
   * while the counter is already 0 means either (a) the permission
   * that set `permissionIdle` was fired at depth >= 2 and never
   * counted here, or (b) the counter was already fully drained. In
   * both cases we must NOT clear `permissionIdle` - doing so would
   * prematurely wake the state even though the pending permission
   * from depth >= 2 is still outstanding. See regression test
   * 'depth-2-only permission does not false-wake on depth-1 tool_end'.
   */
  private updatePendingPermissions(state: SessionTrackingState, event: SessionEvent): void {
    if (state.subagentDepth > 1) return;

    if (event.type === EventType.Idle && event.detail === IdleReason.Permission) {
      state.pendingPermissions += 1;
    } else if (event.type === EventType.ToolEnd && state.permissionIdle && state.pendingPermissions > 0) {
      state.pendingPermissions -= 1;
      if (state.pendingPermissions === 0) {
        state.permissionIdle = false;
      }
    }
  }

  /** Subagent depth tracking + deferred-idle emission on final stop. */
  private updateSubagentDepth(
    sessionId: string,
    state: SessionTrackingState,
    event: SessionEvent,
  ): void {
    if (event.type === EventType.SubagentStart) {
      state.subagentDepth += 1;
    } else if (event.type === EventType.SubagentStop) {
      state.subagentDepth = Math.max(0, state.subagentDepth - 1);

      // Emit deferred idle when the last subagent finishes -- but only if
      // Guard 3 (active background shells) is not also holding. When both
      // guards were active simultaneously and SubagentStop fires first, we
      // hand the deferral off to Guard 3 so it can emit when the last bg
      // shell is killed via KillBash.
      if (state.subagentDepth === 0 && state.pendingIdleWhileSubagent) {
        state.pendingIdleWhileSubagent = false;
        if (state.activeBackgroundShells > 0) {
          // Guard 3 still holds: promote the pending idle to the bg-shell
          // deferred flag instead of emitting now.
          state.pendingIdleWhileBackgroundShell = true;
        } else if (state.activity !== 'idle') {
          state.activity = 'idle';
          this.callbacks.onActivityChange(sessionId, 'idle', false);
        }
      }
    }
  }

  /**
   * Background-shell counter tracking + deferred-idle emission when the
   * last tracked shell is killed. Increments on `background_shell_start`
   * (backgrounded Bash), decrements on `background_shell_end` (KillBash).
   * Resets on session_end. Natural completion of a background shell is
   * not tracked because Claude Code does not fire a hook for it; the
   * counter is therefore a safe upper bound rather than a precise count.
   */
  private updateBackgroundShellCount(
    sessionId: string,
    state: SessionTrackingState,
    event: SessionEvent,
  ): void {
    if (event.type === EventType.BackgroundShellStart) {
      state.activeBackgroundShells += 1;
    } else if (event.type === EventType.BackgroundShellEnd) {
      state.activeBackgroundShells = Math.max(0, state.activeBackgroundShells - 1);

      // Emit deferred idle when the last bg shell is killed -- but only if
      // Guard 2 (active subagent) is not also holding. When both guards were
      // active simultaneously and BackgroundShellEnd fires first, hand the
      // deferral off to Guard 2 so it can emit when the subagent finishes.
      if (state.activeBackgroundShells === 0 && state.pendingIdleWhileBackgroundShell) {
        state.pendingIdleWhileBackgroundShell = false;
        if (state.subagentDepth > 0) {
          // Guard 2 still holds: promote the pending idle to the subagent
          // deferred flag instead of emitting now.
          state.pendingIdleWhileSubagent = true;
        } else if (state.activity !== 'idle') {
          state.activity = 'idle';
          state.idleTimestamp = Date.now();
          state.lastThinkingSignal = null;
          this.callbacks.onActivityChange(sessionId, 'idle', false);
        }
      }
    } else if (event.type === EventType.SessionEnd) {
      // A fresh session should never inherit stale bg-shell state.
      state.activeBackgroundShells = 0;
      state.pendingIdleWhileBackgroundShell = false;
    }
  }

  /** Commit an activity transition + related timestamp bookkeeping. */
  private transition(
    sessionId: string,
    state: SessionTrackingState,
    newActivity: ActivityState,
    event: SessionEvent,
  ): void {
    state.activity = newActivity;

    if (newActivity === 'idle') {
      state.lastThinkingSignal = null;
      state.permissionIdle = event.detail === IdleReason.Permission;
      state.idleTimestamp = Date.now();
    } else if (newActivity === 'thinking') {
      state.lastThinkingSignal = Date.now();
      if (state.firstThinkingTimestamp === null) {
        state.firstThinkingTimestamp = Date.now();
      }
      state.permissionIdle = false;
      state.idleTimestamp = null;
    }

    const isPermissionIdle = newActivity === 'idle' && event.detail === IdleReason.Permission;
    this.callbacks.onActivityChange(sessionId, newActivity, isPermissionIdle);
  }
}
