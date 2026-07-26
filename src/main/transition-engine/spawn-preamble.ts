import { DEFAULT_AGENT } from '../../shared/types';
import type { Task, Swimlane, PermissionMode } from '../../shared/types';
import type { TaskRepository } from '../db/repositories/task-repository';
import { resolveTargetAgent, type AgentResolution } from './agent-resolver';

/**
 * The project-level defaults the preamble resolves inherited fields against.
 * Structural (not `Pick<Project, ...>`) because the board path passes the
 * `Project` row (whose `default_agent` is non-null) while the startup path
 * passes the nullable scalars it was handed; both satisfy this shape.
 */
export interface SpawnPreambleProjectDefaults {
  default_agent: string | null;
  default_model: string | null;
  default_effort: string | null;
}

/**
 * The shared spawn preamble: the per-path behavior every spawn entry point
 * must apply identically (see .claude/rules/spawn-entry-point-parity.md).
 *
 * Board-driven spawns reach it through `spawnAgent`
 * (src/main/ipc/helpers/agent-spawn.ts); startup spawns through
 * `prepareAgentSpawn` (session-startup/prepare-spawn.ts). Handlers never call
 * these functions directly - they route through one of those two chokepoints.
 */

/**
 * Lock the Advanced (Agent / Model / Effort / Permission) overrides on a
 * task's very first ever spawn.
 *
 * A task that already carries at least one explicit override but leaves the
 * others on "inherit" gets ALL FOUR fields locked to the values the Advanced
 * tab displayed when the user configured it: task override -> the lane the
 * task lived in at config time (`settingsLane`) -> project default (global
 * permission mode for Permission). The DESTINATION column's settings never
 * leak into the locked contract - the user never saw them in the dialog. A
 * destination lane forcing `permission_mode: 'plan'` still wins at spawn
 * resolution (see `resolveEffectivePermissionMode` below); the locked
 * permission is what the task runs under everywhere else.
 *
 * A task with NO overrides at all is untouched - it keeps following
 * column/project defaults for its whole life.
 *
 * "First ever spawn" = no session record exists AND task.agent is still null.
 * task.agent is set once, at first successful spawn (see transition-engine.ts),
 * and is NOT cleared by a To-Do reset (cleanupTaskResources wipes session rows
 * but never touches task.agent), so a task that spawned once, was reset to To
 * Do, and is redragged forward is correctly not treated as fresh.
 *
 * Mutates the passed `task` object in place (in addition to persisting) so the
 * spawn already in flight resolves against the locked values without a re-read.
 */
export function lockAdvancedOverridesOnFirstSpawn(options: {
  task: Task;
  /** Whether any session row exists for the task (first-ever-spawn detection). */
  hasSessionRecord: boolean;
  /**
   * The lane whose inherited settings the New Task / Edit dialog displayed
   * when the user configured the task: the lane the task lived in before this
   * spawn (a drag move passes the SOURCE lane), or the creation column for a
   * task created directly in a spawn column. Null when that lane no longer
   * resolves - inherited fields then lock to project/global defaults.
   */
  settingsLane: Pick<Swimlane, 'agent_override' | 'model_override' | 'effort_override' | 'permission_mode'> | null;
  project: SpawnPreambleProjectDefaults | null | undefined;
  /**
   * Lazy accessor for the global permission-mode default. Invoked only when
   * the lock actually proceeds AND the global fallback is reached, so a
   * no-op spawn (the common case) never pays for the synchronous project-config
   * disk read behind `getEffectiveConfig`.
   */
  globalPermissionMode: () => PermissionMode;
  tasks: Pick<TaskRepository, 'update'>;
}): void {
  const { task, hasSessionRecord, settingsLane, project, globalPermissionMode, tasks } = options;

  // Board Profile mode: the ladder IS the contract, not a snapshot to freeze.
  // Locking here would resolve the task's first column and pin those values for
  // its whole life, which is exactly the per-column variation a profile exists
  // to provide - Planning in Opus xhigh would silently become Merge in Opus
  // xhigh too.
  //
  // The guard below already covers this, since a profile task carries none of
  // the four pins (TaskRepository enforces the exclusivity). This states the
  // intent explicitly so the behavior does not silently depend on that
  // invariant holding somewhere else.
  if (task.profile_id) return;

  const isFirstEverSpawn = !hasSessionRecord && task.agent === null;
  const hasAnyOverrideSet = task.agent_override !== null || task.model_override !== null
    || task.effort_override !== null || task.permission_mode !== null;
  if (!isFirstEverSpawn || !hasAnyOverrideSet) return;

  const lockedAgent = task.agent_override ?? settingsLane?.agent_override ?? project?.default_agent ?? DEFAULT_AGENT;
  const lockedModel = task.model_override ?? settingsLane?.model_override ?? project?.default_model ?? null;
  const lockedEffort = task.effort_override ?? settingsLane?.effort_override ?? project?.default_effort ?? null;
  const lockedPermission = task.permission_mode ?? settingsLane?.permission_mode ?? globalPermissionMode();

  tasks.update({
    id: task.id,
    agent_override: lockedAgent,
    model_override: lockedModel,
    effort_override: lockedEffort,
    permission_mode: lockedPermission,
  });
  task.agent_override = lockedAgent;
  task.model_override = lockedModel;
  task.effort_override = lockedEffort;
  task.permission_mode = lockedPermission;
  console.log(
    `[spawn-preamble] Locked Advanced overrides for task ${task.id.slice(0, 8)} on first spawn:`
    + ` agent=${lockedAgent} model=${lockedModel ?? 'null'} effort=${lockedEffort ?? 'null'} permission=${lockedPermission}`,
  );
}

/**
 * Run the shared spawn preamble: lock the Advanced overrides on a first-ever
 * spawn, THEN resolve the target agent. The order is load-bearing - a
 * just-locked `agent_override` must be what `resolveTargetAgent` picks up, so
 * the agent the lock persists is the agent the spawn actually runs.
 *
 * Returns the agent resolution for the caller to pass to the engine
 * (`agentOverride` param) or the adapter registry. Model/effort spawn
 * overrides are deliberately NOT computed here: the board path resolves them
 * per engine call via `resolveSpawnOverrides` against re-read task rows, and
 * the startup path inlines the same chain over scalar project defaults.
 */
export function runSpawnPreamble(options: {
  task: Task;
  /** Whether any session row exists for the task (first-ever-spawn detection). */
  hasSessionRecord: boolean;
  /** See `lockAdvancedOverridesOnFirstSpawn`. */
  settingsLane: Pick<Swimlane, 'agent_override' | 'model_override' | 'effort_override' | 'permission_mode'> | null;
  /** The lane the task is spawning into; its `agent_override` participates in agent resolution (never in the lock). */
  destinationLane: Pick<Swimlane, 'agent_override'> | null;
  project: SpawnPreambleProjectDefaults | null | undefined;
  /** See `lockAdvancedOverridesOnFirstSpawn`. */
  globalPermissionMode: () => PermissionMode;
  tasks: Pick<TaskRepository, 'update'>;
}): AgentResolution {
  lockAdvancedOverridesOnFirstSpawn({
    task: options.task,
    hasSessionRecord: options.hasSessionRecord,
    settingsLane: options.settingsLane,
    project: options.project,
    globalPermissionMode: options.globalPermissionMode,
    tasks: options.tasks,
  });

  return resolveTargetAgent({
    taskAgentOverride: options.task.agent_override,
    columnAgent: options.destinationLane?.agent_override ?? null,
    taskAgent: options.task.agent,
    projectDefaultAgent: options.project?.default_agent ?? null,
  });
}

/**
 * Resolve the permission mode a spawn actually runs under.
 *
 * Resolution order: task override -> lane -> global setting, EXCEPT a lane
 * forcing 'plan' always wins regardless of the task override. Plan mode is a
 * genuine safety guarantee (never let a task's Auto-Classifier/Accept-Edits
 * pin bypass a deliberate read-only phase), not just an ordinary column
 * default like every other mode.
 *
 * The single source of truth for this rule - both engine spawns
 * (transition-engine.ts, which receives the lane's mode as its
 * `permissionOverride` param) and startup spawns (prepare-spawn.ts, which
 * reads the lane directly) call this.
 */
export function resolveEffectivePermissionMode(
  taskPermissionMode: PermissionMode | null | undefined,
  lanePermissionMode: PermissionMode | null | undefined,
  globalPermissionMode: PermissionMode,
): PermissionMode {
  if (lanePermissionMode === 'plan') return 'plan';
  return taskPermissionMode ?? lanePermissionMode ?? globalPermissionMode;
}
