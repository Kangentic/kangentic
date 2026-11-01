/**
 * `CommandTerminalHistoryRepository.setLabel` writes `named_by_user =
 * MAX(named_by_user, ?)`: a user's mark, once set, is never taken off by a later
 * write, so the namer cannot take a user's name back after the user renamed or
 * cleared it. Run against a real migrated project database.
 *
 * Red-green, from toggling the repository and restoring it: replacing the
 * `MAX(named_by_user, ?)` with a plain `?` leaves the mark at 0 after the second
 * write, and the first test fails.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function setup() {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const repository = new CommandTerminalHistoryRepository(database);
  repository.recordConversation({ agentSessionId: 'conversation-a', agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
  return repository;
}

describe('CommandTerminalHistoryRepository.setLabel named_by_user', () => {
  it('keeps the user mark at 1 when a later write does not claim it, while the label still changes', () => {
    const repository = setup();

    repository.setLabel('conversation-a', 'x', true);
    repository.setLabel('conversation-a', 'y');

    expect(repository.get('conversation-a')).toMatchObject({ label: 'y', named_by_user: 1 });
  });

  it('keeps the user mark at 1 when a later write explicitly says it is not the user\'s', () => {
    const repository = setup();

    repository.setLabel('conversation-a', 'x', true);
    repository.setLabel('conversation-a', 'y', false);

    expect(repository.get('conversation-a')).toMatchObject({ label: 'y', named_by_user: 1 });
  });

  it('keeps the user mark at 1 through a clear', () => {
    const repository = setup();

    repository.setLabel('conversation-a', 'x', true);
    repository.setLabel('conversation-a', null);

    expect(repository.get('conversation-a')).toMatchObject({ label: null, named_by_user: 1 });
  });

  it('leaves the mark at 0 while no write claims it, and sets it on the first that does', () => {
    const repository = setup();

    repository.setLabel('conversation-a', 'derived');
    expect(repository.get('conversation-a')).toMatchObject({ label: 'derived', named_by_user: 0 });

    repository.setLabel('conversation-a', 'chosen', true);
    expect(repository.get('conversation-a')).toMatchObject({ label: 'chosen', named_by_user: 1 });
  });
});
