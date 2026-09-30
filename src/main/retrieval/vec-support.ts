import type Database from 'better-sqlite3';

/**
 * Per-connection sqlite-vec capability flag. Kept in this dependency-free module
 * (no electron, no sqlite-vec) so the retrieval store and query path can ask
 * "is the vector extension available on this connection?" without dragging the
 * native/electron-only loader into their import graph (which the unit tests
 * traverse).
 */
const vecCapableConnections = new WeakSet<Database.Database>();

/**
 * Load the sqlite-vec extension from `loadablePath` into a connection and mark
 * it vec-capable. The path is resolved by the caller: main resolves it from the
 * `sqlite-vec` package (`vec-extension.ts`), and the retrieval worker is handed
 * the same path in its init message, since resolving it needs `electron`'s
 * `app`. Throws on failure; the caller decides how to degrade.
 */
export function loadVecExtensionFrom(db: Database.Database, loadablePath: string): void {
  if (hasVecSupport(db)) return;
  db.loadExtension(loadablePath);
  markVecCapable(db);
}

export function markVecCapable(db: Database.Database): void {
  vecCapableConnections.add(db);
}

export function hasVecSupport(db: Database.Database): boolean {
  return vecCapableConnections.has(db);
}
