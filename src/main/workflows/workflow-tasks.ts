import type { Task } from '../../shared/types';
import { getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import type { IpcContext } from '../ipc/ipc-context';

/**
 * Every created task of a workflow, across every project, with its project id.
 * Its own module, a plain read, so the workflow agent can ask which boards its
 * workflow is on without importing the service that ends it.
 */
export function workflowTasks(context: IpcContext, homeProjectId: string, workflowId: string): Array<{ projectId: string; task: Task }> {
  const found: Array<{ projectId: string; task: Task }> = [];
  for (const project of context.projectRepo.list()) {
    let tasks: Task[];
    try {
      tasks = new TaskRepository(getProjectDb(project.id)).listByWorkflow(workflowId);
    } catch {
      continue;
    }
    for (const task of tasks) {
      if ((task.workflow_project_id ?? project.id) === homeProjectId) found.push({ projectId: project.id, task });
    }
  }
  return found;
}
