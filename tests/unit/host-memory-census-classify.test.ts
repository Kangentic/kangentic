/**
 * Where a tagged task stands for the low-memory census (Sentry DESKTOP-5C, 5P):
 * `classifyTaskAcrossOpenProjects` in src/main/diagnostics/host-memory-census.ts.
 * The census splits a task's leftover commit into `terminal_task` (archived, or
 * in a To Do or Done column, the startup sweep's own test) and the mid-board
 * groups, and a tag no open project knows into `unknown_tag`. Misread a column
 * and the next event blames a parked task's agent for a Done task's leftovers,
 * or the other way round. The databases here are real, migrated and seeded; only
 * the open-project lookup is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';

const { openDatabases } = vi.hoisted(() => ({ openDatabases: new Map<string, unknown>() }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/mock', getVersion: () => '0.0.0' } }));
vi.mock('../../src/main/db/database', () => ({
  openProjectDbIds: () => [...openDatabases.keys()],
  getOpenProjectDb: (projectId: string) => openDatabases.get(projectId) ?? null,
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { classifyTaskAcrossOpenProjects } = await import('../../src/main/diagnostics/host-memory-census');

function openProject(projectId: string): Database.Database {
  const database = openTestDatabase();
  database.exec('PRAGMA foreign_keys = ON');
  runProjectMigrations(database);
  openDatabases.set(projectId, database);
  return database;
}

/** A task in the seeded column with this name. */
function taskIn(database: Database.Database, columnName: string): string {
  const column = new SwimlaneRepository(database).list().find((lane) => lane.name === columnName);
  if (!column) throw new Error(`The seeded board has no ${columnName} column`);
  return new TaskRepository(database).create({ title: 'Census probe', description: '', swimlane_id: column.id }).id;
}

describe('classifyTaskAcrossOpenProjects', () => {
  beforeEach(() => {
    openDatabases.clear();
  });

  afterEach(() => {
    for (const database of openDatabases.values()) (database as Database.Database).close();
    openDatabases.clear();
  });

  it('calls a task in a working column mid-board', () => {
    const database = openProject('board');
    expect(classifyTaskAcrossOpenProjects(taskIn(database, 'Executing'))).toBe('mid_board');
    expect(classifyTaskAcrossOpenProjects(taskIn(database, 'Planning'))).toBe('mid_board');
  });

  it('calls a task in To Do or Done terminal', () => {
    const database = openProject('board');
    expect(classifyTaskAcrossOpenProjects(taskIn(database, 'To Do'))).toBe('terminal');
    expect(classifyTaskAcrossOpenProjects(taskIn(database, 'Done'))).toBe('terminal');
  });

  it('calls an archived task terminal whatever column it still names', () => {
    const database = openProject('board');
    const taskId = taskIn(database, 'Executing');
    new TaskRepository(database).archive(taskId);
    expect(classifyTaskAcrossOpenProjects(taskId)).toBe('terminal');
  });

  it('finds a task in the second open project, past one that does not have it', () => {
    openProject('first');
    const second = openProject('second');
    expect(classifyTaskAcrossOpenProjects(taskIn(second, 'Code Review'))).toBe('mid_board');
  });

  it('calls a task no open project has unknown', () => {
    const closed = openTestDatabase();
    runProjectMigrations(closed);
    const taskInClosedProject = taskIn(closed, 'Executing');
    closed.close();
    openProject('board');
    expect(classifyTaskAcrossOpenProjects(taskInClosedProject)).toBe('unknown');
    expect(classifyTaskAcrossOpenProjects('dddddddd-4444-4444-8444-444444444444')).toBe('unknown');
  });
});
