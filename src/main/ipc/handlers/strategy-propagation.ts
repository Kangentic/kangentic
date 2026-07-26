import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { agentRegistry } from '../../agent/agent-registry';
import { prepareInjectionPlan } from '../../transition-engine/injection-plan';
import { applyProfileToLane, findTaskProfile } from '../../transition-engine/column-strategy';
import { restartSessionForSettingsChange } from './session-reconcile';
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
 */
export function propagateStrategyToLiveSessions(
  context: IpcContext,
  label: string,
  changes: StrategyChange[],
): void {
  if (changes.length === 0) return;

  const projectId = context.currentProjectId;
  const projectPath = context.currentProjectPath;
  const sessionRepo = projectId ? new SessionRepository(getProjectDb(projectId)) : null;
  const project = projectId ? context.projectRepo.getById(projectId) : null;

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
    const plan = prepareInjectionPlan({ adapter, sessionRepo, task, toLane: after, project });
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
 * Push a Board Profile rewrite into the live sessions of the tasks riding it.
 *
 * Shared by both profile writers - the Board Manager's save
 * (`BOARD_CONFIG_SET_BOARD_PROFILES`) and the MCP profile tools - so an agent
 * retuning a profile and a human retuning it behave identically. Call it AFTER
 * the write, with the profile list captured before it.
 *
 * Only profile-riding tasks are considered: a task on Default resolves to its
 * column's own settings, which a profile write cannot change.
 */
export function propagateBoardProfileChange(
  context: IpcContext,
  previousProfiles: ReadonlyArray<BoardProfile>,
  nextProfiles: ReadonlyArray<BoardProfile>,
): void {
  const { swimlanes, tasks } = getProjectRepos(context);
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
  );
}
