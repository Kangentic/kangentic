/**
 * The plan approval a RUNNING workflow gets (`readWorkflowPlanApproval`) and
 * the push that tells open Workflows views to re-read it
 * (`notifyWorkflowsReadingBoard`), over real, migrated SQLite.
 *
 * workflow-view-service.test.ts pins the value as the inspector draws it for a
 * planned workflow. This pins what changes once the workflow has started: only
 * the tasks still ahead count, the agent that runs each one is the task's own
 * answer, and the returned shape says whether Automatic is on offer.
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
const { readWorkflowPlanApproval, notifyWorkflowsReadingBoard } = await import('../../src/main/plan-approval/workflow-plan-approval');

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

  function moveToDone(projectId: string, taskId: string): void {
    new TaskRepository(dbOf(projectId)).move(
      { taskId, targetSwimlaneId: laneId(projectId, 'Done'), targetPosition: 0 },
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
      approval: () => readWorkflowPlanApproval(context, 'home', workflowOf(workflow.id)),
      pick: (planApproval: PlanApproval | null) => new WorkflowRepository(dbOf('home')).setPlanApproval(workflow.id, planApproval),
    };
  }

  describe('which tasks count', () => {
    it('stops counting a task that is already in Done', async () => {
      // Home plans Automatic, mobile Manual: the value is Manual only while the
      // mobile task still has its Planning column ahead of it.
      setPlanColumn('home', 'automatic');
      const { approval, taskOn } = await start([
        { key: 'api', title: 'Budgets API' },
        { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' },
      ]);
      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: true });

      moveToDone('mobile', taskOn('mobile', 'Budgets on the phone').id);

      expect(approval()).toEqual({ value: 'automatic', picked: false, canApprove: true });
    });

    it('is Manual again, with Automatic on offer, once every task is in Done', async () => {
      setPlanColumn('home', 'automatic');
      const { approval, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approval().value).toBe('automatic');

      moveToDone('home', taskOn('home', 'Budgets API').id);

      // No plan column is ahead of anything, which derives Manual and offers Automatic.
      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: true });
    });
  });

  describe('which agent would run each task', () => {
    it('reads a task\'s own agent override, an agent that cannot approve plans, as Manual and not on offer', async () => {
      setPlanColumn('home', 'automatic');
      const { approval, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approval()).toEqual({ value: 'automatic', picked: false, canApprove: true });

      setAgentOverride('home', taskOn('home', 'Budgets API').id, 'codex');

      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: false });
    });

    it('does not read the agent that last ran on a task as the agent that would run it next', async () => {
      // `task.agent` records what ran, for resume and handoff. The override,
      // the column and the project name what runs next (`resolveTargetAgent`).
      setPlanColumn('home', 'automatic');
      const { approval, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      dbOf('home').prepare('UPDATE tasks SET agent = ? WHERE id = ?').run('codex', taskOn('home', 'Budgets API').id);

      expect(approval()).toEqual({ value: 'automatic', picked: false, canApprove: true });
    });

    it('reads the board\'s default agent when nothing closer names one, and lets a task override win over it', async () => {
      setPlanColumn('home', 'automatic');
      projects[0].default_agent = 'codex';
      const { approval, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: false });

      setAgentOverride('home', taskOn('home', 'Budgets API').id, 'claude');

      expect(approval()).toEqual({ value: 'automatic', picked: false, canApprove: true });
    });
  });

  describe('the shape it returns', () => {
    it('says a pick was made, and the pick holds over the plan columns either way', async () => {
      const { approval, pick } = await start([{ key: 'api', title: 'Budgets API' }]);
      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: true });

      pick('automatic');
      expect(approval()).toEqual({ value: 'automatic', picked: true, canApprove: true });

      setPlanColumn('home', 'automatic');
      pick('manual');
      expect(approval()).toEqual({ value: 'manual', picked: true, canApprove: true });

      pick(null);
      expect(approval()).toEqual({ value: 'automatic', picked: false, canApprove: true });
    });

    it('reads Manual and takes Automatic off offer when no plan column\'s agent can approve, even for a picked Automatic', async () => {
      const { approval, pick, taskOn } = await start([{ key: 'api', title: 'Budgets API' }]);
      setAgentOverride('home', taskOn('home', 'Budgets API').id, 'codex');
      pick('automatic');

      expect(approval()).toEqual({ value: 'manual', picked: true, canApprove: false });
    });

    it('keeps Automatic on offer while any plan column\'s agent can approve', async () => {
      setPlanColumn('home', 'automatic');
      setPlanColumn('mobile', 'automatic');
      const { approval, pick, taskOn } = await start([
        { key: 'api', title: 'Budgets API' },
        { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' },
      ]);
      setAgentOverride('mobile', taskOn('mobile', 'Budgets on the phone').id, 'codex');

      // Unpicked, one column that cannot approve is enough to wait.
      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: true });

      pick('automatic');
      expect(approval()).toEqual({ value: 'automatic', picked: true, canApprove: true });
    });

    it('offers Automatic when no plan column is ahead of any task at all', async () => {
      // A route that starts after Planning visits no plan column.
      const { approval, pick } = await start([{ key: 'api', title: 'Budgets API', routeStart: 'Executing' }]);
      expect(approval()).toEqual({ value: 'manual', picked: false, canApprove: true });

      pick('automatic');

      expect(approval()).toEqual({ value: 'automatic', picked: true, canApprove: true });
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
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('[plan-approval]');
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
