/**
 * `isRunningWorkflowStepTask` (src/main/workflows/workflow-home.ts): is the task
 * in a running workflow, in a column between To Do and Done?
 *
 * The generic idle notices ask this to leave such a task to its step check, and
 * the hang check asks it before it interrupts a turn, so a wrong "true" silences
 * a notice the user needs and a wrong "false" lets a second one fire. It is true
 * only for an unarchived task that has a workflow, in a column whose role is
 * neither `todo` nor `done`, whose workflow is `running`, and whose own
 * automations are not paused (a held task is a person's to work: nothing judges
 * it, so the generic notices come back). A read that fails counts as false,
 * which keeps the generic notice.
 *
 * Real, migrated SQLite (better-sqlite3). Each negative case is the positive
 * fixture with exactly one fact flipped, and asserts the positive first, so a
 * negative cannot pass because the fixture was wrong to begin with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Projects whose database throws when opened, as a locked file does. */
  broken: new Set<string>(),
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    // What better-sqlite3 throws for a locked file: an error carrying its SQLite code.
    if (harness.broken.has(projectId)) throw Object.assign(new Error(`database for ${projectId} is locked`), { code: 'SQLITE_BUSY' });
    return harness.dbs.get(projectId) ?? null;
  },
  getProjectDb: (projectId: string) => {
    throw new Error(`The step-task read must never open a database it was not given: ${projectId}`);
  },
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { isRunningWorkflowStepTask } = await import('../../src/main/workflows/workflow-home');

import { openTestDatabase } from './helpers/test-database';

type Board = 'home' | 'mobile';
type Place = 'todo' | 'middle' | 'done';

interface StepTaskOptions {
  /** The board the task is on. Its workflow always lives in the home board's database. */
  board?: Board;
  /** Where the task sits: To Do, a column between, or Done. */
  place?: Place;
  /** The state of its workflow. */
  workflowState?: 'running' | 'paused' | 'done';
  /** False leaves the task in no workflow at all. */
  inWorkflow?: boolean;
  archived?: boolean;
  /** The task's own automations are paused: a person is working it by hand. */
  held?: boolean;
}

describe('isRunningWorkflowStepTask', () => {
  function openBoard(projectId: Board): Database.Database {
    const database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.dbs.set(projectId, database);
    return database;
  }

  const databaseOf = (projectId: Board) => harness.dbs.get(projectId) as Database.Database;

  /** The column of this board for a place: To Do and Done by role, "between" is Executing. */
  function columnId(projectId: Board, place: Place): string {
    const lanes = new SwimlaneRepository(databaseOf(projectId)).list();
    const lane = place === 'middle' ? lanes.find((candidate) => candidate.name === 'Executing') : lanes.find((candidate) => candidate.role === place);
    if (!lane) throw new Error(`No ${place} column on the ${projectId} board`);
    if (place === 'middle') expect(['todo', 'done']).not.toContain(lane.role);
    return lane.id;
  }

  /** A task as the positive case has it unless the options flip a fact. Returns its id. */
  function addStepTask(options: StepTaskOptions = {}): string {
    const { board = 'home', place = 'middle', workflowState = 'running', inWorkflow = true, archived = false, held = false } = options;
    const workflows = new WorkflowRepository(databaseOf('home'));
    const workflow = workflows.create({});
    workflows.setState(workflow.id, workflowState);
    const tasks = new TaskRepository(databaseOf(board));
    const task = tasks.create({
      title: 'Budgets API',
      description: '',
      swimlane_id: columnId(board, place),
      automations_disabled: held,
      workflow: inWorkflow
        ? {
          workflow_id: workflow.id,
          workflow_project_id: 'home',
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
          canvas_x: null,
          canvas_y: null,
        }
        : undefined,
    });
    if (archived) tasks.archive(task.id);
    return task.id;
  }

  /** The positive case reads true, and the same case with one fact flipped reads false. */
  function expectFlipToFalse(flip: StepTaskOptions): void {
    expect(isRunningWorkflowStepTask('home', addStepTask())).toBe(true);
    expect(isRunningWorkflowStepTask('home', addStepTask(flip))).toBe(false);
  }

  beforeEach(() => {
    harness.dbs.clear();
    harness.broken.clear();
    openBoard('home');
    openBoard('mobile');
  });

  afterEach(() => {
    for (const database of harness.dbs.values()) {
      if ((database as Database.Database).open) (database as Database.Database).close();
    }
    harness.dbs.clear();
  });

  it('is true for an unarchived task of a running workflow in a column between To Do and Done', () => {
    expect(isRunningWorkflowStepTask('home', addStepTask())).toBe(true);
  });

  it('is false in To Do, where no step runs yet', () => {
    expectFlipToFalse({ place: 'todo' });
  });

  it('is false in Done, where the step is over', () => {
    expectFlipToFalse({ place: 'done' });
  });

  it.each(['paused', 'done'] as const)('is false once its workflow is %s', (workflowState) => {
    expectFlipToFalse({ workflowState });
  });

  it('is false for an archived task, though it still names its workflow', () => {
    expectFlipToFalse({ archived: true });
  });

  it('is false while the task\'s own automations are paused, since nothing judges it then', () => {
    expectFlipToFalse({ held: true });
  });

  it('is true again once the task\'s automations resume', () => {
    const taskId = addStepTask({ held: true });
    expect(isRunningWorkflowStepTask('home', taskId)).toBe(false);

    new TaskRepository(databaseOf('home')).update({ id: taskId, automations_disabled: false });

    expect(isRunningWorkflowStepTask('home', taskId)).toBe(true);
  });

  it('is false for a task in no workflow', () => {
    // `workflowOfTask` also answers null for a task with no workflow id, so this
    // pins the outcome rather than the early return in front of it.
    expectFlipToFalse({ inWorkflow: false });
  });

  it('reads the workflow\'s state in its home database for a task on another board', () => {
    const taskId = addStepTask({ board: 'mobile' });
    expect(isRunningWorkflowStepTask('mobile', taskId)).toBe(true);

    // The workflow is in the home database; the mobile board holds only the task.
    const homeWorkflows = new WorkflowRepository(databaseOf('home'));
    const [workflow] = homeWorkflows.listAll();
    homeWorkflows.setState(workflow.id, 'paused');

    expect(isRunningWorkflowStepTask('mobile', taskId)).toBe(false);
  });

  it('is false for a project whose database is not open', () => {
    const taskId = addStepTask();
    expect(isRunningWorkflowStepTask('home', taskId)).toBe(true);

    expect(isRunningWorkflowStepTask('not-opened', taskId)).toBe(false);
  });

  it('is false, rather than throwing, when the database cannot be read', () => {
    const taskId = addStepTask();
    expect(isRunningWorkflowStepTask('home', taskId)).toBe(true);

    // A locked file: opening it throws.
    harness.broken.add('home');
    expect(isRunningWorkflowStepTask('home', taskId)).toBe(false);
    harness.broken.clear();

    // A connection closed under the read: every query on it throws.
    databaseOf('home').close();
    expect(isRunningWorkflowStepTask('home', taskId)).toBe(false);
  });
});
