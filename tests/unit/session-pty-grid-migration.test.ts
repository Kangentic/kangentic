/**
 * Migration + real-SQL round-trip for the `last_pty_cols` / `last_pty_rows`
 * columns on `sessions` (src/main/db/migrations/project-schema.ts) and the
 * SessionRepository UPDATE that writes them.
 *
 * session-pty-grid-persistence.test.ts drives the repository against a mock DB
 * that never executes SQL, so a column missing from the migration would leave
 * it green while every write failed. This file runs the REAL migration against
 * a REAL in-memory better-sqlite3 database and reads the row back through the
 * REAL repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { recordedPtyGrid } from '../../src/main/db/recorded-pty-grid';

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

const GRID_COLUMNS = ['last_pty_cols', 'last_pty_rows'];

describe('runProjectMigrations - sessions.last_pty_cols / last_pty_rows', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runProjectMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  function gridColumns(): TableColumnInfo[] {
    return (db.pragma('table_info(sessions)') as TableColumnInfo[]).filter((column) => GRID_COLUMNS.includes(column.name));
  }

  function insertSession(repository: SessionRepository): string {
    const swimlane = db.prepare('SELECT id FROM swimlanes ORDER BY position LIMIT 1').get() as { id: string };
    const task = new TaskRepository(db).create({ title: 'Grid task', description: '', swimlane_id: swimlane.id });
    repository.insert({
      id: 'session-grid-1',
      task_id: task.id,
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: 'agent-1',
      command: 'claude',
      cwd: '/project',
      permission_mode: null,
      prompt: null,
      status: 'running',
      exit_code: null,
      started_at: new Date().toISOString(),
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
    });
    return 'session-grid-1';
  }

  it('adds two nullable INTEGER columns', () => {
    const columns = gridColumns();
    expect(columns.map((column) => column.name).sort()).toEqual([...GRID_COLUMNS].sort());
    for (const column of columns) {
      expect(column.type).toBe('INTEGER');
      expect(column.notnull).toBe(0);
    }
  });

  it('is idempotent: a second run neither throws nor duplicates the columns', () => {
    expect(() => runProjectMigrations(db)).not.toThrow();
    expect(gridColumns()).toHaveLength(2);
  });

  it('round-trips through the real repository: an insert reads back no grid, an update writes one', () => {
    const repository = new SessionRepository(db);
    const sessionId = insertSession(repository);
    expect(recordedPtyGrid(repository.findByAnyId(sessionId))).toBeUndefined();

    repository.updatePtyGrid(sessionId, { cols: 210, rows: 48 });

    expect(recordedPtyGrid(repository.findByAnyId(sessionId))).toEqual({ cols: 210, rows: 48 });
  });
});
