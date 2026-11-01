/**
 * Pause a task's live session: the desktop Pause button's whole path, shared
 * by its IPC handler (`SESSION_SUSPEND` in `sessions.ts`), the phone's
 * `pause-session` verb (`mobile-bridge/handlers/pause-session.ts`), and the
 * two pauses Kangentic makes on its own (the idle timeout, and low memory).
 * One function, so they cannot drift: the same lock, reconcile, DB writes, and
 * PTY suspend, with the record written before the PTY goes down.
 *
 * The suspend is recorded as the USER's by default (`suspended_by = 'user'`).
 * A pause Kangentic made records `'auto'` (the idle timeout) or `'low_memory'`.
 * All are held pauses (`isHeldPause`): neither a restart nor an auto-spawn
 * column starts the task again by itself (`autoSpawnForTask`'s held-pause
 * check). The workflow's memory resume is the one exception, for a
 * `'low_memory'` pause of a running workflow's task. A pause never reaps
 * the task's leftover processes: the task is parked, not finished
 * (task-process-tag.md).
 *
 * No Done or archive gate, on purpose, matching the task view, whose Pause
 * stays available in Done and on an archived task because it is the only stop
 * for an agent a failed Done-move suspend left running. The view hides Pause
 * in To Do, where a move has already torn the session down; the phone mirrors
 * that through `BoardTaskWire.pausable`, not here.
 */
import { withTaskLock } from '../task-lifecycle-lock';
import { applySuspendDbWrites, reconcileTaskSessionRef } from './session-reconcile';
import { abortInFlightResume } from './session-resume-controllers';
import type { Session, SuspendedBy } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * `paused`: the task had a live session and it is now suspended.
 * `not-live`: the task had no live session, so nothing was written or stopped.
 * `declined`: the live session no longer passed `stillEligible`, so nothing
 * was written or stopped.
 */
export type PauseTaskSessionOutcome = 'paused' | 'not-live' | 'declined';

export interface PauseTaskSessionOptions {
  /** The interaction-time project; falls back to the current one (project-scoped-ipc.md). */
  projectId?: string | null;
  /**
   * Called once, under the task lock, after the DB records the session as
   * paused and before the PTY shutdown, which takes about 3s and can run past
   * 10s. Not called when there is no live session, when the pause is
   * declined, or when the reconcile throws. Lets the phone's `pause-session`
   * answer on acceptance within its per-verb budget, as `start-session` does
   * on `resumeTaskSession`'s.
   */
  onAccepted?: () => void;
  /** Who is pausing. Defaults to `'user'`; a pause Kangentic made passes `'auto'` or `'low_memory'`. */
  suspendedBy?: SuspendedBy;
  /**
   * For a pause Kangentic decides on its own. Re-checked under the task lock
   * against the live session, since the agent may have started work, or the
   * user may have resumed, moved or typed into the task, while the pause
   * waited for the lock. False declines the pause.
   *
   * Setting it also leaves an in-flight resume alone. A user pause cancels
   * one, because the user's latest gesture wins; a task the user is bringing
   * back is never one Kangentic should pause.
   */
  stillEligible?: (liveSession: Session) => boolean;
}

export function pauseTaskSession(
  context: IpcContext,
  taskId: string,
  options: PauseTaskSessionOptions = {},
): Promise<PauseTaskSessionOutcome> {
  // Cancel any in-flight resume BEFORE queueing on the lock - otherwise
  // we would deadlock waiting for a resume that is stuck in worktree I/O.
  if (!options.stillEligible) abortInFlightResume(taskId);

  return withTaskLock(taskId, async (): Promise<PauseTaskSessionOutcome> => {
    const resolvedProjectId = options.projectId ?? context.currentProjectId;
    if (!resolvedProjectId) throw new Error('No project is currently open');

    // Reconciled against the registry, as SESSION_RESUME and the task move
    // are: a pointer at an exited row is cleared and there is nothing to
    // suspend, and a live PTY the pointer lost is re-linked and suspended.
    // On the raw pointer, a pause on a task whose CLI had ended by itself
    // marked its exited record `suspended` and suspended a row that was not
    // live.
    const { liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
    if (!liveSession) return 'not-live';
    if (options.stillEligible && !options.stillEligible(liveSession)) return 'declined';

    // DB writes first (capture metrics, mark record suspended, clear
    // task.session_id) then async PTY shutdown. Capturing metrics before
    // shutdown is required - caches are still populated; afterwards is
    // also fine, but doing it first matches task-move's order. Writing the
    // record first is also what makes a pause survive a quit that lands
    // during the shutdown: the next launch reads it as paused.
    applySuspendDbWrites(context, resolvedProjectId, taskId, options.suspendedBy ?? 'user');

    // A throwing hook must not leave the record paused over a running PTY.
    try {
      options.onAccepted?.();
    } catch (hookError) {
      console.warn('[SESSION_SUSPEND] onAccepted hook threw:', hookError);
    }

    await context.sessionManager.suspend(liveSession.id);
    return 'paused';
  });
}
