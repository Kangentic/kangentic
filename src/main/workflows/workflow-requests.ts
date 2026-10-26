import type { Workflow } from '../../shared/types';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { getExistingProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';

/**
 * The refusal a workflow request throws and the checks most requests start
 * with. They live apart from workflow-service.ts, which imports the session
 * handlers, so a module the MCP server loads (task-commands.ts, through
 * workflow-task-plan-approval.ts) can throw the same refusal without loading
 * them. workflow-service.ts re-exports the class and `requireWorkflow`.
 */

/** A refusal meant for the caller: its message says what to change. */
export class WorkflowRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRequestError';
  }
}

/** A workflow in its home. A home that is gone has none, and its database is not created again. */
export function requireWorkflow(homeProjectId: string, workflowId: string): Workflow {
  const homeDb = getExistingProjectDb(homeProjectId);
  const workflow = homeDb ? new WorkflowRepository(homeDb).getById(workflowId) : undefined;
  if (!workflow) throw new WorkflowRequestError(`${WORKFLOW_REFUSALS.notFound(workflowId)} List them with kangentic_list_workflows.`);
  return workflow;
}

export function requireStarted(workflow: Workflow, action: string): void {
  if (workflow.state === 'draft') {
    throw new WorkflowRequestError(`"${workflow.title}" has not started. Change its plan with kangentic_save_workflow instead of ${action}.`);
  }
  if (workflow.state === 'done') throw new WorkflowRequestError(`"${workflow.title}" is complete.`);
}
