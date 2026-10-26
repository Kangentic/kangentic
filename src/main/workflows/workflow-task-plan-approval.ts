import type { PlanApproval, Task, TaskPlanApproval } from '../../shared/types';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { normalizeTaskPlanApproval } from '../../shared/plan-approval';
import { getExistingProjectDb, getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import type { IpcContext } from '../ipc/ipc-context';
import { adoptLegacyPlanApproval, readTaskPlanApproval } from '../plan-approval/workflow-plan-approval';
import { announceBoardChange } from './workflow-board-announce';
import { notifyWorkflowChanged } from './workflow-changed';
import { WorkflowRequestError, requireStarted, requireWorkflow } from './workflow-requests';

/**
 * A started task's own plan approval, or null to follow its plan columns, for
 * the inspector, task detail's Workflow panel and `kangentic_update_task`.
 * Refused once it can change nothing: in Done, or past its last plan column.
 * The columns' own value is stored as nothing, so the task keeps following them.
 * The board announcement is what makes the task's live session's approver read
 * it (`plan-approval-writer.ts` listens on the board bus).
 *
 * Its own module, not workflow-service.ts: task-commands.ts calls it, and the
 * MCP server loads task-commands.ts, so it imports nothing that reaches the
 * session handlers. `projectId` and `taskId` are ids, never names or numbers.
 */
export function setTaskPlanApproval(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: { taskId: string; projectId: string },
  planApproval: PlanApproval | null,
): Task {
  const workflow = adoptLegacyPlanApproval(context, homeProjectId, requireWorkflow(homeProjectId, workflowId));
  requireStarted(workflow, 'setting a task\'s plan approval');
  const db = getExistingProjectDb(input.projectId);
  if (!db) throw new WorkflowRequestError('That board is no longer in Kangentic.');
  const tasks = new TaskRepository(db);
  const task = tasks.getById(input.taskId);
  if (!task) throw new WorkflowRequestError(`No task "${input.taskId}" on that board.`);
  const label = `#${task.display_id}`;
  if (task.workflow_id !== workflow.id) throw new WorkflowRequestError(`${label} is not in "${workflow.title}".`);
  const lanes = new SwimlaneRepository(db).list();
  const lane = lanes.find((candidate) => candidate.id === task.swimlane_id);
  if (task.archived_at || lane?.role === 'done') throw new WorkflowRequestError(WORKFLOW_REFUSALS.planDone(label));
  const view = readTaskPlanApproval(context, input.projectId, task, workflow.plan_approval, lanes);
  if (view?.passed) throw new WorkflowRequestError(WORKFLOW_REFUSALS.planPassed(label, view.column.name));
  tasks.setPlanApproval(task.id, storedPlanApproval(planApproval, view, workflow.plan_approval));
  new WorkflowRepository(getProjectDb(homeProjectId)).bumpRevision(workflowId);
  announceBoardChange(context, input.projectId);
  notifyWorkflowChanged(homeProjectId, workflowId);
  return tasks.getById(task.id)!;
}

/**
 * What to store for a requested value. The columns' own value is stored as
 * nothing, so the task keeps following them. A route with no plan column keeps
 * the value as given. While a legacy whole-workflow value is still in place (a
 * board would not read, so adoption could not finish), nothing would read as
 * that value and adoption would later overwrite it, so the pick is stored as
 * given and following the columns is stored as their value.
 */
function storedPlanApproval(
  requested: PlanApproval | null,
  view: TaskPlanApproval | null,
  legacy: PlanApproval | null,
): PlanApproval | null {
  if (!view) return requested;
  if (legacy !== null) return requested ?? view.columnValue;
  return normalizeTaskPlanApproval(requested, view.columnValue);
}
