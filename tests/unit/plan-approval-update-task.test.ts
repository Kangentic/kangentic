/**
 * `planApproval` on `kangentic_update_task` (handleUpdateTask in
 * src/main/agent/commands/task-commands.ts), on real, migrated SQLite: how an
 * agent changes a STARTED workflow task's own plan approval, which
 * kangentic_save_workflow cannot reach once the workflow has started.
 *
 * It goes through the workflow's own setter (`setTaskPlanApproval`), so an agent
 * is held to the inspector's rules: a task in no workflow is refused (its
 * column decides), a task past its plan column is refused, and the column's own
 * value is stored as nothing. Each refusal says what to do and writes nothing.
 * The mobile bridge reaches the handler with no schema, so a value that is none
 * of the three is refused here too.
 *
 * The seeded board's Planning column runs in plan mode and is Manual.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>(), runtime: null as unknown }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const projectDatabase = harness.dbs.get(projectId);
    if (!projectDatabase) throw new Error(`No database for ${projectId}`);
    return projectDatabase;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/pr/pr-linking', () => ({ linkPRForTask: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-runtime')>()),
  requireWorkflowRuntimeContext: () => harness.runtime,
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { handleUpdateTask } = await import('../../src/main/agent/commands/task-commands');

import { openTestDatabase } from './helpers/test-database';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('kangentic_update_task planApproval', () => {
  let database: Database.Database;
  let commandContext: CommandContext;
  let onTaskUpdated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    harness.dbs.clear();
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.dbs.set('home', database);
    const projects = [{ id: 'home', name: 'kangentic', path: '/projects/home' }];
    harness.runtime = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      boardConfigManager: { getBoardProfiles: () => [] },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    onTaskUpdated = vi.fn();
    commandContext = {
      projectId: 'home',
      getProjectDb: () => database,
      getProjectPath: () => '/projects/home',
      getBoardProfiles: () => [],
      onTaskUpdated,
      onTaskSettingsChanged: vi.fn(),
    } as unknown as CommandContext;
  });

  afterEach(() => {
    database.close();
    harness.dbs.clear();
    harness.runtime = null;
  });

  const tasks = () => new TaskRepository(database);
  const laneId = (name: string) => (database.prepare('SELECT id FROM swimlanes WHERE name = ?').get(name) as { id: string }).id;

  async function startedTask() {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context(), 'home', workflow.id, { tasks: [{ key: 'api', title: 'Budgets API' }], links: [] });
    await service.startWorkflow(context(), 'home', workflow.id);
    return tasks().listByWorkflow(workflow.id)[0];
  }

  function context(): IpcContext {
    return harness.runtime as IpcContext;
  }

  it('sets a started workflow task\'s own value, and reports it', async () => {
    const task = await startedTask();

    const response = await handleUpdateTask({ taskId: String(task.display_id), planApproval: 'automatic' }, commandContext);

    expect(response.success, response.error).toBe(true);
    expect(response.message).toContain('Updated planApproval');
    expect((response.data as { planApproval: string | null }).planApproval).toBe('automatic');
    expect(tasks().getById(task.id)!.plan_approval).toBe('automatic');
    expect(onTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it('null follows the plan column again, and the column\'s own value is stored as nothing', async () => {
    const task = await startedTask();
    await handleUpdateTask({ taskId: task.id, planApproval: 'automatic' }, commandContext);

    await handleUpdateTask({ taskId: task.id, planApproval: null }, commandContext);
    expect(tasks().getById(task.id)!.plan_approval).toBeNull();

    await handleUpdateTask({ taskId: task.id, planApproval: 'manual' }, commandContext);
    expect(tasks().getById(task.id)!.plan_approval).toBeNull();
  });

  it('refuses a task in no workflow, naming the column setting to change instead, and writes nothing', async () => {
    const ordinary = tasks().create({ title: 'Ordinary', description: '', swimlane_id: laneId('Planning') });

    const response = await handleUpdateTask({ taskId: ordinary.id, planApproval: 'automatic', title: 'Renamed' }, commandContext);

    expect(response.success).toBe(false);
    expect(response.error).toBe(`#${ordinary.display_id} is not in a workflow. Its column's Plan approval decides; change that with kangentic_update_column. The task was not updated.`);
    expect(tasks().getById(ordinary.id)!.title).toBe('Ordinary');
  });

  it('refuses a task that has passed its plan column, and writes nothing', async () => {
    const task = await startedTask();
    database.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(laneId('Executing'), task.id);

    const response = await handleUpdateTask({ taskId: task.id, planApproval: 'automatic', title: 'Renamed' }, commandContext);

    expect(response.success).toBe(false);
    expect(response.error).toBe(`#${task.display_id} has passed Planning. Its plan approval can no longer change. The task was not updated.`);
    expect(tasks().getById(task.id)!.plan_approval).toBeNull();
    expect(tasks().getById(task.id)!.title).toBe('Budgets API');
  });

  it('refuses a task in Done, and writes nothing', async () => {
    const task = await startedTask();
    const doneLane = database.prepare("SELECT id FROM swimlanes WHERE role = 'done'").get() as { id: string };
    database.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(doneLane.id, task.id);

    const response = await handleUpdateTask({ taskId: task.id, planApproval: 'automatic', title: 'Renamed' }, commandContext);

    expect(response.success).toBe(false);
    expect(response.error).toBe(`#${task.display_id} is done. Its plan approval can no longer change. The task was not updated.`);
    expect(tasks().getById(task.id)!.plan_approval).toBeNull();
    expect(tasks().getById(task.id)!.title).toBe('Budgets API');
  });

  it.each([
    ['an unknown word', 'bogus'],
    ['the right word in the wrong case', 'Automatic'],
    ['a boolean', true],
  ])('refuses %s, as the mobile bridge could send it, and writes nothing', async (_label, planApproval) => {
    const task = await startedTask();

    const response = await handleUpdateTask({ taskId: task.id, planApproval }, commandContext);

    expect(response.success).toBe(false);
    expect(response.error).toBe('planApproval must be "automatic", "manual", or null.');
    expect(tasks().getById(task.id)!.plan_approval).toBeNull();
  });
});
