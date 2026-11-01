/**
 * A column's agent limit as the swimlane repository stores and reads it, against
 * the real schema.
 *
 * `max_agents` is NULL for no limit. A stored value under one would hold every
 * task in the column forever, and the column carries no CHECK constraint, so a
 * hand-edited database or a write from an older build can put one there.
 * `mapRow` reads such a value as no limit. A mock of the database could not tell
 * a repository that narrows from one that passes the raw number through.
 *
 * Red-green: store `row.max_agents` as is in `mapRow` and the 0 and -3 reads
 * return the raw number; drop `max_agents` from the `create` insert and the
 * create round trip reads null.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';

describe('SwimlaneRepository: max_agents', () => {
  let database: DatabaseType.Database;
  let repository: SwimlaneRepository;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    repository = new SwimlaneRepository(database);
  });

  afterEach(() => database.close());

  const limitOf = (laneId: string) => repository.list().find((lane) => lane.id === laneId)?.max_agents;

  it('stores the limit a column is created with and reads it back', () => {
    const lane = repository.create({ name: 'Merge', max_agents: 1 });

    expect(lane.max_agents).toBe(1);
    expect(limitOf(lane.id)).toBe(1);
    expect(repository.getById(lane.id)?.max_agents).toBe(1);
  });

  it('creates a column with no limit when none is given', () => {
    const lane = repository.create({ name: 'Merge' });

    expect(lane.max_agents).toBeNull();
    expect(limitOf(lane.id)).toBeNull();
  });

  it('updates the limit and clears it again with null', () => {
    const lane = repository.create({ name: 'Merge' });

    repository.update({ id: lane.id, max_agents: 3 });
    expect(limitOf(lane.id)).toBe(3);

    repository.update({ id: lane.id, max_agents: null });
    expect(limitOf(lane.id)).toBeNull();
  });

  it('leaves the limit alone when an update does not mention it', () => {
    const lane = repository.create({ name: 'Merge', max_agents: 2 });

    repository.update({ id: lane.id, name: 'Merge queue' });

    expect(limitOf(lane.id)).toBe(2);
  });

  it.each([0, -3])('reads a stored limit of %i as no limit, so the column cannot hold its tasks forever', (stored) => {
    const lane = repository.create({ name: 'Merge', max_agents: 1 });
    database.prepare('UPDATE swimlanes SET max_agents = ? WHERE id = ?').run(stored, lane.id);

    expect(limitOf(lane.id)).toBeNull();
    expect(repository.getById(lane.id)?.max_agents).toBeNull();
  });

  it('reads a NULL limit written straight to the row as no limit', () => {
    const lane = repository.create({ name: 'Merge', max_agents: 1 });
    database.prepare('UPDATE swimlanes SET max_agents = NULL WHERE id = ?').run(lane.id);

    expect(limitOf(lane.id)).toBeNull();
  });
});
