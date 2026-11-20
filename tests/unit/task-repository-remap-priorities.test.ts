/**
 * Board tasks follow an edit of the project's priority list, as backlog items
 * do (#872): a deleted level's tasks become None and the levels above it shift
 * down, on a real migrated database. Before, only the backlog was remapped, so
 * a task promoted before the edit kept a number that named another level, and
 * an automation's Priority line, remapped the same way, stopped matching it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';

describe('TaskRepository.remapPriorities', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let todoLaneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    todoLaneId = new SwimlaneRepository(database).list().find((lane) => lane.role === 'todo')!.id;
  });

  afterEach(() => {
    database.close();
  });

  it('maps a deleted level to None and shifts the levels above it, leaving the rest', () => {
    const none = tasks.create({ title: 'none', description: '', swimlane_id: todoLaneId, priority: 0 });
    const low = tasks.create({ title: 'low', description: '', swimlane_id: todoLaneId, priority: 1 });
    const medium = tasks.create({ title: 'medium', description: '', swimlane_id: todoLaneId, priority: 2 });
    const urgent = tasks.create({ title: 'urgent', description: '', swimlane_id: todoLaneId, priority: 4 });

    // PrioritiesPopover's mapping for deleting level 2 (Medium) from five levels.
    const changed = tasks.remapPriorities({ 2: 0, 3: 2, 4: 3 });

    expect(changed).toBe(2);
    expect(tasks.getById(none.id)?.priority).toBe(0);
    expect(tasks.getById(low.id)?.priority).toBe(1);
    expect(tasks.getById(medium.id)?.priority).toBe(0);
    expect(tasks.getById(urgent.id)?.priority).toBe(3);
    expect(tasks.remapPriorities({})).toBe(0);
  });
});
