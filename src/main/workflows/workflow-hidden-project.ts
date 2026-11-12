import { getExistingProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import type { IpcContext } from '../ipc/ipc-context';
import { pauseWorkflow } from './workflow-service';

/**
 * What hiding a project does to the workflows it is part of (#913): each running one pauses, before the host
 * leaves, so every member's agent stops through the workflow's own Pause and Resume brings them back. The
 * reason is not stored: the summary reads it from the tasks on hidden boards, so it holds exactly as long as
 * it is true, and Resume is refused for as long as it does. Nothing here resumes a workflow when the host comes
 * back: Pause is a person's to lift, and the reason goes away when the board does.
 *
 * The project is still visible when this runs, so the pause reaches its tasks. Never throws: a workflow that
 * could not be paused is logged, and the engine holds it anyway while its tasks are hidden.
 */
export async function pauseWorkflowsOfProject(context: IpcContext, projectId: string): Promise<void> {
  const homes = new Map<string, string>();
  try {
    const db = getExistingProjectDb(projectId);
    if (!db) return;
    for (const membership of new TaskRepository(db).listWorkflowMemberships()) {
      homes.set(membership.workflow_id, membership.workflow_project_id ?? projectId);
    }
    // One homed here keeps running on other boards with this board's tasks out of reach, member or not.
    for (const workflow of new WorkflowRepository(db).listOpen()) homes.set(workflow.id, projectId);
  } catch (error) {
    console.warn(`[WORKFLOW] Could not read the workflows of project ${projectId.slice(0, 8)}, whose host is being removed:`, error);
    return;
  }
  for (const [workflowId, homeProjectId] of homes) {
    try {
      const homeDb = getExistingProjectDb(homeProjectId);
      if (homeDb && new WorkflowRepository(homeDb).getById(workflowId)?.state === 'running') {
        await pauseWorkflow(context, homeProjectId, workflowId, 'its host being removed');
      }
    } catch (error) {
      console.warn(`[WORKFLOW] Could not pause workflow ${workflowId.slice(0, 8)} for a removed host:`, error);
    }
  }
}
