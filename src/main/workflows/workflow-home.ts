import type { Task, Workflow } from '../../shared/types';
import { getExistingProjectDb } from '../db/database';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';

/**
 * The workflow a task is in, read in its home project's database, where a
 * workflow lives. Null for an ordinary task, for a workflow that was deleted,
 * and for a home project that is gone: the home is an id the task stores, so it
 * can outlive its project, and the read never creates that project's database
 * again (`getExistingProjectDb`). Throws only when a home that exists cannot be
 * read, which each caller already handles its own way.
 *
 * A leaf module, importing only the database layer, so the lock check, the
 * step check, the board's notifications and the phone's wire can all use it.
 */
export function workflowOfTask(task: Pick<Task, 'workflow_id' | 'workflow_project_id'>, projectId: string): Workflow | null {
  if (!task.workflow_id) return null;
  const homeDb = getExistingProjectDb(task.workflow_project_id ?? projectId);
  if (!homeDb) return null;
  return new WorkflowRepository(homeDb).getById(task.workflow_id) ?? null;
}

/**
 * Is the task in a workflow that still exists? For a check that refuses an
 * action to protect the task's workflow (a Backlog demote, a move to another
 * project, joining another workflow).
 *
 * A membership whose workflow is gone is no membership. A deleted workflow's
 * Done tasks keep theirs, and one moved back to To Do would otherwise be refused
 * all three for a workflow nothing can show or remove it from. A home that
 * cannot be read counts as a membership, so the refusal still protects it.
 */
export function isInWorkflow(task: Pick<Task, 'workflow_id' | 'workflow_project_id'>, projectId: string): boolean {
  if (!task.workflow_id) return false;
  try {
    return workflowOfTask(task, projectId) !== null;
  } catch {
    return true;
  }
}

/**
 * Is the task in a running workflow, in a column between To Do and Done? Its
 * step check judges every turn end there, and says itself when the agent waits
 * on the user or the task stalls, so the generic idle notices leave it alone.
 * False on any read that fails, which keeps the generic notice.
 */
export function isRunningWorkflowStepTask(projectId: string, taskId: string): boolean {
  try {
    const db = getExistingProjectDb(projectId);
    if (!db) return false;
    const task = new TaskRepository(db).getById(taskId);
    if (!task || task.archived_at || !task.workflow_id) return false;
    const role = new SwimlaneRepository(db).getById(task.swimlane_id)?.role;
    if (role === 'todo' || role === 'done') return false;
    return workflowOfTask(task, projectId)?.state === 'running';
  } catch {
    return false;
  }
}
