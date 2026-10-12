/**
 * `linkEndState` (src/main/workflows/workflow-tasks.ts): where one end of a task
 * link stands against a read of its workflow's tasks. `gone` drops the link,
 * `held` keeps it holding, so a doubtful end must read as `held`.
 *
 * Direct cases for each branch, on a real migrated SQLite database per project.
 * The host test (workflow-engine-host-gone-links.test.ts) reaches the engine
 * through a project in `unreadProjectIds`, which returns before the lookup, so
 * the fallback for a lookup that throws is only reached here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  opened: [] as string[],
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    harness.opened.push(projectId);
    const projectDatabase = harness.dbs.get(projectId);
    if (!projectDatabase) throw new Error(`database is locked for ${projectId}`);
    return projectDatabase;
  },
  // Null when the project has no file, as the real one answers; a locked one throws.
  getExistingProjectDb: (projectId: string) => {
    harness.opened.push(projectId);
    if (projectId === 'locked') throw new Error('database is locked for locked');
    return harness.dbs.get(projectId) ?? null;
  },
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { linkEndState } = await import('../../src/main/workflows/workflow-tasks');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const WORKFLOW_ID = 'workflow-usage-budgets';
const NO_TASK_IDS: ReadonlySet<string> = new Set();
const NO_PROJECT_IDS: ReadonlySet<string> = new Set();

describe('linkEndState', () => {
  let registeredProjectIds: Set<string>;
  let context: IpcContext;

  function database(projectId: string): Database.Database {
    const projectDatabase = openTestDatabase();
    projectDatabase.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(projectDatabase);
    harness.dbs.set(projectId, projectDatabase);
    return projectDatabase;
  }

  /** A task of `workflowId` in the first lane of the project's board. */
  function createTask(projectId: string, workflowId: string): string {
    const projectDatabase = harness.dbs.get(projectId) as Database.Database;
    return new TaskRepository(projectDatabase).create({
      title: 'Budget API',
      description: '',
      swimlane_id: new SwimlaneRepository(projectDatabase).list()[0].id,
      workflow: {
        workflow_id: workflowId,
        workflow_project_id: 'home',
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
        canvas_x: null,
        canvas_y: null,
      },
    }).id;
  }

  beforeEach(() => {
    harness.dbs.clear();
    harness.opened.length = 0;
    registeredProjectIds = new Set(['home', 'broken', 'locked']);
    context = {
      projectRepo: {
        getById: (id: string) => (registeredProjectIds.has(id) ? { id, name: id, path: `/mock/${id}` } : undefined),
      },
    } as unknown as IpcContext;
    database('home');
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  it('reads an end the read found as present, without opening its project', () => {
    const taskId = createTask('home', WORKFLOW_ID);

    const state = linkEndState(context, { projectId: 'home', taskId }, WORKFLOW_ID, new Set([taskId]), NO_PROJECT_IDS);

    expect(state).toBe('present');
    expect(harness.opened).toEqual([]);
  });

  it('holds an end whose project failed to open in the read, without opening it again', () => {
    const state = linkEndState(context, { projectId: 'broken', taskId: 'task-1' }, WORKFLOW_ID, NO_TASK_IDS, new Set(['broken']));

    expect(state).toBe('held');
    expect(harness.opened).toEqual([]);
  });

  it('reads an end whose project is no longer registered as gone, without opening it', () => {
    registeredProjectIds.delete('home');

    const state = linkEndState(context, { projectId: 'home', taskId: 'task-1' }, WORKFLOW_ID, NO_TASK_IDS, NO_PROJECT_IDS);

    expect(state).toBe('gone');
    expect(harness.opened).toEqual([]);
  });

  it('reads an end whose row is missing from an open project as gone', () => {
    const state = linkEndState(context, { projectId: 'home', taskId: 'no-such-task' }, WORKFLOW_ID, NO_TASK_IDS, NO_PROJECT_IDS);

    expect(state).toBe('gone');
    expect(harness.opened).toEqual(['home']);
  });

  it('reads an end whose row moved to another workflow as gone', () => {
    const taskId = createTask('home', 'another-workflow');

    const state = linkEndState(context, { projectId: 'home', taskId }, WORKFLOW_ID, NO_TASK_IDS, NO_PROJECT_IDS);

    expect(state).toBe('gone');
  });

  it('holds an end whose row is still in this workflow but missing from the read', () => {
    const taskId = createTask('home', WORKFLOW_ID);

    const state = linkEndState(context, { projectId: 'home', taskId }, WORKFLOW_ID, NO_TASK_IDS, NO_PROJECT_IDS);

    expect(state).toBe('held');
  });

  it('holds an end whose registered project has no database file, rather than reading it as gone', () => {
    // 'broken' is registered and absent from the unread set, so the check reaches
    // its own lookup, which answers null for a project with no file.
    const state = linkEndState(context, { projectId: 'broken', taskId: 'task-1' }, WORKFLOW_ID, NO_TASK_IDS, NO_PROJECT_IDS);

    expect(harness.opened).toEqual(['broken']);
    expect(state).toBe('held');
  });

  it('holds an end when the lookup itself throws, for a registered project that was not unread', () => {
    const state = linkEndState(context, { projectId: 'locked', taskId: 'task-1' }, WORKFLOW_ID, NO_TASK_IDS, NO_PROJECT_IDS);

    expect(harness.opened).toEqual(['locked']);
    expect(state).toBe('held');
  });
});
