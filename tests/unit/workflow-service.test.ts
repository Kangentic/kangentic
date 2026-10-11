/**
 * The workflow operations on real, migrated SQLite: a plan is validated whole
 * before anything is written, Start creates the tasks on their boards with
 * their routes and links, and the started workflow's guards (links, routes,
 * removal) hold.
 *
 * Two projects, so a task on another board is covered. The move path and the
 * session handlers are mocked: Start moves only the source task, and most
 * workflows here have none. The ones that do pin that a source task that cannot
 * move to Done never fails a Start that has already run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-changed')>()),
  notifyWorkflowChanged: vi.fn(),
}));

const { handleTaskMove } = await import('../../src/main/ipc/handlers/task-move');
const { notifyWorkflowChanged } = await import('../../src/main/workflows/workflow-changed');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('workflow operations', () => {
  let context: IpcContext;

  function database(projectId: string): Database.Database {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
    return db;
  }

  beforeEach(() => {
    harness.dbs.clear();
    database('home');
    database('mobile');
    const projects = [
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
    for (const db of harness.dbs.values()) (db as Database.Database).close();
    harness.dbs.clear();
    vi.restoreAllMocks();
  });

  const lanesOf = (projectId: string) => new SwimlaneRepository(harness.dbs.get(projectId) as Database.Database).list();
  const tasksOf = (projectId: string) => new TaskRepository(harness.dbs.get(projectId) as Database.Database);

  function plan(extra: Partial<service.PlanInput> = {}): service.PlanInput {
    return {
      title: 'Usage budgets',
      tasks: [
        { key: 'api', title: 'Budgets API', description: 'Add the API.', skip: ['Planning'] },
        { key: 'ui', title: 'Budgets UI', description: 'Show budgets.' },
        { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile', routeLast: 'Code Review' },
      ],
      links: [{ blocker: 'api', blocked: 'ui' }, { blocker: 'api', blocked: 'phone' }],
      ...extra,
    };
  }

  it('saves a plan by key, resolving columns and projects by name', () => {
    const workflow = service.createWorkflow('home', {});
    const saved = service.savePlan(context, 'home', workflow.id, plan());
    expect(saved.title).toBe('Usage budgets');
    expect(saved.draft?.tasks.map((task) => task.key)).toEqual(['api', 'ui', 'phone']);
    const planning = lanesOf('home').find((lane) => lane.name === 'Planning')!;
    expect(saved.draft?.tasks[0].skipped_swimlane_ids).toEqual([planning.id]);
    expect(saved.draft?.tasks[2].project_id).toBe('mobile');
  });

  it('refuses a plan with a loop, an unknown key, a bad column or a duplicate key, writing nothing', () => {
    const workflow = service.createWorkflow('home', {});
    const attempts: Array<[Partial<service.PlanInput>, RegExp]> = [
      [{ links: [{ blocker: 'api', blocked: 'ui' }, { blocker: 'ui', blocked: 'api' }] }, /loop/],
      [{ links: [{ blocker: 'nope', blocked: 'ui' }] }, /not a task key/],
      [{ tasks: [{ key: 'api', title: 'A', skip: ['Nowhere'] }] }, /not a column a route can use/],
      [{ tasks: [{ key: 'api', title: 'A' }, { key: 'api', title: 'B' }], links: [] }, /share the key/],
    ];
    for (const [change, message] of attempts) {
      expect(() => service.savePlan(context, 'home', workflow.id, plan(change))).toThrow(message);
    }
    expect(service.readWorkflow(context, 'home', workflow.id).tasks).toEqual([]);
  });

  it('refuses a save over a newer revision', () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan({ revision: workflow.revision }));
    expect(() => service.savePlan(context, 'home', workflow.id, plan({ revision: workflow.revision })))
      .toThrow(/changed since you read it/);
  });

  it('announces a pause, a resume and a rename on every board holding its tasks, though no task row changed', async () => {
    // Every card carries its workflow's state and name, and a paired phone
    // redraws them only on a board event.
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const emit = vi.mocked(context.boardEvents.emitBoardChanged);
    const boardsAnnounced = (): string[] => [...new Set(emit.mock.calls.map(([event]) => event.projectId))].sort();

    emit.mockClear();
    await service.pauseWorkflow(context, 'home', workflow.id);
    expect(boardsAnnounced()).toEqual(['home', 'mobile']);

    emit.mockClear();
    await service.resumeWorkflow(context, 'home', workflow.id);
    expect(boardsAnnounced()).toEqual(['home', 'mobile']);

    emit.mockClear();
    service.renameWorkflow(context, 'home', workflow.id, 'Spend limits');
    expect(boardsAnnounced()).toEqual(['home', 'mobile']);
  });

  it('wakes the engine with the workflow\'s id on a resume only, so Resume retries its failed starts at once', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const wake = vi.fn();
    setWorkflowWake(wake);
    try {
      await service.pauseWorkflow(context, 'home', workflow.id);
      expect(wake.mock.calls.every(([retryWorkflowId]) => retryWorkflowId === undefined)).toBe(true);

      wake.mockClear();
      await service.resumeWorkflow(context, 'home', workflow.id);
      expect(wake).toHaveBeenCalledWith(workflow.id);
    } finally {
      setWorkflowWake(null);
    }
  });

  it('starts: tasks in To Do on their boards, with routes and cross-board links', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    const result = await service.startWorkflow(context, 'home', workflow.id);
    expect(result.workflow.state).toBe('running');
    expect(result.createdCount).toBe(3);

    const homeTasks = tasksOf('home').listByWorkflow(workflow.id);
    const mobileTasks = tasksOf('mobile').listByWorkflow(workflow.id);
    expect(homeTasks.map((task) => task.title).sort()).toEqual(['Budgets API', 'Budgets UI']);
    expect(mobileTasks.map((task) => task.title)).toEqual(['Budgets on the phone']);
    const homeTodo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    expect(homeTasks.every((task) => task.swimlane_id === homeTodo.id)).toBe(true);
    expect(mobileTasks[0].workflow_project_id).toBe('home');

    const links = new TaskLinkRepository(harness.dbs.get('home') as Database.Database).listForWorkflow(workflow.id);
    expect(links).toHaveLength(2);
    expect(links.some((link) => link.blocked_project_id === 'mobile')).toBe(true);

    const view = service.readWorkflow(context, 'home', workflow.id);
    const phone = view.tasks.find((task) => task.title === 'Budgets on the phone')!;
    expect(phone.route).toEqual(['Planning', 'Executing', 'Code Review']);
    expect(phone.waitsFor).toHaveLength(1);
  });

  describe('the task a workflow was made from', () => {
    let wake: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.mocked(handleTaskMove).mockReset();
      vi.mocked(notifyWorkflowChanged).mockClear();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      wake = vi.fn();
      setWorkflowWake(wake);
    });

    afterEach(() => {
      setWorkflowWake(null);
    });

    /** A workflow planned from a task waiting in To Do on the home board. */
    function plannedFromSource(): { workflowId: string; source: { id: string; display_id: number }; todoId: string; doneId: string } {
      const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
      const done = lanesOf('home').find((lane) => lane.role === 'done')!;
      const source = tasksOf('home').create({ title: 'Budgets', description: '', swimlane_id: todo.id });
      const workflow = service.createWorkflow('home', { sourceTaskId: source.id });
      service.savePlan(context, 'home', workflow.id, plan());
      return { workflowId: workflow.id, source, todoId: todo.id, doneId: done.id };
    }

    it('moves it to Done on Start, and reports which task it superseded (the control)', async () => {
      const { workflowId, source, doneId } = plannedFromSource();

      const result = await service.startWorkflow(context, 'home', workflowId);

      expect(handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: source.id, targetSwimlaneId: doneId }),
        'workflow',
        'home',
        '/projects/home',
        expect.anything(),
      );
      expect(result.supersededSource).toBe(source.display_id);
    });

    it('still starts when it cannot move to Done: the workflow runs, the engine wakes, and the task stays in To Do', async () => {
      const { workflowId, source, todoId, doneId } = plannedFromSource();
      vi.mocked(handleTaskMove).mockRejectedValueOnce(new Error('Worktree setup failed: no space left'));
      wake.mockClear();
      vi.mocked(notifyWorkflowChanged).mockClear();

      const result = await service.startWorkflow(context, 'home', workflowId);

      expect(handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: source.id, targetSwimlaneId: doneId }),
        'workflow',
        'home',
        '/projects/home',
        expect.anything(),
      );
      expect(result.workflow.state).toBe('running');
      expect(result.createdCount).toBe(3);
      expect(result.supersededSource).toBeNull();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId);
      expect(tasksOf('home').getById(source.id)!.swimlane_id).toBe(todoId);
      expect(tasksOf('home').listByWorkflow(workflowId)).toHaveLength(2);
    });
  });

  it('refuses to start an empty workflow, or one already started', async () => {
    const empty = service.createWorkflow('home', {});
    await expect(service.startWorkflow(context, 'home', empty.id)).rejects.toThrow(/no tasks yet/);
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toThrow(/already started/);
  });

  it('takes in a board task in To Do instead of creating one', async () => {
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const existing = tasksOf('home').create({ title: 'Already here', description: '', swimlane_id: todo.id });
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'old', title: 'Already here', existingTask: String(existing.display_id) }],
      links: [],
    });
    const result = await service.startWorkflow(context, 'home', workflow.id);
    expect(result.createdCount).toBe(0);
    expect(tasksOf('home').getById(existing.id)!.workflow_id).toBe(workflow.id);
  });

  it('only lets a task in To Do wait, and removes a task with its links', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const api = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets API')!;
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;

    // Start the API task by hand: a started task can no longer wait.
    const executing = lanesOf('home').find((lane) => lane.name === 'Executing')!;
    tasksOf('home').move({ taskId: api.id, targetSwimlaneId: executing.id, targetPosition: 0 }, { origin: 'workflow' });
    expect(() => service.linkTasks(context, 'home', workflow.id, { blocker: String(ui.display_id), blocked: String(api.display_id) }))
      .toThrow(/has started/);

    const removed = service.removeFromWorkflow(context, 'home', workflow.id, { task: String(ui.display_id) });
    expect(removed.workflow_id).toBeNull();
    expect(new TaskLinkRepository(harness.dbs.get('home') as Database.Database).listBlockersOf(ui.id)).toEqual([]);
  });

  it('removes a task\'s links before it clears the task\'s membership, so a failure between the two writes leaves a member with no links', async () => {
    // The links are in the home database and the membership on the task's own
    // board: two writes. If the second fails, links left to a task outside the
    // workflow would hold a dependent back forever (a blocker the workflow
    // cannot see is never done), while a member with no links can be removed again.
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;
    const links = new TaskLinkRepository(harness.dbs.get('home') as Database.Database);
    const linksOfUi = () => links.listForWorkflow(workflow.id)
      .filter((link) => link.blocker_task_id === ui.id || link.blocked_task_id === ui.id);
    expect(linksOfUi()).toHaveLength(1);
    vi.spyOn(TaskRepository.prototype, 'setWorkflowMembership').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => service.removeFromWorkflow(context, 'home', workflow.id, { task: String(ui.display_id) })).toThrow('disk full');

    expect(linksOfUi()).toEqual([]);
    // Still a member, and the other task's links are untouched.
    expect(tasksOf('home').getById(ui.id)!.workflow_id).toBe(workflow.id);
    expect(links.listForWorkflow(workflow.id)).toHaveLength(1);
  });

  it('keeps a started task\'s past route fixed, and lets what is ahead change', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;
    const review = lanesOf('home').find((lane) => lane.name === 'Code Review')!;
    tasksOf('home').move({ taskId: ui.id, targetSwimlaneId: review.id, targetPosition: 0 }, { origin: 'workflow' });

    expect(() => service.setTaskRoute(context, 'home', workflow.id, { task: String(ui.display_id), skip: ['Planning'] }))
      .toThrow(/Only the columns after it can change/);
    const updated = service.setTaskRoute(context, 'home', workflow.id, { task: String(ui.display_id), skip: ['Testing'] });
    const testing = lanesOf('home').find((lane) => lane.name === 'Testing')!;
    expect(updated.skipped_swimlane_ids).toEqual([testing.id]);
  });

  it('deletes a started workflow, leaving its unfinished tasks as ordinary tasks', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const result = service.deleteWorkflow(context, 'home', workflow.id);
    expect(result.released).toBe(3);
    expect(tasksOf('home').listByWorkflow(workflow.id)).toEqual([]);
    expect(tasksOf('mobile').listByWorkflow(workflow.id)).toEqual([]);
  });
});
