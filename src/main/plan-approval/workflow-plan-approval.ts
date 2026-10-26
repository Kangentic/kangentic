import type { PlanApproval, Swimlane, Task, TaskPlanApproval, Workflow, WorkflowDraftTask, WorkflowTaskPlace } from '../../shared/types';
import { routeColumns, taskPlace, type RouteFields } from '../../shared/workflow-route';
import { taskPlanApproval, type WorkflowPlanColumn } from '../../shared/plan-approval';
import { agentRegistry } from '../agent/agent-registry';
import { applyProfileToLane } from '../transition-engine/column-strategy';
import { resolveTargetAgent } from '../transition-engine/agent-resolver';
import { loadTaskProfile } from '../ipc/helpers/task-profile';
import type { IpcContext } from '../ipc/ipc-context';
import { safeLanes } from '../workflows/workflow-lanes';
import { readWorkflowTasks } from '../workflows/workflow-tasks';
import { notifyWorkflowChanged } from '../workflows/workflow-changed';
import { getExistingProjectDb } from '../db/database';
import { isSqliteError } from '../db/sqlite-error';
import { TaskRepository } from '../db/repositories/task-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';

/**
 * The plan approval each workflow task gets, as main computes it
 * (`taskPlanApproval`): the task's own value, or, left alone, the answer the
 * plan columns on its own route give. The inspector lights it, the MCP tools
 * print it, and every running task's approver obeys it, so all three read it
 * here.
 *
 * A plan column is a route column that runs the task in plan mode once its
 * Board Profile is folded in. Whether its agent can approve plans is read off
 * the agent that would run the task there.
 *
 * Older versions picked one value for the whole workflow
 * (`Workflow.plan_approval`). `adoptLegacyPlanApproval` copies a value left
 * there onto the workflow's tasks; until it can, every read here puts it
 * between the task's own value and its columns', so nothing changes for the
 * tasks meanwhile.
 */

/** A workflow task with what decides its plan columns and its agent there. */
interface RoutedTask {
  projectId: string;
  route: RouteFields;
  profileSource: Pick<Task, 'id' | 'profile_id'>;
  agentOverride: string | null;
  agent: string | null;
  set: PlanApproval | null;
  place: WorkflowTaskPlace;
  swimlaneId: string | null;
}

/**
 * What a planned task's plan approval is read from: its board, route, Board
 * Profile and agent override, and its own value when it has one. A whole
 * `WorkflowDraftTask` is one; a task about to be added builds just these.
 */
export type PlannedPlanSource = RouteFields
  & Pick<WorkflowDraftTask, 'key' | 'project_id' | 'profile_id' | 'agent_override'>
  & { plan_approval?: PlanApproval | null };

/**
 * One started task's plan approval. `legacy` is its workflow's whole-workflow
 * value as read before any adoption, so a task read before its copy landed
 * still resolves as it did. `lanes` is its board's columns when the caller
 * already read them.
 */
export function readTaskPlanApproval(
  context: IpcContext,
  projectId: string,
  task: Task,
  legacy: PlanApproval | null,
  lanes: Swimlane[] = safeLanes(projectId),
): TaskPlanApproval | null {
  return resolveRouted(context, routedOfTask(projectId, task, lanes), legacy, lanes);
}

/** One planned task's plan approval, before Start. `lanes` is its board's columns when the caller already read them. */
export function readPlannedTaskPlanApproval(
  context: IpcContext,
  homeProjectId: string,
  planned: PlannedPlanSource,
  legacy: PlanApproval | null,
  lanes?: Swimlane[],
): TaskPlanApproval | null {
  const routed = routedOfPlanned(homeProjectId, planned);
  return resolveRouted(context, routed, legacy, lanes ?? safeLanes(routed.projectId));
}

/**
 * Copy a workflow's legacy whole-workflow plan approval onto each of its tasks
 * that has none of its own (every planned task, or every unfinished started
 * one), then clear it. It is cleared only once every such task has its copy: a
 * board whose database will not open leaves it in place, and the next read
 * tries again. Returns the workflow as it now stands.
 *
 * It only writes. What each task gets does not change, so it announces nothing,
 * which keeps a call from inside the plan approval writer's refresh from
 * triggering another refresh. Once cleared it is one null check.
 */
export function adoptLegacyPlanApproval(context: IpcContext, homeProjectId: string, workflow: Workflow): Workflow {
  const legacy = workflow.plan_approval;
  if (!legacy) return workflow;
  const homeDb = getExistingProjectDb(homeProjectId);
  if (!homeDb) return workflow;
  const workflows = new WorkflowRepository(homeDb);
  try {
    if (workflow.state === 'draft') {
      const draft = workflow.draft ?? { tasks: [], links: [] };
      const written = workflows.writeAdoptedDraft(workflow.id, {
        ...draft,
        tasks: draft.tasks.map((planned) => ({ ...planned, plan_approval: planned.plan_approval ?? legacy })),
      });
      // The row is no longer a draft (a stale argument): its tasks got nothing yet.
      if (!written) return workflow;
    } else if (workflow.state !== 'done') {
      const { tasks, unreadProjectIds } = readWorkflowTasks(context, homeProjectId, workflow.id);
      if (unreadProjectIds.size > 0) return workflow;
      for (const { projectId, task } of tasks) {
        if (task.plan_approval !== null || taskPlace(safeLanes(projectId), task) === 'done') continue;
        const db = getExistingProjectDb(projectId);
        // A board gone since the read keeps the value for the next read.
        if (!db) return workflow;
        new TaskRepository(db).setPlanApproval(task.id, legacy);
      }
    }
    workflows.clearLegacyPlanApproval(workflow.id);
  } catch (error) {
    // A database that will not write keeps the legacy value; the next read retries.
    if (!isSqliteError(error)) throw error;
    console.warn(`[plan-approval] Could not move workflow ${workflow.id.slice(0, 8)}'s plan approval onto its tasks:`, error);
    return workflow;
  }
  return workflows.getById(workflow.id) ?? workflow;
}

/**
 * Tell every workflow that reads this board's columns that its tasks' plan
 * approval may have changed: those with a task on it, and the not-started ones
 * with a planned task on it. The inspector reloads only on `WORKFLOW_CHANGED`,
 * so without this a Planning column switched to Automatic would leave it
 * showing a value that no longer happens.
 */
export function notifyWorkflowsReadingBoard(context: IpcContext, boardProjectId: string): void {
  const notified = new Set<string>();
  const notify = (homeProjectId: string, workflowId: string): void => {
    if (notified.has(workflowId)) return;
    notified.add(workflowId);
    notifyWorkflowChanged(homeProjectId, workflowId);
  };
  // A database that will not read skips only itself; the next change catches up.
  try {
    const boardDb = getExistingProjectDb(boardProjectId);
    if (boardDb) {
      for (const membership of new TaskRepository(boardDb).listWorkflowMemberships()) {
        notify(membership.workflow_project_id ?? boardProjectId, membership.workflow_id);
      }
    }
  } catch (error) {
    console.warn('[plan-approval] Could not read the workflows with a task on a board:', error);
  }
  let projects: ReturnType<IpcContext['projectRepo']['list']>;
  try {
    projects = context.projectRepo.list();
  } catch (error) {
    console.warn('[plan-approval] Could not list the projects for a board change:', error);
    return;
  }
  for (const project of projects) {
    try {
      const homeDb = getExistingProjectDb(project.id);
      if (!homeDb) continue;
      for (const workflow of new WorkflowRepository(homeDb).listOpen()) {
        if (workflow.state !== 'draft') continue;
        const onBoard = (workflow.draft?.tasks ?? []).some((planned) => (planned.project_id ?? project.id) === boardProjectId);
        if (onBoard) notify(project.id, workflow.id);
      }
    } catch (error) {
      console.warn(`[plan-approval] Could not read the draft workflows of project ${project.id.slice(0, 8)}:`, error);
    }
  }
}

function routedOfPlanned(homeProjectId: string, planned: PlannedPlanSource): RoutedTask {
  return {
    projectId: planned.project_id ?? homeProjectId,
    route: planned,
    profileSource: { id: planned.key, profile_id: planned.profile_id },
    agentOverride: planned.agent_override,
    agent: null,
    set: planned.plan_approval ?? null,
    place: 'planned',
    swimlaneId: null,
  };
}

function routedOfTask(projectId: string, task: Task, lanes: Swimlane[]): RoutedTask {
  return {
    projectId,
    route: task,
    profileSource: task,
    agentOverride: task.agent_override,
    agent: task.agent,
    set: task.plan_approval,
    place: taskPlace(lanes, task),
    swimlaneId: task.swimlane_id,
  };
}

function resolveRouted(
  context: IpcContext,
  routed: RoutedTask,
  legacy: PlanApproval | null,
  lanes: Swimlane[],
): TaskPlanApproval | null {
  const project = context.projectRepo.getById(routed.projectId);
  const profile = loadTaskProfile(context, routed.profileSource, project?.path ?? null);
  const planLanes: Swimlane[] = [];
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
    const adapter = agentRegistry.get(agent);
    planLanes.push(lane);
    planColumns.push({
      name: lane.name,
      planApproval: lane.plan_approval,
      agentCanApprove: adapter?.supportsPlanAutoApproval === true,
      agentName: adapter?.displayName ?? agent,
    });
  }
  return taskPlanApproval(routed.set ?? legacy, planColumns, project?.name ?? 'its board', passedPlanColumns(routed, lanes, planLanes));
}

/** In Done, or working in a column after the last plan column on its route. */
function passedPlanColumns(routed: RoutedTask, lanes: readonly Swimlane[], planLanes: readonly Swimlane[]): boolean {
  if (routed.place === 'done') return true;
  if (routed.place !== 'working' || planLanes.length === 0) return false;
  const current = lanes.find((lane) => lane.id === routed.swimlaneId);
  const lastPlanLane = planLanes[planLanes.length - 1];
  return current !== undefined && current.position > lastPlanLane.position;
}
