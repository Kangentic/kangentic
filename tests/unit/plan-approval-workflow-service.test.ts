/**
 * `setTaskPlanApproval` (src/main/workflows/workflow-service.ts) on real,
 * migrated SQLite with two projects: a started workflow task's own plan
 * approval, which the Workflows inspector, task detail's Workflow panel and
 * kangentic_update_task all write through.
 *
 * Setting it:
 *   - stores the value on the task, and stores the plan column's own value as
 *     nothing, so the task keeps following its column;
 *   - tells the workflow's view (`notifyWorkflowChanged`);
 *   - announces the task's board, because its live session's approver re-reads
 *     its decision on a board event (`plan-approval-writer.ts` listens on the
 *     board bus). A change that announced nothing would leave a running session
 *     approving by the old value until some unrelated board change;
 *   - is refused once it can change nothing: the task is in Done, or has passed
 *     its plan column.
 *
 * The seeded board's Planning column runs in plan mode and is Manual.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
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
vi.mock('../../src/main/workflows/workflow-changed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-changed')>()),
  notifyWorkflowChanged: vi.fn(),
}));

const { notifyWorkflowChanged } = await import('../../src/main/workflows/workflow-changed');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const service = await import('../../src/main/workflows/workflow-service');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards, taskTitled } from './helpers/workflow-plans';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('setTaskPlanApproval', () => {
  let context: IpcContext;

  beforeEach(() => {
    harness.dbs.clear();
    for (const projectId of ['home', 'mobile']) {
      const projectDatabase = openTestDatabase();
      projectDatabase.exec('PRAGMA foreign_keys = ON');
      runProjectMigrations(projectDatabase);
      harness.dbs.set(projectId, projectDatabase);
    }
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
      boardConfigManager: { getBoardProfiles: () => [] },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    vi.mocked(notifyWorkflowChanged).mockClear();
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const emitBoardChanged = () => vi.mocked(context.boardEvents.emitBoardChanged);
  const boardsAnnounced = (): string[] =>
    [...new Set(emitBoardChanged().mock.calls.map(([event]) => event.projectId))].sort();

  async function startedPhoneTask() {
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);
    const phone = taskTitled(service.readWorkflow(context, 'home', workflow.id), 'Budgets on the phone');
    return { workflow, taskId: phone.taskId!, projectId: phone.projectId };
  }

  const storedOn = (projectId: string, taskId: string) => new TaskRepository(dbOf(projectId)).getById(taskId)!.plan_approval;

  function moveTo(projectId: string, taskId: string, columnName: string): void {
    const db = dbOf(projectId);
    const lane = db.prepare('SELECT id FROM swimlanes WHERE name = ?').get(columnName) as { id: string };
    db.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(lane.id, taskId);
  }

  it('stores a value that differs from its plan column, and null to follow the column again', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    expect(storedOn(projectId, taskId)).toBeNull();

    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic');
    expect(storedOn(projectId, taskId)).toBe('automatic');

    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, null);
    expect(storedOn(projectId, taskId)).toBeNull();
  });

  it('stores the plan column\'s own value as nothing, so the task keeps following its column', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic');

    // The seeded Planning column is Manual.
    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'manual');

    expect(storedOn(projectId, taskId)).toBeNull();
  });

  it('tells the workflow\'s view, and announces the task\'s own board so its live approver reads the new value', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    vi.mocked(notifyWorkflowChanged).mockClear();
    emitBoardChanged().mockClear();

    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic');

    expect(notifyWorkflowChanged).toHaveBeenCalledWith('home', workflow.id);
    expect(boardsAnnounced()).toEqual(['mobile']);
  });

  it('refuses a task that has passed its plan column, storing nothing and announcing nothing', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    moveTo(projectId, taskId, 'Executing');
    emitBoardChanged().mockClear();

    const display = new TaskRepository(dbOf(projectId)).getById(taskId)!.display_id;
    expect(() => service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic'))
      .toThrow(`#${display} has passed Planning. Its plan approval can no longer change.`);

    expect(storedOn(projectId, taskId)).toBeNull();
    expect(emitBoardChanged()).not.toHaveBeenCalled();
  });

  it('still takes a change while the task is in its plan column: it applies to the plan it is making', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    moveTo(projectId, taskId, 'Planning');

    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic');

    expect(storedOn(projectId, taskId)).toBe('automatic');
  });

  it('refuses a task in Done', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    moveTo(projectId, taskId, 'Done');

    expect(() => service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic'))
      .toThrow(/is done\. Its plan approval can no longer change\./);
    expect(storedOn(projectId, taskId)).toBeNull();
  });

  it('refuses an archived task that is not in Done, as done, storing nothing and announcing nothing', async () => {
    const { workflow, taskId, projectId } = await startedPhoneTask();
    moveTo(projectId, taskId, 'Executing');
    new TaskRepository(dbOf(projectId)).archive(taskId);
    const task = new TaskRepository(dbOf(projectId)).getById(taskId)!;
    // Precondition: archived, and in a working column, not Done.
    expect(task.archived_at).not.toBeNull();
    expect(dbOf(projectId).prepare('SELECT role FROM swimlanes WHERE id = ?').get(task.swimlane_id)).toEqual({ role: null });
    emitBoardChanged().mockClear();

    // The "done" refusal, not "has passed Planning": an archived task is done wherever its column is.
    expect(() => service.setTaskPlanApproval(context, 'home', workflow.id, { taskId, projectId }, 'automatic'))
      .toThrow(`#${task.display_id} is done. Its plan approval can no longer change.`);

    expect(storedOn(projectId, taskId)).toBeNull();
    expect(emitBoardChanged()).not.toHaveBeenCalled();
  });

  it('refuses a workflow that has not started, whose plan is changed with kangentic_save_workflow', () => {
    const workflow = planAcrossBoards(service, context);

    expect(() => service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: 'anything', projectId: 'home' }, 'automatic'))
      .toThrow(/has not started/);
  });

  it('refuses a workflow that does not exist, storing nothing and announcing nothing', () => {
    emitBoardChanged().mockClear();

    expect(() => service.setTaskPlanApproval(context, 'home', 'no-such-workflow', { taskId: 'anything', projectId: 'home' }, 'automatic'))
      .toThrow(service.WorkflowRequestError);

    expect(notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(emitBoardChanged()).not.toHaveBeenCalled();
  });
});
