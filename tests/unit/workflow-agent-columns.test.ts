/**
 * `{{columns}}` on real, migrated SQLite: one line per column a task can visit,
 * with how many of the last finished tasks went through it once any has
 * finished. The counts come from `task_moves`, which every move writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { describeColumnsForPlanning } = await import('../../src/main/workflows/workflow-agent-prompt');

import { openTestDatabase } from './helpers/test-database';

describe('{{columns}}', () => {
  let db: Database.Database;

  beforeEach(() => {
    harness.dbs.clear();
    db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set('home', db);
  });

  function lane(name: string): string {
    const found = new SwimlaneRepository(db).list().find((candidate) => candidate.name === name || candidate.role === name);
    if (!found) throw new Error(`No column ${name}`);
    return found.id;
  }

  it('names each column a task can visit, and no counts before any task has finished', () => {
    const lines = describeColumnsForPlanning('home').split('\n');
    expect(lines[0]).toMatch(/^1\. Planning: An agent in plan mode, whose plan the user approves unless a task sets its own planApproval\.$/);
    expect(lines.some((line) => line.includes('finished tasks'))).toBe(false);
  });

  it('says when Kangentic approves a plan column\'s plans', () => {
    new SwimlaneRepository(db).update({ id: lane('Planning'), plan_approval: 'automatic' });
    const lines = describeColumnsForPlanning('home').split('\n');
    expect(lines[0]).toMatch(/^1\. Planning: An agent in plan mode, whose plan Kangentic approves unless a task sets its own planApproval\.$/);
  });

  it('counts how many of the last finished tasks went through each column', () => {
    const tasks = new TaskRepository(db);
    for (const title of ['One', 'Two']) {
      const task = tasks.create({ title, description: '', swimlane_id: lane('todo') });
      tasks.move({ taskId: task.id, targetSwimlaneId: lane('Executing'), targetPosition: 0 }, { origin: 'workflow' });
      tasks.move({ taskId: task.id, targetSwimlaneId: lane('done'), targetPosition: 0 }, { origin: 'workflow' });
    }
    // Done is the archive lane (`is_archived`), which the counts must still find.
    const lines = describeColumnsForPlanning('home').split('\n');
    expect(lines.find((line) => line.startsWith('2. Executing'))).toContain('2 of the last 2 finished tasks went through it.');
    expect(lines.find((line) => line.startsWith('1. Planning'))).toContain('0 of the last 2 finished tasks went through it.');
  });
});
