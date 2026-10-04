import type { SessionRecord } from '../../shared/types';

/**
 * The PTY grid recorded on a session record (`last_pty_cols/rows`), or
 * undefined when it has none. Both columns must be set: the loose `!= null`
 * also treats a field that is absent altogether (a row object built before the
 * column existed) as unset.
 *
 * Its own module, not a SessionRepository export, because the repository module
 * is mocked wholesale by many tests and a pure reader has no reason to be.
 */
export function recordedPtyGrid(
  record: Pick<SessionRecord, 'last_pty_cols' | 'last_pty_rows'> | null | undefined,
): { cols: number; rows: number } | undefined {
  if (record?.last_pty_cols == null || record.last_pty_rows == null) return undefined;
  return { cols: record.last_pty_cols, rows: record.last_pty_rows };
}
