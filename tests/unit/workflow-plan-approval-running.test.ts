/**
 * The plan approval a STARTED workflow task gets (`readTaskPlanApproval`) and
 * the push that tells open Workflows views to re-read it
 * (`notifyWorkflowsReadingBoard`), over real, migrated SQLite.
 *
 * workflow-view-service.test.ts pins the value as the inspector draws it for a
 * planned workflow. This pins what holds once the workflow has started: each
 * task reads the plan columns on its OWN route, the agent that runs it is the
 * task's own answer, and the shape says whether Automatic is on offer and
 * whether the task has passed its plan column.
 *
 * The seeded boards plan in Planning, Manual by default; Planning runs in plan
 * mode, so it is the one plan column on a route that visits it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { PlanApproval } from '../../src/shared/types';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Project ids whose database read fails, as a locked or corrupt file does. */
  throwFor: new Set<string>(),
}));
const notifyWorkflowChanged = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    if (harness.throwFor.has(projectId)) throw new Error('disk I/O error');
    return harness.dbs.get(projectId) ?? null;
  },
  getProjectDb: (projectId: string) => {
    if (harness.throwFor.has(projectId)) throw new Error('disk I/O error');
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged,
  notifyWorkflowOfTask: vi.fn(),
  setWorkflowChangedWindow: vi.fn(),
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { readTaskPlanApproval, notifyWorkflowsReadingBoard } = await import('../../src/main/plan-approval/workflow-plan-approval');
const { agentRegistry } = await import('../../src/main/agent/agent-registry');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

interface TestProject {
  id: string;
  name: string;
  path: string;
  default_agent?: string;
}

describe('a running workflow\'s plan approval', () => {
  let context: IpcContext;
  let projects: TestProject[];

  function database(projectId: string): Database.Database {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
    return db;
  }

  beforeEach(() => {
    harness.dbs.clear();
    harness.throwFor.clear();
    notifyWorkflowChanged.mockClear();
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
      configManager: { load: () => ({}) },
      boardConfigManager: { getBoardProfiles: () => [] },
      sessionManager: { listSessions: () => [], getActivityCache: () => ({}) },
    } as unknown as IpcContext;
  });

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const lanesOf = (projectId: string) => new SwimlaneRepository(dbOf(projectId)).list();
  const laneId = (projectId: string, name: string) => lanesOf(projectId).find((lane) => lane.name === name)!.id;
  const workflowOf = (workflowId: string) => new WorkflowRepository(dbOf('home')).getById(workflowId)!;

  function setPlanColumn(projectId: string, planApproval: PlanApproval): void {
    new SwimlaneRepository(dbOf(projectId)).update({ id: laneId(projectId, 'Planning'), plan_approval: planApproval });
  }

  function setAgentOverride(projectId: string, taskId: string, agent: string | null): void {
    dbOf(projectId).prepare('UPDATE tasks SET agent_override = ? WHERE id = ?').run(agent, taskId);
  }

  function moveTo(projectId: string, taskId: string, columnName: string): void {
    new TaskRepository(dbOf(projectId)).move(
      { taskId, targetSwimlaneId: laneId(projectId, columnName), targetPosition: 0 },
      { origin: 'workflow' },
    );
  }

  type PlannedTasks = Parameters<typeof service.savePlan>[3]['tasks'];

  /** Plans and starts a workflow homed on `home`. */
  async function start(tasks: PlannedTasks) {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, { tasks, links: [] });
    await service.startWorkflow(context, 'home', workflow.id);
    const taskOn = (projectId: string, title: string) => new TaskRepository(dbOf(projectId)).listByWorkflow(workflow.id).find((task) => task.title === title)!;
    return {
      workflowId: workflow.id,
      taskOn,
      /** The task's plan approval, read as the decision and the views read it. */
      approvalOf: (projectId: string, title: string) =>
        readTaskPlanApproval(context, projectId, taskOn(projectId, title), workflowOf(workflow.id).plan_approval),
      setOwn: (projectId: string, title: string, planApproval: PlanApproval | null) =>
        new TaskRepository(dbOf(projectId)).setPlanApproval(taskOn(projectId, title).id, planApproval),
    };
  }

  const codexName = () => agentRegistry.get('codex')?.displayName ?? 'codex';

  describe('its own route', () => {
    it('a Manual plan column on another board holds only the task whose route passes through it', async () => {
      setPlanColumn('home', 'automatic');
      const { approvalOf } = await start([
        { key: 'api', title: 'Budgets API' },
        { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' },
      ]);

      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', set: null, column: { name: 'Planning', boardName: 'kangentic' } });
      expect(approvalOf('mobile', 'Budgets on the phone')).toMatchObject({ value: 'manual', set: null, column: { name: 'Planning', boardName: 'kangentic-mobile' } });
    });

    it('says when the task has passed its plan column, and that Done has passed it too', async () => {
      const { approvalOf, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approvalOf('home', 'Budgets API')?.passed).toBe(false);

      moveTo('home', taskOn('home', 'Budgets API').id, 'Planning');
      expect(approvalOf('home', 'Budgets API')?.passed).toBe(false);

      moveTo('home', taskOn('home', 'Budgets API').id, 'Executing');
      expect(approvalOf('home', 'Budgets API')?.passed).toBe(true);

      moveTo('home', taskOn('home', 'Budgets API').id, 'Done');
      expect(approvalOf('home', 'Budgets API')?.passed).toBe(true);
    });

    it('with two plan columns on one route, a task between them has not passed its plan column, and one after the second has', async () => {
      // Code Review runs in plan mode too, so the route has two plan columns,
      // Planning and Code Review, with Executing between them.
      new SwimlaneRepository(dbOf('home')).update({ id: laneId('home', 'Code Review'), permission_mode: 'plan' });
      setPlanColumn('home', 'automatic');
      const { approvalOf, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      // Precondition: both are plan columns on this route (Code Review is Manual, so it decides).
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ columnValue: 'manual', column: { name: 'Code Review' } });

      const passedIn = (columnName: string): boolean | undefined => {
        moveTo('home', taskOn('home', 'Budgets API').id, columnName);
        return approvalOf('home', 'Budgets API')?.passed;
      };

      expect(passedIn('Planning')).toBe(false);
      expect(passedIn('Executing')).toBe(false);
      expect(passedIn('Code Review')).toBe(false);
      expect(passedIn('Testing')).toBe(true);
      expect(passedIn('Merge')).toBe(true);
      expect(passedIn('Done')).toBe(true);
    });

    it('is null for a route that visits no plan column', async () => {
      // A route that starts after Planning visits no plan column.
      const { approvalOf } = await start([{ key: 'api', title: 'Budgets API', routeStart: 'Executing' }]);

      expect(approvalOf('home', 'Budgets API')).toBeNull();
    });
  });

  describe('which agent would run each task', () => {
    it('reads a task\'s own agent override, an agent that cannot approve plans, as Manual and not on offer', async () => {
      setPlanColumn('home', 'automatic');
      const { approvalOf, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', canApprove: true, agentName: null });

      setAgentOverride('home', taskOn('home', 'Budgets API').id, 'codex');

      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'manual', canApprove: false, agentName: codexName() });
    });

    it('does not read the agent that last ran on a task as the agent that would run it next', async () => {
      // `task.agent` records what ran, for resume and handoff. The override,
      // the column and the project name what runs next (`resolveTargetAgent`).
      setPlanColumn('home', 'automatic');
      const { approvalOf, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      dbOf('home').prepare('UPDATE tasks SET agent = ? WHERE id = ?').run('codex', taskOn('home', 'Budgets API').id);

      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', canApprove: true });
    });

    it('reads the board\'s default agent when nothing closer names one, and lets a task override win over it', async () => {
      setPlanColumn('home', 'automatic');
      projects[0].default_agent = 'codex';
      const { approvalOf, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'manual', canApprove: false });

      setAgentOverride('home', taskOn('home', 'Budgets API').id, 'claude');

      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', canApprove: true });
    });
  });

  describe('its own value', () => {
    it('holds over its plan column either way, and null follows the column again', async () => {
      const { approvalOf, setOwn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'manual', set: null, columnValue: 'manual' });

      setOwn('home', 'Budgets API', 'automatic');
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', set: 'automatic', columnValue: 'manual' });

      setPlanColumn('home', 'automatic');
      setOwn('home', 'Budgets API', 'manual');
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'manual', set: 'manual', columnValue: 'automatic' });

      setOwn('home', 'Budgets API', null);
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', set: null });
    });

    it('reads Manual and takes Automatic off offer when no plan column\'s agent can approve, even with its own Automatic', async () => {
      const { approvalOf, setOwn, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      setAgentOverride('home', taskOn('home', 'Budgets API').id, 'codex');
      setOwn('home', 'Budgets API', 'automatic');

      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'manual', set: 'automatic', canApprove: false });
    });

    it('a legacy whole-workflow value sits between the task\'s own value and its column', async () => {
      setPlanColumn('home', 'automatic');
      const { workflowId, approvalOf, setOwn } = await start([{ key: 'api', title: 'Budgets API' }]);
      dbOf('home').prepare("UPDATE workflows SET plan_approval = 'manual' WHERE id = ?").run(workflowId);

      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'manual', set: 'manual' });

      setOwn('home', 'Budgets API', 'automatic');
      expect(approvalOf('home', 'Budgets API')).toMatchObject({ value: 'automatic', set: 'automatic' });
    });
  });

  describe('notifyWorkflowsReadingBoard', () => {
    /** Runs the notification for one board and returns what it sent, as `[homeProjectId, workflowId]`. */
    function notifiedFor(boardProjectId: string): Array<[string, string]> {
      notifyWorkflowChanged.mockClear();
      notifyWorkflowsReadingBoard(context, boardProjectId);
      return notifyWorkflowChanged.mock.calls.map(([homeProjectId, workflowId]) => [homeProjectId as string, workflowId as string]);
    }

    function draftWith(tasks: PlannedTasks): string {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, { tasks, links: [] });
      return workflow.id;
    }

    it('tells a running workflow with a task on the board, under the workflow\'s home', async () => {
      const { workflowId } = await start([
        { key: 'api', title: 'Budgets API' },
        { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' },
      ]);

      expect(notifiedFor('mobile')).toEqual([['home', workflowId]]);
      expect(notifiedFor('home')).toEqual([['home', workflowId]]);
    });

    it('tells a draft workflow with a planned task on the board, and none whose plan is all on another board', () => {
      const draftId = draftWith([{ key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' }]);

      expect(notifiedFor('mobile')).toEqual([['home', draftId]]);
      expect(notifiedFor('home')).toEqual([]);
    });

    it('counts a planned task with no board named as being on the workflow\'s own', () => {
      const draftId = draftWith([{ key: 'api', title: 'Budgets API' }]);

      expect(notifiedFor('home')).toEqual([['home', draftId]]);
      expect(notifiedFor('mobile')).toEqual([]);
    });

    it('does not tell a running workflow whose tasks are all on another board', async () => {
      const { workflowId } = await start([{ key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' }]);

      expect(notifiedFor('home')).toEqual([]);
      expect(notifiedFor('mobile')).toEqual([['home', workflowId]]);
    });

    it('tells a workflow once, though the board lists it under two homes', async () => {
      const { workflowId, taskOn } = await start([
        { key: 'api', title: 'Budgets API' },
        { key: 'ui', title: 'Budgets UI' },
      ]);
      // A task row that predates the home column: the same workflow, listed twice.
      dbOf('home').prepare('UPDATE tasks SET workflow_project_id = NULL WHERE id = ?').run(taskOn('home', 'Budgets UI').id);
      expect(new TaskRepository(dbOf('home')).listWorkflowMemberships()).toHaveLength(2);

      expect(notifiedFor('home')).toEqual([[expect.any(String), workflowId]]);
    });

    it('tells a workflow once, though both a task and a planned task put it on the board', () => {
      const draftId = draftWith([
        { key: 'api', title: 'Budgets API' },
        { key: 'ui', title: 'Budgets UI' },
      ]);
      // A task row already pointing at the draft, so the board lists it as a member too.
      new TaskRepository(dbOf('home')).create({
        title: 'Budgets API',
        description: '',
        swimlane_id: laneId('home', 'To Do'),
        workflow: {
          workflow_id: draftId,
          workflow_project_id: 'home',
          route_start_swimlane_id: null,
          route_last_swimlane_id: null,
          skipped_swimlane_ids: [],
          canvas_x: null,
          canvas_y: null,
          plan_approval: null,
        },
      });
      expect(new TaskRepository(dbOf('home')).listWorkflowMemberships()).toHaveLength(1);

      expect(notifiedFor('home')).toEqual([['home', draftId]]);
    });

    it('swallows a board that will not read, with a warning', async () => {
      await start([{ key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        harness.throwFor.add('mobile');
        notifyWorkflowChanged.mockClear();

        expect(() => notifyWorkflowsReadingBoard(context, 'mobile')).not.toThrow();

        expect(notifyWorkflowChanged).not.toHaveBeenCalled();
        // Once for the board's own task list, once for its project's drafts.
        expect(warn).toHaveBeenCalledTimes(2);
        for (const [message] of warn.mock.calls) expect(String(message)).toContain('[plan-approval]');
      } finally {
        warn.mockRestore();
      }
    });

    it('still reads every other project when one project\'s database will not read', () => {
      const draftId = draftWith([{ key: 'api', title: 'Budgets API' }]);
      // The unreadable project is listed ahead of the draft's home.
      projects = [projects[1], projects[0]];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        harness.throwFor.add('mobile');

        expect(notifiedFor('home')).toEqual([['home', draftId]]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('swallows another project\'s database that will not read, with a warning', async () => {
      await start([{ key: 'api', title: 'Budgets API' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        harness.throwFor.add('mobile');

        expect(() => notifyWorkflowsReadingBoard(context, 'home')).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
