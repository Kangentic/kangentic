/**
 * The `dev_ports` schema, run against a REAL SQLite engine (node:sqlite).
 *
 * dev-port-allocator.test.ts drives an in-memory stand-in for the repository,
 * so it would stay green if the schema disagreed with it - and that is not a
 * hypothetical here. The index on `task_id` shipped UNIQUE, from the earlier
 * design where Kangentic assigned each task exactly one port. Multi-port
 * reservation needs it non-unique, and the ONLY thing that proves the migration
 * actually dropped it is the real engine rejecting or accepting a second insert.
 * A mock relaxed to match the new intent proves nothing about the schema.
 *
 * The upgrade branch matters as much as the fresh one: `if (taskIndex?.unique)
 * DROP INDEX` only fires on a database that already carries the old unique
 * index, which no fresh install has. So the second suite builds that older
 * shape by hand and replays the migration over it.
 *
 * node:sqlite is built-in on Node 22.5+ but may need --experimental-sqlite on
 * some builds; this skips where it is unavailable (the same gate as
 * session-interrupted-exited-sql.test.ts). A "pass" on a runner without it is a
 * SKIP - check the reported counts before reading this file as coverage.
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

interface IndexRow {
  name: string;
  unique: number;
}

/**
 * The slice of better-sqlite3's surface `runGlobalMigrations` actually uses,
 * backed by node:sqlite. Deliberately minimal: a fuller shim would be more code
 * to keep honest than the migration it exercises.
 */
function openMigratedDb(): { db: Database.Database; close: () => void } {
  const { DatabaseSync } = sqlite!;
  const handle = new DatabaseSync(':memory:');

  const shim = {
    exec: (sql: string) => handle.exec(sql),
    pragma: (statement: string) => handle.prepare(`PRAGMA ${statement}`).all(),
    prepare: (sql: string) => {
      const statement = handle.prepare(sql);
      return {
        get: (...params: unknown[]) => statement.get(...(params as never[])),
        all: (...params: unknown[]) => statement.all(...(params as never[])),
        run: (...params: unknown[]) => statement.run(...(params as never[])),
      };
    },
  } as unknown as Database.Database;

  return { db: shim, close: () => handle.close() };
}

/** Insert one reservation, reporting whether the engine accepted it. */
function claim(db: Database.Database, port: number, taskId: string): boolean {
  try {
    db.prepare(
      `INSERT INTO dev_ports (port, project_id, task_id, allocated_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run(port, 'proj-1', taskId, '2026-08-21T00:00:00.000Z');
    return true;
  } catch {
    return false;
  }
}

describeWithSqlite('dev_ports schema (fresh database)', () => {
  it('lets ONE task hold several ports', () => {
    // The whole reason the unique index had to go. If this ever fails, the
    // reservation tool silently returns one port for every count it is given.
    const { db, close } = openMigratedDb();
    try {
      runGlobalMigrations(db);
      expect(claim(db, 7300, 'task-1')).toBe(true);
      expect(claim(db, 7301, 'task-1')).toBe(true);
      expect(claim(db, 7302, 'task-1')).toBe(true);

      const held = db.prepare('SELECT port FROM dev_ports WHERE task_id = ? ORDER BY port').all('task-1');
      expect(held).toEqual([{ port: 7300 }, { port: 7301 }, { port: 7302 }]);
    } finally {
      close();
    }
  });

  it('still refuses to hand one PORT to two tasks', () => {
    // `port` stays the primary key. Dropping the task_id constraint must not
    // have relaxed the one that actually prevents a collision.
    const { db, close } = openMigratedDb();
    try {
      runGlobalMigrations(db);
      expect(claim(db, 7300, 'task-1')).toBe(true);
      expect(claim(db, 7300, 'task-2')).toBe(false);
    } finally {
      close();
    }
  });

  it('carries a non-unique index on task_id', () => {
    const { db, close } = openMigratedDb();
    try {
      runGlobalMigrations(db);
      const indexes = db.pragma('index_list(dev_ports)') as IndexRow[];
      const taskIndex = indexes.find((index) => index.name === 'idx_dev_ports_task');
      expect(taskIndex).toBeDefined();
      expect(taskIndex?.unique).toBe(0);
    } finally {
      close();
    }
  });

  it('is idempotent across repeated runs', () => {
    const { db, close } = openMigratedDb();
    try {
      runGlobalMigrations(db);
      claim(db, 7300, 'task-1');
      runGlobalMigrations(db);
      runGlobalMigrations(db);

      const indexes = db.pragma('index_list(dev_ports)') as IndexRow[];
      expect(indexes.find((index) => index.name === 'idx_dev_ports_task')?.unique).toBe(0);
      // A re-run must not drop what is already reserved.
      expect(db.prepare('SELECT COUNT(*) AS c FROM dev_ports').get()).toEqual({ c: 1 });
    } finally {
      close();
    }
  });
});

describeWithSqlite('dev_ports schema (upgrade from the unique-index shape)', () => {
  /** The pre-multi-port table, exactly as the earlier migration created it. */
  function seedLegacySchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE dev_ports (
        port INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        allocated_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE INDEX idx_dev_ports_project ON dev_ports(project_id);
      CREATE UNIQUE INDEX idx_dev_ports_task ON dev_ports(task_id);
    `);
  }

  it('drops the unique index so an upgraded board can reserve several', () => {
    // The branch a fresh install never takes, and therefore the one no other
    // test would ever reach.
    const { db, close } = openMigratedDb();
    try {
      seedLegacySchema(db);
      expect(claim(db, 7300, 'task-1')).toBe(true);
      expect(claim(db, 7301, 'task-1')).toBe(false); // the constraint being removed

      runGlobalMigrations(db);

      expect(claim(db, 7301, 'task-1')).toBe(true);
      const indexes = db.pragma('index_list(dev_ports)') as IndexRow[];
      expect(indexes.find((index) => index.name === 'idx_dev_ports_task')?.unique).toBe(0);
    } finally {
      close();
    }
  });

  it('keeps existing reservations through the upgrade', () => {
    // A board mid-flight must not lose the port its dev server is bound to.
    const { db, close } = openMigratedDb();
    try {
      seedLegacySchema(db);
      claim(db, 7300, 'task-1');
      claim(db, 7301, 'task-2');

      runGlobalMigrations(db);

      const rows = db.prepare('SELECT port, task_id FROM dev_ports ORDER BY port').all();
      expect(rows).toEqual([
        { port: 7300, task_id: 'task-1' },
        { port: 7301, task_id: 'task-2' },
      ]);
    } finally {
      close();
    }
  });
});
