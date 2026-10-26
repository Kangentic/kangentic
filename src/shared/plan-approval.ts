import type { PlanApproval, TaskPlanApproval } from './types';

/**
 * Which plan approval a workflow task gets, shared by main (the decision each
 * session's approver reads, and the MCP tools) and the Workflows inspector (the
 * control it lights), so they cannot disagree.
 *
 * Each task keeps or overrides its plan columns. Left alone, a task is
 * Automatic only when every plan column on its own route is Automatic AND runs
 * an agent whose plans can be approved; anything else is Manual. A Manual
 * column on one board holds only the tasks whose routes pass through it. A
 * task's own value wins over its columns', and setting the columns' own value
 * is the same as setting nothing (`normalizeTaskPlanApproval`).
 */

/** Every PlanApproval value, for a boundary that narrows an untyped one. */
export const PLAN_APPROVALS: readonly PlanApproval[] = ['automatic', 'manual'];

/** Whether an untyped value (a stored row, an IPC or MCP argument) is a PlanApproval. */
export function isPlanApproval(value: unknown): value is PlanApproval {
  return typeof value === 'string' && (PLAN_APPROVALS as readonly string[]).includes(value);
}

/** One plan column on a workflow task's route, as the resolution reads it. */
export interface WorkflowPlanColumn {
  name: string;
  planApproval: PlanApproval;
  /** The agent that runs the task in this column declares `supportsPlanAutoApproval`. */
  agentCanApprove: boolean;
  /** That agent's display name, for the sentence that says it cannot approve plans. */
  agentName: string;
}

/**
 * A task's plan approval from what it carries and the plan columns on its
 * route, in route order. Null when its route has no plan column: there is no
 * plan to approve.
 */
export function taskPlanApproval(
  set: PlanApproval | null,
  planColumns: readonly WorkflowPlanColumn[],
  boardName: string,
  passed: boolean,
): TaskPlanApproval | null {
  if (planColumns.length === 0) return null;
  const approves = (column: WorkflowPlanColumn) => column.planApproval === 'automatic' && column.agentCanApprove;
  const columnValue: PlanApproval = planColumns.every(approves) ? 'automatic' : 'manual';
  const canApprove = planColumns.some((column) => column.agentCanApprove);
  // The column that decided it: the first that holds the task to Manual, else
  // the first plan column on the route.
  const deciding = planColumns.find((column) => !approves(column)) ?? planColumns[0];
  // Where no plan column's agent can approve plans, Automatic approves nothing
  // (`resolvePlanApprovalDecision`), so the task reads Manual whatever it set.
  const value: PlanApproval = canApprove ? set ?? columnValue : 'manual';
  const unable = planColumns.find((column) => !column.agentCanApprove);
  return {
    set,
    value,
    columnValue,
    canApprove,
    column: { name: deciding.name, boardName },
    agentName: canApprove ? null : (unable ?? deciding).agentName,
    // Automatic approves only where the session's agent can, so a plan column
    // whose agent cannot still waits on a route where another column's can.
    waitingAgentName: canApprove ? unable?.agentName ?? null : null,
    passed,
  };
}

/** What to store for a requested value: the columns' own value is stored as nothing, so the task keeps following them. */
export function normalizeTaskPlanApproval(requested: PlanApproval | null, columnValue: PlanApproval): PlanApproval | null {
  return requested === columnValue ? null : requested;
}

function label(value: PlanApproval): string {
  return value === 'automatic' ? 'Automatic' : 'Manual';
}

/** The words every sentence about an agent Kangentic cannot approve plans for starts from. */
function cannotApprove(agentName: string): string {
  return `Kangentic can't approve ${agentName}'s plans`;
}

/** The column that decided the task's value, with its board. */
function decidingColumn(view: TaskPlanApproval): string {
  return `${view.column.boardName}'s ${view.column.name} column`;
}

/** With Automatic, the clause naming a plan column's agent whose plans still wait; empty otherwise. */
function stillWaits(view: TaskPlanApproval): string {
  return view.value === 'automatic' && view.waitingAgentName ? `, but ${view.waitingAgentName}'s plans still wait for you` : '';
}

/** The reason Automatic is off for an agent Kangentic cannot approve plans for, on every surface that offers it. */
export function agentCannotApprovePlans(agentName: string): string {
  return `${cannotApprove(agentName)}, so they wait for you.`;
}

/** The inspector's tip on the lit option: what happens and where it comes from, in one sentence. */
export function taskPlanApprovalTip(view: TaskPlanApproval): string {
  if (!view.canApprove && view.agentName) return `Manual, because ${cannotApprove(view.agentName)}.`;
  if (view.set !== null) {
    return `${label(view.value)}, set for this task (${decidingColumn(view)} is ${label(view.columnValue)})${stillWaits(view)}.`;
  }
  return `${label(view.value)}, from ${decidingColumn(view)}.`;
}

/**
 * The sentence `kangentic_get_workflow` prints for a task, so an agent learns
 * which way a task goes without reading any board's columns.
 */
export function taskPlanApprovalSentence(view: TaskPlanApproval | null): string {
  if (!view) return 'Plan approval: none, no plan column on its route.';
  const ownColumn = `its ${view.column.name} column is ${label(view.columnValue)}`;
  let sentence: string;
  if (!view.canApprove && view.agentName) {
    sentence = `Plan approval: Manual, because ${cannotApprove(view.agentName)} (${ownColumn}).`;
  } else if (view.set !== null) {
    sentence = `Plan approval: ${label(view.value)}, set for this task (${ownColumn})${stillWaits(view)}.`;
  } else {
    sentence = `Plan approval: ${label(view.value)}, from ${decidingColumn(view)}.`;
  }
  return view.passed ? `${sentence} It has passed ${view.column.name}, so it can no longer change.` : sentence;
}
