/**
 * The migrations behind agent accounts (task #1057) are idempotent, and a session row carries the
 * account it ran on. Real SQLite.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const openDatabases: Database.Database[] = [];

function track(database: Database.Database): Database.Database {
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('account migrations run twice', () => {
  it('global: no throw, one agent_accounts table', () => {
    const database = track(new Database(':memory:'));
    runGlobalMigrations(database);
    expect(() => runGlobalMigrations(database)).not.toThrow();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_accounts'").all();
    expect(tables).toHaveLength(1);
  });

  it('project: exactly one account_id column on sessions', () => {
    const database = track(new Database(':memory:'));
    runProjectMigrations(database);
    expect(() => runProjectMigrations(database)).not.toThrow();
    const columns = (database.pragma('table_info(sessions)') as Array<{ name: string }>).filter((column) => column.name === 'account_id');
    expect(columns).toHaveLength(1);
  });
});

describe('SessionRepository.insert and account_id', () => {
  function insertSession(repository: SessionRepository, id: string, accountId?: string | null) {
    return repository.insert({
      id,
      task_id: 'task-a',
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: `agent-${id}`,
      command: 'claude',
      cwd: '/mock/worktree',
      permission_mode: null,
      prompt: null,
      status: 'running',
      exit_code: null,
      started_at: '2027-01-15T10:00:00.000Z',
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
      ...(accountId !== undefined ? { account_id: accountId } : {}),
    });
  }

  it('reads back the account id it was given', () => {
    const database = track(openMigratedProjectDatabase());
    insertTask(database, 'task-a');
    const repository = new SessionRepository(database);
    expect(insertSession(repository, 'with-account', 'account-two').account_id).toBe('account-two');
    expect(repository.getLatestForTask('task-a')?.account_id).toBe('account-two');
  });

  it('reads null when no account was given', () => {
    const database = track(openMigratedProjectDatabase());
    insertTask(database, 'task-a');
    const repository = new SessionRepository(database);
    expect(insertSession(repository, 'no-account').account_id).toBeNull();
    expect(repository.getLatestForTask('task-a')?.account_id).toBeNull();
  });
});
