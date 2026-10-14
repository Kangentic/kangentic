/**
 * The upgrade path of the Text match columns in `runProjectMigrations`
 * (src/main/db/migrations/project-schema.ts): `column_automations.final_line`,
 * `automation_runs.final_line_met` and `automation_runs.final_line_reason`,
 * each added by its own guarded ALTER TABLE.
 *
 * The suites that run the migration once on an empty database never meet the
 * case that matters on a user's machine: tables that already exist, with rows
 * in them, from before the columns were added. A broken guard there throws on
 * project open, which the user sees as a board that will not load. The fixture
 * bootstraps one modern schema with a real pass (so tasks and swimlanes match
 * production), then reverts only the three columns, the way
 * background-call-migration.test.ts does for `background_call_id`. The
 * migration under test is the pass made AFTER the revert.
 *
 * Tier: Unit (real better-sqlite3, in memory).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
}

function openDatabase(): DatabaseType.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function columnInfo(database: DatabaseType.Database, tableName: string, columnName: string): ColumnInfo | undefined {
  return (database.pragma(`table_info(${tableName})`) as ColumnInfo[]).find((column) => column.name === columnName);
}

/** Every Text match column, with the table it lives on and the type it is declared with. */
const FINAL_LINE_COLUMNS = [
  { table: 'column_automations', column: 'final_line', type: 'TEXT' },
  { table: 'automation_runs', column: 'final_line_met', type: 'INTEGER' },
  { table: 'automation_runs', column: 'final_line_reason', type: 'TEXT' },
] as const;

/**
 * A modern schema from one real pass, with the three Text match columns taken
 * back off and one row left in each table, as a build from before them wrote.
 */
function upgradableDatabase(): { database: DatabaseType.Database; columnId: string; taskId: string } {
  const database = openDatabase();
  runProjectMigrations(database);
  for (const { table, column } of FINAL_LINE_COLUMNS) {
    // Dropped only when the pass created it, so a migration that stopped adding
    // a column fails on the assertions below rather than inside this setup.
    if (columnInfo(database, table, column)) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }

  const columnId = new SwimlaneRepository(database).list()[0].id;
  const taskId = 'task-old-1';
  database
    .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, 'A task', '', columnId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database
    .prepare(`
      INSERT INTO column_automations
        (id, swimlane_id, name, type, trigger, position, enabled, config_json, condition, max_runs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('automation-old', columnId, 'Old ping', 'notify', 'turn_end', 0, 1, '{"title":"Hi"}', 'The work is done', 2,
      '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z');
  database
    .prepare(`
      INSERT INTO automation_runs
        (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
         started_at, finished_at, condition_met, condition_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('run-old', 'automation-old', 'Old ping', 'notify', taskId, columnId, 'turn_end', 'succeeded', 'Shown', 1,
      '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:01.000Z', 1, 'Yes.');
  return { database, columnId, taskId };
}

describe('runProjectMigrations: Text match columns', () => {
  it('creates all three columns on a fresh database, nullable and typed for what they hold', () => {
    const database = openDatabase();
    runProjectMigrations(database);

    for (const { table, column, type } of FINAL_LINE_COLUMNS) {
      expect(columnInfo(database, table, column), `${table}.${column}`).toMatchObject({ type, notnull: 0 });
    }
  });

  describe('tables from before the columns existed', () => {
    it('starts from a fixture that really lacks all three columns', () => {
      const { database } = upgradableDatabase();

      for (const { table, column } of FINAL_LINE_COLUMNS) {
        expect(columnInfo(database, table, column), `${table}.${column}`).toBeUndefined();
      }
    });

    it('adds each column, nullable and typed for what it holds, without throwing', () => {
      const { database } = upgradableDatabase();

      expect(() => runProjectMigrations(database)).not.toThrow();

      for (const { table, column, type } of FINAL_LINE_COLUMNS) {
        expect(columnInfo(database, table, column), `${table}.${column}`).toMatchObject({ type, notnull: 0 });
      }
    });

    it('leaves the rows that already exist reading NULL for the new columns, and otherwise untouched', () => {
      const { database } = upgradableDatabase();
      runProjectMigrations(database);

      expect(database.prepare('SELECT id, name, condition, max_runs, final_line FROM column_automations').all())
        .toEqual([{ id: 'automation-old', name: 'Old ping', condition: 'The work is done', max_runs: 2, final_line: null }]);
      expect(database.prepare('SELECT id, status, condition_met, final_line_met, final_line_reason FROM automation_runs').all())
        .toEqual([{ id: 'run-old', status: 'succeeded', condition_met: 1, final_line_met: null, final_line_reason: null }]);
    });

    it('reads the old rows back through the repositories as having no Text match and no Text match answer', () => {
      const { database, taskId } = upgradableDatabase();
      runProjectMigrations(database);

      expect(new AutomationRepository(database).listAll()[0]).toMatchObject({
        id: 'automation-old',
        condition: 'The work is done',
        final_line: null,
      });
      expect(new AutomationRunRepository(database).listForTask(taskId)[0]).toMatchObject({
        id: 'run-old',
        condition_met: true,
        final_line_met: null,
        final_line_reason: null,
      });
    });

    it('stores and reads back a Text match and its answer once the columns exist', () => {
      const { database, columnId, taskId } = upgradableDatabase();
      runProjectMigrations(database);

      const [written] = new AutomationRepository(database).replaceForColumn(columnId, [{
        name: 'Ready ping',
        type: 'notify',
        trigger: 'turn_end',
        enabled: true,
        config: { title: 'Ready' },
        final_line: 'Verdict: Ready',
      }]);
      const runs = new AutomationRunRepository(database);
      runs.start({
        id: 'run-new',
        automation: written,
        taskId,
        finalLine: { met: true, reason: 'The final line reads "Verdict: Ready".' },
      });

      expect(new AutomationRepository(database).getById(written.id)?.final_line).toBe('Verdict: Ready');
      expect(runs.listForTask(taskId).find((run) => run.id === 'run-new')).toMatchObject({
        final_line_met: true,
        final_line_reason: 'The final line reads "Verdict: Ready".',
      });
    });

    it('runs a second time without throwing, and keeps what the first pass and later writes stored', () => {
      const { database, columnId } = upgradableDatabase();
      runProjectMigrations(database);
      new AutomationRepository(database).replaceForColumn(columnId, [{
        name: 'Ready ping',
        type: 'notify',
        trigger: 'turn_end',
        enabled: true,
        config: { title: 'Ready' },
        final_line: 'Verdict: Ready',
      }]);

      expect(() => runProjectMigrations(database)).not.toThrow();

      expect(new AutomationRepository(database).listForColumn(columnId).map((row) => row.final_line)).toEqual(['Verdict: Ready']);
    });

    // Each ALTER has its own guard, so a database a build stopped halfway through
    // (or a downgrade that dropped only some columns) still upgrades. One shared
    // `if` around two ALTERs would throw "duplicate column name" here.
    for (const { table, column } of FINAL_LINE_COLUMNS) {
      it(`adds only ${table}.${column} when the other two are already there`, () => {
        const { database } = upgradableDatabase();
        // Put every column back except the one under test, as the migration itself would.
        for (const other of FINAL_LINE_COLUMNS) {
          if (other.column === column) continue;
          database.exec(`ALTER TABLE ${other.table} ADD COLUMN ${other.column} ${other.type} DEFAULT NULL`);
        }
        expect(columnInfo(database, table, column)).toBeUndefined();

        expect(() => runProjectMigrations(database)).not.toThrow();

        for (const { table: eachTable, column: eachColumn, type } of FINAL_LINE_COLUMNS) {
          expect(columnInfo(database, eachTable, eachColumn), `${eachTable}.${eachColumn}`).toMatchObject({ type, notnull: 0 });
        }
      });
    }
  });
});
