/**
 * Migration + real-SQL round-trip for the `result_tokens_read_at` column on
 * `sessions` (src/main/db/migrations/project-schema.ts), which the earlier-run
 * Tokens fill stamps after a transcript read that answered but left a record
 * nothing to keep, so it does not parse that transcript on every launch.
 *
 * Modelled on session-pty-grid-migration.test.ts: the REAL migration against a
 * REAL in-memory better-sqlite3 database, read back through the REAL repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

describe('runProjectMigrations - sessions.result_tokens_read_at', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runProjectMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  function readAtColumns(): TableColumnInfo[] {
    return (db.pragma('table_info(sessions)') as TableColumnInfo[]).filter((column) => column.name === 'result_tokens_read_at');
  }

  it('adds one nullable TEXT column', () => {
    const columns = readAtColumns();
    expect(columns).toHaveLength(1);
    expect(columns[0].type).toBe('TEXT');
    expect(columns[0].notnull).toBe(0);
  });

  it('is idempotent: a second run neither throws nor duplicates the column', () => {
    expect(() => runProjectMigrations(db)).not.toThrow();
    expect(readAtColumns()).toHaveLength(1);
  });

  it('round-trips through the real repository: an insert reads back NULL, a mark writes a timestamp', () => {
    const repository = new SessionRepository(db);
    const swimlane = db.prepare('SELECT id FROM swimlanes ORDER BY position LIMIT 1').get() as { id: string };
    const task = new TaskRepository(db).create({ title: 'Tokens task', description: '', swimlane_id: swimlane.id });
    const inserted = repository.insert({
      id: 'session-tokens-1',
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
    expect(inserted.result_tokens_read_at).toBeNull();
    expect(repository.findByAnyId('session-tokens-1')?.result_tokens_read_at).toBeNull();

    repository.markResultTokensRead('session-tokens-1');

    expect(repository.findByAnyId('session-tokens-1')?.result_tokens_read_at).toEqual(expect.any(String));
  });
});
