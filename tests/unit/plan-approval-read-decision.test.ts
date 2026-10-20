/**
 * `readPlanApprovalDecision` over real, migrated SQLite: the board read that
 * feeds `resolvePlanApprovalDecision` (the pure rules, pinned in
 * plan-approval-decision.test.ts). This pins what the read itself gathers: the
 * task's own row, its column folded through its Board Profile, the plan exit
 * target, a running workflow's value, the global mode, and the one board read a
 * `DecisionReadCache` shares between sessions.
 *
 * The seeded board is To Do, Planning (plan mode, exits to Executing),
 * Executing, Code Review, Testing, Merge and Done. Every column starts Manual.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BoardProfile, PermissionMode, PlanApproval, Task } from '../../src/shared/types';

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
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { readPlanApprovalDecision, newDecisionReadCache } = await import('../../src/main/plan-approval/read-decision');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('readPlanApprovalDecision', () => {
  let context: IpcContext;
  let globalPermissionMode: PermissionMode;
  let boardProfiles: BoardProfile[];
  let getEffectiveConfig: ReturnType<typeof vi.fn>;

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
    globalPermissionMode = 'default';
    boardProfiles = [];
    getEffectiveConfig = vi.fn((_projectPath?: string) => ({ agent: { permissionMode: globalPermissionMode } }));
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
      configManager: { load: () => ({}), getEffectiveConfig },
      boardConfigManager: { getBoardProfiles: () => boardProfiles },
      sessionManager: { listSessions: () => [], getActivityCache: () => ({}) },
    } as unknown as IpcContext;
  });

  const homeDb = () => harness.dbs.get('home') as Database.Database;
  const lanesOf = (projectId: string) => new SwimlaneRepository(harness.dbs.get(projectId) as Database.Database).list();
  const laneId = (projectId: string, name: string) => lanesOf(projectId).find((lane) => lane.name === name)!.id;
  const taskRepository = () => new TaskRepository(homeDb());

  /** Edit a column of the home board. */
  function editColumn(name: string, changes: { plan_approval?: PlanApproval; permission_mode?: PermissionMode | null; plan_exit_target_id?: string | null }): void {
    new SwimlaneRepository(homeDb()).update({ id: laneId('home', name), ...changes });
  }

  function createTask(columnName: string, extra: { permission_mode?: PermissionMode; profile_id?: string } = {}): Task {
    return taskRepository().create({ title: `Task in ${columnName}`, description: '', swimlane_id: laneId('home', columnName), ...extra });
  }

  function read(
    taskId: string,
    input: { agentCanApprove?: boolean; bypassAvailable?: boolean; ignoreDisabledAutomations?: boolean } = {},
    cache?: ReturnType<typeof newDecisionReadCache>,
  ) {
    return readPlanApprovalDecision(
      context,
      {
        projectId: 'home',
        taskId,
        agentCanApprove: input.agentCanApprove ?? true,
        bypassAvailable: input.bypassAvailable ?? false,
        ignoreDisabledAutomations: input.ignoreDisabledAutomations,
      },
      cache,
    );
  }

  describe('a task outside any workflow', () => {
    it('approves in an Automatic plan column and continues in the mode of the column it exits to', () => {
      editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: laneId('home', 'Executing') });
      editColumn('Executing', { permission_mode: 'acceptEdits' });
      const task = createTask('Planning');

      expect(read(task.id)).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    });

    it('leaves a Manual plan column to the user, with the destination still named', () => {
      editColumn('Executing', { permission_mode: 'acceptEdits' });
      const task = createTask('Planning');

      expect(read(task.id)).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
    });

    it('stays put when its column has no exit target, continuing in the global mode', () => {
      editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: null });
      globalPermissionMode = 'acceptEdits';
      const task = createTask('Planning');

      expect(read(task.id)).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Stayed in Planning' });
      // The global mode comes from the project's effective config, read for its path.
      expect(getEffectiveConfig).toHaveBeenCalledWith('/projects/home');
    });

    it('continues in the task\'s own permission mode ahead of the destination\'s', () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      editColumn('Executing', { permission_mode: 'acceptEdits' });
      const task = createTask('Planning', { permission_mode: 'auto' });

      expect(read(task.id)?.mode).toBe('auto');
    });

    it('reads nothing for a task that is gone, or archived', () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const task = createTask('Planning');
      expect(read(task.id)).not.toBeNull();

      expect(read('no-such-task')).toBeNull();

      taskRepository().archive(task.id);
      expect(read(task.id)).toBeNull();
    });

    it('reads nothing for a task whose column no longer exists', () => {
      const task = createTask('Planning');
      // Orphaned on purpose: a foreign key would refuse this delete in production.
      homeDb().pragma('foreign_keys = OFF');
      homeDb().prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run('deleted-column', task.id);

      expect(read(task.id)).toBeNull();
    });

    it('never approves for an agent that cannot approve plans, though the decision is still read', () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      editColumn('Executing', { permission_mode: 'acceptEdits' });
      const task = createTask('Planning');

      expect(read(task.id, { agentCanApprove: false })).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
      expect(read(task.id, { agentCanApprove: true })?.approve).toBe(true);
    });

    it('holds an Automatic plan column as Manual while the task\'s automations are disabled', () => {
      editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: laneId('home', 'Executing') });
      editColumn('Executing', { permission_mode: 'acceptEdits' });
      const task = createTask('Planning');
      // Control: the same task approves while its automations run.
      expect(read(task.id)?.approve).toBe(true);

      taskRepository().update({ id: task.id, automations_disabled: true });

      expect(read(task.id)).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
      // The pre-spawn question looks past the switch: automations can be enabled while the session lives.
      expect(read(task.id, { ignoreDisabledAutomations: true })).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    });

    it('reads a column that is not in plan mode as Manual, whatever it stores', () => {
      // Executing stores Automatic but runs no plan mode.
      editColumn('Executing', { plan_approval: 'automatic' });
      expect(read(createTask('Executing').id)?.approve).toBe(false);

      // A Planning column switched out of plan mode stops approving too.
      editColumn('Planning', { plan_approval: 'automatic' });
      const planningTask = createTask('Planning');
      expect(read(planningTask.id)?.approve).toBe(true);
      editColumn('Planning', { permission_mode: 'acceptEdits' });
      expect(read(planningTask.id)?.approve).toBe(false);
    });
  });

  describe('the mode a session continues in', () => {
    beforeEach(() => {
      editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: laneId('home', 'Executing') });
      editColumn('Executing', { permission_mode: 'bypassPermissions' });
    });

    it('is bypassPermissions when the session was launched with bypass available', () => {
      globalPermissionMode = 'acceptEdits';
      const task = createTask('Planning');

      expect(read(task.id, { bypassAvailable: true })?.mode).toBe('bypassPermissions');
    });

    it('falls back to the global mode, then default, when it was not', () => {
      const task = createTask('Planning');

      globalPermissionMode = 'acceptEdits';
      expect(read(task.id, { bypassAvailable: false })?.mode).toBe('acceptEdits');

      globalPermissionMode = 'bypassPermissions';
      expect(read(task.id, { bypassAvailable: false })?.mode).toBe('default');
    });
  });

  describe('a task in a workflow', () => {
    async function startedWorkflowTaskInPlanning() {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, { tasks: [{ key: 'api', title: 'Budgets API' }], links: [] });
      await service.startWorkflow(context, 'home', workflow.id);
      const [task] = taskRepository().listByWorkflow(workflow.id);
      taskRepository().move({ taskId: task.id, targetSwimlaneId: laneId('home', 'Planning'), targetPosition: 0 }, { origin: 'workflow' });
      const pick = (planApproval: PlanApproval | null) => new WorkflowRepository(homeDb()).setPlanApproval(workflow.id, planApproval);
      return { workflow, task, pick };
    }

    it('follows the workflow\'s pick over an Automatic column', async () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const { task, pick } = await startedWorkflowTaskInPlanning();
      // Control: unpicked, the plan columns on its route say Automatic.
      expect(read(task.id)?.approve).toBe(true);

      pick('manual');

      expect(read(task.id)?.approve).toBe(false);
    });

    it('follows the workflow\'s pick over a Manual column', async () => {
      const { task, pick } = await startedWorkflowTaskInPlanning();
      expect(read(task.id)?.approve).toBe(false);

      pick('automatic');

      expect(read(task.id)?.approve).toBe(true);
    });

    it('moves on along its route, not along the column\'s exit target', async () => {
      editColumn('Planning', { plan_exit_target_id: laneId('home', 'Testing') });
      const { task, pick } = await startedWorkflowTaskInPlanning();
      pick('automatic');

      expect(read(task.id)?.detail).toBe('Moved to Executing');
    });

    it('goes back to following its column once the workflow is no longer running', async () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const { workflow, task, pick } = await startedWorkflowTaskInPlanning();
      pick('manual');
      expect(read(task.id)?.approve).toBe(false);

      homeDb().prepare("UPDATE workflows SET state = 'done' WHERE id = ?").run(workflow.id);

      expect(read(task.id)?.approve).toBe(true);
    });
  });

  describe('a task riding a Board Profile', () => {
    const PROFILE_ID = 'cheap-profile';

    function profileFor(columns: BoardProfile['columns']): BoardProfile {
      return { id: PROFILE_ID, name: 'Cheap', columns };
    }

    it('reads a column the profile takes out of plan mode as Manual', () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      boardProfiles = [profileFor({ [laneId('home', 'Planning')]: { permissionMode: 'acceptEdits' } })];
      const onProfile = createTask('Planning', { profile_id: PROFILE_ID });
      const onColumnSettings = createTask('Planning');

      expect(read(onProfile.id)?.approve).toBe(false);
      // Control: the same column, for a task on no profile.
      expect(read(onColumnSettings.id)?.approve).toBe(true);
    });

    it('follows the profile\'s plan exit target, by column name', () => {
      editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: laneId('home', 'Executing') });
      boardProfiles = [profileFor({ [laneId('home', 'Planning')]: { planExitTarget: 'Code Review' } })];
      const onProfile = createTask('Planning', { profile_id: PROFILE_ID });
      const onColumnSettings = createTask('Planning');

      expect(read(onProfile.id)?.detail).toBe('Moved to Code Review');
      expect(read(onColumnSettings.id)?.detail).toBe('Moved to Executing');
    });

    it('continues in the destination\'s mode as the profile sets it', () => {
      editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: laneId('home', 'Executing') });
      editColumn('Executing', { permission_mode: 'acceptEdits' });
      boardProfiles = [profileFor({ [laneId('home', 'Executing')]: { permissionMode: 'auto' } })];
      const onProfile = createTask('Planning', { profile_id: PROFILE_ID });
      const onColumnSettings = createTask('Planning');

      expect(read(onProfile.id)?.mode).toBe('auto');
      expect(read(onColumnSettings.id)?.mode).toBe('acceptEdits');
    });
  });

  describe('a DecisionReadCache shared between sessions', () => {
    it('reads the board\'s columns and the global mode once, not once per session', () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const first = createTask('Planning');
      const second = createTask('Planning');
      const listSpy = vi.spyOn(SwimlaneRepository.prototype, 'list');
      try {
        listSpy.mockClear();
        getEffectiveConfig.mockClear();

        const cache = newDecisionReadCache();
        expect(read(first.id, {}, cache)?.approve).toBe(true);
        expect(read(second.id, {}, cache)?.approve).toBe(true);
        expect(listSpy).toHaveBeenCalledTimes(1);
        expect(getEffectiveConfig).toHaveBeenCalledTimes(1);

        // Control: a cache each is a read each.
        listSpy.mockClear();
        getEffectiveConfig.mockClear();
        read(first.id, {}, newDecisionReadCache());
        read(second.id, {}, newDecisionReadCache());
        expect(listSpy).toHaveBeenCalledTimes(2);
        expect(getEffectiveConfig).toHaveBeenCalledTimes(2);
      } finally {
        listSpy.mockRestore();
      }
    });

    it('reads a running workflow\'s derived value once for all its tasks', async () => {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'api', title: 'Budgets API' }, { key: 'ui', title: 'Budgets UI' }],
        links: [],
      });
      await service.startWorkflow(context, 'home', workflow.id);
      const [first, second] = taskRepository().listByWorkflow(workflow.id);
      const listSpy = vi.spyOn(TaskRepository.prototype, 'listByWorkflow');
      try {
        listSpy.mockClear();

        // The derived value walks every project's tasks: two boards here.
        const cache = newDecisionReadCache();
        read(first.id, {}, cache);
        read(second.id, {}, cache);
        expect(listSpy).toHaveBeenCalledTimes(2);

        listSpy.mockClear();
        read(first.id, {}, newDecisionReadCache());
        read(second.id, {}, newDecisionReadCache());
        expect(listSpy).toHaveBeenCalledTimes(4);
      } finally {
        listSpy.mockRestore();
      }
    });
  });
});
