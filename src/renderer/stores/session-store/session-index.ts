import type { Session } from '../../../shared/types';

/**
 * Build a taskId -> Session lookup Map from the sessions array.
 * Shared by multiple slices that need O(1) session-by-task lookup
 * after mutating the session list.
 */
export function buildSessionByTaskId(sessions: Session[]): Map<string, Session> {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    map.set(session.taskId, session);
  }
  return map;
}

/**
 * Drop every session belonging to `taskIds`, returning BOTH halves of the
 * session list so the index cannot be left behind.
 *
 * The board slices evict sessions when a task is moved out of an active column,
 * deleted, or bulk-deleted. Each of those used to filter `sessions` alone, which
 * silently broke the "rebuilt whenever `sessions` changes" invariant on
 * `_sessionByTaskId`: the array lost the session while the index kept pointing a
 * live taskId at it. `TaskCard` resolves its session THROUGH that index, so the
 * card went on rendering the dead session's activity mark and context footer -
 * a task sitting in To Do still looking like a running agent - until some
 * unrelated `syncSessions()` happened to rebuild the map.
 *
 * Returning the pair is what makes this safe to reuse: a caller cannot spread it
 * into `setState` and forget the index.
 */
export function withoutSessionsForTasks(
  sessions: Session[],
  taskIds: ReadonlySet<string> | string,
): { sessions: Session[]; _sessionByTaskId: Map<string, Session> } {
  const remaining = typeof taskIds === 'string'
    ? sessions.filter((session) => session.taskId !== taskIds)
    : sessions.filter((session) => !taskIds.has(session.taskId));
  return { sessions: remaining, _sessionByTaskId: buildSessionByTaskId(remaining) };
}
