import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { withTaskLock } from '../task-lifecycle-lock';
import { agentRegistry } from '../../agent/agent-registry';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos } from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import { restartSessionForSettingsChange } from './session-reconcile';
import { buildCommandInjectionVerifier } from '../../transition-engine/injection-plan';
import type { SettingsChangeSpec } from '../../agent/agent-adapter';
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
 * Three apply paths, picked by what changed and the adapter's capability:
 *   - `persisted`: no live session. The override lands in the DB and the
 *     next manual spawn/resume picks it up via `prepare-spawn.ts`.
 *   - `live`: an EFFORT change on an adapter that implements
 *     `getInjectionSequence` (e.g. Claude returns `/effort Y`). The slash is
 *     scheduled into the running PTY with the adapter's command-injection verifier.
 *   - `restart`: a MODEL change (always), or an effort change on an adapter with
 *     no live-switch slash. We `suspend` (NOT kill) so the agent's session file
 *     stays on disk for `--resume <id>`, then re-spawn with the new overrides via
 *     the shared `restartSessionForSettingsChange` helper. A model change
 *     pauses + resumes for consistency with the column-transition and
 *     column-config-edit paths (a live `/model` swap left the agent paused after
 *     a Planning -> Executing handoff).
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
        const task = tasks.getById(input.taskId);
        if (!task) return { ok: false, reason: 'task not found' };

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

        // Resolve effective values for the SettingsChangeSpec. The user's
        // intent is "what model/effort should this task USE", not "what's the
        // raw override row" - so when they pick "Use column default" we must
        // resolve through to the swimlane's override before asking the
        // adapter for a slash sequence. Without this, clearing a per-task
        // model on a column with `model_override='opus'` would send
        // `{ model: null, modelChanged: true }` to Claude, whose
        // getInjectionSequence skips on null and forces a restart even
        // though `/model opus` would have worked live.
        const lane = swimlanes.getById(task.swimlane_id);
        const swimlaneModel = lane?.model_override ?? null;
        const swimlaneEffort = lane?.effort_override ?? null;

        const oldOverrideModel = task.model_override ?? null;
        const oldOverrideEffort = task.effort_override ?? null;
        const newOverrideModel = input.model !== undefined ? input.model : oldOverrideModel;
        const newOverrideEffort = input.effort !== undefined ? input.effort : oldOverrideEffort;

        const oldEffectiveModel = oldOverrideModel ?? swimlaneModel;
        const newEffectiveModel = newOverrideModel ?? swimlaneModel;
        const oldEffectiveEffort = oldOverrideEffort ?? swimlaneEffort;
        const newEffectiveEffort = newOverrideEffort ?? swimlaneEffort;

        // Persist before any PTY action. After this point, any downstream
        // failure (live-inject schedule miss, respawn error) still leaves the
        // user's choice captured so the next manual resume picks it up via
        // prepare-spawn. The renderer treats `ok: false` after this point as
        // "saved but not yet live" rather than "discarded".
        tasks.updateOverrides(input.taskId, {
          model_override: newOverrideModel,
          effort_override: newOverrideEffort,
        });

        // No live PTY (or no resolvable adapter) -> nothing to apply
        // beyond the DB write. The earlier `unknown agent` guard already
        // ensured we never reach this point with a non-null session and a
        // null adapter, but the `!adapter` term here is load-bearing for
        // TypeScript narrowing on the downstream `buildCommandInjectionVerifier`
        // and `adapter.getInjectionSequence` call sites.
        if (!task.session_id || !adapter) return { ok: true, mode: 'persisted' };

        const spec: SettingsChangeSpec = {
          model: newEffectiveModel,
          modelChanged: oldEffectiveModel !== newEffectiveModel,
          effort: newEffectiveEffort,
          effortChanged: oldEffectiveEffort !== newEffectiveEffort,
        };

        // No-op delta: nothing to do beyond the DB write. (e.g. user picked a
        // value identical to the swimlane default that was already active.)
        if (!spec.modelChanged && !spec.effortChanged) {
          return { ok: true, mode: 'persisted' };
        }

        // A MODEL change pauses + resumes (suspend + `--resume --model`), never a
        // live `/model` swap - consistent with the column-transition and
        // column-config-edit paths. (A live mid-session model switch left the
        // agent paused after a Planning -> Executing handoff.) A concrete target
        // only: clearing the model to "use default" (newEffectiveModel === null)
        // has no `--model` to set and `--resume` preserves the current model, so
        // restarting would churn for nothing.
        const restartForModel = spec.modelChanged && newEffectiveModel !== null;

        if (!restartForModel) {
          // Effort-only change (or a model cleared to default, which emits no
          // `/model`). Live-inject `/effort` when the adapter supports it.
          const sequence = adapter.getInjectionSequence?.(spec) ?? [];
          if (sequence.length > 0) {
            // Live-switch path. Verifier confirms each slash command was parsed
            // by the agent (defends against Enter-key races concatenating
            // commands). Shares the wrapper with prepareInjectionPlan so both
            // the column-transition burst and the user-driven popover use the
            // same SubmissionVerifier-to-CommandVerifier adapter.
            const sessionRepo = new SessionRepository(getProjectDb(projectId));
            const verifier = buildCommandInjectionVerifier(adapter, sessionRepo, task.id);
            context.terminalSubmitScheduler.scheduleKeystrokes(
              input.taskId,
              task.session_id,
              sequence,
              { verifier, verifiedPrefixLength: sequence.length },
            );
            // Record the session's new running effort (concrete change only) so a
            // later column move diffs against it instead of re-injecting. Model is
            // never live-applied here (it restarts).
            sessionRepo.updateAppliedSettings(task.session_id, {
              ...(spec.effortChanged && spec.effort !== null ? { effort: spec.effort } : {}),
            });
            return { ok: true, mode: 'live' };
          }

          // Empty injection sequence with no concrete effort target to apply
          // (e.g. user clicked "Use column default" on a column that has no
          // override of its own). Restarting the PTY here would just kill the
          // session for no reason - there's no `--effort` flag to set on a
          // respawn either. The next spawn naturally uses the agent default
          // because prepare-spawn passes `undefined` when both task and swimlane
          // are null. Just persist and leave the live session alone.
          const restartNeededForEffort = spec.effortChanged && newEffectiveEffort !== null;
          if (!restartNeededForEffort) {
            return { ok: true, mode: 'persisted' };
          }
        }

        // Restart path: a model change (always), or an effort change on an
        // adapter with no live `/effort` swap and a concrete target. Suspend +
        // respawn so the new model/effort reach the CLI as spawn flags. The shared
        // helper resumes idle (no auto_command, no continuation) and keeps
        // `--resume` viable, so a respawn failure leaves the record `suspended`
        // for the existing "Resume" UI to retry.
        const result = await restartSessionForSettingsChange(
          context, projectId, projectPath, input.taskId,
        );
        return result.ok
          ? { ok: true, mode: 'restart' }
          : { ok: false, reason: result.reason };
      });
    },
  );
}
