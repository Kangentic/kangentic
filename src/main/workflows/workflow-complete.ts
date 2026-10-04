import { IPC } from '../../shared/ipc-channels';
import type { WorkflowCompletedEvent } from '../../shared/types';
import { getProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { sendToRenderer } from '../ipc/send-to-renderer';
import type { IpcContext } from '../ipc/ipc-context';

/**
 * Say that a workflow finished: every task in it reached Done. The renderer
 * raises the Workflow Complete toast and desktop notification from this push,
 * each behind its own switch (`notifications.toasts|desktop.onWorkflowComplete`),
 * the way Plan Complete is raised.
 */
export function announceWorkflowComplete(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  taskCount: number,
): void {
  const workflow = new WorkflowRepository(getProjectDb(homeProjectId)).getById(workflowId);
  if (!workflow) return;
  console.log(`[WORKFLOW] "${workflow.title}" is complete (${taskCount} tasks in Done)`);
  const event: WorkflowCompletedEvent = { workflowId, title: workflow.title, taskCount, projectId: homeProjectId };
  sendToRenderer(context.mainWindow, IPC.WORKFLOW_COMPLETED, event);
}
