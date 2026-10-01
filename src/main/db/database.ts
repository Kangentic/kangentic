import path from 'node:path';
import Database from 'better-sqlite3';
import { PATHS, ensureDirs } from '../config/paths';
import { runGlobalMigrations, runProjectMigrations } from './migrations';

let globalDb: Database.Database | null = null;
const projectDbs = new Map<string, Database.Database>();

/**
 * How this process opens project databases. Main opens, creates and migrates
 * them (the default). The retrieval worker (`src/main/retrieval/worker/`) opens
 * a second connection to a database main has already opened: the file must
 * exist, and it runs no migrations, which are unversioned check-then-ALTER
 * steps that two processes opening one file at once would race on ("duplicate
 * column"). Main also names the projects directory, since a worker is forked
 * with no arguments and so cannot see a `--data-dir` override.
 */
interface ProjectDbAccess {
  projectsDir: string | null;
  migrate: boolean;
}

let projectDbAccess: ProjectDbAccess = { projectsDir: null, migrate: true };

/**
 * The WAL auto-checkpoint this process's project connections use, in pages,
 * or null for SQLite's default (1000). SQLite runs an auto-checkpoint on the
 * connection that commits, so on main it puts checkpoint I/O and its sync on
 * the main thread. While the retrieval worker is up it checkpoints for both
 * processes (PASSIVE, which never blocks a writer), and main sets 0 here.
 */
let walAutoCheckpointPages: number | null = null;

/** How large a WAL file is left after a checkpoint resets it, so one grown
 *  in a burst of writes shrinks again. */
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

function applyWalAutoCheckpoint(db: Database.Database): void {
  try {
    db.pragma(`wal_autocheckpoint = ${walAutoCheckpointPages ?? 1000}`);
  } catch {
    // A connection that cannot take it keeps checkpointing as it did.
  }
}

/** Set the auto-checkpoint on every open project connection and on those
 *  opened later. */
export function setWalAutoCheckpoint(pages: number | null): void {
  walAutoCheckpointPages = pages;
  for (const db of projectDbs.values()) applyWalAutoCheckpoint(db);
}

export function configureProjectDbAccess(access: ProjectDbAccess): void {
  projectDbAccess = access;
}

function projectDbPath(projectId: string): string {
  return projectDbAccess.projectsDir
    ? path.join(projectDbAccess.projectsDir, `${projectId}.db`)
    : PATHS.projectDb(projectId);
}

/**
 * Optional per-project-DB initializer, run once per connection right after
 * migrations. Injected (rather than imported) so the sqlite-vec loader stays
 * out of this module's static graph, which main, the pty host and the unit
 * tests all share. Registered only by the retrieval worker
 * (`retrieval/worker/retrieval-worker.ts`): main never loads sqlite-vec.
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
      //
      // `synchronous` is deliberately NOT set, here or below. better-sqlite3
      // compiles SQLite with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so a connection
      // in WAL mode already runs at NORMAL (thirty commits 0.4 ms, against 26 ms
      // at FULL). The switch to WAL fails silently where the filesystem cannot
      // support it (it returns the old mode, it does not throw), and such a
      // database keeps the FULL default, the safe setting for a rollback
      // journal. An explicit NORMAL would take that fallback away.
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
    if (projectDbAccess.migrate) ensureDirs();
    db = new Database(projectDbPath(projectId), { fileMustExist: !projectDbAccess.migrate });
    try {
      // busy_timeout before the WAL switch, for the same reason as the global
      // database above.
      db.pragma('busy_timeout = 5000');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
      applyWalAutoCheckpoint(db);
      if (projectDbAccess.migrate) runProjectMigrations(db);
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
    projectDbs.delete(projectId);
    closeQuietly(db);
  }
}

/** The project databases this process has open, by id: what a checkpoint pass
 *  walks. Opens nothing. */
export function openProjectDbIds(): string[] {
  return [...projectDbs.keys()];
}

/** A project's database only if this process already has it open. Never opens,
 *  creates or migrates one, so a caller that must not resurrect a deleted
 *  project's file (a late transcript flush) can use it safely. */
export function getOpenProjectDb(projectId: string): Database.Database | null {
  return projectDbs.get(projectId) ?? null;
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
