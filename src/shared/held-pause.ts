import type { SessionRecordStatus, SuspendedBy } from './types';

/**
 * The suspend sources that hold a task paused until it is resumed: the user's
 * own Pause (`'user'`), and a pause Kangentic made on its own (`'auto'`, the
 * idle timeout; `'low_memory'`, which only an earlier version wrote). Neither a
 * restart nor a column move starts a held task again, apart from startup
 * recovery's one exception, a `'low_memory'` row on a running workflow's task
 * (`resume-suspended.ts`). The user opening the task lifts an `'auto'` pause
 * (`resumeTaskOnOpen`), which is the user coming back, not something starting
 * by itself. A `'system'` suspend (a quit, a move, a settings restart) holds
 * nothing: those agents come back on the next launch or the next move, as before.
 *
 * One list, so the startup recovery, the spawn guard and the auto-spawn
 * queries cannot disagree about which pauses stick.
 */
export const HELD_PAUSE_SOURCES: readonly SuspendedBy[] = ['user', 'auto', 'low_memory'];

/** Whether a session record is a pause that waits for the user to resume it. */
export function isHeldPause(
  record: { status: SessionRecordStatus; suspended_by: SuspendedBy | null } | null | undefined,
): boolean {
  return record?.status === 'suspended'
    && record.suspended_by !== null
    && HELD_PAUSE_SOURCES.includes(record.suspended_by);
}
