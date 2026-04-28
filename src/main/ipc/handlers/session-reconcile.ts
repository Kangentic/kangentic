import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos } from '../helpers';
import { captureSessionMetrics } from './session-metrics';
import { markRecordExited, markRecordSuspended } from '../../engine/session-lifecycle';
import { decideSuspendDbAction, isLiveSession } from '../../pty/session-registry';
import type { Session, SuspendedBy, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Persist the DB side of a session suspend: capture metrics, mark the latest
 * session record `suspended` (or `exited` for a never-started queued record),
 * and clear `task.session_id`. Idempotent - early-exits when there is no
 * session_id to clear.
 *
 * Caller MUST hold `withTaskLock(taskId)` because this writes to per-task
 * state. Synchronous on purpose: better-sqlite3 is sync, and centralizing the
 * writes here lets the idle-timeout path mirror SESSION_SUSPEND without
 * duplicating the branching.
 */
export function applySuspendDbWrites(
  context: IpcContext,
  projectId: string,
  taskId: string,
  source: SuspendedBy,
): void {
  const { tasks } = getProjectRepos(context, projectId);
  const task = tasks.getById(taskId);
  if (!task?.session_id) return;

  const db = getProjectDb(projectId);
  const sessionRepo = new SessionRepository(db);
  const record = sessionRepo.getLatestForTask(taskId);
  const action = decideSuspendDbAction(record);
  if (record && action === 'suspend') {
    captureSessionMetrics(context.sessionManager, sessionRepo, task.session_id, record.id);
    markRecordSuspended(sessionRepo, record.id, source);
  } else if (record && action === 'exit-queued') {
    markRecordExited(sessionRepo, record.id);
  }
  tasks.update({ id: taskId, session_id: null });
}

/**
 * Read a task and reconcile its `session_id` against the live SessionRegistry.
 *
 * Three outcomes:
 *
 *   - `liveSession` set: the registry has a running/queued session matching
 *     the DB reference. The caller must NOT spawn (would duplicate); use the
 *     returned session as the existing handle.
 *   - `liveSession` null + `task.session_id` was non-null: the DB reference
 *     was stale (registry says suspended/exited or has no entry). This
 *     function clears `task.session_id` so the caller can proceed with a
 *     fresh spawn / resume safely.
 *   - `liveSession` null + `task.session_id` was already null: clean state,
 *     nothing to reconcile.
 *
 * Why this exists: every internal suspend path SHOULD pair `session.status =
 * 'suspended'` with `tasks.update({ session_id: null })`, but `requestSuspend`
 * (idle-timeout) historically didn't, and the auto-spawn placeholder safety
 * net at startup also doesn't. Reconciling here means a single recovery point
 * defends every present and future suspend path that misses the DB clear.
 */
export function reconcileTaskSessionRef(
  context: IpcContext,
  projectId: string,
  taskId: string,
): { task: Task; liveSession: Session | null } {
  const { tasks } = getProjectRepos(context, projectId);
  const task = tasks.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.session_id) return { task, liveSession: null };

  const existing = context.sessionManager.getSession(task.session_id);
  if (existing && isLiveSession(existing)) {
    return { task, liveSession: existing };
  }

  // This log firing means a suspend path mutated the registry without
  // clearing task.session_id (idle-timeout, auto-spawn placeholder safety
  // net, or future regression). Grep this prefix to find divergence sources.
  console.log(
    `[SESSION_RECONCILE] Cleared stale task.session_id for task ${taskId.slice(0, 8)}`
    + ` (registry status: ${existing?.status ?? 'missing'})`,
  );
  tasks.update({ id: taskId, session_id: null });
  // Re-read so the returned task reference matches what subsequent
  // tasks.getById(taskId) calls will return - keeps reference identity
  // consistent for downstream code that mutates the task in place
  // (e.g. ensureTaskWorktree's Object.assign).
  const refreshed = tasks.getById(taskId);
  if (!refreshed) throw new Error(`Task ${taskId} not found`);
  return { task: refreshed, liveSession: null };
}
