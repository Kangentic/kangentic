/**
 * #1211: a board task outside a workflow joins it where it is, in To Do or
 * already started, through a link, an added task's waitsFor, a plan's
 * existingTask, or the Workflows view's Add blocker. These cases pin the
 * rules around that on real, migrated SQLite: what a join writes, what it
 * refuses, when the engine hears of it, and that only a task in To Do waits.
 *
 * The happy paths sit in workflow-service.test.ts. This file holds what a
 * review found untested around them.
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
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const view = await import('../../src/main/workflows/workflow-view-service');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');
const { MAX_WORKFLOW_TASKS } = await import('../../src/main/workflows/workflow-limits');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const STARTED_REFUSAL = 'has started. Only a task in To Do can wait for another.';

describe('a board task joining a workflow where it is', () => {
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
        listHidden: () => [],
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    setWorkflowWake(null);
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const tasksOf = (projectId: string) => new TaskRepository(dbOf(projectId));
  const lanesOf = (projectId: string) => new SwimlaneRepository(dbOf(projectId)).list();
  const lane = (projectId: string, name: string) => lanesOf(projectId).find((candidate) => candidate.name === name)!;
  const todoLane = (projectId: string) => lanesOf(projectId).find((candidate) => candidate.role === 'todo')!;
  const workflowLinks = (workflowId: string) => new TaskLinkRepository(dbOf('home')).listForWorkflow(workflowId);
  const place = (projectId: string, taskId: string, laneName: string) =>
    dbOf(projectId).prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(lane(projectId, laneName).id, taskId);
  const createTask = (projectId: string, title: string, laneName?: string) => tasksOf(projectId).create({
    title,
    description: '',
    swimlane_id: laneName ? lane(projectId, laneName).id : todoLane(projectId).id,
  });

  /** A started workflow of one home task, "Budgets API", in To Do. */
  async function startedWithApi() {
    const workflow = service.createWorkflowWithPlan(context, 'home', {}, {
      title: 'Usage budgets',
      tasks: [{ key: 'api', title: 'Budgets API' }],
      links: [],
    });
    await service.startWorkflow(context, 'home', workflow.id);
    const api = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets API')!;
    return { workflow, api };
  }

  describe('waitsFor naming the same outside task more than once', () => {
    it('writes one link and takes the task in once, whether named by its id twice or by its number and its id', async () => {
      const { workflow } = await startedWithApi();
      const outsider = createTask('mobile', 'Outside blocker');
      const emit = vi.mocked(context.boardEvents.emitBoardChanged);
      const announcementsFor = (projectId: string) => emit.mock.calls.filter(([event]) => event.projectId === projectId).length;

      const byIdTwice = service.addWorkflowTask(context, 'home', workflow.id, {
        key: 'first', title: 'Waits by id', waitsFor: [outsider.id, outsider.id],
      });
      expect(workflowLinks(workflow.id).filter((link) => link.blocked_task_id === byIdTwice.id)).toHaveLength(1);
      expect(announcementsFor('mobile')).toBe(1);
      expect(tasksOf('mobile').getById(outsider.id)?.workflow_id).toBe(workflow.id);

      // A second outsider, named by number on its board and by id.
      const second = createTask('mobile', 'Second outside blocker');
      emit.mockClear();
      const byNumberAndId = service.addWorkflowTask(context, 'home', workflow.id, {
        key: 'second',
        title: 'Waits by number and id',
        waitsFor: [{ task: String(second.display_id), project: 'kangentic-mobile' }, second.id],
      });
      const links = workflowLinks(workflow.id).filter((link) => link.blocked_task_id === byNumberAndId.id);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ blocker_task_id: second.id, blocker_project_id: 'mobile' });
      expect(announcementsFor('mobile')).toBe(1);
    });
  });

  describe('when linkTasks wakes the engine', () => {
    it('wakes it for a link that took a task in, and not for a link between two members', async () => {
      const { workflow, api } = await startedWithApi();
      const second = service.addWorkflowTask(context, 'home', workflow.id, { key: 'second', title: 'Second member' });
      const wake = vi.fn();
      setWorkflowWake(wake);

      service.linkTasks(context, 'home', workflow.id, { blocker: api.id, blocked: second.id });
      expect(wake).not.toHaveBeenCalled();

      const outsider = createTask('home', 'Outside blocker', 'Executing');
      const third = service.addWorkflowTask(context, 'home', workflow.id, { key: 'third', title: 'Third member' });
      wake.mockClear();
      service.linkTasks(context, 'home', workflow.id, { blocker: outsider.id, blocked: third.id });
      expect(wake).toHaveBeenCalled();
    });
  });

  describe('a board with no Done column', () => {
    beforeEach(() => {
      dbOf('mobile').prepare("UPDATE swimlanes SET role = NULL WHERE role = 'done'").run();
    });

    it('refuses a link that would take in its task, naming the missing column', async () => {
      const { workflow, api } = await startedWithApi();
      const outsider = createTask('mobile', 'On a board without Done');

      expect(() => service.linkTasks(context, 'home', workflow.id, { blocker: outsider.id, blocked: api.id }))
        .toThrow(/no To Do or no Done column/);

      expect(tasksOf('mobile').getById(outsider.id)?.workflow_id).toBeNull();
    });

    it('refuses a plan that takes its task in', () => {
      const outsider = createTask('mobile', 'On a board without Done');
      const workflow = service.createWorkflow('home', {});

      expect(() => service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'outside', title: 'Outside', project: 'kangentic-mobile', existingTask: outsider.id }],
        links: [],
      })).toThrow(/no To Do or no Done column/);
    });
  });

  describe('Start re-checking a task the plan takes in', () => {
    it('refuses one whose row is gone, and leaves the workflow a draft', async () => {
      const outsider = createTask('home', 'Taken in, then deleted');
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'gone', title: 'Taken in, then deleted', existingTask: outsider.id }],
        links: [],
      });
      dbOf('home').prepare('DELETE FROM tasks WHERE id = ?').run(outsider.id);

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toThrow(/is gone/);

      expect(new WorkflowRepository(dbOf('home')).getById(workflow.id)?.state).toBe('draft');
    });
  });

  describe('linking with both ends outside the workflow', () => {
    it('takes both in, each following its board\'s route', async () => {
      const { workflow } = await startedWithApi();
      const blocker = createTask('home', 'Outside blocker', 'Executing');
      const blocked = createTask('home', 'Outside waiter');

      const result = service.linkTasks(context, 'home', workflow.id, { blocker: blocker.id, blocked: blocked.id });

      expect(result.joined.map((task) => task.id).sort()).toEqual([blocker.id, blocked.id].sort());
      for (const task of [blocker, blocked]) {
        expect(tasksOf('home').getById(task.id)).toMatchObject({
          workflow_id: workflow.id,
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
        });
      }
    });

    it('writes nothing when the blocker names a task that is not on the board it names', async () => {
      const { workflow } = await startedWithApi();
      const blocked = createTask('home', 'Outside waiter');
      const linksBefore = workflowLinks(workflow.id).length;

      expect(() => service.linkTasks(context, 'home', workflow.id, {
        blocker: '999', blockerProject: 'kangentic-mobile', blocked: blocked.id,
      })).toThrow(/No task "999"/);

      expect(workflowLinks(workflow.id)).toHaveLength(linksBefore);
      expect(tasksOf('home').getById(blocked.id)?.workflow_id).toBeNull();
    });
  });

  describe('only a task in To Do can wait', () => {
    it('refuses a plan whose taken-in started task is a link\'s blocked end, and accepts the reverse', () => {
      const inFlight = createTask('home', 'In flight', 'Executing');
      const tasks = [{ key: 'inflight', title: 'In flight', existingTask: inFlight.id }, { key: 'other', title: 'Other' }];
      const workflow = service.createWorkflow('home', {});

      expect(() => service.savePlan(context, 'home', workflow.id, { tasks, links: [{ blocker: 'other', blocked: 'inflight' }] }))
        .toThrow(STARTED_REFUSAL);
      expect(() => service.createWorkflowWithPlan(context, 'home', {}, { tasks, links: [{ blocker: 'other', blocked: 'inflight' }] }))
        .toThrow(STARTED_REFUSAL);

      const saved = service.savePlan(context, 'home', workflow.id, { tasks, links: [{ blocker: 'inflight', blocked: 'other' }] });
      expect(saved.draft?.links).toEqual([{ blocker: 'inflight', blocked: 'other' }]);
    });

    it('lets Start refuse a link whose taken-in task started after the plan was saved, writing nothing', async () => {
      const waiter = createTask('home', 'Waiter');
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'waiter', title: 'Waiter', existingTask: waiter.id }, { key: 'release', title: 'Release' }],
        links: [{ blocker: 'release', blocked: 'waiter' }],
      });
      place('home', waiter.id, 'Executing');
      const titlesBefore = tasksOf('home').list().map((task) => task.title).sort();

      const start = service.startWorkflow(context, 'home', workflow.id);

      await expect(start).rejects.toThrow(/cannot wait for/);
      await expect(start).rejects.toThrow(/Save the plan again without that link/);
      expect(new WorkflowRepository(dbOf('home')).getById(workflow.id)?.state).toBe('draft');
      expect(tasksOf('home').getById(waiter.id)?.workflow_id).toBeNull();
      expect(tasksOf('home').list().map((task) => task.title).sort()).toEqual(titlesBefore);
    });

    it('has the view refuse a link into, and a blocker for, a planned task that takes in a started task', () => {
      const inFlight = createTask('home', 'In flight', 'Executing');
      const card = createTask('home', 'A card to wait on');
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'inflight', title: 'In flight', existingTask: inFlight.id }, { key: 'other', title: 'Other' }],
        links: [],
      });

      expect(() => view.setViewLink(context, 'home', workflow.id, 'other', 'inflight', true)).toThrow('has started');
      expect(() => view.addCardBlocker(context, 'home', workflow.id, 'inflight', 'home', card.id)).toThrow('has started');

      const draft = new WorkflowRepository(dbOf('home')).getById(workflow.id)!.draft!;
      expect(draft.links).toEqual([]);
      expect(draft.tasks.map((task) => task.key)).toEqual(['inflight', 'other']);
    });
  });

  describe('the Workflows view adding a card as a blocker before Start', () => {
    function draftWithOther() {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, { tasks: [{ key: 'other', title: 'Other' }], links: [] });
      return workflow;
    }

    it('refuses the same card twice, a card that is gone, and a plan already at its task limit', () => {
      const card = createTask('home', 'A card to wait on');
      const workflow = draftWithOther();

      view.addCardBlocker(context, 'home', workflow.id, 'other', 'home', card.id);
      expect(() => view.addCardBlocker(context, 'home', workflow.id, 'other', 'home', card.id)).toThrow(/already in this plan/);
      expect(() => view.addCardBlocker(context, 'home', workflow.id, 'other', 'home', 'no-such-task'))
        .toThrow('That task is no longer on its board.');

      const full = service.createWorkflowWithPlan(context, 'home', {}, {
        tasks: Array.from({ length: MAX_WORKFLOW_TASKS }, (_unused, index) => ({ key: `t${index}`, title: `Task ${index}` })),
        links: [],
      });
      const another = createTask('home', 'One too many');
      expect(() => view.addCardBlocker(context, 'home', full.id, 't0', 'home', another.id)).toThrow(/at most/);
      expect(new WorkflowRepository(dbOf('home')).getById(full.id)?.draft?.tasks).toHaveLength(MAX_WORKFLOW_TASKS);
    });

    it('carries the card\'s own plan approval into the plan as Start would store it', () => {
      // The seeded Planning column is Manual: Automatic is an override that is stored, Manual is the column's own value.
      const automatic = createTask('home', 'Approves its own plan');
      const manual = createTask('home', 'Follows the column');
      dbOf('home').prepare('UPDATE tasks SET plan_approval = ? WHERE id = ?').run('automatic', automatic.id);
      dbOf('home').prepare('UPDATE tasks SET plan_approval = ? WHERE id = ?').run('manual', manual.id);
      const workflow = draftWithOther();

      view.addCardBlocker(context, 'home', workflow.id, 'other', 'home', automatic.id);
      view.addCardBlocker(context, 'home', workflow.id, 'other', 'home', manual.id);

      const planned = new WorkflowRepository(dbOf('home')).getById(workflow.id)!.draft!.tasks;
      const approvalOf = (taskId: string) => planned.find((task) => task.existing_task_id === taskId)!.plan_approval;
      expect(approvalOf(automatic.id)).toBe('automatic');
      expect(approvalOf(manual.id)).toBeNull();
    });
  });
});
