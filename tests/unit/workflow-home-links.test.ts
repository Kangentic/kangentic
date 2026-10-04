/**
 * Deleting a workflow task removes its links in the workflow's home database
 * (src/main/db/repositories/task-repository.ts `delete`, with the callback in
 * src/main/db/repositories/workflow-home-links.ts).
 *
 * Links live in the HOME project's database, so a task on another board has none
 * in its own. The workflow engine registers a remover at startup, and
 * `TaskRepository.delete` (every delete's one path) calls it with the deleted
 * task whenever the task has a workflow and a home project. A delete never fails
 * because of it: a throwing remover is logged, the task is gone, and the
 * dev-server ports are still returned to the pool.
 *
 * Real, migrated SQLite (node:sqlite). The remover here is a spy; the one the
 * engine installs is covered with the host in workflow-engine-host-start-backoff.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

const globalPorts = vi.hoisted(() => ({ releaseByTaskId: vi.fn() }));
vi.mock('../../src/main/db/repositories/dev-port-repository', () => ({
  devPortRepository: { releaseByTaskId: globalPorts.releaseByTaskId },
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { setHomeLinkRemover, removeLinksInWorkflowHome } = await import('../../src/main/db/repositories/workflow-home-links');

import { adaptDatabase } from './helpers/node-sqlite-database';
import type { Task } from '../../src/shared/types';

describeWithSqlite('a deleted workflow task and its links in the workflow\'s home', () => {
  const remover = vi.fn<(task: Task) => void>();

  function freshProject() {
    const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const todo = new SwimlaneRepository(database).list().find((lane) => lane.role === 'todo')!;
    return {
      database,
      todo,
      tasks: new TaskRepository(database),
      workflows: new WorkflowRepository(database),
      links: new TaskLinkRepository(database),
    };
  }

  function membership(workflowId: string, homeProjectId: string | null) {
    return {
      workflow_id: workflowId,
      workflow_project_id: homeProjectId as string,
      route_start_swimlane_id: null,
      route_last_swimlane_id: null,
      skipped_swimlane_ids: [],
      canvas_x: null,
      canvas_y: null,
    };
  }

  beforeEach(() => {
    remover.mockReset();
    globalPorts.releaseByTaskId.mockReset();
    setHomeLinkRemover(remover);
  });

  afterEach(() => {
    setHomeLinkRemover(null);
    vi.restoreAllMocks();
  });

  it('calls the registered remover with the deleted task when its workflow has a home project', () => {
    const { tasks, todo, workflows } = freshProject();
    const workflow = workflows.create({});
    const task = tasks.create({ title: 'On the phone board', description: '', swimlane_id: todo.id, workflow: membership(workflow.id, 'home') });

    tasks.delete(task.id);

    expect(remover).toHaveBeenCalledTimes(1);
    expect(remover).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      workflow_id: workflow.id,
      workflow_project_id: 'home',
    }));
    expect(tasks.getById(task.id)).toBeFalsy();
  });

  it('still removes the links in the task\'s own database, as before', () => {
    const { tasks, todo, workflows, links } = freshProject();
    const workflow = workflows.create({});
    const blocker = tasks.create({ title: 'Blocker', description: '', swimlane_id: todo.id, workflow: membership(workflow.id, 'home') });
    const blocked = tasks.create({ title: 'Blocked', description: '', swimlane_id: todo.id, workflow: membership(workflow.id, 'home') });
    links.insert({ workflow_id: workflow.id, blocker_project_id: 'home', blocker_task_id: blocker.id, blocked_project_id: 'home', blocked_task_id: blocked.id });

    tasks.delete(blocker.id);

    expect(links.listBlockersOf(blocked.id)).toEqual([]);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  it('does not call the remover for a task that is in no workflow', () => {
    const { tasks, todo } = freshProject();
    const task = tasks.create({ title: 'Plain', description: '', swimlane_id: todo.id });

    tasks.delete(task.id);

    expect(remover).not.toHaveBeenCalled();
    expect(tasks.getById(task.id)).toBeFalsy();
  });

  it('does not call the remover for a workflow task with no home project recorded', () => {
    const { database, tasks, todo, workflows } = freshProject();
    const workflow = workflows.create({});
    const task = tasks.create({ title: 'Home unknown', description: '', swimlane_id: todo.id, workflow: membership(workflow.id, 'home') });
    database.prepare('UPDATE tasks SET workflow_project_id = NULL WHERE id = ?').run(task.id);
    expect(tasks.getById(task.id)!.workflow_project_id).toBeNull();

    tasks.delete(task.id);

    expect(remover).not.toHaveBeenCalled();
    expect(tasks.getById(task.id)).toBeFalsy();
  });

  it('does not call the remover for a task that does not exist', () => {
    const { tasks } = freshProject();

    tasks.delete('no-such-task');

    expect(remover).not.toHaveBeenCalled();
  });

  it('deletes the task, logs, and still returns its ports when the remover throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    remover.mockImplementation(() => {
      throw new Error('The home database is closed.');
    });
    const { tasks, todo, workflows } = freshProject();
    const workflow = workflows.create({});
    const task = tasks.create({ title: 'On the phone board', description: '', swimlane_id: todo.id, workflow: membership(workflow.id, 'home') });

    expect(() => tasks.delete(task.id)).not.toThrow();

    expect(remover).toHaveBeenCalledTimes(1);
    expect(tasks.getById(task.id)).toBeFalsy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(task.id.slice(0, 8));
    expect(globalPorts.releaseByTaskId).toHaveBeenCalledWith(task.id);
  });

  it('breaks nothing when no remover is registered', () => {
    setHomeLinkRemover(null);
    const { tasks, todo, workflows } = freshProject();
    const workflow = workflows.create({});
    const task = tasks.create({ title: 'Before the engine started', description: '', swimlane_id: todo.id, workflow: membership(workflow.id, 'home') });

    expect(() => tasks.delete(task.id)).not.toThrow();

    expect(tasks.getById(task.id)).toBeFalsy();
    expect(globalPorts.releaseByTaskId).toHaveBeenCalledWith(task.id);
  });

  it('removeLinksInWorkflowHome hands the task to the registered remover, and does nothing before one is set', () => {
    const task = { id: 'task-1', workflow_id: 'workflow-1', workflow_project_id: 'home' } as Task;

    removeLinksInWorkflowHome(task);
    expect(remover).toHaveBeenCalledWith(task);

    setHomeLinkRemover(null);
    remover.mockClear();
    expect(() => removeLinksInWorkflowHome(task)).not.toThrow();
    expect(remover).not.toHaveBeenCalled();
  });
});
