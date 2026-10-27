/**
 * A session whose agent CLI ran in a WSL distro records the distro on its row
 * (`sessions.cli_target`), so the readers and the reap find it after the
 * session ends. Every other row keeps NULL, which reads as this machine.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { parseStoredCliTarget, serializeCliTarget } from '../../src/main/agent/shared/cli-target';

function openProjectDatabase(): Database.Database {
  const database = new Database(':memory:');
  runProjectMigrations(database);
  database.prepare(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'Executing', 0, '2026-01-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-1', 1, 'Task', '', 'lane-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  return database;
}

const BASE_ROW = {
  task_id: 'task-1', session_type: 'claude_agent', isolated_swimlane_id: null,
  agent_session_id: 'agent-1', command: 'claude', cwd: '/mock/project', permission_mode: null, prompt: null,
  status: 'running' as const, exit_code: null, started_at: '2026-01-01T00:00:00.000Z', suspended_at: null,
  exited_at: null, suspended_by: null,
};

function readTarget(database: Database.Database, id: string): string | null {
  return (database.prepare('SELECT cli_target FROM sessions WHERE id = ?').get(id) as { cli_target: string | null }).cli_target;
}

describe('sessions.cli_target', () => {
  it('is added by the migrations, and running them again changes nothing', () => {
    const database = openProjectDatabase();
    runProjectMigrations(database);
    const columns = (database.pragma('table_info(sessions)') as Array<{ name: string; dflt_value: string | null }>)
      .filter((column) => column.name === 'cli_target');
    expect(columns).toHaveLength(1);
    expect(columns[0].dflt_value).toBe('NULL');
  });

  it('holds the distro a WSL session ran in, which reads back as the same target', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    const inserted = repository.insert({ ...BASE_ROW, id: 'session-wsl', cli_target: serializeCliTarget({ kind: 'wsl', distro: 'Ubuntu' }) });

    expect(inserted.cli_target).toBe('{"kind":"wsl","distro":"Ubuntu"}');
    expect(parseStoredCliTarget(readTarget(database, 'session-wsl'))).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('is NULL for a row inserted without one, as every row before it was', () => {
    const database = openProjectDatabase();
    const inserted = new SessionRepository(database).insert({ ...BASE_ROW, id: 'session-local' });

    expect(inserted.cli_target).toBeNull();
    expect(readTarget(database, 'session-local')).toBeNull();
    expect(parseStoredCliTarget(readTarget(database, 'session-local'))).toBeNull();
  });
});
