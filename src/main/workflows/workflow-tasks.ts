import type { Task } from '../../shared/types';
import { getExistingProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import type { IpcContext } from '../ipc/ipc-context';

/**
 * Every created task of a workflow, across every project, with its project id.
 * Its own module, a plain read, so the workflow agent can ask which boards its
 * workflow is on without importing the service that ends it. A registered
 * project whose database file is gone has no tasks, and is not given an empty
 * database for asking.
 */
export function workflowTasks(context: IpcContext, homeProjectId: string, workflowId: string): Array<{ projectId: string; task: Task }> {
  return readWorkflowTasks(context, homeProjectId, workflowId).tasks;
}

/**
 * `workflowTasks`, plus the projects whose database would not open during the
 * read. A task on one of those is missing from `tasks` without being gone, which
 * is what `linkEndState` needs to tell apart.
 */
export function readWorkflowTasks(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
): { tasks: Array<{ projectId: string; task: Task }>; unreadProjectIds: Set<string> } {
  const found: Array<{ projectId: string; task: Task }> = [];
  const unreadProjectIds = new Set<string>();
  for (const project of context.projectRepo.list()) {
    let tasks: Task[];
    try {
      const db = getExistingProjectDb(project.id);
      if (!db) continue;
      tasks = new TaskRepository(db).listByWorkflow(workflowId);
    } catch {
      unreadProjectIds.add(project.id);
      continue;
    }
    for (const task of tasks) {
      if ((task.workflow_project_id ?? project.id) === homeProjectId) found.push({ projectId: project.id, task });
    }
  }
  return { tasks: found, unreadProjectIds };
}

/**
 * Where one end of a link stands, against a read of its workflow's tasks:
 * - `present`: the read found the task.
 * - `gone`: provably gone. Its project is no longer registered, or its project's
 *   database opens and the task is not there, or is in another workflow now. A
 *   delete removes its links; this is a link whose removal failed.
 * - `held`: missing from the read, but not provably gone. Its project's database
 *   would not open (in this read, or now), or the task is there and still in
 *   this workflow (created after the read). The link keeps holding, as the
 *   engine reads a blocker it cannot see as not done.
 *
 * Presence is by task id alone, whatever project the link names: a workflow
 * task never moves to another project (`handleMoveTaskToProject` refuses it),
 * so a stale project id can never make a live task read as gone.
 *
 * A project in `unreadProjectIds` is not opened again: its open already failed
 * in this read, and `getProjectDb`'s busy timeout would stall main for seconds
 * a link. An unregistered project is never opened, so no database is created
 * for a stale id.
 */
export function linkEndState(
  context: IpcContext,
  end: { projectId: string; taskId: string },
  workflowId: string,
  presentTaskIds: ReadonlySet<string>,
  unreadProjectIds: ReadonlySet<string>,
): 'present' | 'gone' | 'held' {
  if (presentTaskIds.has(end.taskId)) return 'present';
  if (unreadProjectIds.has(end.projectId)) return 'held';
  try {
    if (!context.projectRepo.getById(end.projectId)) return 'gone';
    // A registered project whose file is missing is held, not read as gone: it
    // is not provably so, and `getProjectDb` would create an empty one.
    const projectDb = getExistingProjectDb(end.projectId);
    if (!projectDb) return 'held';
    const task = new TaskRepository(projectDb).getById(end.taskId);
    if (!task || task.workflow_id !== workflowId) return 'gone';
    return 'held';
  } catch {
    return 'held';
  }
}
