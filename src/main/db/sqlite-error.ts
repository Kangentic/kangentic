/**
 * Classification for `better-sqlite3` failures, so the degradation paths can
 * tell a user what happened instead of showing them a stack trace.
 *
 * Nothing in `src/` inspected a `SQLITE_*` code before this module. It exists
 * because of Sentry DESKTOP-9/A/B: one install hit `SQLITE_IOERR` on the global
 * `index.db` and the raw `SqliteError` crossed IPC as
 * `Error invoking remote method 'project:list'`. That message names the channel
 * and says nothing about the file, the cause, or what the user can do.
 *
 * The codes here are the ones a healthy install can still hit for reasons
 * outside the app: an antivirus scan or a cloud-sync client holding the file,
 * a read-only or full volume, failing storage. They are environmental, so the
 * copy points at the environment rather than at Kangentic.
 */

/** The shape `better-sqlite3` throws. It is not exported as a value by the package. */
interface SqliteErrorLike extends Error {
  code: string;
}

/**
 * True for a `better-sqlite3` error carrying a `SQLITE_*` code.
 *
 * Deliberately duck-typed rather than an `instanceof` check: `SqliteError` is
 * not exported from `better-sqlite3`'s type surface, and the native binding is
 * mocked wholesale in the unit tier (see tests/unit/dev-port-ledger-unavailable.test.ts
 * for why the real one cannot load under plain Node).
 */
export function isSqliteError(error: unknown): error is SqliteErrorLike {
  if (!(error instanceof Error)) return false;
  const code = (error as Partial<SqliteErrorLike>).code;
  return typeof code === 'string' && code.startsWith('SQLITE_');
}

/**
 * The one-line technical cause shown under the file path in the unreadable-database
 * dialog, e.g. `disk I/O error (SQLITE_IOERR)`.
 *
 * A non-SQLite failure still reaches here. Opening the database can fail with a
 * plain `Error` (a `NODE_MODULE_VERSION` ABI mismatch is the documented one), and
 * the user needs a line either way, so this falls back to the message rather than
 * returning nothing.
 */
export function describeSqliteFailure(error: unknown): string {
  if (isSqliteError(error)) return `${error.message} (${error.code})`;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
