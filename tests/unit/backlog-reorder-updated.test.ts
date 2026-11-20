/**
 * A drag in the backlog counts as activity (task #1137): `BacklogRepository.reorder` stamps the
 * moved row's `updated_at`, so the list's Updated column and its sort show it as just changed.
 * The rows it displaced keep their own time. Real SQLite.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BacklogRepository } from '../../src/main/db/repositories/backlog-repository';

const OLD_TIME = '2026-01-01T00:00:00.000Z';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

function seededRepository(): { repository: BacklogRepository; ids: string[] } {
  const database = new Database(':memory:');
  openDatabases.push(database);
  runProjectMigrations(database);
  const repository = new BacklogRepository(database);
  const ids = ['First', 'Second', 'Third'].map((title) => repository.create({ title }).id);
  database.prepare('UPDATE backlog_tasks SET updated_at = ?').run(OLD_TIME);
  return { repository, ids };
}

describe('BacklogRepository.reorder', () => {
  it('stamps the moved row and leaves the rows it displaced alone', () => {
    const { repository, ids } = seededRepository();
    const [first, second, third] = ids;
    repository.reorder([third, first, second], third);

    const rows = repository.list();
    expect(rows.map((row) => row.id)).toEqual([third, first, second]);
    expect(Date.parse(repository.getById(third)?.updated_at ?? '')).toBeGreaterThan(Date.parse(OLD_TIME));
    expect(repository.getById(first)?.updated_at).toBe(OLD_TIME);
    expect(repository.getById(second)?.updated_at).toBe(OLD_TIME);
  });

  it('stamps nothing when the named row is not among the reordered ids', () => {
    const { repository, ids } = seededRepository();
    const [first, second, third] = ids;
    // `third` exists but is outside the reordered list, so it was not moved by this drag.
    repository.reorder([second, first], third);
    expect(repository.list().every((row) => row.updated_at === OLD_TIME)).toBe(true);
  });

  it('stamps nothing when no row is named as moved', () => {
    const { repository, ids } = seededRepository();
    repository.reorder([...ids].reverse());
    expect(repository.list().every((row) => row.updated_at === OLD_TIME)).toBe(true);
  });
});
