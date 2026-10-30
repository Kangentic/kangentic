/**
 * The Workflows view's operations on real, migrated SQLite: the read model the
 * canvas and inspector draw, the planned-workflow edits addressed by key and
 * column id, the positions write that changes no plan, and the change push.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>(), sent: [] as Array<{ channel: string; payload: unknown }> }));
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
vi.mock('../../src/main/ipc/send-to-renderer', () => ({
  sendToRenderer: (_window: unknown, channel: string, payload: unknown) => harness.sent.push({ channel, payload }),
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { AutomationRunRepository } = await import('../../src/main/db/repositories/automation-run-repository');
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

  it('reads each planned task\'s plan approval from the plan columns on its own route, across boards', () => {
    // The seeded boards plan in Planning, Manual by default.
    const workflow = service.createWorkflow('home', {});
    const apiKey = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });
    const phoneKey = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets on the phone', projectId: 'mobile' });
    const approvalOf = (key: string) => view.readWorkflowDetail(context, 'home', workflow.id).tasks.find((task) => task.key === key)!.planApproval;
    expect(approvalOf(apiKey)).toMatchObject({ value: 'manual', set: null, canApprove: true, passed: false });

    // One board's Planning on Automatic moves only the task on that board.
    new SwimlaneRepository(homeDb()).update({ id: laneId('home', 'Planning'), plan_approval: 'automatic' });
    expect(approvalOf(apiKey)).toMatchObject({ value: 'automatic', column: { name: 'Planning', boardName: 'kangentic' } });
    expect(approvalOf(phoneKey)).toMatchObject({ value: 'manual', column: { name: 'Planning', boardName: 'kangentic-mobile' } });

    // A plan column on an agent that cannot approve plans makes it Manual, with Automatic off.
    new SwimlaneRepository(homeDb()).update({ id: laneId('home', 'Planning'), agent_override: 'codex' });
    expect(approvalOf(apiKey)).toMatchObject({ value: 'manual', canApprove: false });
  });

  it('sets a planned task\'s own plan approval, storing its column\'s own value as nothing', () => {
    const workflow = service.createWorkflow('home', {});
    const key = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });
    const plannedValue = () => view.readWorkflowDetail(context, 'home', workflow.id).tasks.find((task) => task.key === key)!.planned!.plan_approval;

    view.setViewPlanApproval(context, 'home', workflow.id, key, 'automatic');
    expect(plannedValue()).toBe('automatic');

    // The seeded Planning column is Manual: picking it goes back to following the column.
    view.setViewPlanApproval(context, 'home', workflow.id, key, 'manual');
    expect(plannedValue()).toBeNull();
  });

  it('refuses a plan approval for a key that is no longer in the plan, writing nothing', () => {
    const workflow = service.createWorkflow('home', {});
    const key = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });
    const before = new WorkflowRepository(homeDb()).getById(workflow.id)!;

    expect(() => view.setViewPlanApproval(context, 'home', workflow.id, 'task-9', 'automatic')).toThrow(/no longer in the plan/);

    const after = new WorkflowRepository(homeDb()).getById(workflow.id)!;
    expect(after.revision).toBe(before.revision);
    expect(after.draft?.tasks.find((task) => task.key === key)?.plan_approval).toBeNull();
  });

  it('a planned task moved to another board drops its own plan approval and follows the new board\'s columns', () => {
    const workflow = service.createWorkflow('home', {});
    const key = view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });
    view.setViewPlanApproval(context, 'home', workflow.id, key, 'automatic');

    view.updatePlannedTask(context, 'home', workflow.id, key, { projectId: 'mobile' });

    expect(view.readWorkflowDetail(context, 'home', workflow.id).tasks.find((task) => task.key === key)!.planned!.plan_approval).toBeNull();
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
    const checkEndsAndReadDoneColors = (projectIds: string[]) => {
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
    expect(checkEndsAndReadDoneColors(['home'])).toEqual({ home: homeDone });
    service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'api', title: 'Budgets API' }, { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' }],
      links: [],
    });
    expect(checkEndsAndReadDoneColors(['home', 'mobile'])).toEqual({ home: homeDone, mobile: '#a855f7' });
    await service.startWorkflow(context, 'home', workflow.id);
    expect(checkEndsAndReadDoneColors(['home', 'mobile'])).toEqual({ home: homeDone, mobile: '#a855f7' });
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

    it('counts the tasks the Delete confirm may delete: in To Do and never started', async () => {
      const { workflow, api, ui } = await started();
      const tasks = new TaskRepository(homeDb());
      // One that left To Do and came back: the reset wiped what it ran, but not its moves.
      const lanes = new SwimlaneRepository(homeDb()).list();
      const planning = lanes.find((lane) => lane.name === 'Planning')!;
      const todo = lanes.find((lane) => lane.role === 'todo')!;
      tasks.move({ taskId: api.id, targetSwimlaneId: planning.id, targetPosition: 0 }, { origin: 'renderer' });
      tasks.move({ taskId: api.id, targetSwimlaneId: todo.id, targetPosition: 0 }, { origin: 'renderer' });
      // And one with a worktree.
      tasks.update({ id: ui.id, worktree_path: '/projects/home/.kangentic/worktrees/ui' });

      const summary = view.listWorkflowSummaries(context, 'home').find((candidate) => candidate.workflow.id === workflow.id);
      expect(summary?.neverStartedCount).toBe(1);
    });

    it('gives each board card what it waits for, where a hand may move it, and whether it has links', async () => {
      const { workflow, api, ui, docs } = await started();
      const [before] = view.listWorkflowSummaries(context, 'home');
      expect(before.boardTasks[ui.id]).toEqual({ waitingFor: [`#${api.display_id}`], humanGateTargetId: null, hasLinks: true, stallReason: null });
      // Docs has no link either way, so its strip offers none to show.
      expect(before.boardTasks[docs.id]).toEqual({ waitingFor: [], humanGateTargetId: null, hasLinks: false, stallReason: null });

      // In a column whose work no agent can judge (here, none is chosen), a person drags it on.
      new TaskRepository(homeDb()).move(
        { taskId: api.id, targetSwimlaneId: laneId('home', 'Executing'), targetPosition: 0 },
        { origin: 'renderer' },
      );
      const [after] = view.listWorkflowSummaries(context, 'home');
      // A blocker has links too: the link is read from either end.
      expect(after.boardTasks[api.id]).toEqual({ waitingFor: [], humanGateTargetId: laneId('home', 'Code Review'), hasLinks: true, stallReason: null });
      expect(after.workflow).toMatchObject({ id: workflow.id, state: 'running' });
    });

    // A stall is read from the run log (`listStalledTasks`), so the mark
    // survives a restart and an automatic pause, and a later judged turn or a
    // move clears it with no other state to keep in step.
    it('marks a task the workflow stalled on, until a turn is judged or it moves', async () => {
      const { workflow, api } = await started();
      const executing = laneId('home', 'Executing');
      new TaskRepository(homeDb()).move({ taskId: api.id, targetSwimlaneId: executing, targetPosition: 0 }, { origin: 'workflow' });
      const runs = new AutomationRunRepository(homeDb());
      runs.recordWorkflowStall({ taskId: api.id, swimlaneId: executing, workflowId: workflow.id, reason: 'the step check could not run.', countedNudges: 0 });

      const [stalled] = view.listWorkflowSummaries(context, 'home');
      expect(stalled.stalledTasks).toEqual([{ taskId: api.id, displayId: api.display_id, reason: 'the step check could not run.' }]);
      expect(stalled.boardTasks[api.id].stallReason).toBe('the step check could not run.');
      expect(view.readWorkflowDetail(context, 'home', workflow.id).tasks.find((task) => task.key === api.id)!.stallReason)
        .toBe('the step check could not run.');
      expect(service.readWorkflow(context, 'home', workflow.id).tasks.find((task) => task.taskId === api.id)!.stalled)
        .toBe('the step check could not run.');

      // A paused workflow says Paused, not Stalled.
      new WorkflowRepository(homeDb()).setState(workflow.id, 'paused');
      expect(view.listWorkflowSummaries(context, 'home')[0].stalledTasks).toEqual([]);
      new WorkflowRepository(homeDb()).setState(workflow.id, 'running');

      // A later turn the step check judged clears it.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      runs.recordWorkflowStep({ taskId: api.id, swimlaneId: executing, workflowId: workflow.id, met: false, reason: 'Not yet.', detail: 'Not done yet: Not yet.' });
      expect(view.listWorkflowSummaries(context, 'home')[0].stalledTasks).toEqual([]);
      expect(view.listWorkflowSummaries(context, 'home')[0].boardTasks[api.id].stallReason).toBeNull();
    });

    describe('a task whose own automations are paused', () => {
      // The task's hold: a person works it by hand while the rest of the workflow
      // runs. The workflow neither judges nor nudges it, so no stall is read for
      // it, and no human-gate exit is offered (a hand may move it anywhere but
      // To Do). Every case first asserts the same task not held, so a "none"
      // cannot pass because the fixture was never stalled or never in a gate.
      async function startedInExecuting() {
        const fixture = await started();
        const tasks = new TaskRepository(homeDb());
        const executing = laneId('home', 'Executing');
        tasks.move({ taskId: fixture.api.id, targetSwimlaneId: executing, targetPosition: 0 }, { origin: 'workflow' });
        return { ...fixture, tasks, executing };
      }

      const summaryTask = (workflowId: string, taskId: string) =>
        view.listWorkflowSummaries(context, 'home').find((summary) => summary.workflow.id === workflowId)!.boardTasks[taskId];
      const viewTask = (workflowId: string, taskId: string) =>
        view.readWorkflowDetail(context, 'home', workflowId).tasks.find((task) => task.key === taskId)!;
      const agentTask = (workflowId: string, taskId: string) =>
        service.readWorkflow(context, 'home', workflowId).tasks.find((task) => task.taskId === taskId)!;

      it('reads no stall for it in the summary, the canvas or the agent view, and reads it again once resumed', async () => {
        const { workflow, api, tasks, executing } = await startedInExecuting();
        new AutomationRunRepository(homeDb()).recordWorkflowStall({
          taskId: api.id, swimlaneId: executing, workflowId: workflow.id, reason: 'the step check could not run.', countedNudges: 0,
        });
        // Not held: the stall shows everywhere it is read.
        expect(summaryTask(workflow.id, api.id).stallReason).toBe('the step check could not run.');
        expect(view.listWorkflowSummaries(context, 'home')[0].stalledTasks).toHaveLength(1);
        expect(viewTask(workflow.id, api.id).stallReason).toBe('the step check could not run.');
        expect(agentTask(workflow.id, api.id).stalled).toBe('the step check could not run.');

        tasks.update({ id: api.id, automations_disabled: true });

        expect(summaryTask(workflow.id, api.id).stallReason).toBeNull();
        expect(view.listWorkflowSummaries(context, 'home')[0].stalledTasks).toEqual([]);
        expect(viewTask(workflow.id, api.id).stallReason).toBeNull();
        expect(agentTask(workflow.id, api.id).stalled).toBeNull();

        // The row is still in the run log, so resuming brings the mark back
        // until recovery starts over (the hold module's job, pinned apart).
        tasks.update({ id: api.id, automations_disabled: false });
        expect(summaryTask(workflow.id, api.id).stallReason).toBe('the step check could not run.');
      });

      it('names no human-gate exit for it, where the same task not held names the next column', async () => {
        const { workflow, api, tasks } = await startedInExecuting();
        expect(summaryTask(workflow.id, api.id).humanGateTargetId).toBe(laneId('home', 'Code Review'));

        tasks.update({ id: api.id, automations_disabled: true });

        expect(summaryTask(workflow.id, api.id).humanGateTargetId).toBeNull();
      });

      it('lets a hand move it to any column but To Do, through the real lock check, and keeps another agent out', async () => {
        const { api, tasks } = await startedInExecuting();
        const check = (column: string, origin: 'renderer' | 'agent') => lock.checkWorkflowMove(context, {
          projectId: 'home',
          task: tasks.getById(api.id)!,
          toSwimlaneId: laneId('home', column),
          origin,
          moverIsTaskAgent: false,
        });
        // Not held: only the gate's next column is open to a hand.
        expect(check('Testing', 'renderer')).toMatch(/is locked while/);

        tasks.update({ id: api.id, automations_disabled: true });

        expect(check('Testing', 'renderer')).toBeNull();
        expect(check('Done', 'renderer')).toBeNull();
        expect(check('To Do', 'renderer')).toMatch(/Remove it from the workflow to move it to To Do/);
        expect(check('Testing', 'agent')).toMatch(/is locked while/);
      });

      it('says so in the agent view of a started task, and not for a finished one', async () => {
        const { workflow, api, ui, tasks } = await startedInExecuting();
        expect(agentTask(workflow.id, api.id).automationsPaused).toBe(false);

        tasks.update({ id: api.id, automations_disabled: true });
        tasks.update({ id: ui.id, automations_disabled: true });
        expect(agentTask(workflow.id, api.id).automationsPaused).toBe(true);
        // Held in To Do reads held too: the engine will not start it.
        expect(agentTask(workflow.id, ui.id).automationsPaused).toBe(true);

        tasks.move({ taskId: api.id, targetSwimlaneId: laneId('home', 'Done'), targetPosition: 0 }, { origin: 'workflow' });
        expect(agentTask(workflow.id, api.id).automationsPaused).toBe(false);
      });

      it('says nothing of it for a planned task, which has no row to hold', () => {
        const workflow = service.createWorkflow('home', {});
        view.addViewTask(context, 'home', workflow.id, { title: 'Budgets API' });

        expect(service.readWorkflow(context, 'home', workflow.id).tasks.map((task) => task.automationsPaused)).toEqual([false]);
      });
    });

    describe('when a blocker on another board is missing from the read', () => {
      /** Budgets UI waits for Budgets API, which is on the mobile board. */
      async function startedAcrossBoards() {
        const workflow = service.createWorkflow('home', {});
        service.savePlan(context, 'home', workflow.id, {
          tasks: [
            { key: 'api', title: 'Budgets API', project: 'mobile' },
            { key: 'ui', title: 'Budgets UI' },
          ],
          links: [{ blocker: 'api', blocked: 'ui' }],
        });
        await service.startWorkflow(context, 'home', workflow.id);
        const api = new TaskRepository(harness.dbs.get('mobile') as Database.Database).listByWorkflow(workflow.id)[0];
        const ui = new TaskRepository(homeDb()).listByWorkflow(workflow.id)[0];
        return { workflow, api, ui };
      }

      const uiOf = (workflowId: string, uiId: string) => view.readWorkflowDetail(context, 'home', workflowId).tasks.find((task) => task.key === uiId)!;
      const summaryOf = (workflowId: string) => view.listWorkflowSummaries(context, 'home').find((summary) => summary.workflow.id === workflowId)!;
      const waitsForOf = (workflowId: string, uiId: string) =>
        service.readWorkflow(context, 'home', workflowId).tasks.find((task) => task.taskId === uiId)!.waitsFor;

      it('names a live blocker by its number, on its board', async () => {
        const { workflow, api, ui } = await startedAcrossBoards();
        expect(uiOf(workflow.id, ui.id).unnamedBlockerCount).toBe(0);
        expect(summaryOf(workflow.id).boardTasks[ui.id].waitingFor).toEqual([`#${api.display_id}`]);
        expect(waitsForOf(workflow.id, ui.id)).toEqual([`#${api.display_id} on "kangentic-mobile"`]);
      });

      it('leaves out a blocker that is provably gone, since the engine drops its link', async () => {
        const { workflow, api, ui } = await startedAcrossBoards();
        // Deleted without the remover: what a delete whose home write threw leaves.
        (harness.dbs.get('mobile') as Database.Database).prepare('DELETE FROM tasks WHERE id = ?').run(api.id);

        const detail = view.readWorkflowDetail(context, 'home', workflow.id);
        expect(detail.links).toEqual([]);
        expect(detail.tasks.find((task) => task.key === ui.id)!.unnamedBlockerCount).toBe(0);
        const summary = summaryOf(workflow.id);
        expect(summary.boardTasks[ui.id].waitingFor).toEqual([]);
        expect(summary).toMatchObject({ queuedCount: 1, blockedCount: 0 });
        expect(waitsForOf(workflow.id, ui.id)).toEqual([]);
      });

      it('counts a blocker whose project will not open as an unnamed one that still holds', async () => {
        const { workflow, ui } = await startedAcrossBoards();
        (harness.dbs.get('mobile') as Database.Database).close();
        harness.dbs.delete('mobile');

        const detail = view.readWorkflowDetail(context, 'home', workflow.id);
        expect(detail.links).toEqual([]);
        expect(detail.tasks.find((task) => task.key === ui.id)!.unnamedBlockerCount).toBe(1);
        const summary = summaryOf(workflow.id);
        expect(summary.boardTasks[ui.id].waitingFor).toEqual(['a task']);
        expect(summary).toMatchObject({ queuedCount: 0, blockedCount: 1 });
        expect(waitsForOf(workflow.id, ui.id)).toEqual(['a task on "kangentic-mobile" that could not be read']);
      });

      it('counts two blockers on one task as two, one per missing blocker', async () => {
        const workflow = service.createWorkflow('home', {});
        service.savePlan(context, 'home', workflow.id, {
          tasks: [
            { key: 'api', title: 'Budgets API', project: 'mobile' },
            { key: 'schema', title: 'Budgets schema', project: 'mobile' },
            { key: 'ui', title: 'Budgets UI' },
          ],
          links: [{ blocker: 'api', blocked: 'ui' }, { blocker: 'schema', blocked: 'ui' }],
        });
        await service.startWorkflow(context, 'home', workflow.id);
        const ui = new TaskRepository(homeDb()).listByWorkflow(workflow.id)[0];
        const mobileTasks = new TaskRepository(harness.dbs.get('mobile') as Database.Database).listByWorkflow(workflow.id);
        expect(mobileTasks).toHaveLength(2);
        // The control: both blockers read, so both are named and none is unnamed.
        expect(uiOf(workflow.id, ui.id).unnamedBlockerCount).toBe(0);
        expect(summaryOf(workflow.id).boardTasks[ui.id].waitingFor).toHaveLength(2);

        (harness.dbs.get('mobile') as Database.Database).close();
        harness.dbs.delete('mobile');

        expect(uiOf(workflow.id, ui.id).unnamedBlockerCount).toBe(2);
        const summary = summaryOf(workflow.id);
        expect(summary.boardTasks[ui.id].waitingFor).toEqual(['a task', 'a task']);
        expect(summary).toMatchObject({ queuedCount: 0, blockedCount: 1 });
        expect(waitsForOf(workflow.id, ui.id)).toEqual([
          'a task on "kangentic-mobile" that could not be read',
          'a task on "kangentic-mobile" that could not be read',
        ]);
      });

      it('names a held blocker on this board as "this board", since the home board has no name to give', async () => {
        const workflow = service.createWorkflow('home', {});
        service.savePlan(context, 'home', workflow.id, {
          tasks: [
            { key: 'api', title: 'Budgets API' },
            { key: 'ui', title: 'Budgets UI' },
          ],
          links: [{ blocker: 'api', blocked: 'ui' }],
        });
        await service.startWorkflow(context, 'home', workflow.id);
        const tasks = new TaskRepository(homeDb()).listByWorkflow(workflow.id);
        const api = tasks.find((task) => task.title === 'Budgets API')!;
        const ui = tasks.find((task) => task.title === 'Budgets UI')!;
        // The control: read, a blocker on this board is named by its number alone.
        expect(waitsForOf(workflow.id, ui.id)).toEqual([`#${api.display_id}`]);

        // The blocker keeps this workflow's id, so it is held, but its row names another
        // home, so the read leaves it out: missing from the read without being gone.
        homeDb().prepare('UPDATE tasks SET workflow_project_id = ? WHERE id = ?').run('elsewhere', api.id);

        expect(waitsForOf(workflow.id, ui.id)).toEqual(['a task on "this board" that could not be read']);
        expect(uiOf(workflow.id, ui.id).unnamedBlockerCount).toBe(1);
        expect(summaryOf(workflow.id).boardTasks[ui.id].waitingFor).toEqual(['a task']);
      });
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

    describe('when the lock cannot read the task\'s workflow', () => {
      /** An agent that is not the task's own, moving it out of To Do: the lock's plain refusal while the workflow reads. */
      async function startedTaskMove() {
        const { api } = await started();
        const task = new TaskRepository(homeDb()).getById(api.id)!;
        const move = () => lock.checkWorkflowMove(context, {
          projectId: 'home',
          task,
          toSwimlaneId: laneId('home', 'Executing'),
          origin: 'agent',
          moverIsTaskAgent: false,
        });
        return { task, move };
      }

      it('allows the move and logs the read failure, naming the workflow, the task and the error', async () => {
        const { task, move } = await startedTaskMove();
        // The control: the same move is refused while the workflow can be read.
        expect(move()).toMatch(/is locked while/);

        const readFailure = new Error('database disk image is malformed');
        const readSpy = vi.spyOn(WorkflowRepository.prototype, 'getById').mockImplementation(() => {
          throw readFailure;
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          expect(move()).toBeNull();

          expect(warnSpy).toHaveBeenCalledTimes(1);
          const [message, logged] = warnSpy.mock.calls[0];
          expect(message).toMatch(/^\[WORKFLOW-LOCK\] Could not read workflow .*, so the move is allowed:$/);
          expect(message).toContain(task.workflow_id);
          expect(message).toContain(task.id.slice(0, 8));
          expect(logged).toBe(readFailure);
        } finally {
          warnSpy.mockRestore();
          readSpy.mockRestore();
        }
      });

      it('allows the move without a log when the workflow is gone: an ordinary task, not a failed read', async () => {
        const { move } = await startedTaskMove();
        const readSpy = vi.spyOn(WorkflowRepository.prototype, 'getById').mockReturnValue(undefined);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          expect(move()).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
          readSpy.mockRestore();
        }
      });
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

    describe('setting a started task\'s plan approval from the view', () => {
      /** The task row's own value, read raw around the repository's narrowing. */
      const storedApproval = (taskId: string): unknown =>
        (homeDb().prepare('SELECT plan_approval FROM tasks WHERE id = ?').get(taskId) as { plan_approval: unknown }).plan_approval;

      it('writes the task row by its id, storing the plan column\'s own value as nothing', async () => {
        const { workflow, api, ui } = await started();
        expect(storedApproval(api.id)).toBeNull();

        // The seeded Planning column is Manual, so Automatic is an override worth storing.
        view.setViewPlanApproval(context, 'home', workflow.id, api.id, 'automatic');
        expect(storedApproval(api.id)).toBe('automatic');
        // Only the task it names.
        expect(storedApproval(ui.id)).toBeNull();

        // Picking the column's own value goes back to following the column.
        view.setViewPlanApproval(context, 'home', workflow.id, api.id, 'manual');
        expect(storedApproval(api.id)).toBeNull();

        view.setViewPlanApproval(context, 'home', workflow.id, api.id, 'automatic');
        view.setViewPlanApproval(context, 'home', workflow.id, api.id, null);
        expect(storedApproval(api.id)).toBeNull();
      });

      it('shows the stored value in the read model it draws from', async () => {
        const { workflow, api } = await started();

        view.setViewPlanApproval(context, 'home', workflow.id, api.id, 'automatic');

        const task = view.readWorkflowDetail(context, 'home', workflow.id).tasks.find((candidate) => candidate.key === api.id)!;
        expect(task.planApproval).toMatchObject({ set: 'automatic', value: 'automatic' });
      });

      it('refuses a key that is no task of the workflow, writing nothing', async () => {
        const { workflow, api, ui } = await started();

        // The view's key for a started task is its id: the number an agent reads is not one.
        expect(() => view.setViewPlanApproval(context, 'home', workflow.id, `#${api.display_id}`, 'automatic'))
          .toThrow(/That task is no longer in this workflow\./);
        expect(() => view.setViewPlanApproval(context, 'home', workflow.id, 'no-such-task', 'automatic'))
          .toThrow(/That task is no longer in this workflow\./);

        expect(storedApproval(api.id)).toBeNull();
        expect(storedApproval(ui.id)).toBeNull();
      });

      it('refuses a finished workflow, leaving the row as it was', async () => {
        const { workflow, api } = await started();
        view.setViewPlanApproval(context, 'home', workflow.id, api.id, 'automatic');
        new WorkflowRepository(homeDb()).setState(workflow.id, 'done');

        // The only hold `requireViewMayChange` has today. Its docblock says the hold on an
        // edit while the workflow agent works is still to come, so none is pinned here.
        expect(() => view.setViewPlanApproval(context, 'home', workflow.id, api.id, null)).toThrow(/complete/);

        expect(storedApproval(api.id)).toBe('automatic');
      });
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
