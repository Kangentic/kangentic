/**
 * Reads of a project id that workflow data stores: a task's workflow home, a
 * link's far end, a planned task's board. Each can name a project deleted
 * since, and `getProjectDb` on main creates, migrates and seeds a database for
 * any id it is given, so each of these reads used to bring the deleted
 * project's file back, empty. They go through `getExistingProjectDb` now, and
 * read a project that is gone as having nothing.
 *
 * Real, migrated SQLite. A deleted project is one whose registry row and
 * database are both gone, while workflow data elsewhere still names it: what a
 * project delete left behind before it learned to detach its workflows. The
 * mocked `getProjectDb` records every id it is asked for; a read of a gone
 * project through it is the failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  getProjectDbCalls: [] as string[],
  /** Projects whose database throws when opened, as a locked file does. */
  broken: new Set<string>(),
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    if (harness.broken.has(projectId)) throw new Error(`database for ${projectId} is locked`);
    return harness.dbs.get(projectId) ?? null;
  },
  getProjectDb: (projectId: string) => {
    harness.getProjectDbCalls.push(projectId);
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { createWorkflowForView, listWorkflowSummaries, listWorkflowSupersessions } = await import('../../src/main/workflows/workflow-view-service');
const { isInWorkflow, workflowOfTask } = await import('../../src/main/workflows/workflow-home');
const { SUPERSEDED_MOVE_REASON_PREFIX, WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { checkWorkflowMove, checkWorkflowMoveForAgent, workflowTitleOf } = await import('../../src/main/workflows/workflow-lock-check');
const { readWorkflowPromptFacts } = await import('../../src/main/workflows/workflow-prompt-facts');
const { workflowStepApplies } = await import('../../src/main/workflows/workflow-step');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards, taskTitled } from './helpers/workflow-plans';
import { WORKFLOW_REFUSALS } from '../../src/shared/workflow-refusals';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Workflow } from '../../src/shared/types';

describe('reads of a project id that workflow data stores, after that project is deleted', () => {
  let context: IpcContext;
  let projects: Array<{ id: string; name: string; path: string }>;

  function database(projectId: string): void {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
  }

  /** The project's row and database go; whatever else names it stays. */
  function deleteProject(projectId: string, options: { keepRegistered?: boolean } = {}): void {
    (harness.dbs.get(projectId) as Database.Database).close();
    harness.dbs.delete(projectId);
    if (!options.keepRegistered) projects = projects.filter((project) => project.id !== projectId);
    harness.getProjectDbCalls.length = 0;
  }

  beforeEach(() => {
    harness.dbs.clear();
    harness.getProjectDbCalls.length = 0;
    harness.broken.clear();
    database('home');
    database('mobile');
    projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/projects/mobile' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
    vi.restoreAllMocks();
  });

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const tasksOf = (projectId: string) => new TaskRepository(dbOf(projectId));

  /** A started workflow homed on the mobile board, with one task on the home board. */
  async function workflowHomedOnMobile(): Promise<{ workflow: Workflow; homeTaskId: string }> {
    const workflow = service.createWorkflow('mobile', {});
    service.savePlan(context, 'mobile', workflow.id, {
      title: 'Usage budgets',
      tasks: [{ key: 'api', title: 'Budgets API', project: 'kangentic' }],
      links: [],
    });
    await service.startWorkflow(context, 'mobile', workflow.id);
    return { workflow, homeTaskId: tasksOf('home').listByWorkflow(workflow.id)[0].id };
  }

  describe('a task whose workflow home is gone', () => {
    it('is in no workflow, and its home is not opened', async () => {
      const { homeTaskId } = await workflowHomedOnMobile();
      deleteProject('mobile');
      const task = tasksOf('home').getById(homeTaskId)!;

      expect(workflowOfTask(task, 'home')).toBeNull();
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    it('still reads the workflow of a live home, and null for an ordinary task', async () => {
      const { workflow, homeTaskId } = await workflowHomedOnMobile();
      const task = tasksOf('home').getById(homeTaskId)!;

      expect(workflowOfTask(task, 'home')?.id).toBe(workflow.id);
      expect(workflowOfTask({ workflow_id: null, workflow_project_id: null }, 'home')).toBeNull();
    });

    it('moves as an ordinary task for its agent, and its home is not opened', async () => {
      const { homeTaskId } = await workflowHomedOnMobile();
      deleteProject('mobile');
      const task = tasksOf('home').getById(homeTaskId)!;
      const done = new SwimlaneRepository(dbOf('home')).list().find((lane) => lane.role === 'done')!;

      expect(checkWorkflowMoveForAgent('home', task, done.id, true)).toBeNull();
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    it('is in no workflow for a refusal that protects one, while a live or unreadable home still counts', async () => {
      const { workflow, homeTaskId } = await workflowHomedOnMobile();
      const task = tasksOf('home').getById(homeTaskId)!;
      expect(isInWorkflow(task, 'home')).toBe(true);
      expect(isInWorkflow({ workflow_id: null, workflow_project_id: null }, 'home')).toBe(false);

      // A home that cannot be read keeps the refusal: it may still hold the workflow.
      harness.broken.add('mobile');
      expect(isInWorkflow(task, 'home')).toBe(true);
      harness.broken.delete('mobile');

      // The workflow deleted in a live home: its Done tasks keep the membership.
      new WorkflowRepository(dbOf('mobile')).delete(workflow.id);
      expect(isInWorkflow(task, 'home')).toBe(false);

      deleteProject('mobile');
      expect(isInWorkflow(task, 'home')).toBe(false);
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    it('gets no workflow block in its prompt, and its home is not opened', async () => {
      const { homeTaskId } = await workflowHomedOnMobile();
      deleteProject('mobile');

      expect(readWorkflowPromptFacts(tasksOf('home').getById(homeTaskId)!, 'home')).toBeNull();
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    it('gets no workflow step at a turn end, and its home is not opened', async () => {
      const { homeTaskId } = await workflowHomedOnMobile();
      const task = tasksOf('home').getById(homeTaskId)!;
      // The control: a running workflow in a live home steps its tasks.
      expect(workflowStepApplies(task, 'home')).toBe(true);

      deleteProject('mobile');

      expect(workflowStepApplies(task, 'home')).toBe(false);
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    describe('moved by hand', () => {
      /** The task sits in To Do, where a hand's move into Planning is the lock's plain refusal while the workflow runs. */
      async function handMoveOfHomeTask() {
        const { homeTaskId } = await workflowHomedOnMobile();
        const task = tasksOf('home').getById(homeTaskId)!;
        const lanes = new SwimlaneRepository(dbOf('home')).list();
        expect(lanes.find((lane) => lane.id === task.swimlane_id)?.role).toBe('todo');
        const planning = lanes.find((lane) => lane.name === 'Planning')!;
        const move = () => checkWorkflowMove(context, {
          projectId: 'home',
          task,
          toSwimlaneId: planning.id,
          origin: 'renderer',
          moverIsTaskAgent: false,
        });
        return { task, move };
      }

      it('is allowed as an ordinary task, with no read failure logged and its home not opened', async () => {
        const { move } = await handMoveOfHomeTask();
        // The control: the same move is refused while the home is there.
        expect(move()).toMatch(/is locked while/);

        deleteProject('mobile');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(move()).toBeNull();
        // A home that is gone is an ordinary task, not the fail-open path for a read that threw.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(harness.getProjectDbCalls).not.toContain('mobile');
      });

      it('allows the move and logs the failure when the home exists but cannot be read', async () => {
        const { move } = await handMoveOfHomeTask();
        harness.broken.add('mobile');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(move()).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('is named "its workflow" in a refusal, and its home is not opened', async () => {
      const { homeTaskId } = await workflowHomedOnMobile();
      const task = tasksOf('home').getById(homeTaskId)!;
      // The control: the title of a workflow in a live home.
      expect(workflowTitleOf(task, 'home')).toBe('Usage budgets');

      deleteProject('mobile');

      expect(workflowTitleOf(task, 'home')).toBe('its workflow');
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });
  });

  describe('making a workflow from a To Do task', () => {
    const noRoute = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null };

    function todoTask(projectId: string) {
      const todo = new SwimlaneRepository(dbOf(projectId)).list().find((lane) => lane.role === 'todo')!;
      return tasksOf(projectId).create({ title: 'Usage budgets', description: 'Cap spend per project.', swimlane_id: todo.id });
    }

    it('refuses a task in a workflow that exists, and takes one whose workflow was deleted', () => {
      const source = todoTask('home');
      const existing = service.createWorkflow('home', {});
      tasksOf('home').setWorkflowMembership(source.id, { workflow_id: existing.id, workflow_project_id: 'home', ...noRoute });

      // The control: a live workflow holds the task.
      expect(() => createWorkflowForView(context, 'home', source.id)).toThrow(`#${source.display_id} is already in a workflow.`);

      // Deleting a workflow leaves the membership on its tasks; it is no membership.
      new WorkflowRepository(dbOf('home')).delete(existing.id);
      expect(tasksOf('home').getById(source.id)?.workflow_id).toBe(existing.id);

      const created = createWorkflowForView(context, 'home', source.id);

      expect(created.source_task_id).toBe(source.id);
      expect(created.brief).toBe('Usage budgets\n\nCap spend per project.');
    });

    it('takes a task whose workflow home is a project that was deleted, without opening that project', async () => {
      const { homeTaskId } = await workflowHomedOnMobile();
      const task = tasksOf('home').getById(homeTaskId)!;
      // The control: the workflow is in a live home, so the task is in it.
      expect(() => createWorkflowForView(context, 'home', task.id)).toThrow(`#${task.display_id} is already in a workflow.`);

      deleteProject('mobile');

      expect(createWorkflowForView(context, 'home', task.id).source_task_id).toBe(task.id);
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });
  });

  it('lists no supersessions for a home that is gone, and does not open it', () => {
    // The control: a source Start moved to Done is listed while its home is there.
    const lanes = new SwimlaneRepository(dbOf('mobile')).list();
    const source = tasksOf('mobile').create({
      title: 'Usage budgets and a hard cap',
      description: '',
      swimlane_id: lanes.find((lane) => lane.role === 'todo')!.id,
    });
    const workflows = new WorkflowRepository(dbOf('mobile'));
    const workflow = workflows.create({ title: 'Usage budgets', sourceTaskId: source.id });
    workflows.markStarted(workflow.id);
    tasksOf('mobile').move(
      { taskId: source.id, targetSwimlaneId: lanes.find((lane) => lane.role === 'done')!.id, targetPosition: 0 },
      { origin: 'workflow', reason: `${SUPERSEDED_MOVE_REASON_PREFIX}Usage budgets` },
    );
    expect(listWorkflowSupersessions('mobile')).toEqual([
      { sourceTaskId: source.id, workflowId: workflow.id, title: 'Usage budgets', colorSlot: workflow.color_slot },
    ]);

    deleteProject('mobile');

    expect(listWorkflowSupersessions('mobile')).toEqual([]);
    expect(harness.getProjectDbCalls).not.toContain('mobile');
  });

  describe('the refusal for a workflow its home does not hold', () => {
    /** The renderer tells a deleted workflow from a failed read by finding `WORKFLOW_REFUSALS.notFound` in the message. */
    function refusalOf(action: () => unknown): string {
      try {
        action();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('Expected the call to refuse.');
    }

    it('requireWorkflow carries the shared sentence for an id the home does not hold, and for a home that is gone', async () => {
      const { workflow } = await workflowHomedOnMobile();
      const wording = (workflowId: string) => `No workflow "${workflowId}" in this project. List them with kangentic_list_workflows.`;

      const missing = refusalOf(() => service.requireWorkflow('mobile', 'no-such-workflow'));
      expect(missing).toContain(WORKFLOW_REFUSALS.notFound('no-such-workflow'));
      expect(missing).toBe(wording('no-such-workflow'));

      deleteProject('mobile');
      const homeGone = refusalOf(() => service.requireWorkflow('mobile', workflow.id));
      expect(homeGone).toContain(WORKFLOW_REFUSALS.notFound(workflow.id));
      expect(homeGone).toBe(wording(workflow.id));
    });

    it('resolveWorkflow carries the shared sentence for a selector that matches no id or title', () => {
      service.createWorkflow('home', { title: 'Usage budgets' });

      const refusal = refusalOf(() => service.resolveWorkflow('home', 'Spend limits'));

      expect(refusal).toContain(WORKFLOW_REFUSALS.notFound('Spend limits'));
      expect(refusal).toBe('No workflow "Spend limits" in this project. List them with kangentic_list_workflows.');
    });
  });

  it('leaves a blocker on a deleted board out of the prompt, and does not open that board', async () => {
    // The phone task (mobile) blocks api (home).
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);
    const api = taskTitled(service.readWorkflow(context, 'home', workflow.id), 'Budgets API');
    deleteProject('mobile');

    const facts = readWorkflowPromptFacts(tasksOf('home').getById(api.taskId!)!, 'home');

    expect(facts?.title).toBe('Usage budgets');
    expect(facts?.waitsFor).toEqual([]);
    expect(harness.getProjectDbCalls).not.toContain('mobile');
  });

  it('lists no workflows for a home that is gone, and does not open it', async () => {
    await workflowHomedOnMobile();
    deleteProject('mobile');

    expect(listWorkflowSummaries(context, 'mobile')).toEqual([]);
    expect(harness.getProjectDbCalls).not.toContain('mobile');
  });

  it('finds no workflow in a home that is gone, and does not open it', async () => {
    const { workflow } = await workflowHomedOnMobile();
    deleteProject('mobile');

    expect(() => service.requireWorkflow('mobile', workflow.id)).toThrow(`No workflow "${workflow.id}" in this project.`);
    expect(harness.getProjectDbCalls).not.toContain('mobile');
  });

  describe('a plan with a task on a board deleted after it was saved', () => {
    it('reads without opening that board', () => {
      const workflow = planAcrossBoards(service, context);
      deleteProject('mobile');

      const view = service.readWorkflow(context, 'home', workflow.id);

      expect(taskTitled(view, 'Budgets on the phone').route).toEqual([]);
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    it('is refused at Start by that task\'s name, before anything is written, and that board is not opened', async () => {
      const workflow = planAcrossBoards(service, context);
      deleteProject('mobile');

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toThrow(
        '"Budgets on the phone" goes on a board that is no longer in Kangentic. Save the plan again without it.',
      );
      expect(tasksOf('home').listByWorkflow(workflow.id)).toEqual([]);
      expect(service.requireWorkflow('home', workflow.id).state).toBe('draft');
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });

    it('is refused at Start when the board is still registered but its database is gone', async () => {
      const workflow = planAcrossBoards(service, context);
      deleteProject('mobile', { keepRegistered: true });

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toThrow('That board is no longer in Kangentic.');
      expect(tasksOf('home').listByWorkflow(workflow.id)).toEqual([]);
      expect(harness.getProjectDbCalls).not.toContain('mobile');
    });
  });
});
