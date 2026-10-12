import { getExistingProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import type { IpcContext } from '../ipc/ipc-context';
import { notifyWorkflowChanged } from './workflow-changed';
import { announceBoardChange } from './workflow-board-announce';
import { deleteWorkflow } from './workflow-service';
import { wakeWorkflowEngine } from './workflow-wake';

/**
 * What a project delete does to the workflows it is part of: what deleting
 * each of its tasks would.
 *
 * - A workflow homed in the project goes with its database. Its tasks on other
 *   boards become ordinary tasks, Done and archived ones included, since
 *   nothing can show that workflow again.
 * - In a workflow homed elsewhere, every link naming one of its tasks goes, so
 *   a task that waited only on those starts on the next engine pass.
 * - A started workflow homed elsewhere that is left with no task at all is
 *   deleted, its agent with it: it could never complete.
 *
 * The delete removes the database file without deleting its tasks one by one,
 * so without this every task and link elsewhere that named the project kept
 * naming it, and each read of it would create its database again.
 *
 * Called first in `cleanupProject`, while the project's database is still
 * open. Never throws: a board that cannot be read is logged and skipped.
 */
export function detachProjectFromWorkflows(context: IpcContext, deletedProjectId: string): void {
  // 1. What the deleted board's tasks are part of, read before its database goes.
  const candidates = new Map<string, { homeProjectId: string; survivors: number }>();
  try {
    const deletedDb = getExistingProjectDb(deletedProjectId);
    if (deletedDb) {
      const deletedTasks = new TaskRepository(deletedDb);
      for (const membership of deletedTasks.listWorkflowMemberships()) {
        const homeProjectId = membership.workflow_project_id ?? deletedProjectId;
        if (homeProjectId !== deletedProjectId) candidates.set(membership.workflow_id, { homeProjectId, survivors: 0 });
      }
      // 2. Its own tasks leave every workflow now, so no engine pass starts one
      // of them while the delete kills its sessions (a kill frees a slot).
      deletedTasks.releaseAllWorkflowMembers();
    }
  } catch (error) {
    console.error(`[PROJECT_DELETE] Could not read the workflows of project ${deletedProjectId.slice(0, 8)}:`, error);
  }

  // 3. Every other board: release the members of its workflows, drop the links
  // naming its tasks, and count what is left of each workflow it was part of.
  const unreadBoards: string[] = [];
  for (const project of context.projectRepo.list()) {
    if (project.id === deletedProjectId) continue;
    try {
      const db = getExistingProjectDb(project.id);
      if (!db) {
        unreadBoards.push(project.name);
        continue;
      }
      const tasks = new TaskRepository(db);
      if (tasks.releaseMembersOfHome(deletedProjectId) > 0) announceBoardChange(context, project.id);
      const unlinkedWorkflowIds = new TaskLinkRepository(db).deleteForProject(deletedProjectId);
      const workflows = new WorkflowRepository(db);
      for (const workflowId of unlinkedWorkflowIds) {
        workflows.bumpRevision(workflowId);
        notifyWorkflowChanged(project.id, workflowId);
      }
      for (const [workflowId, candidate] of candidates) {
        candidate.survivors += tasks.listByWorkflow(workflowId)
          .filter((task) => (task.workflow_project_id ?? project.id) === candidate.homeProjectId).length;
      }
    } catch (error) {
      unreadBoards.push(project.name);
      console.error(`[PROJECT_DELETE] Could not detach project ${deletedProjectId.slice(0, 8)} from the workflows on ${project.name}:`, error);
    }
  }

  // 4. A started workflow with no task left is deleted. Only when every board
  // was read: a board that could not be may hold its survivors, and deleting a
  // workflow that still has tasks would strand them.
  if (unreadBoards.length > 0) {
    if (candidates.size > 0) {
      console.warn(`[PROJECT_DELETE] Left every workflow in place, since ${unreadBoards.join(', ')} could not be read.`);
    }
  } else {
    for (const [workflowId, candidate] of candidates) {
      if (candidate.survivors > 0) continue;
      try {
        const homeDb = getExistingProjectDb(candidate.homeProjectId);
        const workflow = homeDb ? new WorkflowRepository(homeDb).getById(workflowId) : undefined;
        if (workflow?.state !== 'running' && workflow?.state !== 'paused') continue;
        deleteWorkflow(context, candidate.homeProjectId, workflowId);
      } catch (error) {
        console.error(`[PROJECT_DELETE] Could not delete workflow ${workflowId.slice(0, 8)}, left with no tasks:`, error);
      }
    }
  }

  // 5. A task that waited only on the deleted board's tasks can start now.
  wakeWorkflowEngine();
}
