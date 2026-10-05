import type { SessionRecord } from '../../../shared/types';
import type { SessionRepository } from './session-repository';

/**
 * The record a capture for a session writes to: the session's own (record id
 * == PTY session id), else the task's newest.
 *
 * Its own record, not the task's newest, because a task can hold two tracks at
 * once (its main session and an isolated swimlane's), and the newest record
 * can belong to the other one. A capture there counts this run twice in that
 * track's merged tool totals. The newest is the fallback for the window before
 * a spawn's record is inserted, and the answer when no session id is known (a
 * task with no live session).
 *
 * The quit flush (`syncShutdownCleanup`) and the metrics snapshot timer look a
 * session up by id with no fallback, on purpose, and skip a session whose
 * record is not inserted yet. A fallback is unsafe there: both act on any
 * `running` record, and when the task's other track has a live session, the
 * task's newest record is that session's `running` one, so the capture would
 * land on the wrong track.
 */
export function resolveOwnSessionRecord(
  sessionRepo: Pick<SessionRepository, 'findByAnyId' | 'getLatestForTask'>,
  sessionId: string | null | undefined,
  taskId: string,
): SessionRecord | undefined {
  return (sessionId ? sessionRepo.findByAnyId(sessionId) : undefined) ?? sessionRepo.getLatestForTask(taskId);
}
