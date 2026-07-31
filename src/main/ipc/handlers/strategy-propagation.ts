import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { agentRegistry } from '../../agent/agent-registry';
import { prepareInjectionPlan, resolveLiveEffort } from '../../transition-engine/injection-plan';
import { applyProfileToLane, findTaskProfile } from '../../transition-engine/column-strategy';
import { restartSessionForSettingsChange } from './session-reconcile';
import { reconcileAutoSpawnChange } from './auto-spawn-reconcile';
import { getProjectRepos } from '../helpers';
import { withTaskLock } from '../task-lifecycle-lock';
import { IPC } from '../../../shared/ipc-channels';
import type { BoardProfile, Swimlane, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * One task whose effective column strategy just changed, with the resolved
 * before/after so the caller does not have to know how the change was produced.
 */
export interface StrategyChange {
  task: Task;
  /** The task's effective lane BEFORE the edit, profile already folded. */
  before: Swimlane | null;
  /** The task's effective lane AFTER the edit, profile already folded. */
  after: Swimlane | null;
  /** Names the source of the change for log lines (a column or profile name). */
  sourceName: string;
}

/**
 * Push a settings change into tasks' LIVE sessions.
 *
 * Two edits can change what a running session should be using: editing a column
 * (`SWIMLANE_UPDATE`) and editing a Board Profile (`BOARD_CONFIG_SET_BOARD_PROFILES`).
 * They used to be one hand-written block in the swimlane handler, which meant a
 * profile edit reached in-flight sessions not at all - a task riding an edited
 * profile kept its old model until the user moved it out and back. Routing both
 * through here is the same reasoning as `spawn-entry-point-parity`: behavior that
 * must apply however the change was made belongs at one chokepoint.
 *
 * Suspended and queued sessions need no help - `prepare-spawn` re-reads the
 * effective strategy when they resume.
 *
 * THE GATE IS PER TASK, comparing the task's own resolved before/after rather
 * than the raw column's. That is what makes the column path correct for a
 * profiled task: editing a column's model must NOT push that model into a task
 * whose profile pins a different one for that column, and before this was
 * extracted the swimlane handler passed the raw lane and did exactly that.
 *
 * A MODEL change restarts the session (suspend + `--resume --model`) rather than
 * live-injecting `/model`, matching the column-transition and ContextBar paths.
 * An EFFORT change still swaps live.
 *
 * An `auto_spawn` change is reconciled here too, via `reconcileAutoSpawnChange`.
 * That one cannot ride the loop below: the loop bails on `!task.session_id`, so
 * it can only ever inject into or restart an EXISTING session, never create one.
 *
 * `projectId` is a required parameter rather than a read of
 * `context.currentProjectId` because the reconcile spawns and suspends. A
 * mis-targeted keystroke injection is cosmetic; a mis-targeted spawn is not.
 * Required, not optional, so a future caller cannot silently fall back to
 * ambient state.
 */
export function propagateStrategyToLiveSessions(
  context: IpcContext,
  label: string,
  changes: StrategyChange[],
  projectId: string | null,
): void {
  if (changes.length === 0) return;

  reconcileAutoSpawnChange(context, projectId, label, changes);

  const sessionRepo = projectId ? new SessionRepository(getProjectDb(projectId)) : null;
  const project = projectId ? context.projectRepo.getById(projectId) : null;
  // Tied to the resolved project rather than read from ambient state, so the
  // restart below cannot target a different project's checkout than the one the
  // records were loaded from.
  const projectPath = project?.path ?? null;
  // `getUsageCache()` rebuilds a plain object from the app-wide session map on
  // every call, so reading it per task would be O(tasks x live sessions across
  // ALL open projects). Nothing mutates it inside this synchronous loop, so one
  // snapshot serves the whole pass.
  const usageCacheSnapshot = context.sessionManager.getUsageCache();
  const usageCacheReader = { getUsageCache: () => usageCacheSnapshot };

  for (const { task, before, after, sourceName } of changes) {
    // Re-saving at a value the task already resolves to must inject nothing.
    // Gating here (not on each session's recorded `applied_*`) also protects
    // sessions whose `applied_*` is stale - e.g. NULL on a record predating
    // applied-settings recording - from a phantom delta and a needless restart.
    const overridesChanged = !!before && (
      before.model_override !== after?.model_override
      || before.effort_override !== after?.effort_override
    );
    if (!overridesChanged) continue;

    if (!task.session_id) continue;
    const session = context.sessionManager.getSession(task.session_id);
    if (!session || session.status !== 'running') continue;

    const adapter = task.agent ? agentRegistry.get(task.agent) : undefined;
    // No auto_command propagation on a settings edit - the intent is "change
    // settings", not "re-run any auto trigger".
    // Same source of truth as a column move, so the two paths cannot disagree
    // about what the session is running at. Also drops a redundant injection:
    // editing a column from low to high on a session the user already switched
    // to high by hand currently re-injects `/effort high` for nothing.
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo,
      task,
      toLane: after,
      project,
      liveEffort: resolveLiveEffort(usageCacheReader, task.session_id),
    });
    if (!plan) continue;

    if (plan.needsRestartForModel) {
      if (!projectId || !projectPath) {
        console.warn(
          `[${label}] Skipping model-change restart for task ${task.id.slice(0, 8)}`
          + ` from "${sourceName}": no resolved project context.`,
        );
        continue;
      }
      // Backgrounded so the save stays responsive (the session updates the UI
      // via session-changed events); per-task locked so it cannot race a drag.
      const taskId = task.id;
      void withTaskLock(taskId, async () => {
        const restart = await restartSessionForSettingsChange(context, projectId, projectPath, taskId);
        if (!restart.ok) {
          console.warn(
            `[${label}] Could not restart session for task ${taskId.slice(0, 8)}`
            + ` after model change from "${sourceName}": ${restart.reason}`,
          );
          return;
        }
        // The restart respawned the task with a new session_id; the board store
        // still holds the pre-restart id until it reloads. Push a quiet
        // (toast-free) re-sync, distinct from TASK_UPDATED_BY_AGENT, since this
        // followed the user's own edit rather than an agent-driven change.
        if (!context.mainWindow.isDestroyed()) {
          context.mainWindow.webContents.send(IPC.TASK_SESSION_RESYNC, projectId);
        }
      });
      continue;
    }

    context.terminalSubmitScheduler.scheduleKeystrokes(task.id, task.session_id, plan.sequence, {
      verifier: plan.verifier,
      verifiedPrefixLength: plan.verifiedPrefixLength,
    });
    // Record the new running value so a later column move does not re-inject.
    if (plan.appliedSettings && sessionRepo) {
      sessionRepo.updateAppliedSettings(task.session_id, plan.appliedSettings);
    }
    console.log(
      `[${label}] Propagating ${plan.sequence.length} setting(s) to active session for task ${task.id.slice(0, 8)}`
      + ` from "${sourceName}"${plan.verifier ? ' (with command verification)' : ''}: ${plan.sequence.join(' | ')}`,
    );
  }
}

/**
 * Build the per-task before/after for a COLUMN edit, folding each task's Board
 * Profile over both sides.
 *
 * Shared by every column writer (the `SWIMLANE_UPDATE` handler and the MCP
 * `update_column` tool) so they cannot disagree about what changed for a task.
 * The MCP path used to propagate nothing at all, not even model/effort.
 */
export function buildColumnStrategyChanges(input: {
  context: IpcContext;
  projectId: string | null;
  /** Undefined when the row could not be re-read; treated the same as null. */
  before: Swimlane | null | undefined;
  after: Swimlane;
}): StrategyChange[] {
  // Bail rather than let `getProjectRepos` fall back to the ambient project.
  // With no resolved project there is nothing to propagate OR reconcile, and an
  // ambient fallback here would be the exact mis-targeting the explicit
  // projectId exists to prevent.
  if (!input.projectId) return [];
  const { swimlanes, tasks } = getProjectRepos(input.context, input.projectId);
  const boardProfiles = input.context.boardConfigManager.getBoardProfiles();
  const laneList = swimlanes.list();

  return tasks.list(input.after.id).map((task) => {
    const profile = findTaskProfile({ profiles: boardProfiles, profileId: task.profile_id, taskId: task.id });
    return {
      task,
      before: applyProfileToLane(input.before, profile, laneList),
      after: applyProfileToLane(input.after, profile, laneList),
      sourceName: input.after.name,
    };
  });
}

/**
 * Push a Board Profile rewrite into the live sessions of the tasks riding it.
 *
 * Shared by both profile writers - the Board Manager's save
 * (`BOARD_CONFIG_SET_BOARD_PROFILES`) and the MCP profile tools - so an agent
 * retuning a profile and a human retuning it behave identically. Call it AFTER
 * the write, with the profile list captured before it.
 *
 * Only profile-riding tasks are considered: a task on Default resolves to its
 * column's own settings, which a profile write cannot change.
 *
 * `auto_spawn` is profile-scoped too, so a profile that flips it reconciles the
 * same way a column edit does - which is exactly what this shared chokepoint
 * exists to guarantee.
 */
export function propagateBoardProfileChange(
  context: IpcContext,
  previousProfiles: ReadonlyArray<BoardProfile>,
  nextProfiles: ReadonlyArray<BoardProfile>,
  projectId: string | null,
): void {
  // Bail rather than let `getProjectRepos` fall back to the ambient project,
  // exactly as `buildColumnStrategyChanges` does: this path now reconciles
  // auto_spawn, so an ambient fallback could spawn or suspend against a project
  // whose profiles were never edited.
  if (!projectId) return;
  const { swimlanes, tasks } = getProjectRepos(context, projectId);
  const laneList = swimlanes.list();
  const laneById = new Map(laneList.map((lane) => [lane.id, lane]));

  propagateStrategyToLiveSessions(
    context,
    'BOARD_PROFILES',
    tasks.list()
      .filter((task) => task.profile_id)
      .map((task) => {
        const lane = laneById.get(task.swimlane_id) ?? null;
        const beforeProfile = findTaskProfile({ profiles: previousProfiles, profileId: task.profile_id, taskId: task.id });
        const afterProfile = findTaskProfile({ profiles: nextProfiles, profileId: task.profile_id, taskId: task.id });
        return {
          task,
          before: applyProfileToLane(lane, beforeProfile, laneList),
          after: applyProfileToLane(lane, afterProfile, laneList),
          sourceName: afterProfile?.name ?? beforeProfile?.name ?? 'profile',
        };
      }),
    projectId,
  );
}
