/**
 * Real-SQL tests for the `handoffs` table (src/main/db/migrations/project-schema.ts)
 * and the HandoffRepository that reads and writes it
 * (src/main/db/repositories/handoff-repository.ts).
 *
 * Every other suite that touches handoffs mocks the repository, so none of them
 * ran the real INSERT against the real schema. That is how a NOT NULL
 * `packet_json` column, left behind when the repository stopped writing it,
 * failed every cross-agent handoff insert. spawnAgent caught the error and only
 * logged it, so the Handoff Chain and kangentic_get_handoff_context never had a
 * row to read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { HandoffRepository } from '../../src/main/db/repositories/handoff-repository';
import { openTestDatabase } from './helpers/test-database';

interface TableColumnInfo {
  name: string;
  notnull: number;
}

const EXPECTED_COLUMNS: TableColumnInfo[] = [
  { name: 'id', notnull: 0 },
  { name: 'task_id', notnull: 1 },
  { name: 'from_session_id', notnull: 0 },
  { name: 'to_session_id', notnull: 0 },
  { name: 'from_agent', notnull: 1 },
  { name: 'to_agent', notnull: 1 },
  { name: 'trigger', notnull: 1 },
  { name: 'created_at', notnull: 1 },
  { name: 'session_history_path', notnull: 0 },
];

describe('handoffs migration + repository round-trip', () => {
  let database: DatabaseType.Database;

  beforeEach(() => {
    database = openTestDatabase();
    // Production sets this before running migrations (src/main/db/database.ts).
    database.pragma('foreign_keys = ON');
    runProjectMigrations(database);
  });

  afterEach(() => {
    database.close();
  });

  /** `tasks.swimlane_id` and `updated_at` are NOT NULL, so a task needs a seeded lane. */
  function seedTask(taskId: string): void {
    const seededSwimlane = database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    database
      .prepare('INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, `Task ${taskId}`, seededSwimlane.id, 0, now, now);
  }

  /** `from_session_id` and `to_session_id` are foreign keys, so a referenced session must exist. */
  function seedSession(sessionId: string, taskId: string): void {
    database
      .prepare(`
        INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(sessionId, taskId, 'agent', 'claude', '/mock/project', 'running', new Date().toISOString());
  }

  function columnsOfHandoffs(): TableColumnInfo[] {
    return (database.pragma('table_info(handoffs)') as TableColumnInfo[])
      .map((column) => ({ name: column.name, notnull: column.notnull }));
  }

  it('has exactly the columns the repository writes, with no packet_json', () => {
    expect(columnsOfHandoffs()).toEqual(EXPECTED_COLUMNS);
  });

  it('is idempotent across repeated migration runs', () => {
    expect(() => runProjectMigrations(database)).not.toThrow();
    expect(columnsOfHandoffs()).toEqual(EXPECTED_COLUMNS);
  });

  it('stores a handoff and reads it back by task', () => {
    seedTask('task-1');
    seedSession('source-session', 'task-1');
    const repository = new HandoffRepository(database);

    const inserted = repository.insert({
      task_id: 'task-1',
      from_session_id: 'source-session',
      to_session_id: null,
      from_agent: 'claude',
      to_agent: 'codex',
      trigger: 'column_transition',
      session_history_path: '/mock/history/source-session.jsonl',
    });

    // UTC ISO 8601, never SQLite's naive CURRENT_TIMESTAMP.
    expect(inserted.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(repository.listByTaskId('task-1')).toEqual([inserted]);
    expect(repository.getLatestForTask('task-1')).toEqual(inserted);
  });

  it('stores a handoff whose source agent left no session file', () => {
    // The shape spawnAgent sends when the source agent has no history file to
    // point at, or no earlier session row on the task.
    seedTask('task-1');
    const repository = new HandoffRepository(database);

    const inserted = repository.insert({
      task_id: 'task-1',
      from_session_id: null,
      to_session_id: null,
      from_agent: 'cursor',
      to_agent: 'claude',
      trigger: 'column_transition',
      session_history_path: null,
    });

    expect(repository.listByTaskId('task-1')).toEqual([inserted]);
  });

  it('links the target session after spawn, for forward and backward lookups', () => {
    seedTask('task-1');
    seedSession('source-session', 'task-1');
    seedSession('target-session', 'task-1');
    const repository = new HandoffRepository(database);
    const inserted = repository.insert({
      task_id: 'task-1',
      from_session_id: 'source-session',
      to_session_id: null,
      from_agent: 'claude',
      to_agent: 'gemini',
      trigger: 'column_transition',
      session_history_path: '/mock/history/source-session.jsonl',
    });

    repository.updateToSession(inserted.id, 'target-session');

    const linked = { ...inserted, to_session_id: 'target-session' };
    expect(repository.getByFromSession('source-session')).toEqual(linked);
    expect(repository.getByToSession('target-session')).toEqual(linked);
  });

  it('drops packet_json from a database created before the fix and keeps its rows', () => {
    // The shape every shipped build left: the original table, plus the
    // session_history_path column a later migration added beside packet_json.
    database.exec('DROP TABLE handoffs');
    database.exec(`
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        to_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        trigger TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        session_history_path TEXT
      )
    `);
    seedTask('task-1');
    seedSession('source-session', 'task-1');
    database
      .prepare(`
        INSERT INTO handoffs (id, task_id, from_session_id, to_session_id, from_agent, to_agent, trigger, packet_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run('legacy-handoff', 'task-1', 'source-session', null, 'claude', 'codex', 'column_transition', '{"summary":"old packet"}', '2026-04-01T00:00:00.000Z');

    expect(() => runProjectMigrations(database)).not.toThrow();

    expect(columnsOfHandoffs()).toEqual(EXPECTED_COLUMNS);
    const repository = new HandoffRepository(database);
    expect(repository.listByTaskId('task-1')).toEqual([{
      id: 'legacy-handoff',
      task_id: 'task-1',
      from_session_id: 'source-session',
      to_session_id: null,
      from_agent: 'claude',
      to_agent: 'codex',
      trigger: 'column_transition',
      session_history_path: null,
      created_at: '2026-04-01T00:00:00.000Z',
    }]);

    const inserted = repository.insert({
      task_id: 'task-1',
      from_session_id: 'source-session',
      to_session_id: null,
      from_agent: 'codex',
      to_agent: 'claude',
      trigger: 'column_transition',
      session_history_path: null,
    });
    expect(repository.getLatestForTask('task-1')).toEqual(inserted);
  });
});
