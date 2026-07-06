import type Database from 'better-sqlite3';

/**
 * Per-connection sqlite-vec capability flag. Kept in this dependency-free module
 * (no electron, no sqlite-vec) so the retrieval store and query path can ask
 * "is the vector extension available on this connection?" without dragging the
 * native/electron-only loader into their import graph (which the unit tests
 * traverse).
 */
const vecCapableConnections = new WeakSet<Database.Database>();

export function markVecCapable(db: Database.Database): void {
  vecCapableConnections.add(db);
}

export function hasVecSupport(db: Database.Database): boolean {
  return vecCapableConnections.has(db);
}
