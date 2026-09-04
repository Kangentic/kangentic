import type { Session } from '../../../shared/types';
import { isLiveSessionStatus } from '../../../shared/session-liveness';

/**
 * Of two rows sharing a taskId, the one that is the task's current session:
 * a live (running / queued) row beats a stale suspended or exited one, and
 * among equals the later `startedAt` wins. Independent of array order, except
 * that an exact tie (same liveness, same `startedAt`) keeps `first`, which in
 * both callers below is the row seen earlier in the array.
 *
 * Main keeps its registry at one row per task, so a collision here is either
 * transient (a queued respawn listed behind its suspended predecessor until
 * promotion) or a main-side regression. Either way the live row is the answer.
 * Before this, the task-detail hook took the FIRST array match and the board
 * card took the LAST (`map.set`), and a stale suspended row that main listed
 * ahead of the live PTY painted "Resume session" on a running agent while the
 * card beside it showed the spinner.
 */
export function preferSessionForTask(first: Session, second: Session): Session {
  const firstLive = isLiveSessionStatus(first.status);
  const secondLive = isLiveSessionStatus(second.status);
  if (firstLive !== secondLive) return firstLive ? first : second;
  return (second.startedAt || '') > (first.startedAt || '') ? second : first;
}

/**
 * The task's current session, resolved with `preferSessionForTask`. Every
 * renderer site that resolves a session by taskId over the array goes
 * through this rather than `sessions.find(...)`, which is first-wins.
 */
export function findSessionForTask(sessions: readonly Session[], taskId: string): Session | undefined {
  let best: Session | undefined;
  for (const session of sessions) {
    if (session.taskId !== taskId) continue;
    best = best ? preferSessionForTask(best, session) : session;
  }
  return best;
}

/**
 * Build a taskId -> Session lookup Map from the sessions array.
 * Shared by multiple slices that need O(1) session-by-task lookup
 * after mutating the session list. A collision resolves the same way
 * `findSessionForTask` does, so the index and the array agree.
 */
export function buildSessionByTaskId(sessions: Session[]): Map<string, Session> {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    const current = map.get(session.taskId);
    map.set(session.taskId, current ? preferSessionForTask(current, session) : session);
  }
  return map;
}

/**
 * Write `next` into the session list as its task's ONLY row, returning BOTH
 * halves so the index cannot be left behind.
 *
 * If a row with `next.id` is already present it is replaced in place (the
 * bottom panel's tab order follows array order), otherwise `next` is appended
 * (a respawn under a new id). Either way every OTHER row for `next.taskId` is
 * dropped. The in-place branch is the one that used to leave a stale suspended
 * sibling in front of the live row: `syncSessions` had imported main's list
 * verbatim with the stale row first, so every status push and every reconcile
 * probe found the live id already present, replaced it where it stood, and
 * left the sibling to keep painting "Resume session" over a running agent.
 *
 * Shared by `upsertSession` (the `sessions.onStatus` push path) and
 * `reconcileSession` (the task-detail self-heal probe) so the one-row-per-task
 * contract has one implementation.
 */
export function withSessionUpserted(
  sessions: Session[],
  next: Session,
): { sessions: Session[]; _sessionByTaskId: Map<string, Session> } {
  const inPlace = sessions.some((session) => session.id === next.id);
  const remaining = inPlace
    ? sessions
      .filter((session) => session.id === next.id || session.taskId !== next.taskId)
      .map((session) => (session.id === next.id ? next : session))
    : [...sessions.filter((session) => session.taskId !== next.taskId), next];
  return { sessions: remaining, _sessionByTaskId: buildSessionByTaskId(remaining) };
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
