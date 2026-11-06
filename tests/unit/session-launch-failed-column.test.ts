/**
 * `sessions.launch_failed_at` marks a fresh launch found never to have started, so
 * a Resume starts it fresh with its own prompt instead of `--resume` on a
 * conversation the agent never wrote. Every other row keeps NULL. Runs the real
 * migrations and the real `SessionRepository.markLaunchFailed` over an in-memory
 * database: the other tests mock the method or write the column by hand.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';

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

function launchColumns(database: Database.Database): Array<{ name: string; type: string; dflt_value: string | null }> {
  return (database.pragma('table_info(sessions)') as Array<{ name: string; type: string; dflt_value: string | null }>)
    .filter((column) => column.name === 'launch_failed_at');
}

function readFailedAt(database: Database.Database, id: string): string | null {
  return (database.prepare('SELECT launch_failed_at FROM sessions WHERE id = ?').get(id) as { launch_failed_at: string | null }).launch_failed_at;
}

describe('sessions.launch_failed_at', () => {
  it('is added in place to a sessions table made before it, and a second run changes nothing', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-old' });
    database.exec('ALTER TABLE sessions DROP COLUMN launch_failed_at');
    expect(launchColumns(database)).toHaveLength(0);

    runProjectMigrations(database);
    const [column] = launchColumns(database);
    expect(column).toMatchObject({ type: 'TEXT', dflt_value: 'NULL' });
    // The row made before the column reads as never failed.
    expect(readFailedAt(database, 'session-old')).toBeNull();

    expect(() => runProjectMigrations(database)).not.toThrow();
    expect(launchColumns(database)).toHaveLength(1);
  });

  it('reads null on a new record', () => {
    const database = openProjectDatabase();
    const inserted = new SessionRepository(database).insert({ ...BASE_ROW, id: 'session-new' });

    expect(inserted.launch_failed_at).toBeNull();
    expect(readFailedAt(database, 'session-new')).toBeNull();
  });
});

describe('SessionRepository.markLaunchFailed', () => {
  it('writes a UTC ISO timestamp for that record only', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-failed' });
    repository.insert({ ...BASE_ROW, id: 'session-other', started_at: '2026-01-01T00:00:01.000Z' });

    const before = Date.now();
    repository.markLaunchFailed('session-failed');
    const after = Date.now();

    const stamp = readFailedAt(database, 'session-failed');
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(stamp as string).toISOString()).toBe(stamp);
    expect(Date.parse(stamp as string)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stamp as string)).toBeLessThanOrEqual(after);
    expect(readFailedAt(database, 'session-other')).toBeNull();
  });

  it('is what the latest-record read the held messages use sees', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-failed' });
    repository.markLaunchFailed('session-failed');

    expect(repository.getLatestForTask('task-1')?.launch_failed_at).toBeTruthy();
  });

  it('changes nothing for an id with no record', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.insert({ ...BASE_ROW, id: 'session-real' });

    expect(() => repository.markLaunchFailed('session-missing')).not.toThrow();
    expect(readFailedAt(database, 'session-real')).toBeNull();
  });
});
