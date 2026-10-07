import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { withTaskLock } from '../task-lifecycle-lock';
import { agentRegistry } from '../../agent/agent-registry';
import { getProjectRepos } from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import { applyProfileToLane } from '../../transition-engine/column-strategy';
import { loadTaskProfile } from '../helpers/task-profile';
import { reconcileTaskSessionRef, restartSessionForSettingsChange } from './session-reconcile';
import {
  resolveReportedEffort,
  resolveRestartReason,
  resolveSourceEffort,
  resolveTargetSettings,
  restartPhaseFor,
} from '../../transition-engine/injection-plan';
import { SessionRepository } from '../../db/repositories/session-repository';
import { resolveOwnSessionRecord } from '../../db/repositories/session-own-record';
import { getProjectDb } from '../../db/database';
import type {
  TaskSetRuntimeOverrideInput,
  TaskSetRuntimeOverrideResult,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Which of a task's settings a write asked to apply. A field left false keeps
 * the live session as it is even when the session drifted from the task's
 * config, so a pick of one field never restarts for a manual change to the
 * other.
 */
export interface SettingsFieldsChanged {
  model: boolean;
  effort: boolean;
}

/**
 * Apply a task's ALREADY-PERSISTED model and effort to its live session:
 * restart it when a changed field's target differs from what the session runs
 * at, otherwise leave it alone.
 *
 * Shared by the ContextBar pick (`TASK_SET_RUNTIME_OVERRIDE` below) and the
 * MCP `update_task` write (`onTaskSettingsChanged` in `mcp-project-context.ts`),
 * so a pin set by a user and one set by an agent or the phone reach a running
 * session the same way.
 *
 * Targets come from the task row as it stands now, folded through its Board
 * Profile and the agent-gated project default, the same resolution the respawn
 * applies (`resolveSpawnOverrides`). Reading the row after the write matters: a
 * pin clears the task's profile, and a target read from the old profile would
 * restart toward a model the respawn never passes.
 *
 * Sources come from the live session, never from the task's old config:
 * - effort: `resolveSourceEffort` with no pin (the pin is what was written),
 *   so an effort the user already set by hand with `/effort` restarts nothing,
 *   and a level the model silently downgraded counts as applied.
 * - model: the session's own `applied_model`. Not live telemetry, because the
 *   agent reports a canonical id while the config holds the flag string.
 * The record is the live session's own, since the task's newest can belong to
 * an isolated track. NULL on it means the session launched at the agent
 * default, so a concrete target restarts.
 *
 * Caller MUST hold `withTaskLock(taskId)`.
 */
export async function applyTaskSettingsToLiveSession(
  context: IpcContext,
  projectId: string,
  projectPath: string,
  taskId: string,
  changed: SettingsFieldsChanged,
): Promise<TaskSetRuntimeOverrideResult> {
  // Reconciled against the registry, as SESSION_RESUME and the task move are.
  // On the raw pointer, a task whose CLI had ended by itself still read as
  // live: a model pick then suspended a dead session and respawned it. With
  // the pointer cleared it lands on `persisted`, and the override is picked up
  // at the next spawn.
  const { task } = reconcileTaskSessionRef(context, projectId, taskId);
  if (!task.session_id) return { ok: true, mode: 'persisted' };

  const { swimlanes } = getProjectRepos(context, projectId);
  const lane = applyProfileToLane(
    swimlanes.getById(task.swimlane_id),
    loadTaskProfile(context, task, projectPath),
  );
  const { targetModel, targetEffort } = resolveTargetSettings({
    task,
    lane,
    project: context.projectRepo.getById(projectId),
  });

  const ownRecord = resolveOwnSessionRecord(
    new SessionRepository(getProjectDb(projectId)),
    task.session_id,
    task.id,
  );
  const sourceModel = changed.model ? (ownRecord?.applied_model ?? null) : targetModel;
  const sourceEffort = changed.effort
    ? resolveSourceEffort({
      taskEffortOverride: null,
      ...resolveReportedEffort(context.sessionManager, task.session_id),
      appliedEffort: ownRecord?.applied_effort,
      targetEffort,
    })
    : targetEffort;

  // Only a change to a CONCRETE value restarts. Clearing a field to "use
  // default" with nothing below it (the effective value becomes null) has no
  // `--model` / `--effort` to set, and `--resume` keeps whatever the session
  // runs at, so restarting would churn for nothing. Same rule a column move
  // applies (`resolveRestartReason`).
  const restartReason = resolveRestartReason({ sourceModel, targetModel, sourceEffort, targetEffort });
  if (!restartReason) return { ok: true, mode: 'persisted' };

  // Suspend + respawn so the new model/effort reach the CLI as launch flags.
  // The shared helper resumes idle (no auto_command, no continuation), so an
  // in-flight turn stops, and it keeps `--resume` viable, so a respawn failure
  // leaves the record `suspended` for the existing "Resume" UI to retry.
  const result = await restartSessionForSettingsChange(
    context, projectId, projectPath, taskId,
    { phase: restartPhaseFor(restartReason) },
  );
  return result.ok
    ? { ok: true, mode: 'restart' }
    : { ok: false, reason: result.reason };
}

/**
 * Handler for `IPC.TASK_SET_RUNTIME_OVERRIDE`. Persists the per-task model
 * and/or effort override and applies the change to the live PTY session if
 * one exists (`applyTaskSettingsToLiveSession`).
 *
 * Two apply paths, picked by what changed:
 *   - `persisted`: no live session, no change to a concrete value, or the
 *     session already runs at the pick (say after a manual `/effort`). The
 *     override lands in the DB and the next manual spawn/resume picks it up via
 *     `prepare-spawn.ts`.
 *   - `restart`: a MODEL or EFFORT change to a concrete value. We `suspend`
 *     (NOT kill) so the agent's session file stays on disk for `--resume <id>`,
 *     then re-spawn with the new overrides as launch flags via the shared
 *     `restartSessionForSettingsChange` helper. Nothing is typed into the PTY,
 *     consistent with the column-transition and column-config-edit paths: a live
 *     `/model` swap left the agent paused after a Planning -> Executing handoff,
 *     and a mid-turn `/effort` writes nothing a verifier can confirm.
 *
 * The Command Terminal keeps its live `/model` / `/effort` swap through
 * `SESSION_INJECT_SETTINGS` (`transient-sessions.ts`): it has no task row and
 * nothing to `--resume`.
 *
 * Recovery contract (the user must never get stuck):
 *   - DB persist happens FIRST. Any downstream failure still leaves the
 *     user's choice captured for the next manual resume.
 *   - The restart path uses `suspend`, not `kill`, so `--resume` always
 *     remains valid.
 *   - On respawn failure, the session record stays in `suspended` state and
 *     the existing "Resume" UI affordance can re-spawn it (with whatever
 *     model/effort the user picks next).
 */
export function registerTaskRuntimeOverrideHandlers(context: IpcContext): void {
  ipcMain.handle(
    IPC.TASK_SET_RUNTIME_OVERRIDE,
    async (_, input: TaskSetRuntimeOverrideInput, projectIdArg?: string | null): Promise<TaskSetRuntimeOverrideResult> => {
      const { projectId, projectPath } = resolveProjectContext(context, projectIdArg);
      if (!projectId || !projectPath) {
        return { ok: false, reason: 'no project is currently open' };
      }

      return withTaskLock(input.taskId, async () => {
        const { tasks } = getProjectRepos(context, projectId);
        if (!tasks.getById(input.taskId)) return { ok: false, reason: 'task not found' };
        const { task } = reconcileTaskSessionRef(context, projectId, input.taskId);

        // Validate adapter resolution BEFORE persisting. If the task has no
        // agent or the agent is unknown, the override would never be applied
        // by any code path - persisting would just leave a stale value in the
        // DB. Pure read; no DB mutation has happened yet so the renderer's
        // optimistic UI update can roll back cleanly.
        //
        // Default-agent tasks never write the project default into `task.agent`
        // (it stays null), but their live session WAS spawned with a concrete
        // agent. Fall back to the live session's registry agent name so the
        // override applies instead of being rejected with "unknown agent
        // (none)". `getSessionAgentName` returns the registry key (e.g.
        // "claude"), not the adapter's `sessionType` ("claude_agent"), so it
        // can be passed straight to `agentRegistry.get`.
        const resolvedAgentName = task.agent
          ?? (task.session_id ? context.sessionManager.getSessionAgentName(task.session_id) ?? null : null);
        const adapter = resolvedAgentName ? agentRegistry.get(resolvedAgentName) : null;
        if (!adapter && task.session_id) {
          return { ok: false, reason: `unknown agent "${resolvedAgentName ?? '(none)'}"` };
        }

        // Persist before any PTY action. After this point, any downstream
        // failure (a suspend or respawn error) still leaves the user's choice
        // captured so the next manual resume picks it up via prepare-spawn. The
        // renderer treats `ok: false` after this point as "saved but not yet
        // live" rather than "discarded".
        tasks.updateOverrides(input.taskId, {
          model_override: input.model !== undefined ? input.model : task.model_override ?? null,
          effort_override: input.effort !== undefined ? input.effort : task.effort_override ?? null,
        });

        // A concrete pin detaches the task from its Board Profile
        // (`updateOverrides`), which can move the OTHER field's target too, so
        // a detach counts as a change to both.
        const profileDetached = task.profile_id != null && tasks.getById(input.taskId)?.profile_id == null;
        return applyTaskSettingsToLiveSession(context, projectId, projectPath, input.taskId, {
          model: input.model !== undefined || profileDetached,
          effort: input.effort !== undefined || profileDetached,
        });
      });
    },
  );
}
