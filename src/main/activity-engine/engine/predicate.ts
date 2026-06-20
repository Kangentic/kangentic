import type { ActivityState, ActivityReason } from '../../../shared/types';
import type { SessionEngineState } from './shapes';

/**
 * Pure predicate functions for the activity engine.
 *
 * The shape is intentionally tiny: given a session state, derive
 * either the activity ('thinking' | 'idle' | 'permission') or a
 * structured reason for that activity. No engine reference, no
 * mutation, safe to call from anywhere.
 */

/**
 * Compute the activity state from the session's flags / counters. The
 * predicate is the entire state machine in one function:
 *
 *   permission IFF permissionPending
 *   thinking   IFF turnActive OR subagentDepth>0 OR bgShells>0
 *   idle       otherwise
 */
export function derivePredicate(state: SessionEngineState): ActivityState {
  if (state.permissionPending) return 'permission';
  const bgShellCount =
    state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount;
  if (state.turnActive || state.subagentDepth > 0 || bgShellCount > 0) {
    return 'thinking';
  }
  return 'idle';
}

/**
 * Whether an `idle_hint` event (e.g. a "waiting for your input" notification)
 * should end the turn. Conservative by design: the hint clears `turnActive`
 * ONLY when nothing else is keeping the session thinking, so a hint that fires
 * mid-turn (tools, subagents, or background shells still outstanding, or a
 * permission pending) never short-circuits genuine work. When this returns
 * false the hint is a pure no-op and the 180s stale-thinking watchdog remains
 * the backstop.
 */
export function idleHintEndsTurn(state: SessionEngineState): boolean {
  const bgShellCount =
    state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount;
  return state.turnActive
    && state.pendingToolCount === 0
    && state.subagentDepth === 0
    && bgShellCount === 0
    && !state.permissionPending;
}

/**
 * Pure derivation of an `ActivityReason` for the given activity.
 * Anchors to the activity argument (not `state.activity`) so callers
 * can compute reasons for both the current and would-be states
 * without mutating the input.
 *
 * Priority ladder when activity='thinking':
 *   tool > subagent > background-shell > turn-active
 */
export function deriveReasonForActivity(
  state: SessionEngineState,
  activity: ActivityState,
): ActivityReason {
  if (activity === 'permission') return { kind: 'permission' };
  if (activity === 'idle') return { kind: 'idle' };
  // activity === 'thinking'
  if (state.pendingToolCount > 0) {
    return {
      kind: 'tool',
      pendingCount: state.pendingToolCount,
      currentTool: state.currentTool,
    };
  }
  if (state.subagentDepth > 0) {
    return { kind: 'subagent', depth: state.subagentDepth };
  }
  const bgShellCount =
    state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount;
  if (bgShellCount > 0) {
    return {
      kind: 'background-shell',
      count: bgShellCount,
      ids: Array.from(state.activeBackgroundShellIds),
    };
  }
  return { kind: 'turn-active' };
}

/**
 * Reason for the CURRENT state.activity. Used by external callers
 * (`getActivityReason`, `getStatsSnapshot`) to read the engine's
 * current shape without computing a hypothetical transition.
 */
export function deriveReason(state: SessionEngineState): ActivityReason {
  return deriveReasonForActivity(state, state.activity);
}

/**
 * Combined activity + reason for transition emissions. Computes the
 * WOULD-BE next activity via the predicate, then derives the reason
 * for that activity (without mutating state).
 */
export function deriveActivityAndReason(
  state: SessionEngineState,
): { activity: ActivityState; reason: ActivityReason } {
  const activity = derivePredicate(state);
  const reason = deriveReasonForActivity(state, activity);
  return { activity, reason };
}
