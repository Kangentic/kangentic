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

export function getGlobalDb(): Database.Database {
  if (!globalDb) {
    ensureDirs();
    globalDb = new Database(PATHS.globalDb);
    globalDb.pragma('journal_mode = WAL');
    globalDb.pragma('busy_timeout = 5000');
    globalDb.pragma('foreign_keys = ON');
    runGlobalMigrations(globalDb);
  }
  return globalDb;
}

export function getProjectDb(projectId: string): Database.Database {
  let db = projectDbs.get(projectId);
  if (!db) {
    ensureDirs();
    db = new Database(PATHS.projectDb(projectId));
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    runProjectMigrations(db);
    // Load optional extensions (sqlite-vec) after migrations. Never throws:
    // the initializer swallows a load failure and the engine falls back to
    // lexical-only search.
    projectDbInitializer?.(db);
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
