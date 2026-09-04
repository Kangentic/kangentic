import type { SessionStatus } from './types';

/**
 * A live session occupies a concurrency slot and must not be duplicated:
 * `running` (PTY alive) or `queued` (slot reserved, promotion pending).
 * `suspended` and `exited` rows are stale references a caller may clear.
 *
 * One home for the predicate, shared by main's registry queries and the
 * renderer's task-to-session selectors. The two must agree: a row main treats
 * as live was once masked in the task-detail window by a stale suspended row
 * the renderer happened to list first.
 */
export function isLiveSessionStatus(status: SessionStatus): boolean {
  return status === 'running' || status === 'queued';
}
