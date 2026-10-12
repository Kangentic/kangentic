/**
 * What a project delete does to the workflows it is part of
 * (src/main/workflows/workflow-project-delete.ts), on real, migrated SQLite
 * with three boards. The delete removes the project's database file without
 * deleting its tasks one by one, so this is what deleting each of them would do:
 *
 * - links in other homes that name its tasks go, so a task waiting only on
 *   them can start;
 * - a workflow homed in it goes with it, and its tasks on other boards become
 *   ordinary tasks, Done and archived ones included;
 * - a started workflow homed elsewhere that has no task left is deleted, but
 *   only when every board could be read, since an unread board may hold one.
 *
 * `cleanupProject` calls it while the deleted project is still registered and
 * its database open, as here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Boards whose database throws when opened, as a locked file does. */
  broken: new Set<string>(),
  /** What better-sqlite3 throws for a locked file: an error carrying its SQLite code. */
  lockedError: (projectId: string) => Object.assign(new Error(`database for ${projectId} is locked`), { code: 'SQLITE_BUSY' }),
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    if (harness.broken.has(projectId)) throw harness.lockedError(projectId);
    return harness.dbs.get(projectId) ?? null;
  },
  getProjectDb: (projectId: string) => {
    if (harness.broken.has(projectId)) throw harness.lockedError(projectId);
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-changed')>()),
  notifyWorkflowChanged: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-agent')>()),
  endWorkflowAgent: vi.fn(async () => undefined),
}));

const { notifyWorkflowChanged } = await import('../../src/main/workflows/workflow-changed');
const { endWorkflowAgent } = await import('../../src/main/workflows/workflow-agent');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');
const { detachProjectFromWorkflows } = await import('../../src/main/workflows/workflow-project-delete');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards, taskTitled } from './helpers/workflow-plans';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Workflow } from '../../src/shared/types';

describe('a project delete and the workflows it is part of', () => {
  let context: IpcContext;
  let wake: ReturnType<typeof vi.fn>;

  function database(projectId: string): void {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
  }

  beforeEach(() => {
    harness.dbs.clear();
    harness.broken.clear();
    database('home');
    database('mobile');
    database('web');
    const projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/projects/mobile' },
      { id: 'web', name: 'kangentic-web', path: '/projects/web' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      sessionManager: { listSessions: () => [] },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    wake = vi.fn();
    setWorkflowWake(wake);
    vi.mocked(notifyWorkflowChanged).mockClear();
    vi.mocked(endWorkflowAgent).mockClear();
  });

  afterEach(() => {
    setWorkflowWake(null);
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
    vi.restoreAllMocks();
  });

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const tasksOf = (projectId: string) => new TaskRepository(dbOf(projectId));
  const workflowsOf = (projectId: string) => new WorkflowRepository(dbOf(projectId));
  const laneOf = (projectId: string, role: 'todo' | 'done') => new SwimlaneRepository(dbOf(projectId)).list().find((lane) => lane.role === role)!;
  const boardChanges = () => vi.mocked(context.boardEvents.emitBoardChanged).mock.calls.map(([event]) => event.projectId);

  /** A started workflow homed in `homeProjectId`, with one task per entry on that entry's board. */
  async function startedWorkflow(homeProjectId: string, boards: Array<{ title: string; project: string }>): Promise<Workflow> {
    const workflow = service.createWorkflow(homeProjectId, {});
    service.savePlan(context, homeProjectId, workflow.id, {
      title: 'Usage budgets',
      tasks: boards.map((board, index) => ({ key: `task-${index}`, title: board.title, project: board.project })),
      links: [],
    });
    await service.startWorkflow(context, homeProjectId, workflow.id);
    return workflowsOf(homeProjectId).getById(workflow.id)!;
  }

  function moveToDone(projectId: string, taskId: string): void {
    dbOf(projectId).prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(laneOf(projectId, 'done').id, taskId);
  }

  it('drops the links in another home that name its tasks, so the task waiting on them can start', async () => {
    // The phone task (on the deleted board) blocks api, and api blocks ui.
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);
    const view = service.readWorkflow(context, 'home', workflow.id);
    const api = taskTitled(view, 'Budgets API');
    const ui = taskTitled(view, 'Budgets UI');
    const revisionBefore = workflowsOf('home').getById(workflow.id)!.revision;
    // Start notified and woke too; only the delete's own calls count here.
    vi.mocked(notifyWorkflowChanged).mockClear();
    wake.mockClear();

    detachProjectFromWorkflows(context, 'mobile');

    const links = new TaskLinkRepository(dbOf('home'));
    expect(links.listBlockersOf(api.taskId!)).toEqual([]);
    expect(links.listForWorkflow(workflow.id).map((link) => [link.blocker_task_id, link.blocked_task_id])).toEqual([[api.taskId, ui.taskId]]);
    expect(workflowsOf('home').getById(workflow.id)!.revision).toBe(revisionBefore + 1);
    expect(notifyWorkflowChanged).toHaveBeenCalledWith('home', workflow.id);
    expect(wake).toHaveBeenCalled();
    // api and ui are still there, so the workflow is not deleted.
    expect(workflowsOf('home').getById(workflow.id)?.state).toBe('running');
    expect(endWorkflowAgent).not.toHaveBeenCalled();
  });

  it('takes the deleted board\'s own tasks out of every workflow, so no workflow starts one while its sessions are killed', async () => {
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);

    detachProjectFromWorkflows(context, 'mobile');

    expect(tasksOf('mobile').listByWorkflow(workflow.id)).toEqual([]);
  });

  it('makes the tasks on other boards of a workflow homed in it ordinary tasks, Done and archived ones included', async () => {
    const workflow = await startedWorkflow('mobile', [
      { title: 'Waiting on the home board', project: 'kangentic' },
      { title: 'Finished on the home board', project: 'kangentic' },
      { title: 'Archived on the home board', project: 'kangentic' },
      { title: 'On the phone board', project: 'kangentic-mobile' },
    ]);
    const [waiting, finished, archived] = tasksOf('home').listByWorkflow(workflow.id);
    moveToDone('home', finished.id);
    dbOf('home').prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), archived.id);
    vi.mocked(context.boardEvents.emitBoardChanged).mockClear();

    detachProjectFromWorkflows(context, 'mobile');

    for (const task of [waiting, finished, archived]) {
      const after = tasksOf('home').getById(task.id)!;
      expect(after.workflow_id).toBeNull();
      expect(after.workflow_project_id).toBeNull();
      expect(after.route_start_swimlane_id).toBeNull();
    }
    expect(boardChanges()).toContain('home');
    // A board with none of its tasks keeps quiet.
    expect(boardChanges()).not.toContain('web');
  });

  it('deletes a started workflow homed elsewhere whose every task was on the deleted board, and ends its agent', async () => {
    const emptied = await startedWorkflow('home', [
      { title: 'Phone one', project: 'kangentic-mobile' },
      { title: 'Phone two', project: 'kangentic-mobile' },
    ]);
    // The control: one Done task left on the home board, so it completes on the
    // engine's next pass instead of being deleted.
    const kept = await startedWorkflow('home', [
      { title: 'Shipped on the home board', project: 'kangentic' },
      { title: 'Phone three', project: 'kangentic-mobile' },
    ]);
    moveToDone('home', tasksOf('home').listByWorkflow(kept.id)[0].id);

    detachProjectFromWorkflows(context, 'mobile');

    expect(workflowsOf('home').getById(emptied.id)).toBeUndefined();
    expect(endWorkflowAgent).toHaveBeenCalledWith(context, emptied.id);
    expect(workflowsOf('home').getById(kept.id)?.state).toBe('running');
    expect(endWorkflowAgent).not.toHaveBeenCalledWith(context, kept.id);
  });

  it('does not delete a paused one with a task left, nor a planned one, nor a finished one', async () => {
    const paused = await startedWorkflow('home', [
      { title: 'Home task', project: 'kangentic' },
      { title: 'Phone task', project: 'kangentic-mobile' },
    ]);
    workflowsOf('home').setState(paused.id, 'paused');
    const finished = await startedWorkflow('home', [{ title: 'Finished phone task', project: 'kangentic-mobile' }]);
    workflowsOf('home').setState(finished.id, 'done');

    detachProjectFromWorkflows(context, 'mobile');

    expect(workflowsOf('home').getById(paused.id)?.state).toBe('paused');
    expect(workflowsOf('home').getById(finished.id)?.state).toBe('done');
  });

  it('goes on to the other boards when one cannot be read', async () => {
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);
    harness.broken.add('web');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    detachProjectFromWorkflows(context, 'mobile');

    const api = taskTitled(service.readWorkflow(context, 'home', workflow.id), 'Budgets API');
    expect(new TaskLinkRepository(dbOf('home')).listBlockersOf(api.taskId!)).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('kangentic-web'), expect.any(Error));
  });

  it('keeps a workflow whose only surviving task is on a board it could not read', async () => {
    const workflow = await startedWorkflow('home', [
      { title: 'Phone task', project: 'kangentic-mobile' },
      { title: 'Web task', project: 'kangentic-web' },
    ]);
    harness.broken.add('web');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    detachProjectFromWorkflows(context, 'mobile');

    expect(workflowsOf('home').getById(workflow.id)?.state).toBe('running');
    expect(endWorkflowAgent).not.toHaveBeenCalled();
    harness.broken.delete('web');
    expect(tasksOf('web').listByWorkflow(workflow.id)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kangentic-web'));
  });

  it('keeps a workflow when a board is registered but its database file is gone', async () => {
    const workflow = await startedWorkflow('home', [
      { title: 'Phone task', project: 'kangentic-mobile' },
      { title: 'Web task', project: 'kangentic-web' },
    ]);
    const webDatabase = dbOf('web');
    harness.dbs.delete('web');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    detachProjectFromWorkflows(context, 'mobile');

    expect(workflowsOf('home').getById(workflow.id)?.state).toBe('running');
    webDatabase.close();
  });
});
