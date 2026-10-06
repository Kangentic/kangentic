/**
 * Start (resume or spawn) a task's session in the column it is already in,
 * for the phone's `start-session` verb (`mobile-bridge/handlers/start-session.ts`).
 * The phone has no other way back to a working agent: `move-task` is the
 * protocol's only other lifecycle verb, and a same-column move only
 * repositions.
 *
 * Two paths, chosen by the task's session under the task lock:
 *
 * - **Paused (a `suspended` registry row): the desktop Resume button's path.**
 *   `resumeTaskSession` (`session-resume.ts`) is the very function the
 *   `SESSION_RESUME` handler calls: the same lock, reconcile, eligibility
 *   gate, worktree ensure, "Resuming session..." label, and engine resume. It
 *   runs NO enter automations and delivers no column message, so a phone
 *   Resume on a paused task in Code Review does not send `/code-review` again,
 *   exactly as the desktop's Resume does not. It also cancels a resume already
 *   in flight for the task, as a second desktop Resume click does: a phone
 *   Resume mirrors the desktop one. This is the case the read-stream feed's
 *   `resumable` flag promises the phone.
 * - **No session, or an exited one: a start.** `autoSpawnForTask` ->
 *   `spawnAgent` with `explicitStart: true`, which does what a MOVE INTO the
 *   column does for the session, minus the move: the column's whole enter
 *   list runs, column message included. That is the phone's "Session ended"
 *   path. `autoSpawnForTask` owns the lock, the worktree, the branch checkout,
 *   the profile fold, the engine, the progress label, and the spawn-blocked
 *   notice, and re-checks the column under its own lock. It registers
 *   alongside any resume in flight rather than cancelling it: there is no
 *   desktop action this start mirrors, so it never takes work away from one.
 */
import { withTaskLock } from '../task-lifecycle-lock';
import { getProjectRepos } from '../helpers/project-repos';
import { autoSpawnForTask } from '../helpers/agent-spawn';
import { notifySpawnBlocked } from '../helpers/task-git';
import { reconcileTaskSessionRef } from './session-reconcile';
import { resumeTaskSession, type ResumeAcceptance } from './session-resume';
import { pausedTaskIdsOf, resumeBlockMessage, resumeBlockReasonForTask } from '../../../shared/session-resume-eligibility';
import type { IpcContext } from '../ipc-context';

export type StartTaskSessionResult =
  /** The task already has a live session. Nothing was spawned. */
  | { outcome: 'live' }
  /**
   * The start was accepted; the worktree, checkout, and spawn or resume run
   * behind this result. `settled` resolves when that work finishes. Both paths
   * report their own failures desktop-side with the spawn-blocked notice
   * (`autoSpawnForTask` itself; the resume through its `onFailed` hook), so
   * `settled` rejecting is possible (a resume's failure still rejects) but
   * must not escape: a caller that does not await it must still attach a
   * handler.
   */
  | { outcome: 'starting'; settled: Promise<void> };

/**
 * Refuses a To Do or Done column and an archived task with the same copy the
 * desktop's Resume shows (`resumeBlockMessage`), by throwing it. Returns
 * `'live'` without spawning when a session is already running: the phone's
 * view can be stale, and handing back nothing new is the correct, idempotent
 * answer.
 *
 * The decision runs under the task lock because `reconcileTaskSessionRef`
 * writes: a natural agent exit leaves `task.session_id` pointing at an exited
 * registry row, and `spawnAgent`'s `startAgent` bails on any `session_id`, so
 * without the reconcile a start would run the enter list and then spawn
 * nothing. The lock is released before either path runs, since each takes its
 * own (`withTaskLock` is not reentrant) and re-checks. A task moved to Done in
 * that gap reaches the two paths differently. A start passes this gate and
 * then stops silently inside `spawnAgent`'s role check after the caller was
 * already told `starting`, which is the drag path's outcome too. A resume
 * re-gates in its own Phase 1 before it accepts, so the phone gets the
 * desktop's Resume copy as ok:false instead.
 */
export async function startTaskSession(
  context: IpcContext,
  projectId: string,
  taskId: string,
): Promise<StartTaskSessionResult> {
  const decision = await withTaskLock(taskId, async () => {
    const { task, liveSession } = reconcileTaskSessionRef(context, projectId, taskId);
    if (liveSession) return { path: 'live' as const };

    const { swimlanes } = getProjectRepos(context, projectId);
    const lane = swimlanes.getById(task.swimlane_id);
    const blocked = resumeBlockReasonForTask({ task, laneRole: lane?.role });
    if (blocked) throw new Error(resumeBlockMessage(blocked));

    // The same scan read-board's `resumable` runs, so the flag that promises
    // the phone this path and the choice of it cannot disagree. A suspended row
    // survives reconcileTaskSessionRef, which clears only the task's pointer.
    if (pausedTaskIdsOf(context.sessionManager.listSessions()).has(taskId)) return { path: 'resume' as const };

    if (!lane) throw new Error(`Column ${task.swimlane_id} not found for task ${taskId}`);
    return { path: 'start' as const, task: { id: task.id, title: task.title }, laneId: lane.id };
  });

  if (decision.path === 'live') return { outcome: 'live' };

  if (decision.path === 'start') {
    const settled = autoSpawnForTask(context, projectId, decision.task, decision.laneId, { explicitStart: true });
    return { outcome: 'starting', settled };
  }

  // The resume answers on acceptance, the moment its own Phase 1 has decided,
  // and runs the git phase and the engine resume behind the answer. Its Phase 1
  // re-reads under the lock, so a session that went live in the gap since the
  // decision above is reported as `live` and nothing spawns.
  const { promise: accepted, resolve: onAccepted } = Promise.withResolvers<ResumeAcceptance>();
  const resumed = resumeTaskSession(context, taskId, {
    projectId,
    onAccepted,
    // The phone was answered before this work ran, so no rejection reaches a
    // toast. The desktop's spawn-blocked notice is how a failed phone Resume
    // shows, as a failed phone Start does through autoSpawnForTask.
    onFailed: (step, error, task) => notifySpawnBlocked(context, task, step, error, projectId),
  });
  // A refusal in the resume's Phase 1 rejects before acceptance and reaches
  // the phone as ok:false, as the decision's own refusals do.
  const acceptance = await Promise.race([accepted, resumed.then(() => null)]);
  if (acceptance === 'live') return { outcome: 'live' };
  return { outcome: 'starting', settled: resumed.then(() => undefined) };
}
