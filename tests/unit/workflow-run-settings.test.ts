/**
 * A planned task's run settings (#732, sign-offs 9 and 25) on real, migrated
 * SQLite: its base branch, Worktree or Project, and Column Settings with a
 * profile or an agent override. `kangentic_save_workflow` checks each one in
 * its handler (a command can be reached without the zod schema), refusing with
 * the valid values; the Workflows view's Add task and Edit Task store them; and
 * Start, or an Add task into a running workflow, creates the task with them.
 *
 * Two projects, so a task on another board is covered. The capability probe
 * behind the model and effort check is stubbed with a fixed agent list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>(), agents: [] as unknown[] }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/sessions', () => ({ pauseTaskSession: vi.fn(), resumeTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/agent/agent-list', () => ({ listAgents: async () => harness.agents }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { parseDraft, WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const view = await import('../../src/main/workflows/workflow-view-service');
const { setWorkflowRuntimeContext } = await import('../../src/main/workflows/workflow-runtime');
const { commandHandlers } = await import('../../src/main/agent/commands');
const { DEFAULT_RUN_SETTINGS } = await import('../../src/shared/workflow-run-settings');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { WorkflowDraftTask } from '../../src/shared/types';

const HEAVY_PROFILE = { id: 'profile-heavy', name: 'Heavy', columns: {} };

describe('a planned task\'s run settings', () => {
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
    harness.agents = [];
    database('home');
    database('mobile');
    const projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home', default_agent: 'claude' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/projects/mobile', default_agent: 'claude' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      // Only the home board has a profile.
      boardConfigManager: {
        getBoardProfiles: (projectPath?: string) => (projectPath === '/projects/home' ? [HEAVY_PROFILE] : []),
      },
      configManager: { load: () => ({ agent: { cliPaths: {} } }) },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      sessionManager: { listSessions: () => [], getActivityCache: () => ({}) },
    } as unknown as IpcContext;
    setWorkflowRuntimeContext(context);
  });

  afterEach(() => {
    setWorkflowRuntimeContext(null);
  });

  const tasksOf = (projectId: string) => new TaskRepository(harness.dbs.get(projectId) as Database.Database);
  const todoOf = (projectId: string) => new SwimlaneRepository(harness.dbs.get(projectId) as Database.Database).list().find((lane) => lane.role === 'todo')!;
  const plannedByKey = (workflowId: string): Map<string, WorkflowDraftTask> =>
    new Map((service.requireWorkflow('home', workflowId).draft?.tasks ?? []).map((task) => [task.key, task]));

  describe('kangentic_save_workflow (savePlan)', () => {
    it('stores each setting in the task row\'s shape, and the defaults for what is left out', () => {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [
          { key: 'api', title: 'Budgets API', baseBranch: 'develop', useWorktree: false, agentOverride: 'codex', modelOverride: 'o3', effortOverride: 'high', permissionMode: 'plan' },
          { key: 'ui', title: 'Budgets UI', profile: 'heavy' },
          { key: 'pinned', title: 'Pinned nothing', runMode: 'agent_override' },
          { key: 'docs', title: 'Budgets docs' },
        ],
        links: [],
      });
      const planned = plannedByKey(workflow.id);
      expect(planned.get('api')).toMatchObject({
        base_branch: 'develop', use_worktree: 0, run_mode: 'agent_override', profile_id: null,
        agent_override: 'codex', model_override: 'o3', effort_override: 'high', permission_mode: 'plan',
      });
      // A profile is Column Settings, found by name on the task's own board.
      expect(planned.get('ui')).toMatchObject({ ...DEFAULT_RUN_SETTINGS, profile_id: 'profile-heavy' });
      // Agent Override with everything inherited is a real choice, not the default.
      expect(planned.get('pinned')).toMatchObject({ ...DEFAULT_RUN_SETTINGS, run_mode: 'agent_override' });
      expect(planned.get('docs')).toMatchObject(DEFAULT_RUN_SETTINGS);
    });

    it('refuses an unknown agent, naming the registered ones, and writes nothing', () => {
      const workflow = service.createWorkflow('home', {});
      expect(() => service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'api', title: 'Budgets API', agentOverride: 'nope' }],
        links: [],
      })).toThrow(/Task 1 \("api"\): agentOverride "nope" is not a registered agent\. Valid values: .*claude.*codex/);
      expect(service.requireWorkflow('home', workflow.id).draft?.tasks).toEqual([]);
    });

    it('refuses a profile its board does not have, naming that board\'s profiles', () => {
      const workflow = service.createWorkflow('home', {});
      expect(() => service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'ui', title: 'Budgets UI', profile: 'Light' }],
        links: [],
      })).toThrow(/no Board Profile matches "Light" on that task's board\. Its profiles: Heavy\./);
      // The home board's profile is not the other board's.
      expect(() => service.savePlan(context, 'home', workflow.id, {
        tasks: [{ key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile', profile: 'Heavy' }],
        links: [],
      })).toThrow(/Its profiles: \(none defined\)/);
    });

    it('refuses a profile with a pin, Column Settings with a pin, a bad branch name, and settings on a task taken in', () => {
      const existing = tasksOf('home').create({ title: 'Already on the board', description: '', swimlane_id: todoOf('home').id });
      const workflow = service.createWorkflow('home', {});
      const attempts: Array<[service.PlannedTaskInput, RegExp]> = [
        [{ key: 'a', title: 'A', profile: 'Heavy', agentOverride: 'codex' }, /pass either profile .* not both/],
        [{ key: 'a', title: 'A', profile: 'Heavy', runMode: 'agent_override' }, /pass either profile .* not both/],
        [{ key: 'a', title: 'A', runMode: 'column_settings', modelOverride: 'opus' }, /mean runMode "agent_override"/],
        [{ key: 'a', title: 'A', baseBranch: 'bad branch' }, /baseBranch "bad branch" is not a valid git branch name/],
        [{ key: 'a', title: 'A', existingTask: String(existing.display_id), baseBranch: 'develop' }, /keeps its own base branch/],
      ];
      for (const [task, message] of attempts) {
        expect(() => service.savePlan(context, 'home', workflow.id, { tasks: [task], links: [] })).toThrow(message);
      }
    });
  });

  describe('Start and Add task', () => {
    it('Start creates each task with its planned settings, on its own board', async () => {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        tasks: [
          { key: 'api', title: 'Budgets API', baseBranch: 'develop', useWorktree: true, agentOverride: 'codex', modelOverride: 'o3', permissionMode: 'acceptEdits' },
          { key: 'ui', title: 'Budgets UI', profile: 'Heavy' },
          { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile', useWorktree: false },
        ],
        links: [],
      });
      await service.startWorkflow(context, 'home', workflow.id);

      const homeTasks = tasksOf('home').list(todoOf('home').id);
      expect(homeTasks.find((task) => task.title === 'Budgets API')).toMatchObject({
        base_branch: 'develop', use_worktree: 1, run_mode: 'agent_override', profile_id: null,
        agent_override: 'codex', model_override: 'o3', effort_override: null, permission_mode: 'acceptEdits',
      });
      expect(homeTasks.find((task) => task.title === 'Budgets UI')).toMatchObject({
        base_branch: null, use_worktree: null, run_mode: 'column_settings', profile_id: 'profile-heavy', agent_override: null,
      });
      expect(tasksOf('mobile').list(todoOf('mobile').id).find((task) => task.title === 'Budgets on the phone')).toMatchObject({
        base_branch: null, use_worktree: 0, run_mode: 'column_settings',
      });
    });

    it('the view\'s Add task into a running workflow creates the task with its settings on its own project', async () => {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, { tasks: [{ key: 'api', title: 'Budgets API' }], links: [] });
      await service.startWorkflow(context, 'home', workflow.id);

      const taskId = view.addViewTask(context, 'home', workflow.id, {
        title: 'Budgets on the phone',
        projectId: 'mobile',
        base_branch: 'release',
        use_worktree: 0,
        run_mode: 'agent_override',
        agent_override: 'claude',
        effort_override: 'high',
      });
      expect(tasksOf('mobile').getById(taskId)).toMatchObject({
        swimlane_id: todoOf('mobile').id, workflow_id: workflow.id, workflow_project_id: 'home',
        base_branch: 'release', use_worktree: 0, run_mode: 'agent_override', agent_override: 'claude', effort_override: 'high',
      });
    });
  });

  describe('the Workflows view\'s planned task', () => {
    it('Add task stores the settings, Edit Task round-trips them, and Column Settings clears the pins', () => {
      const workflow = service.createWorkflow('home', {});
      const key = view.addViewTask(context, 'home', workflow.id, { title: 'Token table', base_branch: 'develop', profile_id: 'profile-heavy' });
      expect(plannedByKey(workflow.id).get(key)).toMatchObject({ base_branch: 'develop', profile_id: 'profile-heavy', run_mode: 'column_settings' });

      view.updatePlannedTask(context, 'home', workflow.id, key, {
        run_mode: 'agent_override', agent_override: 'codex', model_override: 'o3', permission_mode: 'plan', use_worktree: 1,
      });
      // Agent Override detaches the profile, as on a task.
      expect(plannedByKey(workflow.id).get(key)).toMatchObject({
        base_branch: 'develop', use_worktree: 1, run_mode: 'agent_override', profile_id: null,
        agent_override: 'codex', model_override: 'o3', permission_mode: 'plan',
      });

      view.updatePlannedTask(context, 'home', workflow.id, key, { run_mode: 'column_settings' });
      expect(plannedByKey(workflow.id).get(key)).toMatchObject({
        run_mode: 'column_settings', agent_override: null, model_override: null, effort_override: null, permission_mode: null,
      });
    });

    it('a new board resets the route, the base branch and the profile, unless the edit sets them', () => {
      const workflow = service.createWorkflow('home', {});
      const key = view.addViewTask(context, 'home', workflow.id, { title: 'Token table', base_branch: 'develop', profile_id: 'profile-heavy' });
      view.updatePlannedTask(context, 'home', workflow.id, key, { projectId: 'mobile' });
      expect(plannedByKey(workflow.id).get(key)).toMatchObject({ project_id: 'mobile', base_branch: null, profile_id: null, route_start_swimlane_id: null });

      view.updatePlannedTask(context, 'home', workflow.id, key, { projectId: 'home', base_branch: 'main' });
      expect(plannedByKey(workflow.id).get(key)).toMatchObject({ project_id: null, base_branch: 'main' });
    });

    it('refuses a profile that is not on the task\'s board, an unknown agent, and a bad type', () => {
      const workflow = service.createWorkflow('home', {});
      expect(() => view.addViewTask(context, 'home', workflow.id, { title: 'Phone', projectId: 'mobile', profile_id: 'profile-heavy' }))
        .toThrow('That profile is not on the kangentic-mobile board. Choose one of its profiles, or Default.');
      expect(() => view.addViewTask(context, 'home', workflow.id, { title: 'A', agent_override: 'nope' }))
        .toThrow(/agentOverride "nope" is not a registered agent/);
      const untyped = { title: 'A', use_worktree: true } as unknown as Parameters<typeof view.addViewTask>[3];
      expect(() => view.addViewTask(context, 'home', workflow.id, untyped)).toThrow('use_worktree must be 1, 0 or null.');
    });

    it('a draft saved before the run settings reads them as the defaults', () => {
      const draft = parseDraft(JSON.stringify({ tasks: [{ key: 'task-1', title: 'Token table', run_mode: 'sideways', permission_mode: 'yolo' }], links: [] }));
      expect(draft?.tasks[0]).toMatchObject(DEFAULT_RUN_SETTINGS);
    });
  });

  describe('the save_workflow and get_workflow handlers', () => {
    const commandContext = { projectId: 'home' } as unknown as CommandContext;

    it('refuses a setting of the wrong type or outside its values, before anything is created', async () => {
      const attempts: Array<[Record<string, unknown>, string]> = [
        [{ useWorktree: 'yes' }, 'Task 1 ("api"): useWorktree must be true (its own worktree) or false (the project folder).'],
        [{ runMode: 'sometimes' }, 'Task 1 ("api"): runMode "sometimes" is not valid. Valid values: column_settings, agent_override.'],
        [{ agentOverride: 7 }, 'Task 1 ("api"): agentOverride must be text.'],
        [{ permissionMode: 'yolo' }, 'Task 1 ("api"): permissionMode "yolo" is not valid. Valid values: plan, dontAsk, default, acceptEdits, auto, bypassPermissions.'],
      ];
      for (const [settings, error] of attempts) {
        const response = await commandHandlers.save_workflow({ title: 'Budgets', tasks: [{ key: 'api', title: 'Budgets API', ...settings }] }, commandContext);
        expect(response).toEqual({ success: false, error });
      }
    });

    it('refuses a model or an effort the agent does not offer, naming the ones it does', async () => {
      harness.agents = [{ name: 'claude', capabilities: { supportsModelOverride: true, models: ['claude-opus-4-8', 'claude-sonnet-5-0'], effortLevels: ['low', 'high'] } }];
      const model = await commandHandlers.save_workflow({ tasks: [{ key: 'api', title: 'Budgets API', modelOverride: 'claude-opus-9-9' }] }, commandContext);
      expect(model.success).toBe(false);
      expect(model.error).toMatch(/Task 1 \("api"\): modelOverride "claude-opus-9-9" is not a known model .* Valid values: claude-opus-4-8, claude-sonnet-5-0/);
      const effort = await commandHandlers.save_workflow({ tasks: [{ key: 'api', title: 'Budgets API', effortOverride: 'extreme' }] }, commandContext);
      expect(effort.error).toMatch(/effortOverride "extreme" is not valid .* Valid values: low, high/);
    });

    it('saves the settings, and the read lists them in save_workflow\'s own names so a plan sent back keeps them', async () => {
      harness.agents = [{ name: 'codex', capabilities: { supportsModelOverride: true, models: [], effortLevels: [] } }];
      const saved = await commandHandlers.save_workflow({
        title: 'Budgets',
        tasks: [
          { key: 'api', title: 'Budgets API', baseBranch: 'develop', useWorktree: false, agentOverride: 'codex', modelOverride: 'o3' },
          { key: 'ui', title: 'Budgets UI', profile: 'Heavy' },
          { key: 'docs', title: 'Budgets docs' },
        ],
      }, commandContext);
      expect(saved.success).toBe(true);
      const workflowId = (saved.data as { id: string }).id;
      const read = await commandHandlers.get_workflow({ workflow: workflowId }, commandContext);
      const lines = (read.message ?? '').split('\n');
      expect(lines.find((line) => line.startsWith('- [api]'))).toContain(
        'Settings: baseBranch "develop", useWorktree false, runMode "agent_override", agentOverride "codex", modelOverride "o3".',
      );
      expect(lines.find((line) => line.startsWith('- [ui]'))).toContain('Settings: profile "Heavy".');
      expect(lines.find((line) => line.startsWith('- [docs]'))).not.toContain('Settings:');
    });

    it('a refused save with no workflow creates nothing, whichever check refuses it', async () => {
      harness.agents = [{ name: 'claude', capabilities: { supportsModelOverride: true, models: ['claude-opus-4-8'], effortLevels: ['high'] } }];
      const attempts: Array<Record<string, unknown>> = [
        // The handler's own type check, the CLI's model check, and savePlan's checks.
        { title: 'Budgets', tasks: [{ key: 'api', title: 'Budgets API', useWorktree: 'yes' }] },
        { title: 'Budgets', tasks: [{ key: 'api', title: 'Budgets API', modelOverride: 'claude-opus-9-9' }] },
        { title: 'Budgets', tasks: [{ key: 'api', title: 'Budgets API', agentOverride: 'nope' }] },
        { title: 'Budgets', tasks: [{ key: 'api', title: 'Budgets API', routeStart: 'Nowhere' }] },
        { title: 'Budgets', tasks: [{ key: 'api', title: 'Budgets API' }], links: [{ blocker: 'api', blocked: 'ui' }] },
        {
          title: 'Budgets',
          tasks: [{ key: 'api', title: 'Budgets API' }, { key: 'ui', title: 'Budgets UI' }],
          links: [{ blocker: 'api', blocked: 'ui' }, { blocker: 'ui', blocked: 'api' }],
        },
      ];
      for (const params of attempts) {
        const response = await commandHandlers.save_workflow(params, commandContext);
        expect(response.success).toBe(false);
      }
      expect(new WorkflowRepository(harness.dbs.get('home') as Database.Database).listAll()).toEqual([]);
    });

    it('a save with no workflow creates it holding the plan, with its title and brief', async () => {
      const saved = await commandHandlers.save_workflow({
        title: 'Budgets', brief: 'Track spending.', tasks: [{ key: 'api', title: 'Budgets API', baseBranch: 'develop' }],
      }, commandContext);
      expect(saved.success).toBe(true);
      const workflows = new WorkflowRepository(harness.dbs.get('home') as Database.Database).listAll();
      expect(workflows).toHaveLength(1);
      expect(workflows[0]).toMatchObject({ title: 'Budgets', brief: 'Track spending.', state: 'draft', revision: 2 });
      expect(plannedByKey(workflows[0].id).get('api')).toMatchObject({ title: 'Budgets API', base_branch: 'develop' });
    });
  });

  describe('the add_workflow_task handler', () => {
    const commandContext = { projectId: 'home' } as unknown as CommandContext;

    async function startedWorkflow(): Promise<string> {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, { tasks: [{ key: 'api', title: 'Budgets API' }], links: [] });
      await service.startWorkflow(context, 'home', workflow.id);
      return workflow.id;
    }

    it('creates the task with the run settings kangentic_save_workflow takes, on its own board', async () => {
      harness.agents = [{ name: 'codex', capabilities: { supportsModelOverride: true, models: [], effortLevels: [] } }];
      const workflowId = await startedWorkflow();
      const pinned = await commandHandlers.add_workflow_task({
        workflow: workflowId, title: 'Budgets on the phone', taskProject: 'kangentic-mobile',
        baseBranch: 'release', useWorktree: false, agentOverride: 'codex', modelOverride: 'o3', permissionMode: 'plan',
      }, commandContext);
      expect(pinned.success).toBe(true);
      expect(tasksOf('mobile').getById((pinned.data as { id: string }).id)).toMatchObject({
        swimlane_id: todoOf('mobile').id, workflow_id: workflowId,
        base_branch: 'release', use_worktree: 0, run_mode: 'agent_override', profile_id: null,
        agent_override: 'codex', model_override: 'o3', permission_mode: 'plan',
      });

      // A profile is found by name on the task's own board.
      const profiled = await commandHandlers.add_workflow_task({ workflow: workflowId, title: 'Budgets UI', profile: 'heavy' }, commandContext);
      expect(tasksOf('home').getById((profiled.data as { id: string }).id)).toMatchObject({ run_mode: 'column_settings', profile_id: 'profile-heavy' });

      // Left out, the defaults: Column Settings from the board's base branch.
      const plain = await commandHandlers.add_workflow_task({ workflow: workflowId, title: 'Budgets docs' }, commandContext);
      expect(tasksOf('home').getById((plain.data as { id: string }).id)).toMatchObject({
        base_branch: null, use_worktree: null, run_mode: 'column_settings', profile_id: null, agent_override: null,
      });
    });

    it('refuses as kangentic_save_workflow does, naming the task, and writes nothing', async () => {
      harness.agents = [{ name: 'claude', capabilities: { supportsModelOverride: true, models: ['claude-opus-4-8'], effortLevels: ['high'] } }];
      const workflowId = await startedWorkflow();
      const before = tasksOf('home').list(todoOf('home').id).length;
      const attempts: Array<[Record<string, unknown>, string | RegExp]> = [
        [{ useWorktree: 'yes' }, '"Budgets UI": useWorktree must be true (its own worktree) or false (the project folder).'],
        [{ runMode: 'sometimes' }, '"Budgets UI": runMode "sometimes" is not valid. Valid values: column_settings, agent_override.'],
        [{ agentOverride: 7 }, '"Budgets UI": agentOverride must be text.'],
        [{ permissionMode: 'yolo' }, /^"Budgets UI": permissionMode "yolo" is not valid\. Valid values: /],
        [{ agentOverride: 'nope' }, /^"Budgets UI": agentOverride "nope" is not a registered agent\. Valid values: .*claude/],
        [{ profile: 'Light' }, /^"Budgets UI": no Board Profile matches "Light" on that task's board\. Its profiles: Heavy\./],
        [{ taskProject: 'kangentic-mobile', profile: 'Heavy' }, /Its profiles: \(none defined\)/],
        [{ profile: 'Heavy', agentOverride: 'claude' }, /pass either profile .* not both/],
        [{ runMode: 'column_settings', modelOverride: 'claude-opus-4-8' }, /mean runMode "agent_override"/],
        [{ baseBranch: 'bad branch' }, /baseBranch "bad branch" is not a valid git branch name/],
        [{ modelOverride: 'claude-opus-9-9' }, /^"Budgets UI": modelOverride "claude-opus-9-9" is not a known model .* Valid values: claude-opus-4-8/],
        [{ effortOverride: 'extreme' }, /^"Budgets UI": effortOverride "extreme" is not valid .* Valid values: high/],
      ];
      for (const [settings, error] of attempts) {
        const response = await commandHandlers.add_workflow_task({ workflow: workflowId, title: 'Budgets UI', ...settings }, commandContext);
        expect(response.success).toBe(false);
        if (typeof error === 'string') expect(response.error).toBe(error);
        else expect(response.error).toMatch(error);
      }
      expect(tasksOf('home').list(todoOf('home').id)).toHaveLength(before);
      expect(tasksOf('mobile').list(todoOf('mobile').id)).toHaveLength(0);
    });
  });
});
