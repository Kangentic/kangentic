/**
 * Start (spawn or resume) a task's session in the column it is already in.
 *
 * The bridge twin of the desktop's Resume button, reached today from the
 * phone's `start-session` verb (`mobile-bridge/handlers/start-session.ts`).
 * The phone's "Session ended" state has no other way back: `move-task` is
 * the protocol's only other lifecycle verb, and a same-column move only
 * repositions.
 *
 * Why this routes through `autoSpawnForTask` -> `spawnAgent` and not the
 * engine call `SESSION_RESUME` makes: the column's enter automations, and
 * with them the column message, run only inside `spawnAgent`
 * (`engine.executeTransition(task, toLane, 'enter', ...)`). `SESSION_RESUME`
 * resumes idle with the column's model / effort / permission and nothing
 * else. So a start here does what a MOVE INTO the column does for the
 * session, minus the move, and a start re-runs that column's whole enter
 * list. `autoSpawnForTask` already owns the lock, the worktree, the branch
 * checkout, the profile fold, the engine, the progress label, and the
 * spawn-blocked notice, and it re-checks the column under its own lock.
 */
import { withTaskLock } from '../task-lifecycle-lock';
import { getProjectRepos } from '../helpers/project-repos';
import { autoSpawnForTask } from '../helpers/agent-spawn';
import { reconcileTaskSessionRef } from './session-reconcile';
import { resumeBlockMessage, resumeBlockReason } from '../../../shared/session-resume-eligibility';
import type { IpcContext } from '../ipc-context';

export type StartTaskSessionResult =
  /** The task already has a live session. Nothing was spawned. */
  | { outcome: 'live' }
  /**
   * The start was accepted; the worktree, checkout, and spawn run behind
   * this result. `settled` resolves when `autoSpawnForTask` returns. That
   * function swallows and reports its own failures (log, Sentry counter,
   * desktop spawn-blocked notice), so `settled` rejecting is unexpected, but
   * a caller that does not await it must still attach a handler.
   */
  | { outcome: 'starting'; settled: Promise<void> };

/**
 * Refuses a To Do or Done column and an archived task with the same copy the
 * desktop's Resume shows (`resumeBlockMessage`), by throwing it. Returns
 * `'live'` without spawning when a session is already running: the phone's
 * "ended" view can be stale, and handing back nothing new is the correct,
 * idempotent answer.
 *
 * Phase 1 runs under the task lock because `reconcileTaskSessionRef` writes:
 * a natural agent exit leaves `task.session_id` pointing at an exited
 * registry row, and `spawnAgent`'s `startAgent` bails on any `session_id`, so
 * without the reconcile a start would run the enter list and then spawn
 * nothing. The lock is released before `autoSpawnForTask`, which takes its
 * own (`withTaskLock` is not reentrant) and re-checks that the task is still
 * in this column. A task moved to Done in that gap passes this gate and then
 * returns silently inside `spawnAgent`'s role check after the caller was
 * already told `starting`. That is the drag path's outcome too, and the
 * re-check is `autoSpawnForTask`'s job, not this function's.
 *
 * There is deliberately no `abortInFlightResume` here. A phone tap must
 * never cancel desktop work, and a desktop resume in flight converges on its
 * own: both paths reconcile under the lock, whichever spawns first wins, and
 * the other either returns the live session or delivers the column message
 * to it.
 */
export async function startTaskSession(
  context: IpcContext,
  projectId: string,
  taskId: string,
): Promise<StartTaskSessionResult> {
  const accepted = await withTaskLock(taskId, async () => {
    const { task, liveSession } = reconcileTaskSessionRef(context, projectId, taskId);
    if (liveSession) return { outcome: 'live' as const };

    const { swimlanes } = getProjectRepos(context, projectId);
    const lane = swimlanes.getById(task.swimlane_id);
    // Truthiness, not `!== null`: a Task assembled without the column carries
    // `undefined` in `archived_at`, which `!== null` would read as archived.
    const blocked = resumeBlockReason({ laneRole: lane?.role, isArchived: Boolean(task.archived_at) });
    if (blocked) throw new Error(resumeBlockMessage(blocked));
    if (!lane) throw new Error(`Column ${task.swimlane_id} not found for task ${taskId}`);

    return { outcome: 'starting' as const, task: { id: task.id, title: task.title }, laneId: lane.id };
  });

  if (accepted.outcome === 'live') return { outcome: 'live' };

  const settled = autoSpawnForTask(context, projectId, accepted.task, accepted.laneId, { explicitStart: true });
  return { outcome: 'starting', settled };
}
