/**
 * The workflows migration runs as one transaction
 * (`runWorkflowsMigration`, src/main/db/migrations/project-schema.ts).
 *
 * The workflow engine's probe checks only for the `workflows` table before it
 * reads `tasks.workflow_id` (src/main/workflows/workflow-project-probe.ts), so
 * the table and the column have to land together. A run that failed between
 * them used to leave the table without the column, and the engine read that
 * board as unreadable until the next open finished the migration.
 *
 * A pre-workflows board is rebuilt by running every migration and dropping
 * what this one adds. `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35 or newer,
 * which the bundled better-sqlite3 is well past.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { openTestDatabase } from './helpers/test-database';

const WORKFLOW_TASK_COLUMNS = [
  'workflow_id',
  'workflow_project_id',
  'route_start_swimlane_id',
  'route_last_swimlane_id',
  'skipped_swimlane_ids',
  'canvas_x',
  'canvas_y',
];

describe('the workflows migration', () => {
  let database: Database.Database;

  const tableExists = (name: string): boolean =>
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  const taskColumns = (): string[] =>
    (database.pragma('table_info(tasks)') as Array<{ name: string }>).map((column) => column.name);

  /** Back to a board from before workflows: neither table, none of the task columns. */
  function toPreWorkflowsSchema(): void {
    database.exec('DROP TABLE task_links');
    database.exec('DROP TABLE workflows');
    database.exec('DROP INDEX idx_tasks_workflow');
    for (const column of WORKFLOW_TASK_COLUMNS) database.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
  }

  /** Fail the migration at the `tasks.workflow_id` ALTER, after the `workflows` table was created. */
  function failAtTheWorkflowIdColumn(): void {
    const realExec = database.exec.bind(database);
    vi.spyOn(database, 'exec').mockImplementation((sql: string) => {
      if (sql.includes('ADD COLUMN workflow_id ')) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return realExec(sql);
    });
  }

  beforeEach(() => {
    database = openTestDatabase();
    database.pragma('foreign_keys = ON');
    runProjectMigrations(database);
    toPreWorkflowsSchema();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  it('leaves nothing behind when a step fails, so the table never lands without the column', () => {
    failAtTheWorkflowIdColumn();

    expect(() => runProjectMigrations(database)).toThrow('disk I/O error');

    expect(tableExists('workflows')).toBe(false);
    expect(tableExists('task_links')).toBe(false);
    expect(taskColumns()).not.toContain('workflow_id');
  });

  it('finishes on the next run after a failed one', () => {
    failAtTheWorkflowIdColumn();
    expect(() => runProjectMigrations(database)).toThrow('disk I/O error');
    vi.restoreAllMocks();

    runProjectMigrations(database);

    expect(tableExists('workflows')).toBe(true);
    expect(tableExists('task_links')).toBe(true);
    expect(taskColumns()).toEqual(expect.arrayContaining(WORKFLOW_TASK_COLUMNS));
  });

  it('finishes a board an older build left with the table and without the column', () => {
    // What a failed run looked like before the migration was one transaction:
    // its first statement, and nothing after it.
    database.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        brief TEXT,
        source_task_id TEXT,
        state TEXT NOT NULL DEFAULT 'draft',
        draft_json TEXT,
        color_slot INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )
    `);

    runProjectMigrations(database);

    expect(taskColumns()).toEqual(expect.arrayContaining(WORKFLOW_TASK_COLUMNS));
    expect(tableExists('task_links')).toBe(true);
  });
});
