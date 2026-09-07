import Database from 'better-sqlite3';
import { PATHS, ensureDirs } from '../config/paths';
import { runGlobalMigrations, runProjectMigrations } from './migrations';

let globalDb: Database.Database | null = null;
const projectDbs = new Map<string, Database.Database>();

/**
 * Optional per-project-DB initializer, run once per connection right after
 * migrations. Injected (rather than imported) so the sqlite-vec loader - which
 * pulls electron + the native extension - stays out of this module's static
 * graph, which the unit tests traverse. Registered from `src/main/index.ts`.
 */
let projectDbInitializer: ((db: Database.Database) => void) | null = null;

export function setProjectDbInitializer(initializer: (db: Database.Database) => void): void {
  projectDbInitializer = initializer;
}

/**
 * Close a connection we are abandoning, swallowing a close that itself fails.
 *
 * Closing a connection whose file is already unreachable can throw again, and
 * the original open attempt's error is the one worth surfacing. Used by every
 * path that gives a half-built or superseded handle back to the OS, which on
 * Windows is what stops a retry from fighting our own file lock.
 */
function closeQuietly(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // Best effort. The handle is being abandoned either way.
  }
}

/**
 * The global index database, opened lazily and cached for the process.
 *
 * The connection is built into a LOCAL and only published to `globalDb` once the
 * pragmas and migrations have succeeded. Publishing first (which is what this
 * did until Sentry DESKTOP-9) means a throw from `journal_mode = WAL` leaves a
 * cached handle that never ran migrations: the first caller sees the real
 * `SqliteError`, and every later caller gets `no such table: projects` instead,
 * so the symptom mutates away from its cause. WAL is the likely throw site
 * precisely because it has to create the `-wal` and `-shm` sidecars, which is
 * what an antivirus scan or a cloud-sync lock blocks.
 *
 * On failure the half-built handle is closed (releasing the file, so a retry is
 * not fighting our own lock) and the error is rethrown for the caller to
 * degrade on. `getProjectDb` below already had this shape; global was the
 * outlier.
 */
export function getGlobalDb(): Database.Database {
  if (!globalDb) {
    ensureDirs();
    const db = new Database(PATHS.globalDb);
    try {
      // busy_timeout FIRST. It is a connection setting, so it only covers
      // statements that run after it, and `journal_mode = WAL` is a
      // lock-taking statement: it creates the -wal and -shm sidecars. Two
      // Kangentic instances sharing a config dir (the main checkout plus a
      // non-ephemeral worktree dev run) now both open this file eagerly at
      // boot, so the WAL switch is exactly where they can collide.
      db.pragma('busy_timeout = 5000');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      runGlobalMigrations(db);
    } catch (error) {
      closeQuietly(db);
      throw error;
    }
    globalDb = db;
  }
  return globalDb;
}

/**
 * Drop the cached global connection so the next `getGlobalDb()` is a real
 * reopen. This is what makes the unreadable-database dialog's Retry button
 * mean something: without it, a retry after a transient lock would re-read a
 * cache that is either stale or absent for the wrong reason.
 *
 * Distinct from `closeAll()`, which also tears down every project database as
 * part of shutdown.
 */
export function resetGlobalDb(): void {
  if (!globalDb) return;
  closeQuietly(globalDb);
  globalDb = null;
}

export function getProjectDb(projectId: string): Database.Database {
  let db = projectDbs.get(projectId);
  if (!db) {
    ensureDirs();
    db = new Database(PATHS.projectDb(projectId));
    try {
      // busy_timeout before the WAL switch, for the same reason as the global
      // database above.
      db.pragma('busy_timeout = 5000');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      runProjectMigrations(db);
      // Load optional extensions (sqlite-vec) after migrations. Never throws:
      // the initializer swallows a load failure and the engine falls back to
      // lexical-only search.
      projectDbInitializer?.(db);
    } catch (error) {
      // This path never had the global cache bug (the map is written below,
      // after migrations), but it did leak the handle: on Windows an unclosed
      // connection keeps the file locked by US, so the retry fights our own
      // lock on top of whatever caused the failure.
      closeQuietly(db);
      throw error;
    }
    projectDbs.set(projectId, db);
  }
  return db;
}

export function closeProjectDb(projectId: string): void {
  const db = projectDbs.get(projectId);
  if (db) {
    db.close();
    projectDbs.delete(projectId);
  }
}

export function closeAll(): void {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
  for (const [id, db] of projectDbs) {
    db.close();
    projectDbs.delete(id);
  }
}
