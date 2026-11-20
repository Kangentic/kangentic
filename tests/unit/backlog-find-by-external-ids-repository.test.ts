/**
 * The "already imported" check tells two saved sources of one provider apart
 * by the source's repository (#872), on a real migrated database. Two
 * Repository folder sources can each hold an `add-dark-mode`, and two GitHub
 * repos can each have an issue 12; matching by provider alone marked one
 * source's item imported because of the other's. A row with no repository,
 * imported before the column existed, still matches by provider alone, so an
 * upgrade never re-offers an item already imported.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BacklogRepository } from '../../src/main/db/repositories/backlog-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';

describe('BacklogRepository.findByExternalIds by repository', () => {
  let database: Database.Database;
  let backlog: BacklogRepository;
  let tasks: TaskRepository;
  let todoLaneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    backlog = new BacklogRepository(database);
    tasks = new TaskRepository(database);
    todoLaneId = new SwimlaneRepository(database).list().find((lane) => lane.role === 'todo')!.id;
  });

  afterEach(() => {
    database.close();
  });

  it('counts an id imported from the same repository, and not one from another', () => {
    backlog.create({ title: 'add-dark-mode', externalId: 'add-dark-mode', externalSource: 'repo_folder', externalRepository: 'openspec/changes' });

    expect(backlog.findByExternalIds('repo_folder', ['add-dark-mode'], 'openspec/changes')).toEqual(new Set(['add-dark-mode']));
    expect(backlog.findByExternalIds('repo_folder', ['add-dark-mode'], 'docs/rfcs')).toEqual(new Set());
  });

  it('carries the repository onto a promoted task, which still counts for its own source only', () => {
    tasks.create({
      title: 'Issue 12', description: '', swimlane_id: todoLaneId,
      externalId: '12', externalSource: 'github_issues', externalRepository: 'acme/web',
    });

    expect(backlog.findByExternalIds('github_issues', ['12'], 'acme/web')).toEqual(new Set(['12']));
    expect(backlog.findByExternalIds('github_issues', ['12'], 'acme/api')).toEqual(new Set());
  });

  it('still matches a row from before the column by provider alone, and a call with no repository', () => {
    backlog.create({ title: 'old', externalId: '7', externalSource: 'github_issues' });

    expect(backlog.findByExternalIds('github_issues', ['7'], 'acme/web')).toEqual(new Set(['7']));
    expect(backlog.findByExternalIds('github_issues', ['7'])).toEqual(new Set(['7']));
  });
});
