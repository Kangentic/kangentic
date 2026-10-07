import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { withTaskLock } from '../task-lifecycle-lock';
import { agentRegistry } from '../../agent/agent-registry';
import { getProjectRepos } from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import { applyProfileToLane } from '../../transition-engine/column-strategy';
import { loadTaskProfile } from '../helpers/task-profile';
import { reconcileTaskSessionRef, restartSessionForSettingsChange } from './session-reconcile';
import { resolveRestartReason, restartPhaseFor } from '../../transition-engine/injection-plan';
import { projectModelDefaultsApply } from '../../transition-engine/spawn-preamble';
import { DEFAULT_AGENT } from '../../../shared/types';
import type {
  TaskSetRuntimeOverrideInput,
  TaskSetRuntimeOverrideResult,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Handler for `IPC.TASK_SET_RUNTIME_OVERRIDE`. Persists the per-task model
 * and/or effort override and applies the change to the live PTY session if
 * one exists.
 *
 * Two apply paths, picked by what changed:
 *   - `persisted`: no live session, or no change to a concrete value. The
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
        const { tasks, swimlanes } = getProjectRepos(context, projectId);
        if (!tasks.getById(input.taskId)) return { ok: false, reason: 'task not found' };
        // The pointer this handler acts on, reconciled against the registry
        // as SESSION_RESUME and the task move are. On the raw pointer, a task
        // whose CLI had ended by itself still read as live here: a model pick
        // then suspended a dead session and respawned it, and an effort pick
        // scheduled keystrokes into a PTY that was gone. With the pointer
        // cleared both land on the `persisted` branch below, which is what a
        // task with no live agent should get: the override is picked up at
        // its next spawn.
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

        // Resolve effective values. The user's intent is "what model/effort
        // should this task USE", not "what's the raw override row" - so when
        // they pick "Use column default" we must resolve through to the
        // swimlane's override before deciding whether anything changed.
        // Without this, clearing a per-task model on a column with
        // `model_override='opus'` would read as a change to null (no restart)
        // even though the session must now run opus.
        // Folded through the task's Board Profile: "use column default" must
        // resolve to the rung the task actually runs on for this column, not the
        // column's base pin, or the restart applies a model the task was never
        // going to use.
        const lane = applyProfileToLane(
          swimlanes.getById(task.swimlane_id),
          loadTaskProfile(context, task, projectPath),
        );
        const swimlaneModel = lane?.model_override ?? null;
        const swimlaneEffort = lane?.effort_override ?? null;
        const project = context.projectRepo.getById(projectId);
        // The project tier applies only when the task runs the project's default
        // agent, the same gate the respawn's `resolveSpawnOverrides` applies.
        // Without it, a task on another agent read the project default as its
        // effective value and restarted for a model or effort the respawn
        // never passes.
        const projectDefaultsApply = projectModelDefaultsApply(
          task.agent_override ?? lane?.agent_override ?? project?.default_agent ?? DEFAULT_AGENT,
          project?.default_agent,
        );
        const projectDefaultModel = projectDefaultsApply ? project?.default_model ?? null : null;
        const projectDefaultEffort = projectDefaultsApply ? project?.default_effort ?? null : null;

        const oldOverrideModel = task.model_override ?? null;
        const oldOverrideEffort = task.effort_override ?? null;
        const newOverrideModel = input.model !== undefined ? input.model : oldOverrideModel;
        const newOverrideEffort = input.effort !== undefined ? input.effort : oldOverrideEffort;

        const oldEffectiveModel = oldOverrideModel ?? swimlaneModel ?? projectDefaultModel;
        const newEffectiveModel = newOverrideModel ?? swimlaneModel ?? projectDefaultModel;
        const oldEffectiveEffort = oldOverrideEffort ?? swimlaneEffort ?? projectDefaultEffort;
        const newEffectiveEffort = newOverrideEffort ?? swimlaneEffort ?? projectDefaultEffort;

        // Persist before any PTY action. After this point, any downstream
        // failure (a suspend or respawn error) still leaves the
        // user's choice captured so the next manual resume picks it up via
        // prepare-spawn. The renderer treats `ok: false` after this point as
        // "saved but not yet live" rather than "discarded".
        tasks.updateOverrides(input.taskId, {
          model_override: newOverrideModel,
          effort_override: newOverrideEffort,
        });

        // No live PTY -> nothing to apply beyond the DB write. The earlier
        // `unknown agent` guard already returned for a live session with no
        // adapter.
        if (!task.session_id) return { ok: true, mode: 'persisted' };

        // Only a change to a CONCRETE value restarts. Clearing a field to "use
        // default" with nothing below it (the effective value becomes null) has
        // no `--model` / `--effort` to set, and `--resume` keeps whatever the
        // session runs at, so restarting would churn for nothing. The next
        // spawn naturally uses the agent default because prepare-spawn passes
        // `undefined` when both task and swimlane are null. The same holds when
        // the user picked a value identical to the one already active. Same rule
        // a column move applies (`resolveRestartReason`).
        const restartReason = resolveRestartReason({
          sourceModel: oldEffectiveModel,
          targetModel: newEffectiveModel,
          sourceEffort: oldEffectiveEffort,
          targetEffort: newEffectiveEffort,
        });
        if (!restartReason) {
          return { ok: true, mode: 'persisted' };
        }

        // Restart path: suspend + respawn so the new model/effort reach the CLI
        // as launch flags. The shared helper resumes idle (no auto_command, no
        // continuation), so an in-flight turn stops, and it keeps `--resume`
        // viable, so a respawn failure leaves the record `suspended` for the
        // existing "Resume" UI to retry.
        const result = await restartSessionForSettingsChange(
          context, projectId, projectPath, input.taskId,
          { phase: restartPhaseFor(restartReason) },
        );
        return result.ok
          ? { ok: true, mode: 'restart' }
          : { ok: false, reason: result.reason };
      });
    },
  );
}
