/**
 * Board Profiles: turning (column, profile) into the strategy a spawn runs under.
 *
 * A Board Profile is a named alternate ladder of per-column STRATEGY settings,
 * so one task can run Planning in Opus xhigh, Executing in Opus high, and Merge
 * in Sonnet high while another rides a cheaper ladder over the same board.
 * Column identity (which columns exist, their name, order, role, color, icon) is
 * singular across profiles; only strategy is profile-scoped.
 *
 * This module is the ONE place a profile is folded into a column's settings.
 * Every spawn-affecting read of a lane's strategy fields goes through it, so a
 * profile can never be honored on one code path and silently ignored on another
 * (the failure mode `auto_command` already shipped: honored on a cold spawn,
 * dropped on a warm move). `tests/unit/column-strategy-parity.test.ts` enforces
 * that mechanically.
 *
 * Everything here is pure and TOTAL - no throws, no I/O. It runs inside
 * `runSpawnPreamble` on both spawn chokepoints, and profiles live in a
 * checked-in config file while task assignments live in the local DB, so a
 * teammate deleting a profile must degrade to the base column rather than wedge
 * an in-flight task.
 */

import type {
  AutoCommandMode,
  BoardProfile,
  BoardProfileEntry,
  PermissionMode,
  SessionSpawnStrategy,
  SessionTarget,
  Swimlane,
} from '../../shared/types';

/** The lane fields a profile can re-point. Deliberately a `Pick`, so a caller cannot pass a lane-shaped object and have identity fields silently participate. */
export type LaneStrategyFields = Pick<
  Swimlane,
  | 'id'
  | 'agent_override'
  | 'model_override'
  | 'effort_override'
  | 'permission_mode'
  | 'auto_command'
  | 'auto_command_mode'
  | 'auto_spawn'
  | 'handoff_context'
  | 'session_target'
  | 'session_spawn_strategy'
  | 'plan_exit_target_id'
>;

/**
 * A column's strategy after its profile delta is applied - the COLUMN tier only.
 * The task pin, project default, and agent default tiers are layered on by
 * callers (agent via `resolveTargetAgent`, permission via
 * `resolveEffectivePermissionMode`, model/effort via `resolveSpawnOverrides`).
 *
 * Field names mirror `Swimlane` exactly so a converted call site reads the same
 * as before, just off `strategy` instead of `lane`.
 */
export interface ColumnStrategy {
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
  permission_mode: PermissionMode | null;
  auto_command: string | null;
  auto_command_mode: AutoCommandMode;
  auto_spawn: boolean;
  handoff_context: boolean;
  session_target: SessionTarget;
  session_spawn_strategy: SessionSpawnStrategy;
  plan_exit_target_id: string | null;
}

/**
 * Dangling `(taskId, profileId)` pairs already logged, so a task that spawns
 * repeatedly against a deleted profile warns once instead of on every move.
 * Main-process module state: not subject to the renderer HMR patterns.
 */
const warnedDanglingProfiles = new Set<string>();

/**
 * Find the profile a task rides, or null for the synthetic "Default" (the
 * columns' own settings).
 *
 * Total by design. Profiles live in a checked-in `kangentic.json` while
 * `tasks.profile_id` lives in the per-machine database, so the two go out of
 * sync for ordinary reasons - a teammate renames or deletes a profile and you
 * `git pull` while a task is mid-flight. That must degrade to Default, never
 * throw: this runs inside `runSpawnPreamble` on both spawn chokepoints, and
 * failing here would block the spawn entirely.
 */
export function findTaskProfile(input: {
  profiles: ReadonlyArray<BoardProfile> | null | undefined;
  profileId: string | null | undefined;
  /** Only used to de-duplicate the dangling-profile warning. */
  taskId?: string;
}): BoardProfile | null {
  const { profiles, profileId, taskId } = input;
  if (!profileId) return null;

  const match = profiles?.find((profile) => profile.id === profileId);
  if (match) return match;

  const warnKey = `${taskId ?? 'unknown'}\0${profileId}`;
  if (!warnedDanglingProfiles.has(warnKey)) {
    warnedDanglingProfiles.add(warnKey);
    console.warn(
      `[column-strategy] Task ${taskId?.slice(0, 8) ?? '?'} references unknown profile ${profileId.slice(0, 8)}`
      + ' - falling back to the columns\' own settings. The profile was likely renamed away or deleted by a teammate.',
    );
  }
  return null;
}

/** Defaults for a null lane, matching `swimlane-repository.mapRow`'s coercions. */
const NO_LANE_STRATEGY: ColumnStrategy = {
  agent_override: null,
  model_override: null,
  effort_override: null,
  permission_mode: null,
  auto_command: null,
  auto_command_mode: 'immediate',
  auto_spawn: false,
  handoff_context: false,
  session_target: 'main',
  session_spawn_strategy: 'create_or_resume',
  plan_exit_target_id: null,
};

/**
 * Whether a profile entry explicitly carries a key.
 *
 * The whole sparse design rests on this being key PRESENCE, not truthiness and
 * not `??`. A profile must be able to say "this column runs the agent's default
 * model" against a base column that pins one, which is `{ modelOverride: null }`
 * - indistinguishable from "inherit" under `??`.
 */
function hasKey(entry: BoardProfileEntry | undefined, key: keyof BoardProfileEntry): boolean {
  return entry !== undefined && Object.prototype.hasOwnProperty.call(entry, key);
}

/**
 * Fold a profile's delta for one column over that column's base settings.
 *
 * A null/undefined profile, or a profile with no entry for this column, returns
 * the lane's own values verbatim - so a board with no profiles behaves exactly
 * as it did before this feature existed, and adding a column later does not rot
 * existing profiles.
 *
 * `columns` is needed only to resolve a profile's `planExitTarget`, which is
 * carried by NAME (matching `BoardColumnConfig.planExitTarget`) while every
 * other profile key is addressed by swimlane uuid. Omit it when the caller does
 * not care about plan-exit routing; the lane's own target is then kept.
 */
export function resolveColumnStrategy(input: {
  lane: LaneStrategyFields | null | undefined;
  profile: BoardProfile | null | undefined;
  columns?: ReadonlyArray<Pick<Swimlane, 'id' | 'name'>>;
}): ColumnStrategy {
  const { lane, profile, columns } = input;
  if (!lane) return { ...NO_LANE_STRATEGY };

  const base: ColumnStrategy = {
    agent_override: lane.agent_override,
    model_override: lane.model_override,
    effort_override: lane.effort_override,
    permission_mode: lane.permission_mode,
    auto_command: lane.auto_command,
    auto_command_mode: lane.auto_command_mode,
    auto_spawn: lane.auto_spawn,
    handoff_context: lane.handoff_context,
    session_target: lane.session_target,
    session_spawn_strategy: lane.session_spawn_strategy,
    plan_exit_target_id: lane.plan_exit_target_id,
  };

  const entry = profile?.columns?.[lane.id];
  if (!entry) return base;

  return {
    agent_override: hasKey(entry, 'agentOverride') ? entry.agentOverride ?? null : base.agent_override,
    model_override: hasKey(entry, 'modelOverride') ? entry.modelOverride ?? null : base.model_override,
    effort_override: hasKey(entry, 'effortOverride') ? entry.effortOverride ?? null : base.effort_override,
    permission_mode: hasKey(entry, 'permissionMode') ? entry.permissionMode ?? null : base.permission_mode,
    auto_command: hasKey(entry, 'autoCommand') ? entry.autoCommand ?? null : base.auto_command,
    auto_command_mode: hasKey(entry, 'autoCommandMode')
      ? entry.autoCommandMode ?? 'immediate'
      : base.auto_command_mode,
    auto_spawn: hasKey(entry, 'autoSpawn') ? entry.autoSpawn === true : base.auto_spawn,
    handoff_context: hasKey(entry, 'handoffContext') ? entry.handoffContext === true : base.handoff_context,
    session_target: hasKey(entry, 'sessionTarget') ? entry.sessionTarget ?? 'main' : base.session_target,
    session_spawn_strategy: hasKey(entry, 'sessionSpawnStrategy')
      ? entry.sessionSpawnStrategy ?? 'create_or_resume'
      : base.session_spawn_strategy,
    plan_exit_target_id: hasKey(entry, 'planExitTarget')
      ? resolvePlanExitTargetId(entry.planExitTarget, columns, base.plan_exit_target_id)
      : base.plan_exit_target_id,
  };
}

/**
 * Overlay a profile's delta onto a lane, returning a lane-shaped object.
 *
 * `ColumnStrategy`'s field names deliberately mirror `Swimlane`'s, so folding a
 * profile is a spread: identity fields (id, name, role, position, color, icon)
 * pass through untouched and only strategy is re-pointed. That matters for
 * conversion safety - a call site adopts profiles by resolving its lane ONCE at
 * the top and using the result everywhere it used the raw lane, instead of
 * threading a parallel `strategy` argument through every downstream call and
 * risking one being missed.
 *
 * Returns null for a null lane so callers keep their existing `lane?.x` guards.
 */
export function applyProfileToLane<TLane extends LaneStrategyFields>(
  lane: TLane | null | undefined,
  profile: BoardProfile | null | undefined,
  columns?: ReadonlyArray<Pick<Swimlane, 'id' | 'name'>>,
): TLane | null {
  if (!lane) return null;
  if (!profile) return lane;
  return { ...lane, ...resolveColumnStrategy({ lane, profile, columns }) };
}

/**
 * The auto-command a spawn or a live injection should actually deliver:
 * task tier -> column tier (already profile-folded) -> none.
 *
 * Exists because the two paths disagreed. The spawn path honored
 * `task.auto_command`, while the live-injection path in task-move.ts read only
 * the destination lane - so a task carrying its own command worked on a cold
 * spawn and was silently dropped on a warm move into a column that already had a
 * live session. That split-brain reads as flaky rather than broken, and it would
 * have been inherited by profile-scoped auto-commands (honored on one path,
 * ignored on the other), so both paths now resolve here.
 *
 * Returns null rather than '' so callers keep their existing `?.trim()` guards.
 */
export function resolveEffectiveAutoCommand(
  taskAutoCommand: string | null | undefined,
  columnAutoCommand: string | null | undefined,
): string | null {
  return taskAutoCommand ?? columnAutoCommand ?? null;
}

/**
 * Map a profile's `planExitTarget` column NAME to a swimlane id.
 *
 * Mirrors `apply-config.ts`'s second-pass name resolution. An unresolvable name
 * (a renamed or deleted column, or a caller that passed no `columns`) keeps the
 * base column's target rather than clearing it: dropping the target would
 * silently strand a task in plan mode, which is worse than routing it the way
 * the board already would.
 */
function resolvePlanExitTargetId(
  targetName: string | undefined,
  columns: ReadonlyArray<Pick<Swimlane, 'id' | 'name'>> | undefined,
  fallback: string | null,
): string | null {
  if (!targetName || !columns) return fallback;
  const match = columns.find((column) => column.name === targetName);
  return match ? match.id : fallback;
}
