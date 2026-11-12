/**
 * Resume a task the idle timeout paused, because the user opened it. Opening is
 * the whole gesture: no click on Resume and no wait, so a pause Kangentic made
 * costs the user nothing. Only the opening does it. A pause landing on a window
 * already open does not, or a focused window would resume, idle and pause in a
 * loop all night, and neither does a restart restoring a window.
 *
 * It only ever does what costs no tokens. A resume that would send the agent a
 * message is a paid turn nobody asked for, so a card that needs one keeps its
 * Resume button: a column's message for a card moved while paused, the prompt a
 * launch that never ran still owes, or a fresh start because the conversation
 * never began or the agent deleted it (`SpawnOverrides.resumeOnly`, which only
 * the engine can tell, after the git phase, so a decline is remembered and asked
 * once). Held messages do not stop it: they wait for the agent to end a turn
 * (`deferHeldUntilTurnEnd`).
 *
 * The user's own Pause stays paused, and so does a task in a paused workflow: a
 * workflow's Pause is its one stop, and a member the idle timeout paused first
 * never reached that Pause, so its record still reads `'auto'`.
 *
 * The rest of the resume is the Resume button's own path (`resumeTaskSession`),
 * so a full column queues it and the task window says why.
 */
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos, notifySpawnBlocked } from '../helpers';
import { workflowOfTask } from '../../workflows/workflow-home';
import { isUnderWorkflowRecovery } from '../../workflows/workflow-recovery-state';
import { resumeBlockReasonForTask } from '../../../shared/session-resume-eligibility';
import { columnEnteredWhilePaused, resumeTaskSession } from './session-resume';
import { isResumeInFlight } from './session-resume-controllers';
import type { LaunchStartPath, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Records whose resume the engine declined. What it read holds for as long as the
 * record stands, so a later open skips the git phase, the CLI checks and the
 * Resuming label to reach the same answer. A Resume retires the record. In memory:
 * a restart asks once more.
 */
const declinedRecordIds = new Set<string>();

/** Whether a workflow's Pause holds this task. Unreadable reads as held: nobody asked for this start. */
function isHeldByWorkflow(task: Task, projectId: string): boolean {
  try {
    return workflowOfTask(task, projectId)?.state === 'paused';
  } catch (error) {
    console.warn(`[SESSION_RESUME] Could not read the workflow of task ${task.id.slice(0, 8)}:`, error);
    return true;
  }
}

/** Whether opening this task resumes it. A read: most opens end here. */
function isPlainIdleResume(context: IpcContext, projectId: string, task: Task): boolean {
  const { swimlanes } = getProjectRepos(context, projectId);
  const laneRole = swimlanes.getById(task.swimlane_id)?.role;
  if (resumeBlockReasonForTask({ task, laneRole })) return false;

  const db = getProjectDb(projectId);
  const sessionRepo = new SessionRepository(db);
  const latest = sessionRepo.getLatestForTask(task.id);
  if (latest?.status !== 'suspended' || latest.suspended_by !== 'auto') return false;
  if (latest.launch_failed_at || declinedRecordIds.has(latest.id)) return false;
  if (columnEnteredWhilePaused(db, sessionRepo, task)) return false;
  if (isUnderWorkflowRecovery(task.id)) return false;
  return !isHeldByWorkflow(task, projectId);
}

/**
 * What an open did, decided before any git work:
 *
 * - `not-eligible`: nothing, because the task is not one an open resumes (most
 *   opens), or the resume's own locked check found it no longer is.
 * - `live`: the task already has a running agent.
 * - `starting`: a resume is under way, this one or one already in flight. The
 *   engine can still decline it after the git phase (`resumeOnly`), which leaves
 *   the task paused behind its Resume button.
 */
export type OpenResumeOutcome = 'not-eligible' | 'live' | 'starting';

export interface ResumeOnOpenOptions {
  /** Where the open came from, for the launch report. The desktop's own is `'open'`. */
  startPath?: LaunchStartPath;
  /**
   * Called once, as soon as the outcome is known: for an accepted resume,
   * before its git phase. For a caller with a short answer budget, a phone's
   * open, which answers then and leaves the slow part running.
   */
  onDecided?: (outcome: OpenResumeOutcome) => void;
}

/**
 * Never rejects: the user opened a task, and nothing here is theirs to answer. A
 * resume that fails after it started shows the spawn-blocked notice. Resolves
 * with the outcome once the work is done; `onDecided` hears it sooner.
 */
export async function resumeTaskOnOpen(
  context: IpcContext,
  taskId: string,
  projectId?: string | null,
  options: ResumeOnOpenOptions = {},
): Promise<OpenResumeOutcome> {
  const startPath = options.startPath ?? 'open';
  let decided: OpenResumeOutcome | null = null;
  const decide = (outcome: OpenResumeOutcome): OpenResumeOutcome => {
    if (decided === null) {
      decided = outcome;
      try {
        options.onDecided?.(outcome);
      } catch (hookError) {
        console.warn('[SESSION_RESUME] onDecided hook threw:', hookError);
      }
    }
    return decided;
  };

  const resolvedProjectId = projectId ?? context.currentProjectId;
  if (!resolvedProjectId) return decide('not-eligible');
  try {
    const task = getProjectRepos(context, resolvedProjectId).tasks.getById(taskId);
    if (!task || !isPlainIdleResume(context, resolvedProjectId, task)) return decide('not-eligible');
    // Ahead of `resumeTaskSession`, which cancels whatever is in flight: a Resume
    // click carrying a prompt, a workflow's Resume, the launch retry. That one is
    // already bringing the agent back, so the open reads as starting.
    if (isResumeInFlight(taskId)) return decide('starting');
    await resumeTaskSession(context, taskId, {
      projectId: resolvedProjectId,
      startPath,
      onAccepted: (acceptance) => decide(acceptance === 'live' ? 'live' : 'starting'),
      plainResume: {
        stillEligible: (current) => isPlainIdleResume(context, resolvedProjectId, current),
        onDeclined: () => {
          const declined = new SessionRepository(getProjectDb(resolvedProjectId)).getLatestForTask(taskId);
          if (declined) declinedRecordIds.add(declined.id);
        },
      },
      onFailed: (step, error, failedTask) => notifySpawnBlocked(context, failedTask, step, error, resolvedProjectId, startPath),
    });
  } catch (error) {
    console.warn(`[SESSION_RESUME] Task ${taskId.slice(0, 8)} did not resume on open:`, error);
  }
  // A resume that ended without accepting (its locked check found the task no
  // longer eligible, a Pause cancelled it, or it was refused) did nothing.
  return decide('not-eligible');
}

/** Test-only: forget every declined record. */
export function resetDeclinedOpensForTests(): void {
  declinedRecordIds.clear();
}
