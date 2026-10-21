import type { SessionRecordStatus, SuspendedBy } from './types';

/**
 * The suspend sources that hold a task paused until the user resumes it: the
 * user's own Pause (`'user'`), and a pause Kangentic made on its own
 * (`'auto'`: low memory, the idle timeout). Neither a restart nor a column
 * move starts a held task again. A `'system'` suspend (a quit, a move, a
 * settings restart) holds nothing: those agents come back on the next launch
 * or the next move, as before.
 *
 * One list, so the startup recovery, the spawn guard and the auto-spawn
 * queries cannot disagree about which pauses stick.
 */
export const HELD_PAUSE_SOURCES: readonly SuspendedBy[] = ['user', 'auto'];

/** Whether a session record is a pause that waits for the user to resume it. */
export function isHeldPause(
  record: { status: SessionRecordStatus; suspended_by: SuspendedBy | null } | null | undefined,
): boolean {
  return record?.status === 'suspended'
    && record.suspended_by !== null
    && HELD_PAUSE_SOURCES.includes(record.suspended_by);
}
