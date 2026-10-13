/**
 * The upgrade path of the background call ledger in `runProjectMigrations`
 * (src/main/db/migrations/project-schema.ts): the `background_calls` table, its
 * two indexes, and the `automation_runs.background_call_id` column with its index.
 *
 * background-calls.test.ts runs the migration once on an empty database, which
 * never meets the case that matters on a user's machine: an `automation_runs`
 * table that already exists, with history in it, from before the column was
 * added. The fixture here bootstraps one modern schema with a real migration
 * pass (so tasks and swimlanes match production), then reverts only
 * `automation_runs` to its pre-upgrade shape, the way usage-history-migration.test.ts
 * does for `usage_history`. The migration under test is the pass made AFTER the
 * revert.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BackgroundCallRepository } from '../../src/main/db/repositories/background-call-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function openDatabase(): DatabaseType.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function indexNames(database: DatabaseType.Database, tableName: string): string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name")
    .all(tableName) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columnNames(database: DatabaseType.Database, tableName: string): string[] {
  return (database.pragma(`table_info(${tableName})`) as Array<{ name: string }>).map((column) => column.name);
}

function insertTask(database: DatabaseType.Database): { columnId: string; taskId: string } {
  const columnId = new SwimlaneRepository(database).list()[0].id;
  const taskId = 'task-1';
  database
    .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, 'A task', '', columnId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  return { columnId, taskId };
}

describe('runProjectMigrations: background call ledger', () => {
  it('runs twice on one database without throwing, and leaves the table, columns and indexes in place', () => {
    const database = openDatabase();
    runProjectMigrations(database);

    expect(() => runProjectMigrations(database)).not.toThrow();

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'background_calls'")
      .all();
    expect(tables).toHaveLength(1);
    expect(indexNames(database, 'background_calls')).toEqual(['idx_background_calls_started', 'idx_background_calls_task']);
    expect(columnNames(database, 'automation_runs')).toContain('background_call_id');
    expect(indexNames(database, 'automation_runs')).toContain('idx_automation_runs_background_call');
  });

  it('keeps a ledger the repository can write and read after the second pass', () => {
    const database = openDatabase();
    runProjectMigrations(database);
    runProjectMigrations(database);

    new BackgroundCallRepository(database).record({
      id: 'call-1', job: 'task_title', taskId: null, swimlaneId: null, agent: 'claude', requestedModel: 'haiku', effort: null,
      usage: null, durationMs: 400, outcome: 'succeeded', detail: null, startedAt: '2026-10-13T14:02:11.402Z',
    });

    const groups = new BackgroundCallRepository(database).listGroups(null, null, 15 * 60_000);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ job: 'task_title', modelId: 'haiku', calls: 1 });
  });

  describe('an automation_runs table from before the column existed', () => {
    /** Modern schema from one real pass, then automation_runs put back as an older build left it. */
    function upgradableDatabase(): { database: DatabaseType.Database; columnId: string; taskId: string } {
      const database = openDatabase();
      runProjectMigrations(database);
      // SQLite refuses to drop a column an index names, so the index goes first.
      database.exec('DROP INDEX idx_automation_runs_background_call');
      database.exec('ALTER TABLE automation_runs DROP COLUMN background_call_id');
      const { columnId, taskId } = insertTask(database);
      // A history row written by that older build: no background_call_id to supply.
      database
        .prepare(`
          INSERT INTO automation_runs
            (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
             started_at, finished_at, condition_met, condition_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run('run-old', 'a1', 'Old row', 'send_message', taskId, columnId, 'turn_end', 'succeeded', 'Sent.', 1,
          '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:01.000Z', 1, 'Yes.');
      return { database, columnId, taskId };
    }

    it('gains the column and its index, and keeps the old row', () => {
      const { database } = upgradableDatabase();
      // The fixture really is the old shape, so a passing assertion below cannot be a fixture mistake.
      expect(columnNames(database, 'automation_runs')).not.toContain('background_call_id');
      expect(indexNames(database, 'automation_runs')).not.toContain('idx_automation_runs_background_call');

      expect(() => runProjectMigrations(database)).not.toThrow();

      expect(columnNames(database, 'automation_runs')).toContain('background_call_id');
      expect(indexNames(database, 'automation_runs')).toContain('idx_automation_runs_background_call');
      const row = database.prepare('SELECT id, status, background_call_id FROM automation_runs').all();
      expect(row).toEqual([{ id: 'run-old', status: 'succeeded', background_call_id: null }]);
    });

    it('reads the old row back through the repository with no check, beside a new row that has one', () => {
      const { database, columnId, taskId } = upgradableDatabase();
      runProjectMigrations(database);
      const runs = new AutomationRunRepository(database);

      const before = runs.listForTask(taskId);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ id: 'run-old', condition_met: true });
      expect(before[0].check).toBeNull();

      new BackgroundCallRepository(database).record({
        id: 'call-1', job: 'condition_check', taskId, swimlaneId: columnId, agent: 'claude', requestedModel: 'haiku', effort: 'low',
        usage: null, durationMs: 700, outcome: 'timed_out', detail: 'the agent timed out', startedAt: '2026-10-13T14:02:11.402Z',
      });
      runs.start({
        id: 'run-new',
        automation: { id: 'a1', name: 'Old row', type: 'send_message', swimlane_id: columnId, trigger: 'turn_end' },
        taskId,
        backgroundCallId: 'call-1',
      });

      const after = runs.listForTask(taskId);
      expect(after).toHaveLength(2);
      expect(after.find((run) => run.id === 'run-old')?.check).toBeNull();
      expect(after.find((run) => run.id === 'run-new')?.check).toMatchObject({ callId: 'call-1', outcome: 'timed_out' });
    });
  });
});
