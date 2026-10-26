/**
 * `readPlanApprovalDecision` over real, migrated SQLite: the board read that
 * feeds `resolvePlanApprovalDecision` (the pure rules, pinned in
 * plan-approval-decision.test.ts). This pins what the read itself gathers: the
 * task's own row, its column folded through its Board Profile, the plan exit
 * target, a workflow task's own value, the global mode, and the one board read a
 * `DecisionReadCache` shares between sessions.
 *
 * The seeded board is To Do, Planning (plan mode, exits to Executing),
 * Executing, Code Review, Testing, Merge and Done. Every column starts Manual.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BoardProfile, PermissionMode, PlanApproval, Task } from '../../src/shared/types';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Project ids whose database read fails as a locked file does: a SQLite error. */
  throwFor: new Set<string>(),
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    if (harness.throwFor.has(projectId)) {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    }
    return harness.dbs.get(projectId) ?? null;
  },
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
    harness.throwFor.clear();
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
      const setOwn = (planApproval: PlanApproval | null) => taskRepository().setPlanApproval(task.id, planApproval);
      return { workflow, task, setOwn };
    }

    it('follows its own value over an Automatic column', async () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const { task, setOwn } = await startedWorkflowTaskInPlanning();
      // Control: left alone, the plan column on its route says Automatic.
      expect(read(task.id)?.approve).toBe(true);

      setOwn('manual');

      expect(read(task.id)?.approve).toBe(false);
    });

    it('follows its own value over a Manual column', async () => {
      const { task, setOwn } = await startedWorkflowTaskInPlanning();
      expect(read(task.id)?.approve).toBe(false);

      setOwn('automatic');

      expect(read(task.id)?.approve).toBe(true);
    });

    it('moves on along its route, not along the column\'s exit target', async () => {
      editColumn('Planning', { plan_exit_target_id: laneId('home', 'Testing') });
      const { task, setOwn } = await startedWorkflowTaskInPlanning();
      setOwn('automatic');

      expect(read(task.id)?.detail).toBe('Moved to Executing');
    });

    it('keeps its own value while its workflow is paused, where its card can be moved by hand', async () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const { workflow, task, setOwn } = await startedWorkflowTaskInPlanning();
      setOwn('manual');

      homeDb().prepare("UPDATE workflows SET state = 'paused' WHERE id = ?").run(workflow.id);

      expect(read(task.id)?.approve).toBe(false);
    });

    it('is not held by a Manual plan column on another task\'s board', async () => {
      // The #452 case: this board's Planning is Automatic, the phone board's is
      // Manual. Only the task whose route passes through it waits.
      editColumn('Planning', { plan_approval: 'automatic' });
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'api', title: 'Budgets API' }, { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' }],
        links: [],
      });
      await service.startWorkflow(context, 'home', workflow.id);
      const [task] = taskRepository().listByWorkflow(workflow.id);
      taskRepository().move({ taskId: task.id, targetSwimlaneId: laneId('home', 'Planning'), targetPosition: 0 }, { origin: 'workflow' });

      expect(read(task.id)?.approve).toBe(true);
    });

    it('follows a legacy whole-workflow value until it has its own, and the value moves onto the task', async () => {
      editColumn('Planning', { plan_approval: 'automatic' });
      const { workflow, task } = await startedWorkflowTaskInPlanning();
      homeDb().prepare("UPDATE workflows SET plan_approval = 'manual' WHERE id = ?").run(workflow.id);

      expect(read(task.id)?.approve).toBe(false);

      expect(taskRepository().getById(task.id)!.plan_approval).toBe('manual');
      expect(new WorkflowRepository(homeDb()).getById(workflow.id)!.plan_approval).toBeNull();
      // Read again, from the task's own copy.
      expect(read(task.id)?.approve).toBe(false);
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

    it('reads a workflow task\'s value from its own route, without walking the workflow\'s other boards', async () => {
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

        const cache = newDecisionReadCache();
        read(first.id, {}, cache);
        read(second.id, {}, cache);

        expect(listSpy).not.toHaveBeenCalled();
      } finally {
        listSpy.mockRestore();
      }
    });

    describe('a legacy whole-workflow value that an unreadable board keeps from being adopted', () => {
      /**
       * A started workflow on the home board with a task in Planning (an
       * Automatic column) whose legacy value is Manual, and the phone board
       * unreadable after Start. The adoption walks every board, so with the
       * phone board unreadable it cannot finish and the legacy value stays:
       * without a once-per-pass guard, every session of the workflow would walk
       * the boards again. (Once adopted, the value is cleared and the next
       * attempt is one null check, which would hide the guard.)
       */
      async function stuckWorkflow(taskTitles: string[]) {
        const workflow = service.createWorkflow('home', {});
        service.savePlan(context, 'home', workflow.id, {
          tasks: taskTitles.map((title, index) => ({ key: `task-${index}`, title })),
          links: [],
        });
        await service.startWorkflow(context, 'home', workflow.id);
        const tasks = taskRepository().listByWorkflow(workflow.id);
        for (const task of tasks) {
          taskRepository().move({ taskId: task.id, targetSwimlaneId: laneId('home', 'Planning'), targetPosition: 0 }, { origin: 'workflow' });
        }
        homeDb().prepare("UPDATE workflows SET plan_approval = 'manual' WHERE id = ?").run(workflow.id);
        return { workflow, tasks };
      }

      const legacyOf = (workflowId: string) => new WorkflowRepository(homeDb()).getById(workflowId)!.plan_approval;

      it('is tried once per pass for the sessions of one workflow, and once per session without a shared cache', async () => {
        editColumn('Planning', { plan_approval: 'automatic' });
        const { workflow, tasks: [first, second] } = await stuckWorkflow(['Budgets API', 'Budgets UI']);
        harness.throwFor.add('mobile');
        const listSpy = vi.spyOn(TaskRepository.prototype, 'listByWorkflow');
        try {
          listSpy.mockClear();

          // The legacy Manual sits above the Automatic column, so neither session approves.
          const cache = newDecisionReadCache();
          expect(read(first.id, {}, cache)?.approve).toBe(false);
          expect(read(second.id, {}, cache)?.approve).toBe(false);
          // One attempt reads the one readable board's tasks once.
          expect(listSpy).toHaveBeenCalledTimes(1);

          // Control: a cache each is an attempt each, and the same decisions.
          listSpy.mockClear();
          expect(read(first.id, {}, newDecisionReadCache())?.approve).toBe(false);
          expect(read(second.id, {}, newDecisionReadCache())?.approve).toBe(false);
          expect(listSpy).toHaveBeenCalledTimes(2);
        } finally {
          listSpy.mockRestore();
        }
        // Nothing was adopted, so the next pass retries.
        expect(legacyOf(workflow.id)).toBe('manual');
      });

      it('is tried once per workflow: a second workflow in the same pass is tried too', async () => {
        editColumn('Planning', { plan_approval: 'automatic' });
        const { workflow: firstWorkflow, tasks: [firstOfFirst, secondOfFirst] } = await stuckWorkflow(['Budgets API', 'Budgets UI']);
        const { workflow: secondWorkflow, tasks: [onlyOfSecond] } = await stuckWorkflow(['Reports API']);
        harness.throwFor.add('mobile');
        const listSpy = vi.spyOn(TaskRepository.prototype, 'listByWorkflow');
        try {
          listSpy.mockClear();

          const cache = newDecisionReadCache();
          read(firstOfFirst.id, {}, cache);
          expect(listSpy).toHaveBeenCalledTimes(1);
          expect(read(onlyOfSecond.id, {}, cache)?.approve).toBe(false);
          expect(listSpy).toHaveBeenCalledTimes(2);
          expect(read(secondOfFirst.id, {}, cache)?.approve).toBe(false);
          expect(listSpy).toHaveBeenCalledTimes(2);
        } finally {
          listSpy.mockRestore();
        }
        expect(legacyOf(firstWorkflow.id)).toBe('manual');
        expect(legacyOf(secondWorkflow.id)).toBe('manual');
      });
    });
  });
});
