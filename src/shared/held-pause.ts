import type { SessionRecordStatus, SuspendedBy } from './types';

/**
 * The suspend sources that hold a task paused until it is resumed: the user's
 * own Pause (`'user'`), and a pause Kangentic made on its own (`'auto'`, the
 * idle timeout; `'low_memory'`, which only an earlier version wrote). A restart
 * never starts a held task again, apart from startup recovery's one exception,
 * a `'low_memory'` row on a running workflow's task (`resume-suspended.ts`). A
 * column move starts none either, except that the owner's own move lifts an
 * `'auto'` pause (`handleTaskMove`, Priority 4), and so does the user opening
 * the task (`resumeTaskOnOpen`): both are the user coming back, not something
 * starting by itself (`isLiftableIdlePause`). A `'system'` suspend (a quit, a
 * move, a settings restart) holds nothing: those agents come back on the next
 * launch or the next move, as before.
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
