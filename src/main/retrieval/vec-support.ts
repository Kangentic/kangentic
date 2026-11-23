import type Database from 'better-sqlite3';

/**
 * Per-connection sqlite-vec capability flag. Kept in this dependency-free module
 * (no electron, no sqlite-vec) so the retrieval store and query path can ask
 * "is the vector extension available on this connection?" without dragging the
 * native/electron-only loader into their import graph (which the unit tests
 * traverse).
 */
const vecCapableConnections = new WeakSet<Database.Database>();

/** The shared-library suffix SQLite appends on its retry, per platform. */
const LIBRARY_SUFFIX = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
/** Windows file names ignore case. Elsewhere the retry appends the suffix in
 *  lower case, so only an exact match may be taken off. */
const SUFFIX_IGNORES_CASE = process.platform === 'win32';

/**
 * Load the sqlite-vec extension from `loadablePath` into a connection and mark
 * it vec-capable. The path is resolved by the caller: main resolves it from the
 * `sqlite-vec` package (`vec-extension.ts`), and the retrieval worker is handed
 * the same path in its init message, since resolving it needs `electron`'s
 * `app`. Throws on failure; the caller decides how to degrade.
 */
export function loadVecExtensionFrom(db: Database.Database, loadablePath: string): void {
  if (hasVecSupport(db)) return;
  db.loadExtension(withoutLibrarySuffix(loadablePath));
  markVecCapable(db);
}

/**
 * The path with its platform's library suffix taken off, so the error a failed
 * load reports is about the real file (Sentry DESKTOP-4Q).
 *
 * When a load fails, SQLite tries again with the suffix appended
 * (`sqlite3LoadExtension` in better-sqlite3's bundled `sqlite3.c`, the
 * `azEndings` loop), then replaces its own message with the loader's last
 * error. Given `vec0.dll`, that last error is about `vec0.dll.dll`, which never
 * exists, so every failure read "module could not be found" whatever the real
 * cause. Given `vec0`, the first attempt is the one that cannot exist and the
 * retry is the real file. On Windows `LoadLibraryW` appends `.dll` to a path
 * with no extension itself, so both attempts reach the real file. Either name
 * gives SQLite the same entry point, `sqlite3_vec_init`, since it reads the
 * letters before the first dot.
 */
export function withoutLibrarySuffix(loadablePath: string): string {
  const comparable = SUFFIX_IGNORES_CASE ? loadablePath.toLowerCase() : loadablePath;
  return comparable.endsWith(LIBRARY_SUFFIX)
    ? loadablePath.slice(0, loadablePath.length - LIBRARY_SUFFIX.length)
    : loadablePath;
}

export function markVecCapable(db: Database.Database): void {
  vecCapableConnections.add(db);
}

export function hasVecSupport(db: Database.Database): boolean {
  return vecCapableConnections.has(db);
}
