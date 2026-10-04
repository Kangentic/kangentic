/**
 * Unit tests for migrateOpenCodeProjectData()
 * (src/main/agent/adapters/opencode/project-relocation.ts).
 *
 * OpenCode stores sessions in a global SQLite DB with absolute directory columns
 * (session.directory, session.path, project.worktree, project_directory.directory).
 * Relocation rewrites the path prefix in those columns in one transaction,
 * defensively skipping tables/columns that do not exist and rows that collide.
 *
 * Builds its fixture databases with the real better-sqlite3 driver.
 *
 * Generic fixture paths only - never personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateOpenCodeProjectData } from '../../src/main/agent/adapters/opencode/project-relocation';

let tmpBase: string;
let OLD_PATH: string;
let NEW_PATH: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  OLD_PATH = path.resolve(path.join(tmpBase, 'projects', 'old-app'));
  NEW_PATH = path.resolve(path.join(tmpBase, 'projects', 'new-app'));
  fs.mkdirSync(NEW_PATH, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function dbPath(): string {
  return path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');
}

function createDb(setup: (db: Database.Database) => void): void {
  fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
  const db = new Database(dbPath());
  setup(db);
  db.close();
}

function queryDb<T>(read: (db: Database.Database) => T): T {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe('migrateOpenCodeProjectData', () => {
  it('rewrites session, project, and project_directory path columns (root + worktree), leaving siblings alone', async () => {
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', 'feat-x');
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x');
    fs.mkdirSync(newWorktree, { recursive: true });
    const sibling = `${OLD_PATH}2`;

    createDb((db) => {
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT)');
      db.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)');
      db.exec('CREATE TABLE project_directory (id TEXT PRIMARY KEY, directory TEXT)');
      db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('s1', OLD_PATH, OLD_PATH);
      db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('s2', oldWorktree, oldWorktree);
      db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('s3', sibling, sibling);
      db.prepare('INSERT INTO project VALUES (?, ?)').run('p1', OLD_PATH);
      db.prepare('INSERT INTO project_directory VALUES (?, ?)').run('d1', OLD_PATH);
    });

    await migrateOpenCodeProjectData(OLD_PATH, NEW_PATH);

    const rows = queryDb((db) => ({
      session: db.prepare('SELECT id, directory, path FROM session ORDER BY id').all() as Array<{ id: string; directory: string; path: string }>,
      project: db.prepare('SELECT worktree FROM project').get() as { worktree: string },
      projectDir: db.prepare('SELECT directory FROM project_directory').get() as { directory: string },
    }));

    expect(rows.session.find((r) => r.id === 's1')?.directory).toBe(NEW_PATH);
    expect(rows.session.find((r) => r.id === 's1')?.path).toBe(NEW_PATH);
    expect(rows.session.find((r) => r.id === 's2')?.directory).toBe(newWorktree);
    expect(rows.session.find((r) => r.id === 's3')?.directory).toBe(sibling); // sibling untouched
    expect(rows.project.worktree).toBe(NEW_PATH);
    expect(rows.projectDir.directory).toBe(NEW_PATH);
  });

  it('tolerates a missing column (session without a path column)', async () => {
    createDb((db) => {
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)');
      db.prepare('INSERT INTO session VALUES (?, ?)').run('s1', OLD_PATH);
    });

    await expect(migrateOpenCodeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    const directory = queryDb((db) => (db.prepare('SELECT directory FROM session').get() as { directory: string }).directory);
    expect(directory).toBe(NEW_PATH);
  });

  it('tolerates a missing table (no project_directory)', async () => {
    createDb((db) => {
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT)');
      db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('s1', OLD_PATH, OLD_PATH);
    });

    await expect(migrateOpenCodeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    const directory = queryDb((db) => (db.prepare('SELECT directory FROM session').get() as { directory: string }).directory);
    expect(directory).toBe(NEW_PATH);
  });

  it('does not throw when the DB is absent', async () => {
    await expect(migrateOpenCodeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();
    expect(fs.existsSync(dbPath())).toBe(false);
  });

  it('skips a row whose rewrite collides with a UNIQUE constraint while updating the rest', async () => {
    createDb((db) => {
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT UNIQUE)');
      db.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)');
      db.prepare('INSERT INTO session VALUES (?, ?)').run('s_old', OLD_PATH);
      db.prepare('INSERT INTO session VALUES (?, ?)').run('s_new', NEW_PATH); // target already present
      db.prepare('INSERT INTO project VALUES (?, ?)').run('p1', OLD_PATH);
    });

    await expect(migrateOpenCodeProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    const result = queryDb((db) => ({
      sOld: (db.prepare('SELECT directory FROM session WHERE id = ?').get('s_old') as { directory: string }).directory,
      sNew: (db.prepare('SELECT directory FROM session WHERE id = ?').get('s_new') as { directory: string }).directory,
      project: (db.prepare('SELECT worktree FROM project').get() as { worktree: string }).worktree,
    }));

    // The colliding row is left stale; the unique target row is untouched.
    expect(result.sOld).toBe(OLD_PATH);
    expect(result.sNew).toBe(NEW_PATH);
    // A non-colliding column in another table is still rewritten (transaction not aborted).
    expect(result.project).toBe(NEW_PATH);
  });
});
