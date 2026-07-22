import type { ActivityState } from './types';

/**
 * The Kangentic idle-vs-active distinction at its most basic form: does a
 * running session require user interaction, or is the agent working on its own?
 *
 *   'idle'   -> requires user interaction. The agent is waiting on the human:
 *               it finished its turn (`ActivityState` `'idle'`) or paused for
 *               approval (`ActivityState` `'permission'`). Rendered as the amber
 *               "needs you" affordance.
 *   'active' -> no interaction needed. The agent is progressing a turn
 *               (`ActivityState` `'thinking'`). Rendered as the green spinner.
 *
 * This is THE single source of truth for that question. Every consumer (sidebar
 * counts, task-card indicator, terminal tab dot, auto-focus target, idle
 * notification dedup) reads it from here instead of comparing `ActivityState`
 * string literals inline. That scattering is what let `'permission'` fall into
 * the wrong bucket and produce the sidebar active/idle miscount: each call site
 * independently re-derived the bucket and one of them forgot `'permission'`.
 *
 * Note the deliberate name overlap: the granular engine state `ActivityState`
 * has a member `'idle'`, and the coarser `ActivityDisposition` also has `'idle'`
 * (which covers BOTH `'idle'` and `'permission'`). The disposition is the
 * product-level "idle vs active" the UI speaks in; the `ActivityState` is the
 * engine's finer-grained truth.
 */
export type ActivityDisposition = 'idle' | 'active';

/**
 * Maps every granular `ActivityState` to its idle/active disposition.
 *
 * `satisfies Record<ActivityState, ActivityDisposition>` is the keystone of this
 * design: add a new `ActivityState` variant and `tsc` FAILS here until it is
 * classified, so a new state can never again silently default into the wrong
 * bucket at a call site.
 */
const ACTIVITY_DISPOSITION = {
  idle: 'idle',
  permission: 'idle',
  thinking: 'active',
} satisfies Record<ActivityState, ActivityDisposition>;

/**
 * Does a session in this activity state require user interaction? True for
 * `'idle'` and `'permission'`. `undefined` (the engine has not reported a state
 * yet) returns `false`, preserving the existing "an unreported session is not
 * yet known to need the user" behavior at every call site.
 */
export function requiresUserInteraction(state: ActivityState | undefined): boolean {
  return state !== undefined && ACTIVITY_DISPOSITION[state] === 'idle';
}

/**
 * Is the agent actively working (no user interaction needed)? True only for
 * `'thinking'`. `undefined` returns `false`. Covers the "active" direction so a
 * future active variant is routed correctly too, not just a future idle one.
 */
export function isActive(state: ActivityState | undefined): boolean {
  return state !== undefined && ACTIVITY_DISPOSITION[state] === 'active';
}

/**
 * The disposition VALUE itself ('idle' | 'active'), not just a boolean bucket
 * check. Use this when persisting or displaying the disposition (e.g. the
 * `disposition` column on `session_activity_intervals`) so a future
 * `ActivityState` variant is classified here once, at the compile-time-checked
 * source, rather than re-derived (and risking drift) at each storage/display
 * call site. Requires a defined state - a caller with `ActivityState |
 * undefined` should branch on `requiresUserInteraction`/`isActive` first.
 */
export function dispositionOf(state: ActivityState): ActivityDisposition {
  return ACTIVITY_DISPOSITION[state];
}
