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
