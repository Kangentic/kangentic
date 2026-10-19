import type { PlanApproval } from './types';

/**
 * Which plan approval a workflow's tasks get, shared by main (the decision
 * each session's approver reads) and the Workflows inspector (the value it
 * shows), so the two cannot disagree.
 *
 * A pick holds. Until someone picks, the workflow is Automatic only when every
 * plan column its tasks visit is Automatic AND runs an agent whose plans can be
 * approved; anything else is Manual. Mixed boards resolve to the safe answer on
 * purpose: one Manual column makes every task in the workflow wait, which is
 * what the user sees in the inspector before they choose.
 */

/** Every PlanApproval value, for a boundary that narrows an untyped one. */
export const PLAN_APPROVALS: readonly PlanApproval[] = ['automatic', 'manual'];

/** Whether an untyped value (a stored row, an IPC or MCP argument) is a PlanApproval. */
export function isPlanApproval(value: unknown): value is PlanApproval {
  return typeof value === 'string' && (PLAN_APPROVALS as readonly string[]).includes(value);
}

/** One plan column a workflow task visits, as the derived value reads it. */
export interface WorkflowPlanColumn {
  planApproval: PlanApproval;
  /** The agent that runs the task in this column declares `supportsPlanAutoApproval`. */
  agentCanApprove: boolean;
}

export function workflowPlanApproval(
  picked: PlanApproval | null,
  planColumns: readonly WorkflowPlanColumn[],
): PlanApproval {
  if (picked) return picked;
  if (planColumns.length === 0) return 'manual';
  return planColumns.every((column) => column.planApproval === 'automatic' && column.agentCanApprove)
    ? 'automatic'
    : 'manual';
}
