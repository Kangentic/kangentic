import type {
  Swimlane,
  Task,
  Workflow,
  WorkflowBoardTask,
  WorkflowCanvasPosition,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowDraftTask,
  WorkflowRouteStep,
  WorkflowSummary,
  WorkflowTaskInput,
  WorkflowTaskPlace,
  WorkflowViewLink,
  WorkflowViewTask,
} from '../../shared/types';
import { nextOnRoute, plannedRouteSteps, routeFromColumns, routeSteps, taskPlace } from '../../shared/workflow-route';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskMoveRepository } from '../db/repositories/task-move-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import type { IpcContext } from '../ipc/ipc-context';
import { wouldCreateCycle } from './engine/workflow-engine-core';
import { notifyWorkflowChanged } from './workflow-changed';
import { isHumanGate } from './workflow-lock-check';
import {
  MAX_WORKFLOW_TASKS,
  WorkflowRequestError,
  addWorkflowTask,
  createWorkflow,
  linkTasks,
  removeFromWorkflow,
  requireWorkflow,
  resolveProjectId,
  safeLanes,
  setTaskRouteByIds,
  unlinkTasks,
  workflowTasks,
} from './workflow-service';

/**
 * The Workflows view's side of the workflow operations: a read model shaped
 * for the canvas and the inspector, and edits addressed by the view's own keys
 * and column ids rather than the names an agent types.
 *
 * Every rule a started workflow has is enforced once, in `workflow-service.ts`
 * (the same calls the MCP tools make), so the view and an agent can never be
 * held to different rules. What is here is the planned-workflow editing (the
 * view edits one task or link at a time where an agent replaces the whole
 * plan) and the read model.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function plannedSteps(lanes: Swimlane[], planned: WorkflowDraftTask): WorkflowRouteStep[] {
  return plannedRouteSteps(lanes, planned);
}

/** When the task last left each column, from its recorded moves. */
function leftAtByColumn(projectId: string, taskId: string): Map<string, string> {
  const left = new Map<string, string>();
  try {
    for (const move of new TaskMoveRepository(getProjectDb(projectId)).listForTask(taskId)) {
      if (move.from_swimlane_id) left.set(move.from_swimlane_id, move.at);
    }
  } catch {
    // No history readable: the rail shows the step without a time.
  }
  return left;
}

function projectNameOf(context: IpcContext, projectId: string): string {
  return context.projectRepo.getById(projectId)?.name ?? 'Another project';
}

export function readWorkflowDetail(context: IpcContext, homeProjectId: string, workflowId: string): WorkflowDetail {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  const projectNames: Record<string, string> = { [homeProjectId]: projectNameOf(context, homeProjectId) };

  if (workflow.state === 'draft') {
    const draft = workflow.draft ?? { tasks: [], links: [] };
    const tasks = draft.tasks.map((planned): WorkflowViewTask => {
      const projectId = planned.project_id ?? homeProjectId;
      projectNames[projectId] ??= projectNameOf(context, projectId);
      return {
        key: planned.key,
        projectId,
        task: null,
        planned,
        title: planned.title,
        displayId: null,
        place: 'planned',
        swimlaneId: null,
        steps: plannedSteps(safeLanes(projectId), planned),
        canvasX: planned.canvas_x,
        canvasY: planned.canvas_y,
      };
    });
    const links = draft.links.map((link): WorkflowViewLink => ({ blockerKey: link.blocker, blockedKey: link.blocked }));
    return { workflow, homeProjectId, tasks, links, projectNames };
  }

  const created = workflowTasks(context, homeProjectId, workflowId);
  const tasks = created.map(({ projectId, task }): WorkflowViewTask => {
    projectNames[projectId] ??= projectNameOf(context, projectId);
    const lanes = safeLanes(projectId);
    const place = taskPlace(lanes, task);
    return {
      key: task.id,
      projectId,
      task,
      planned: null,
      title: task.title,
      displayId: task.display_id,
      place,
      swimlaneId: task.swimlane_id,
      steps: routeSteps(lanes, task, place === 'todo' ? new Map() : leftAtByColumn(projectId, task.id)),
      canvasX: task.canvas_x,
      canvasY: task.canvas_y,
    };
  });
  const present = new Set(tasks.map((task) => task.key));
  // A link whose end left the board (a deleted task) has nothing to draw. The
  // engine still never reads it as satisfied (`blockersDone`).
  const links = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflowId)
    .filter((link) => present.has(link.blocker_task_id) && present.has(link.blocked_task_id))
    .map((link): WorkflowViewLink => ({ blockerKey: link.blocker_task_id, blockedKey: link.blocked_task_id }));
  return { workflow, homeProjectId, tasks, links, projectNames };
}

/** The picker's rows: every workflow of the project that has not finished, newest first. */
export function listWorkflowSummaries(context: IpcContext, homeProjectId: string): WorkflowSummary[] {
  const workflows = new WorkflowRepository(getProjectDb(homeProjectId)).listOpen();
  return workflows.map((workflow) => summarize(context, homeProjectId, workflow));
}

function summarize(context: IpcContext, homeProjectId: string, workflow: Workflow): WorkflowSummary {
  if (workflow.state === 'draft') {
    return { workflow, taskCount: workflow.draft?.tasks.length ?? 0, doneCount: 0, inProgressCount: 0, queuedCount: 0, blockedCount: 0, boardTasks: {} };
  }
  const created = workflowTasks(context, homeProjectId, workflow.id);
  const places = new Map<string, Exclude<WorkflowTaskPlace, 'planned'>>();
  const displayIds = new Map<string, number>();
  for (const { projectId, task } of created) {
    places.set(task.id, taskPlace(safeLanes(projectId), task));
    displayIds.set(task.id, task.display_id);
  }
  const links = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflow.id);
  let doneCount = 0;
  let inProgressCount = 0;
  let queuedCount = 0;
  let blockedCount = 0;
  const boardTasks: Record<string, WorkflowBoardTask> = {};
  for (const { projectId, task } of created) {
    const place = places.get(task.id)!;
    let waitingFor: string[] = [];
    let humanGateTargetId: string | null = null;
    if (place === 'done') doneCount += 1;
    else if (place === 'working') {
      inProgressCount += 1;
      humanGateTargetId = humanGateExit(context, projectId, task, workflow);
    } else {
      // A blocker that left every board (deleted) still holds the task, as the engine reads it.
      waitingFor = links
        .filter((link) => link.blocked_task_id === task.id && places.get(link.blocker_task_id) !== 'done')
        .map((link) => {
          const displayId = displayIds.get(link.blocker_task_id);
          return displayId ? `#${displayId}` : 'a removed task';
        });
      if (waitingFor.length > 0) blockedCount += 1;
      else queuedCount += 1;
    }
    if (place !== 'done') boardTasks[task.id] = { waitingFor, humanGateTargetId };
  }
  return { workflow, taskCount: places.size, doneCount, inProgressCount, queuedCount, blockedCount, boardTasks };
}

/** While the workflow runs: where a person may drag a task out of the human gate it sits in. */
function humanGateExit(context: IpcContext, projectId: string, task: Task, workflow: Workflow): string | null {
  if (workflow.state !== 'running') return null;
  const lanes = safeLanes(projectId);
  const column = lanes.find((lane) => lane.id === task.swimlane_id);
  if (!column || !isHumanGate(context, projectId, task, column)) return null;
  return nextOnRoute(lanes, task, column.id)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/**
 * The one gate every view edit passes. Today it refuses a finished workflow;
 * the workflow agent's turn adds the hold on everything that would change its
 * plan (#732 board 2c), here and nowhere else.
 */
function requireViewMayChange(workflow: Workflow): void {
  if (workflow.state === 'done') throw new WorkflowRequestError(`"${workflow.title}" is complete.`);
}

/** A planned workflow's edit: change a copy of its plan and store it (a plan change bumps the revision). */
function editDraft(homeProjectId: string, workflowId: string, edit: (draft: WorkflowDraft, workflow: Workflow) => void): void {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireViewMayChange(workflow);
  if (workflow.state !== 'draft') throw new WorkflowRequestError(`"${workflow.title}" has started.`);
  const draft: WorkflowDraft = structuredClone(workflow.draft ?? { tasks: [], links: [] });
  edit(draft, workflow);
  new WorkflowRepository(getProjectDb(homeProjectId)).saveDraft(workflowId, draft);
  notifyWorkflowChanged(homeProjectId, workflowId);
}

function requirePlanned(draft: WorkflowDraft, key: string): WorkflowDraftTask {
  const planned = draft.tasks.find((task) => task.key === key);
  if (!planned) throw new WorkflowRequestError('That task is no longer in the plan.');
  return planned;
}

/** A started workflow's task by its view key (the task id), with the board it is on. */
function requireCreated(context: IpcContext, homeProjectId: string, workflowId: string, key: string): { projectId: string; task: Task } {
  const found = workflowTasks(context, homeProjectId, workflowId).find(({ task }) => task.id === key);
  if (!found) throw new WorkflowRequestError('That task is no longer in this workflow.');
  return found;
}

function nextPlannedKey(draft: WorkflowDraft): string {
  const used = new Set(draft.tasks.map((task) => task.key));
  let index = draft.tasks.length + 1;
  while (used.has(`task-${index}`)) index += 1;
  return `task-${index}`;
}

/** New workflow, from a To Do task (its title and description are the brief) or from nothing. */
export function createWorkflowForView(context: IpcContext, homeProjectId: string, sourceTaskId: string | null): Workflow {
  if (!sourceTaskId) return createWorkflow(homeProjectId, {});
  const db = getProjectDb(homeProjectId);
  const source = new TaskRepository(db).getById(sourceTaskId);
  if (!source || source.archived_at) throw new WorkflowRequestError('That task is no longer on the board.');
  if (source.workflow_id) throw new WorkflowRequestError(`#${source.display_id} is already in a workflow.`);
  const lane = safeLanes(homeProjectId).find((candidate) => candidate.id === source.swimlane_id);
  if (lane?.role !== 'todo') throw new WorkflowRequestError(`#${source.display_id} has started. Only a task in To Do can become a workflow.`);
  const brief = [source.title.trim(), source.description.trim()].filter(Boolean).join('\n\n');
  return createWorkflow(homeProjectId, { brief, sourceTaskId: source.id });
}

/** Add task: a planned task before Start; a task in To Do after, which starts when nothing it waits for is left. */
export function addViewTask(context: IpcContext, homeProjectId: string, workflowId: string, input: WorkflowTaskInput): string {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new WorkflowRequestError('The task needs a title.');
  const projectId = resolveProjectId(context, homeProjectId, input.projectId ?? null);
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireViewMayChange(workflow);

  if (workflow.state !== 'draft') {
    const created = addWorkflowTask(context, homeProjectId, workflowId, {
      key: '',
      title,
      description: input.description ?? '',
      labels: input.labels ?? [],
      priority: input.priority ?? 0,
      project: projectId,
    });
    return created.id;
  }

  let key = '';
  editDraft(homeProjectId, workflowId, (draft) => {
    if (draft.tasks.length >= MAX_WORKFLOW_TASKS) {
      throw new WorkflowRequestError(`A workflow plans at most ${MAX_WORKFLOW_TASKS} tasks.`);
    }
    key = nextPlannedKey(draft);
    draft.tasks.push({
      key,
      title,
      description: input.description ?? '',
      project_id: projectId === homeProjectId ? null : projectId,
      existing_task_id: null,
      route_start_swimlane_id: null,
      route_last_swimlane_id: null,
      skipped_swimlane_ids: [],
      labels: input.labels ?? [],
      priority: input.priority ?? 0,
      canvas_x: null,
      canvas_y: null,
    });
  });
  return key;
}

/** Edit a planned task (the Edit Task window before Start). A changed board resets its route to every column there. */
export function updatePlannedTask(context: IpcContext, homeProjectId: string, workflowId: string, key: string, input: Partial<WorkflowTaskInput>): void {
  const nextProjectId = input.projectId === undefined ? undefined : resolveProjectId(context, homeProjectId, input.projectId);
  editDraft(homeProjectId, workflowId, (draft) => {
    const planned = requirePlanned(draft, key);
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new WorkflowRequestError('The task needs a title.');
      planned.title = title;
    }
    if (input.description !== undefined) planned.description = input.description;
    if (input.labels !== undefined) planned.labels = input.labels.filter((label) => typeof label === 'string');
    if (input.priority !== undefined) planned.priority = input.priority;
    if (nextProjectId !== undefined) {
      const stored = nextProjectId === homeProjectId ? null : nextProjectId;
      if (stored !== planned.project_id) {
        if (planned.existing_task_id) throw new WorkflowRequestError('A task already on a board stays on its board.');
        planned.project_id = stored;
        planned.route_start_swimlane_id = null;
        planned.route_last_swimlane_id = null;
        planned.skipped_swimlane_ids = [];
      }
    }
  });
}

/** Remove: a planned task leaves the plan with its links; a created one stays on its board as an ordinary task. */
export function removeViewTask(context: IpcContext, homeProjectId: string, workflowId: string, key: string): void {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireViewMayChange(workflow);
  if (workflow.state === 'draft') {
    editDraft(homeProjectId, workflowId, (draft) => {
      requirePlanned(draft, key);
      draft.tasks = draft.tasks.filter((task) => task.key !== key);
      draft.links = draft.links.filter((link) => link.blocker !== key && link.blocked !== key);
    });
    return;
  }
  const { projectId, task } = requireCreated(context, homeProjectId, workflowId, key);
  removeFromWorkflow(context, homeProjectId, workflowId, { task: task.id, project: projectId });
}

/** Link or unlink: `blocked` waits for `blocker` to reach Done. */
export function setViewLink(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  blockerKey: string,
  blockedKey: string,
  linked: boolean,
): void {
  if (blockerKey === blockedKey) throw new WorkflowRequestError(WORKFLOW_REFUSALS.selfLink);
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireViewMayChange(workflow);
  if (workflow.state === 'draft') {
    editDraft(homeProjectId, workflowId, (draft) => {
      requirePlanned(draft, blockerKey);
      requirePlanned(draft, blockedKey);
      const exists = draft.links.some((link) => link.blocker === blockerKey && link.blocked === blockedKey);
      if (!linked) {
        draft.links = draft.links.filter((link) => !(link.blocker === blockerKey && link.blocked === blockedKey));
        return;
      }
      if (exists) return;
      const asCore = draft.links.map((link) => ({ blockerTaskId: link.blocker, blockedTaskId: link.blocked }));
      if (wouldCreateCycle(asCore, blockerKey, blockedKey)) {
        throw new WorkflowRequestError(WORKFLOW_REFUSALS.loop);
      }
      draft.links.push({ blocker: blockerKey, blocked: blockedKey });
    });
    return;
  }
  const blocker = requireCreated(context, homeProjectId, workflowId, blockerKey);
  const blocked = requireCreated(context, homeProjectId, workflowId, blockedKey);
  const selectors = { blocker: blocker.task.id, blockerProject: blocker.projectId, blocked: blocked.task.id, blockedProject: blocked.projectId };
  if (linked) linkTasks(context, homeProjectId, workflowId, selectors);
  else unlinkTasks(context, homeProjectId, workflowId, selectors);
}

/** The route switches: the task visits exactly these columns of its board. */
export function setViewRoute(context: IpcContext, homeProjectId: string, workflowId: string, key: string, swimlaneIds: string[]): void {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireViewMayChange(workflow);
  if (workflow.state === 'draft') {
    editDraft(homeProjectId, workflowId, (draft) => {
      const planned = requirePlanned(draft, key);
      const route = routeFromColumns(safeLanes(planned.project_id ?? homeProjectId), swimlaneIds);
      if (!route) throw new WorkflowRequestError(WORKFLOW_REFUSALS.routeEmpty);
      planned.route_start_swimlane_id = route.route_start_swimlane_id;
      planned.route_last_swimlane_id = route.route_last_swimlane_id;
      planned.skipped_swimlane_ids = route.skipped_swimlane_ids;
    });
    return;
  }
  const { projectId, task } = requireCreated(context, homeProjectId, workflowId, key);
  const route = routeFromColumns(safeLanes(projectId), swimlaneIds);
  if (!route) throw new WorkflowRequestError(WORKFLOW_REFUSALS.routeEmpty);
  setTaskRouteByIds(context, homeProjectId, workflowId, { taskId: task.id, projectId, route });
}

/**
 * Where hands placed cards, or null to put every card back in the automatic
 * layout. Changes no plan: the revision stays (a save the workflow agent built
 * on its last read still goes through) and a task's `updated_at` stays (the
 * knowledge index does not re-read a task for a card drag).
 */
export function setViewPositions(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  positions: WorkflowCanvasPosition[] | null,
): void {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  const byKey = new Map((positions ?? []).map((position) => [position.key, position]));
  const placeOf = (key: string): { x: number | null; y: number | null } | null => {
    if (positions === null) return { x: null, y: null };
    const position = byKey.get(key);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
    return { x: Math.round(position.x), y: Math.round(position.y) };
  };

  if (workflow.state === 'draft') {
    const draft: WorkflowDraft = structuredClone(workflow.draft ?? { tasks: [], links: [] });
    for (const planned of draft.tasks) {
      const place = placeOf(planned.key);
      if (!place) continue;
      planned.canvas_x = place.x;
      planned.canvas_y = place.y;
    }
    new WorkflowRepository(getProjectDb(homeProjectId)).writeDraftLayout(workflowId, draft);
  } else {
    for (const { projectId, task } of workflowTasks(context, homeProjectId, workflowId)) {
      const place = placeOf(task.id);
      if (!place) continue;
      new TaskRepository(getProjectDb(projectId)).setCanvasPosition(task.id, place.x, place.y);
    }
  }
  notifyWorkflowChanged(homeProjectId, workflowId);
}
