/**
 * The Workflows view's operations on real, migrated SQLite: the read model the
 * canvas and inspector draw, the planned-workflow edits addressed by key and
 * column id, the positions write that changes no plan, and the change push.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>(), sent: [] as Array<{ channel: string; payload: unknown }> }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({
  sendToRenderer: (_window: unknown, channel: string, payload: unknown) => harness.sent.push({ channel, payload }),
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const view = await import('../../src/main/workflows/workflow-view-service');
const lock = await import('../../src/main/workflows/workflow-lock-check');
const { setWorkflowChangedWindow } = await import('../../src/main/workflows/workflow-changed');
const { IPC } = await import('../../src/shared/ipc-channels');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('the Workflows view operations', () => {
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
    harness.sent.length = 0;
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
      // No Automation agent chosen: every column is a human gate unless it starts no agent at all.
      configManager: { load: () => ({}) },
      // The workflow agents: none unless a test adds one.
      sessionManager: {
        listSessions: () => agentSessions,
        getActivityCache: () => agentActivity,
      },
    } as unknown as IpcContext;
    agentSessions.length = 0;
    for (const key of Object.keys(agentActivity)) delete agentActivity[key];
  });

  const agentSessions: Array<{ id: string; workflowId: string; status: string }> = [];
  const agentActivity: Record<string, string> = {};

  afterEach(() => {
    setWorkflowChangedWindow(null);
    vi.useRealTimers();
  });

  const homeDb = () => harness.dbs.get('home') as Database.Database;
  const lanesOf = (projectId: string) => new SwimlaneRepository(harness.dbs.get(projectId) as Database.Database).list();
  const laneId = (projectId: string, name: string) => lanesOf(projectId).find((lane) => lane.name === name)!.id;

  it('names the workflow agent\'s state for the picker: none, active, idle or paused', () => {
    const workflow = service.createWorkflow('home', {});
    const agentOf = () => view.listWorkflowSummaries(context, 'home').find((summary) => summary.workflow.id === workflow.id)!.agent;
    expect(agentOf()).toBeNull();
    agentSessions.push({ id: 'agent-1', workflowId: workflow.id, status: 'running' });
    agentActivity['agent-1'] = 'thinking';
    expect(agentOf()).toEqual({ state: 'active', lastReplyAt: null, startedOverSessionId: null });
    agentActivity['agent-1'] = 'idle';
    expect(agentOf()?.state).toBe('idle');
    agentSessions[0].status = 'suspended';
    expect(agentOf()?.state).toBe('paused');
    agentSessions[0].status = 'exited';
    expect(agentOf()).toBeNull();
  });

  it('adds planned tasks by key, every route column ahead', () => {
    const workflow = service.createWorkflow('home', {});
    const first = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });
    const second = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets UI', labels: ['ui'] });
    expect([first, second]).toEqual(['task-1', 'task-2']);

    const detail = view.readWorkflowDetail(context, 'home', workflow.id);
    expect(detail.tasks.map((task) => task.place)).toEqual(['planned', 'planned']);
    expect(detail.tasks[0].steps.map((step) => step.name)).toEqual(['Planning', 'Executing', 'Code Review', 'Testing', 'Merge']);
    expect(detail.tasks[0].steps.every((step) => step.state === 'ahead')).toBe(true);
    expect(detail.tasks[1].planned?.labels).toEqual(['ui']);
  });

  it('sets a route from the switched-on columns, open at the ends, and refuses an empty one', () => {
    const workflow = service.createWorkflow('home', {});
    const key = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });
    view.setViewRoute(context, 'home', workflow.id, key, [laneId('home', 'Executing'), laneId('home', 'Code Review')]);
    const planned = new WorkflowRepository(homeDb()).getById(workflow.id)!.draft!.tasks[0];
    expect(planned.route_start_swimlane_id).toBe(laneId('home', 'Executing'));
    expect(planned.route_last_swimlane_id).toBe(laneId('home', 'Code Review'));
    expect(planned.skipped_swimlane_ids).toEqual([]);

    const steps = view.readWorkflowDetail(context, 'home', workflow.id).tasks[0].steps;
    expect(steps.map((step) => step.state)).toEqual(['skipped', 'ahead', 'ahead', 'skipped', 'skipped']);

    // Every column on again is the open route a task nobody customized has.
    view.setViewRoute(context, 'home', workflow.id, key, lanesOf('home').filter((lane) => lane.role === null).map((lane) => lane.id));
    const reopened = new WorkflowRepository(homeDb()).getById(workflow.id)!.draft!.tasks[0];
    expect(reopened.route_start_swimlane_id).toBeNull();
    expect(reopened.route_last_swimlane_id).toBeNull();

    expect(() => view.setViewRoute(context, 'home', workflow.id, key, [])).toThrow(/at least one column/);
  });

  it('links planned tasks, refuses a loop or a self-link, and unlinks', () => {
    const workflow = service.createWorkflow('home', {});
    const api = view.addViewTask(context, 'home', workflow.id, { title: 'API' });
    const ui = view.addViewTask(context, 'home', workflow.id, { title: 'UI' });
    view.setViewLink(context, 'home', workflow.id, api, ui, true);
    view.setViewLink(context, 'home', workflow.id, api, ui, true);
    expect(view.readWorkflowDetail(context, 'home', workflow.id).links).toEqual([{ blockerKey: api, blockedKey: ui }]);
    expect(() => view.setViewLink(context, 'home', workflow.id, ui, api, true)).toThrow(/loop/);
    expect(() => view.setViewLink(context, 'home', workflow.id, api, api, true)).toThrow(/itself/);
    view.setViewLink(context, 'home', workflow.id, api, ui, false);
    expect(view.readWorkflowDetail(context, 'home', workflow.id).links).toEqual([]);
  });

  it('edits a planned task, and moving it to another board resets its route', () => {
    const workflow = service.createWorkflow('home', {});
    const key = view.addViewTask(context, 'home', workflow.id, { title: 'Phone' });
    view.setViewRoute(context, 'home', workflow.id, key, [laneId('home', 'Executing')]);
    view.updatePlannedTask(context, 'home', workflow.id, key, { title: 'Phone budgets', projectId: 'mobile' });
    const planned = new WorkflowRepository(homeDb()).getById(workflow.id)!.draft!.tasks[0];
    expect(planned.title).toBe('Phone budgets');
    expect(planned.project_id).toBe('mobile');
    expect(planned.route_start_swimlane_id).toBeNull();
    expect(planned.route_last_swimlane_id).toBeNull();
    expect(view.readWorkflowDetail(context, 'home', workflow.id).projectNames).toEqual({ home: 'kangentic', mobile: 'kangentic-mobile' });
    expect(() => view.updatePlannedTask(context, 'home', workflow.id, key, { title: '  ' })).toThrow(/needs a title/);
  });

  it('carries each board\'s To Do and Done columns, planned and started, so a card on another board draws its own ends', async () => {
    (harness.dbs.get('mobile') as Database.Database).prepare("UPDATE swimlanes SET color = ? WHERE role = 'done'").run('#a855f7');
    const homeDone = lanesOf('home').find((lane) => lane.role === 'done')!.color;
    expect(homeDone).not.toBe('#a855f7');
    const doneColors = (projectIds: string[]) => {
      const ends = view.readWorkflowDetail(context, 'home', workflow.id).boardEnds;
      expect(Object.keys(ends).sort()).toEqual([...projectIds].sort());
      // Each board names both ends, with its own columns.
      for (const projectId of projectIds) {
        expect(ends[projectId].todo?.swimlaneId).toBe(lanesOf(projectId).find((lane) => lane.role === 'todo')!.id);
        expect(ends[projectId].done?.swimlaneId).toBe(lanesOf(projectId).find((lane) => lane.role === 'done')!.id);
      }
      return Object.fromEntries(projectIds.map((projectId) => [projectId, ends[projectId].done?.color ?? null]));
    };
    const workflow = service.createWorkflow('home', {});
    // A workflow on one board carries that board's alone.
    expect(doneColors(['home'])).toEqual({ home: homeDone });
    service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'api', title: 'Budgets API' }, { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' }],
      links: [],
    });
    expect(doneColors(['home', 'mobile'])).toEqual({ home: homeDone, mobile: '#a855f7' });
    await service.startWorkflow(context, 'home', workflow.id);
    expect(doneColors(['home', 'mobile'])).toEqual({ home: homeDone, mobile: '#a855f7' });
  });

  it('removes a planned task with its links', () => {
    const workflow = service.createWorkflow('home', {});
    const api = view.addViewTask(context, 'home', workflow.id, { title: 'API' });
    const ui = view.addViewTask(context, 'home', workflow.id, { title: 'UI' });
    view.setViewLink(context, 'home', workflow.id, api, ui, true);
    view.removeViewTask(context, 'home', workflow.id, api);
    const detail = view.readWorkflowDetail(context, 'home', workflow.id);
    expect(detail.tasks.map((task) => task.key)).toEqual([ui]);
    expect(detail.links).toEqual([]);
  });

  it('stores card positions without changing the plan revision', () => {
    const workflow = service.createWorkflow('home', {});
    const key = view.addViewTask(context, 'home', workflow.id, { title: 'API' });
    const before = new WorkflowRepository(homeDb()).getById(workflow.id)!.revision;
    view.setViewPositions(context, 'home', workflow.id, [{ key, x: 120.4, y: 80.6 }]);
    const after = new WorkflowRepository(homeDb()).getById(workflow.id)!;
    expect(after.revision).toBe(before);
    expect(after.draft!.tasks[0]).toMatchObject({ canvas_x: 120, canvas_y: 81 });
    // A save the agent built on its last read still goes through.
    expect(() => service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key, title: 'API' }], links: [], revision: before,
    })).not.toThrow();
    // ...and keeps where the hand put the card.
    expect(new WorkflowRepository(homeDb()).getById(workflow.id)!.draft!.tasks[0].canvas_x).toBe(120);
  });

  describe('once started', () => {
    async function started() {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [
          { key: 'api', title: 'Budgets API' },
          { key: 'ui', title: 'Budgets UI' },
          { key: 'docs', title: 'Budgets docs' },
        ],
        links: [{ blocker: 'api', blocked: 'ui' }],
      });
      await service.startWorkflow(context, 'home', workflow.id);
      const tasks = new TaskRepository(homeDb()).listByWorkflow(workflow.id);
      const byTitle = (title: string) => tasks.find((task) => task.title === title)!;
      return { workflow, api: byTitle('Budgets API'), ui: byTitle('Budgets UI'), docs: byTitle('Budgets docs') };
    }

    it('reads tasks by id, with their place, steps and links', async () => {
      const { workflow, api, ui, docs } = await started();
      const detail = view.readWorkflowDetail(context, 'home', workflow.id);
      expect(detail.tasks.map((task) => task.key).sort()).toEqual([api.id, ui.id, docs.id].sort());
      expect(detail.tasks.every((task) => task.place === 'todo' && task.task?.id === task.key)).toBe(true);
      expect(detail.links).toEqual([{ blockerKey: api.id, blockedKey: ui.id }]);
    });

    it('counts what waits and what is ready for the picker', async () => {
      const { workflow } = await started();
      const [summary] = view.listWorkflowSummaries(context, 'home');
      expect(summary.workflow.id).toBe(workflow.id);
      expect(summary).toMatchObject({ taskCount: 3, doneCount: 0, inProgressCount: 0, queuedCount: 2, blockedCount: 1 });
    });

    it('gives each board card what it waits for and where a hand may move it', async () => {
      const { workflow, api, ui, docs } = await started();
      const [before] = view.listWorkflowSummaries(context, 'home');
      expect(before.boardTasks[ui.id]).toEqual({ waitingFor: [`#${api.display_id}`], humanGateTargetId: null });
      expect(before.boardTasks[docs.id]).toEqual({ waitingFor: [], humanGateTargetId: null });

      // In a column whose work no agent can judge (here, none is chosen), a person drags it on.
      new TaskRepository(homeDb()).move(
        { taskId: api.id, targetSwimlaneId: laneId('home', 'Executing'), targetPosition: 0 },
        { origin: 'renderer' },
      );
      const [after] = view.listWorkflowSummaries(context, 'home');
      expect(after.boardTasks[api.id]).toEqual({ waitingFor: [], humanGateTargetId: laneId('home', 'Code Review') });
      expect(after.workflow).toMatchObject({ id: workflow.id, state: 'running' });
    });

    it('lets a hand drag a started task out of a gate, and never a task out of To Do', async () => {
      const { api, ui, docs } = await started();
      const tasks = new TaskRepository(homeDb());
      const byHand = (taskId: string, column: string) => lock.checkWorkflowMove(context, {
        projectId: 'home',
        task: tasks.getById(taskId)!,
        toSwimlaneId: laneId('home', column),
        origin: 'renderer',
        moverIsTaskAgent: false,
      });
      // To Do runs no agent, but it is the queue, not a gate: a ready task and
      // a waiting one both stay for the engine, as the board's lock shows them.
      expect(byHand(docs.id, 'Planning')).toMatch(/is locked while/);
      expect(byHand(ui.id, 'Planning')).toMatch(/is locked while/);

      // Started, in a column no agent judges (none is chosen here): the drag to
      // the next column on its route is the report, and only that one.
      tasks.move({ taskId: api.id, targetSwimlaneId: laneId('home', 'Executing'), targetPosition: 0 }, { origin: 'workflow' });
      expect(byHand(api.id, 'Code Review')).toBeNull();
      expect(byHand(api.id, 'Testing')).toMatch(/is locked while/);
    });

    it('shows a moved task as current, the columns before it done and the rest ahead', async () => {
      const { workflow, api } = await started();
      const tasks = new TaskRepository(homeDb());
      tasks.move({ taskId: api.id, targetSwimlaneId: laneId('home', 'Planning'), targetPosition: 0 }, { origin: 'workflow' });
      tasks.move({ taskId: api.id, targetSwimlaneId: laneId('home', 'Code Review'), targetPosition: 0 }, { origin: 'workflow' });
      const task = view.readWorkflowDetail(context, 'home', workflow.id).tasks.find((candidate) => candidate.key === api.id)!;
      expect(task.place).toBe('working');
      expect(task.steps.map((step) => step.state)).toEqual(['done', 'done', 'current', 'ahead', 'ahead']);
      expect(task.steps[0].finishedAt).not.toBeNull();
    });

    it('links, routes and removes started tasks through the same rules an agent gets', async () => {
      const { workflow, api, ui, docs } = await started();
      view.setViewLink(context, 'home', workflow.id, docs.id, ui.id, true);
      expect(view.readWorkflowDetail(context, 'home', workflow.id).links).toHaveLength(2);
      view.setViewLink(context, 'home', workflow.id, docs.id, ui.id, false);

      view.setViewRoute(context, 'home', workflow.id, api.id, [laneId('home', 'Executing')]);
      expect(new TaskRepository(homeDb()).getById(api.id)!.route_start_swimlane_id).toBe(laneId('home', 'Executing'));

      view.removeViewTask(context, 'home', workflow.id, ui.id);
      const after = new TaskRepository(homeDb()).getById(ui.id)!;
      expect(after.workflow_id).toBeNull();
      expect(view.readWorkflowDetail(context, 'home', workflow.id).links).toEqual([]);
    });

    it('adds a task to a running workflow in To Do', async () => {
      const { workflow } = await started();
      const key = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets alerts' });
      const added = new TaskRepository(homeDb()).getById(key)!;
      expect(added.workflow_id).toBe(workflow.id);
      expect(lanesOf('home').find((lane) => lane.id === added.swimlane_id)?.role).toBe('todo');
    });

    it('stores a started card position without touching updated_at', async () => {
      const { workflow, api } = await started();
      const before = new TaskRepository(homeDb()).getById(api.id)!.updated_at;
      view.setViewPositions(context, 'home', workflow.id, [{ key: api.id, x: 40, y: 60 }]);
      const after = new TaskRepository(homeDb()).getById(api.id)!;
      expect(after.canvas_x).toBe(40);
      expect(after.updated_at).toBe(before);
      view.setViewPositions(context, 'home', workflow.id, null);
      expect(new TaskRepository(homeDb()).getById(api.id)!.canvas_x).toBeNull();
    });

    it('refuses an edit on a finished workflow', async () => {
      const { workflow } = await started();
      new WorkflowRepository(homeDb()).setState(workflow.id, 'done');
      expect(() => view.addViewTask(context, 'home', workflow.id, { title: 'Late' })).toThrow(/complete/);
    });
  });

  it('makes a workflow from a To Do task, its title and description the brief', () => {
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const source = new TaskRepository(homeDb()).create({ title: 'Usage budgets', description: 'Cap spend per project.', swimlane_id: todo.id });
    const workflow = view.createWorkflowForView(context, 'home', source.id);
    expect(workflow.brief).toBe('Usage budgets\n\nCap spend per project.');
    expect(workflow.source_task_id).toBe(source.id);

    const executing = laneId('home', 'Executing');
    const started = new TaskRepository(homeDb()).create({ title: 'Already going', description: '', swimlane_id: executing });
    expect(() => view.createWorkflowForView(context, 'home', started.id)).toThrow(/Only a task in To Do/);
  });

  it('pushes one coalesced change per workflow to the window', () => {
    vi.useFakeTimers();
    setWorkflowChangedWindow(() => context.mainWindow);
    const workflow = service.createWorkflow('home', {});
    view.addViewTask(context, 'home', workflow.id, { title: 'API' });
    view.addViewTask(context, 'home', workflow.id, { title: 'UI' });
    expect(harness.sent).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(harness.sent).toEqual([{ channel: IPC.WORKFLOW_CHANGED, payload: { projectId: 'home', workflowId: workflow.id } }]);
  });
});
