/**
 * isNeverStarted: the guards that decide whether a workflow's delete may take a
 * task along. Real, migrated SQLite behind a mocked board lookup, so the column
 * role, the archive flag and the missing-board answer are read from rows, not
 * from doubles.
 *
 * The session, worktree and move checks are exercised end to end in
 * workflow-service.test.ts ("deleting the tasks that never started"). The cases
 * here are the ones that file cannot reach: a task that sits in a column other
 * than To Do with nothing else against it, an archived task, and a board that
 * does not exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));

const { isNeverStarted } = await import('../../src/main/workflows/workflow-never-started');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');

import { openTestDatabase } from './helpers/test-database';

describe('isNeverStarted', () => {
  let db: Database.Database;
  let tasks: InstanceType<typeof TaskRepository>;

  beforeEach(() => {
    harness.dbs.clear();
    db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set('home', db);
    tasks = new TaskRepository(db);
  });

  afterEach(() => {
    db.close();
    harness.dbs.clear();
  });

  const lanes = () => new SwimlaneRepository(db).list();
  const laneNamed = (name: string) => lanes().find((lane) => lane.name === name)!;
  const todo = () => lanes().find((lane) => lane.role === 'todo')!;

  function taskIn(swimlaneId: string) {
    const created = tasks.create({ title: 'Budgets API', description: '', swimlane_id: swimlaneId });
    return tasks.getById(created.id)!;
  }

  it('answers true for a task created in To Do that nothing has touched', () => {
    const fresh = taskIn(todo().id);

    // Without the lanes argument, so the board's columns are read the way a delete reads them.
    expect(isNeverStarted('home', fresh)).toBe(true);
    expect(isNeverStarted('home', fresh, lanes())).toBe(true);
  });

  it('answers false for a task that sits in a column other than To Do, though it has no session, worktree or move out of its column', () => {
    // Born in Planning: its only move row is the create into Planning, so the move check
    // alone would call it never started. Only the column's role says it is not a brief.
    const planning = laneNamed('Planning');
    const inPlanning = taskIn(planning.id);
    expect(inPlanning.session_id).toBeNull();
    expect(inPlanning.worktree_path).toBeNull();
    expect(inPlanning.archived_at).toBeNull();

    expect(isNeverStarted('home', inPlanning)).toBe(false);
    expect(isNeverStarted('home', inPlanning, lanes())).toBe(false);

    const inDone = taskIn(lanes().find((lane) => lane.role === 'done')!.id);
    expect(isNeverStarted('home', inDone)).toBe(false);
  });

  it('answers false for an archived task that sits in To Do with nothing else against it', () => {
    const task = taskIn(todo().id);
    expect(isNeverStarted('home', task)).toBe(true);

    tasks.archive(task.id);
    const archived = tasks.getById(task.id)!;

    expect(archived.archived_at).not.toBeNull();
    expect(archived.swimlane_id).toBe(todo().id);
    expect(isNeverStarted('home', archived)).toBe(false);
  });

  it('answers false for a project whose database does not exist', () => {
    const fresh = taskIn(todo().id);
    expect(isNeverStarted('home', fresh)).toBe(true);

    // Default columns: a board that cannot be read has none.
    expect(isNeverStarted('ghost', fresh)).toBe(false);
    // Columns the caller already read (a delete reads them once), so the answer rests on the missing database alone.
    expect(isNeverStarted('ghost', fresh, lanes())).toBe(false);
  });
});
