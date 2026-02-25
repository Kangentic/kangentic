import Database from 'better-sqlite3';
import { PATHS, ensureDirs } from '../config/paths';
import { runGlobalMigrations, runProjectMigrations } from './migrations';

let globalDb: Database.Database | null = null;
const projectDbs = new Map<string, Database.Database>();

export function getGlobalDb(): Database.Database {
  if (!globalDb) {
    ensureDirs();
    globalDb = new Database(PATHS.globalDb);
    globalDb.pragma('journal_mode = WAL');
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
    db.pragma('foreign_keys = ON');
    runProjectMigrations(db);
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
