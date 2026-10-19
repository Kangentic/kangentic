import type { Swimlane, Task, Workflow, WorkflowDetail, WorkflowDraftTask } from '../../shared/types';
import { routeColumns, taskPlace, type RouteFields } from '../../shared/workflow-route';
import { workflowPlanApproval, type WorkflowPlanColumn } from '../../shared/plan-approval';
import { agentRegistry } from '../agent/agent-registry';
import { applyProfileToLane } from '../transition-engine/column-strategy';
import { resolveTargetAgent } from '../transition-engine/agent-resolver';
import { loadTaskProfile } from '../ipc/helpers/task-profile';
import type { IpcContext } from '../ipc/ipc-context';
import { safeLanes } from '../workflows/workflow-service';
import { workflowTasks } from '../workflows/workflow-tasks';
import { notifyWorkflowChanged } from '../workflows/workflow-changed';
import { getExistingProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';

/**
 * The plan approval a workflow's tasks get, as main computes it: the workflow's
 * pick, or, until someone picks, the answer its plan columns give together
 * (`workflowPlanApproval`). The inspector shows it and every running task's
 * approver obeys it, so both read it here.
 *
 * A plan column is a route column that runs the task in plan mode once its
 * Board Profile is folded in. Whether its agent can approve plans is read off
 * the agent that would run the task there. A task already done visits nothing
 * more, so its route no longer counts; before Start, every planned task does.
 */

/** A task that still has columns ahead of it, with what decides its agent and profile there. */
interface RoutedTask {
  projectId: string;
  route: RouteFields;
  profileSource: Pick<Task, 'id' | 'profile_id'>;
  agentOverride: string | null;
  agent: string | null;
}

export function readWorkflowPlanApproval(
  context: IpcContext,
  homeProjectId: string,
  workflow: Workflow,
): WorkflowDetail['planApproval'] {
  const columns = routedTasksOf(context, homeProjectId, workflow).flatMap((routed) => planColumnsOf(context, routed));
  // Where no plan column's agent can approve plans, Automatic approves nothing
  // (`resolvePlanApprovalDecision`), so the inspector shows Manual, as the
  // Column Manager does for such an agent, and does not offer Automatic.
  const canApprove = columns.length === 0 || columns.some((column) => column.agentCanApprove);
  const value = workflowPlanApproval(workflow.plan_approval, columns);
  return { value: canApprove ? value : 'manual', picked: workflow.plan_approval !== null, canApprove };
}

/**
 * Tell every workflow that reads this board's columns that its plan approval
 * may have changed: those with a task on it, and the not-started ones with a
 * planned task on it. The inspector reloads only on `WORKFLOW_CHANGED`, so
 * without this a Planning column switched to Automatic would leave it showing
 * a value that no longer happens.
 */
export function notifyWorkflowsReadingBoard(context: IpcContext, boardProjectId: string): void {
  const notified = new Set<string>();
  const notify = (homeProjectId: string, workflowId: string): void => {
    if (notified.has(workflowId)) return;
    notified.add(workflowId);
    notifyWorkflowChanged(homeProjectId, workflowId);
  };
  try {
    const boardDb = getExistingProjectDb(boardProjectId);
    if (boardDb) {
      for (const membership of new TaskRepository(boardDb).listWorkflowMemberships()) {
        notify(membership.workflow_project_id ?? boardProjectId, membership.workflow_id);
      }
    }
    for (const project of context.projectRepo.list()) {
      const homeDb = getExistingProjectDb(project.id);
      if (!homeDb) continue;
      for (const workflow of new WorkflowRepository(homeDb).listOpen()) {
        if (workflow.state !== 'draft') continue;
        const onBoard = (workflow.draft?.tasks ?? []).some((planned) => (planned.project_id ?? project.id) === boardProjectId);
        if (onBoard) notify(project.id, workflow.id);
      }
    }
  } catch (error) {
    // A board that will not read reloads nothing; the next change catches up.
    console.warn('[plan-approval] Could not find the workflows reading a board:', error);
  }
}

function routedTasksOf(context: IpcContext, homeProjectId: string, workflow: Workflow): RoutedTask[] {
  if (workflow.state === 'draft') {
    return (workflow.draft?.tasks ?? []).map((planned: WorkflowDraftTask) => ({
      projectId: planned.project_id ?? homeProjectId,
      route: planned,
      profileSource: { id: planned.key, profile_id: planned.profile_id },
      agentOverride: planned.agent_override,
      agent: null,
    }));
  }
  return workflowTasks(context, homeProjectId, workflow.id)
    .filter(({ projectId, task }) => taskPlace(safeLanes(projectId), task) !== 'done')
    .map(({ projectId, task }) => ({
      projectId,
      route: task,
      profileSource: task,
      agentOverride: task.agent_override,
      agent: task.agent,
    }));
}

function planColumnsOf(context: IpcContext, routed: RoutedTask): WorkflowPlanColumn[] {
  const project = context.projectRepo.getById(routed.projectId);
  const lanes: Swimlane[] = safeLanes(routed.projectId);
  const profile = loadTaskProfile(context, routed.profileSource, project?.path ?? null);
  const planColumns: WorkflowPlanColumn[] = [];
  for (const lane of routeColumns(lanes, routed.route)) {
    const folded = applyProfileToLane(lane, profile, lanes) ?? lane;
    if (folded.permission_mode !== 'plan') continue;
    const { agent } = resolveTargetAgent({
      taskAgentOverride: routed.agentOverride,
      columnAgent: folded.agent_override,
      taskAgent: routed.agent,
      projectDefaultAgent: project?.default_agent ?? null,
    });
    planColumns.push({
      planApproval: lane.plan_approval,
      agentCanApprove: agentRegistry.get(agent)?.supportsPlanAutoApproval === true,
    });
  }
  return planColumns;
}
