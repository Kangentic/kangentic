/**
 * Migration and round trip for the `tasks.automations_disabled` column
 * (src/main/db/migrations/project-schema.ts, src/main/db/repositories/task-repository.ts).
 *
 * The switch is stored as INTEGER 0/1 and surfaces on `Task` as a boolean. Two
 * things have to hold for every board that already exists: the migration adds
 * the column with a default of 0 (today's behavior, no backfill), and every read
 * path maps the integer to a real boolean. A mapper that skipped `rowToTask`
 * would leak `1` into the MCP `automationsDisabled` field and the card's strip.
 *
 * Runs on a real better-sqlite3 database. The upgrade path is reproduced the way
 * tasks-run-mode-migration.test.ts does it: run the migration, drop the column
 * it added, seed a row as it looked before, and run the migration again.
 * `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35 or newer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';

interface TableColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

describe('tasks.automations_disabled migration and round trip', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let todoLaneId: string;
  let doneLaneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    const lanes = new SwimlaneRepository(database).list();
    todoLaneId = lanes.find((lane) => lane.role === 'todo')!.id;
    doneLaneId = lanes.find((lane) => lane.role === 'done')!.id;
  });

  afterEach(() => {
    database.close();
  });

  function automationsDisabledColumns(): TableColumnInfo[] {
    return (database.pragma('table_info(tasks)') as TableColumnInfo[])
      .filter((column) => column.name === 'automations_disabled');
  }

  /** The value SQLite holds, read without the repository's row mapping. */
  function storedValue(taskId: string): unknown {
    const row = database.prepare('SELECT automations_disabled FROM tasks WHERE id = ?').get(taskId) as { automations_disabled: unknown };
    return row.automations_disabled;
  }

  describe('the migration', () => {
    it('adds automations_disabled as NOT NULL defaulting to 0', () => {
      const columns = automationsDisabledColumns();

      expect(columns).toHaveLength(1);
      expect(columns[0].notnull).toBe(1);
      // 0 is today's behavior, so an INSERT that predates the column keeps it.
      expect(columns[0].dflt_value).toBe('0');
    });

    it('is idempotent across repeated runs (the app migrates on every project open)', () => {
      expect(() => runProjectMigrations(database)).not.toThrow();
      expect(() => runProjectMigrations(database)).not.toThrow();

      expect(automationsDisabledColumns()).toHaveLength(1);
    });

    it('does not disturb an existing value on a re-run', () => {
      const task = tasks.create({ title: 'Held', description: '', swimlane_id: todoLaneId, automations_disabled: true });

      runProjectMigrations(database);

      expect(storedValue(task.id)).toBe(1);
      expect(tasks.getById(task.id)!.automations_disabled).toBe(true);
    });

    it('defaults a row inserted without the column to 0', () => {
      database.prepare(
        `INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at)
         VALUES ('t-raw', 'Raw', '', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(todoLaneId);

      expect(storedValue('t-raw')).toBe(0);
    });

    it('gives a pre-existing task the default (false) when the column is added to an old database', () => {
      // The pre-migration table shape: the column does not exist yet.
      database.exec('ALTER TABLE tasks DROP COLUMN automations_disabled');
      expect(automationsDisabledColumns()).toHaveLength(0);
      database.prepare(
        `INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at)
         VALUES ('t-old', 'Old task', '', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(todoLaneId);

      runProjectMigrations(database);

      expect(automationsDisabledColumns()).toHaveLength(1);
      expect(storedValue('t-old')).toBe(0);
      const upgraded = tasks.getById('t-old')!;
      expect(upgraded.automations_disabled).toBe(false);
      expect(typeof upgraded.automations_disabled).toBe('boolean');
    });
  });

  describe('create', () => {
    it('stores 0 and reads false when the field is omitted', () => {
      const created = tasks.create({ title: 'Plain', description: '', swimlane_id: todoLaneId });

      expect(created.automations_disabled).toBe(false);
      expect(storedValue(created.id)).toBe(0);
      expect(tasks.getById(created.id)!.automations_disabled).toBe(false);
    });

    it('stores 0 and reads false when the field is false', () => {
      const created = tasks.create({ title: 'Explicit', description: '', swimlane_id: todoLaneId, automations_disabled: false });

      expect(created.automations_disabled).toBe(false);
      expect(storedValue(created.id)).toBe(0);
    });

    it('stores 1 and reads true when the field is true', () => {
      const created = tasks.create({ title: 'Held', description: '', swimlane_id: todoLaneId, automations_disabled: true });

      expect(created.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
      expect(tasks.getById(created.id)!.automations_disabled).toBe(true);
    });
  });

  describe('every read path hands back a boolean, never the stored integer', () => {
    it('getById', () => {
      const held = tasks.create({ title: 'Held', description: '', swimlane_id: todoLaneId, automations_disabled: true });
      const plain = tasks.create({ title: 'Plain', description: '', swimlane_id: todoLaneId });

      expect(tasks.getById(held.id)!.automations_disabled).toBe(true);
      expect(tasks.getById(plain.id)!.automations_disabled).toBe(false);
    });

    it('list', () => {
      const held = tasks.create({ title: 'Held', description: '', swimlane_id: todoLaneId, automations_disabled: true });
      const plain = tasks.create({ title: 'Plain', description: '', swimlane_id: todoLaneId });

      const listed = tasks.list(todoLaneId);

      expect(listed.find((task) => task.id === held.id)!.automations_disabled).toBe(true);
      expect(listed.find((task) => task.id === plain.id)!.automations_disabled).toBe(false);
    });

    it('listArchived', () => {
      const held = tasks.create({ title: 'Held', description: '', swimlane_id: todoLaneId, automations_disabled: true });
      tasks.move({ taskId: held.id, targetSwimlaneId: doneLaneId, targetPosition: 0 }, { origin: 'renderer' });
      tasks.archive(held.id);

      const archived = tasks.listArchived();

      expect(archived).toHaveLength(1);
      // Strictly true: a mapper that left the raw 1 in place would fail here.
      expect(archived[0].automations_disabled).toBe(true);
    });
  });

  describe('update', () => {
    it('round trips true then false', () => {
      const created = tasks.create({ title: 'Task', description: '', swimlane_id: todoLaneId });

      const disabled = tasks.update({ id: created.id, automations_disabled: true });
      expect(disabled.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
      expect(tasks.getById(created.id)!.automations_disabled).toBe(true);

      const enabled = tasks.update({ id: created.id, automations_disabled: false });
      expect(enabled.automations_disabled).toBe(false);
      expect(storedValue(created.id)).toBe(0);
      expect(tasks.getById(created.id)!.automations_disabled).toBe(false);
    });

    it('leaves the switch alone on an update that does not name it', () => {
      // The UPDATE writes the column on every call, so an omitted field must
      // carry the stored value forward rather than reset it.
      const created = tasks.create({ title: 'Held', description: '', swimlane_id: todoLaneId, automations_disabled: true });

      const renamed = tasks.update({ id: created.id, title: 'Held, renamed' });

      expect(renamed.automations_disabled).toBe(true);
      expect(storedValue(created.id)).toBe(1);
      expect(tasks.getById(created.id)!.title).toBe('Held, renamed');
    });

    it('leaves an enabled task enabled on an update that does not name it', () => {
      const created = tasks.create({ title: 'Plain', description: '', swimlane_id: todoLaneId });

      tasks.update({ id: created.id, title: 'Plain, renamed' });

      expect(storedValue(created.id)).toBe(0);
    });
  });
});
