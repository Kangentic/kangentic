import type {
  PlanApproval,
  Swimlane,
  Task,
  Workflow,
  WorkflowBoardEnds,
  WorkflowBoardTask,
  WorkflowCanvasPosition,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowDraftTask,
  WorkflowRouteStep,
  WorkflowSummary,
  WorkflowSupersession,
  WorkflowTaskInput,
  WorkflowTaskPlace,
  WorkflowViewLink,
  WorkflowViewTask,
} from '../../shared/types';
import { boardEnds, nextOnRoute, plannedRouteSteps, routeFromColumns, routeSteps, taskPlace } from '../../shared/workflow-route';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { DEFAULT_RUN_SETTINGS, hasRunSettings } from '../../shared/workflow-run-settings';
import { UNNAMED_BLOCKER_LABEL } from '../../shared/workflow-waiting';
import { canTaskRunAutomations } from '../../shared/automation-manifest';
import { getExistingProjectDb, getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskMoveRepository } from '../db/repositories/task-move-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import type { IpcContext } from '../ipc/ipc-context';
import { wouldCreateCycle } from './engine/workflow-engine-core';
import { notifyWorkflowChanged } from './workflow-changed';
import { isHumanGate } from './workflow-lock-check';
import { isInWorkflow } from './workflow-home';
import { workflowAgentSummary } from './workflow-agent';
import { linkEndState, readWorkflowTasks } from './workflow-tasks';
import { isNeverStarted } from './workflow-never-started';
import { adoptLegacyPlanApproval, readPlannedTaskPlanApproval, readTaskPlanApproval } from '../plan-approval/workflow-plan-approval';
import {
  MAX_WORKFLOW_TASKS,
  WorkflowRequestError,
  addWorkflowTask,
  createWorkflow,
  linkTasks,
  mergeRunSettings,
  parseRunSettingsInput,
  plannedPlanApproval,
  removeFromWorkflow,
  requireProfileOnBoard,
  requireWorkflow,
  resolveProjectId,
  runSettingsOf,
  safeLanes,
  setTaskRouteByIds,
  stallReader,
  unlinkTasks,
  workflowTasks,
} from './workflow-service';
import { setTaskPlanApproval } from './workflow-task-plan-approval';

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
  const workflow = adoptLegacyPlanApproval(context, homeProjectId, requireWorkflow(homeProjectId, workflowId));
  const projectNames: Record<string, string> = { [homeProjectId]: projectNameOf(context, homeProjectId) };
  // Each board's To Do and Done columns: the ends of its cards' tracks, and a Done card's color.
  const ends: Record<string, WorkflowBoardEnds> = { [homeProjectId]: boardEnds(safeLanes(homeProjectId)) };
  const noteProject = (projectId: string): void => {
    projectNames[projectId] ??= projectNameOf(context, projectId);
    if (!(projectId in ends)) ends[projectId] = boardEnds(safeLanes(projectId));
  };

  if (workflow.state === 'draft') {
    const draft = workflow.draft ?? { tasks: [], links: [] };
    const tasks = draft.tasks.map((planned): WorkflowViewTask => {
      const projectId = planned.project_id ?? homeProjectId;
      noteProject(projectId);
      const lanes = safeLanes(projectId);
      return {
        key: planned.key,
        projectId,
        task: null,
        planned,
        title: planned.title,
        displayId: null,
        place: 'planned',
        swimlaneId: null,
        steps: plannedSteps(lanes, planned),
        canvasX: planned.canvas_x,
        canvasY: planned.canvas_y,
        unnamedBlockerCount: 0,
        stallReason: null,
        planApproval: readPlannedTaskPlanApproval(context, homeProjectId, planned, workflow.plan_approval, lanes),
      };
    });
    const links = draft.links.map((link): WorkflowViewLink => ({ blockerKey: link.blocker, blockedKey: link.blocked }));
    return { workflow, homeProjectId, tasks, links, projectNames, boardEnds: ends };
  }

  const { tasks: created, unreadProjectIds } = readWorkflowTasks(context, homeProjectId, workflowId);
  const present = new Set(created.map(({ task }) => task.id));
  const linkRows = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflowId);
  // A blocker the read could not name, because its project would not open,
  // still holds its task, and the card says so. One that is provably gone is
  // skipped: the engine drops its link.
  const unnamedBlockers = new Map<string, number>();
  for (const link of linkRows) {
    if (present.has(link.blocker_task_id) || !present.has(link.blocked_task_id)) continue;
    const blocker = { projectId: link.blocker_project_id, taskId: link.blocker_task_id };
    if (linkEndState(context, blocker, workflowId, present, unreadProjectIds) !== 'held') continue;
    unnamedBlockers.set(link.blocked_task_id, (unnamedBlockers.get(link.blocked_task_id) ?? 0) + 1);
  }
  const stallOf = stallReader(workflow);
  const tasks = created.map(({ projectId, task }): WorkflowViewTask => {
    noteProject(projectId);
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
      unnamedBlockerCount: unnamedBlockers.get(task.id) ?? 0,
      stallReason: place === 'done' ? null : stallOf(projectId, task),
      planApproval: readTaskPlanApproval(context, projectId, task, workflow.plan_approval, lanes),
    };
  });
  // A link with an end the detail does not have has nothing to draw: it is
  // counted above when it still holds, and dropped by the engine when it is gone.
  const links = linkRows
    .filter((link) => present.has(link.blocker_task_id) && present.has(link.blocked_task_id))
    .map((link): WorkflowViewLink => ({ blockerKey: link.blocker_task_id, blockedKey: link.blocked_task_id }));
  return { workflow, homeProjectId, tasks, links, projectNames, boardEnds: ends };
}

/**
 * The picker's rows: every workflow of the project that has not finished,
 * newest first. A board asks for the homes its tasks name, and a home that is
 * gone lists none rather than having its database created again.
 */
export function listWorkflowSummaries(context: IpcContext, homeProjectId: string): WorkflowSummary[] {
  const homeDb = getExistingProjectDb(homeProjectId);
  if (!homeDb) return [];
  const workflows = new WorkflowRepository(homeDb).listOpen();
  return workflows.map((workflow) => summarize(context, homeProjectId, workflow));
}

/**
 * The tasks of the project a workflow replaced at Start, for the line under
 * their Done rows. Unlike the summaries, a finished workflow stays: that is
 * when most superseded tasks sit in Done. None for a project whose database
 * file is gone, as for the summaries.
 */
export function listWorkflowSupersessions(homeProjectId: string): WorkflowSupersession[] {
  const homeDb = getExistingProjectDb(homeProjectId);
  return homeDb ? new WorkflowRepository(homeDb).listSupersessions() : [];
}

function summarize(context: IpcContext, homeProjectId: string, workflow: Workflow): WorkflowSummary {
  if (workflow.state === 'draft') {
    return {
      workflow,
      taskCount: workflow.draft?.tasks.length ?? 0,
      doneCount: 0,
      inProgressCount: 0,
      queuedCount: 0,
      blockedCount: 0,
      neverStartedCount: 0,
      boardTasks: {},
      agent: workflowAgentSummary(context, workflow.id),
      stalledTasks: [],
    };
  }
  const { tasks: created, unreadProjectIds } = readWorkflowTasks(context, homeProjectId, workflow.id);
  // Each board's columns, read once: every task on it asks for them, twice for one in To Do.
  const lanesByProject = new Map<string, Swimlane[]>();
  const lanesOf = (projectId: string): Swimlane[] => {
    let lanes = lanesByProject.get(projectId);
    if (!lanes) {
      lanes = safeLanes(projectId);
      lanesByProject.set(projectId, lanes);
    }
    return lanes;
  };
  const places = new Map<string, Exclude<WorkflowTaskPlace, 'planned'>>();
  const displayIds = new Map<string, number>();
  for (const { projectId, task } of created) {
    places.set(task.id, taskPlace(lanesOf(projectId), task));
    displayIds.set(task.id, task.display_id);
  }
  const present = new Set(displayIds.keys());
  const links = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflow.id);
  const linked = new Set(links.flatMap((link) => [link.blocker_task_id, link.blocked_task_id]));
  let doneCount = 0;
  let inProgressCount = 0;
  let queuedCount = 0;
  let blockedCount = 0;
  let neverStartedCount = 0;
  const boardTasks: Record<string, WorkflowBoardTask> = {};
  const stallOf = stallReader(workflow);
  const stalledTasks: WorkflowSummary['stalledTasks'] = [];
  for (const { projectId, task } of created) {
    const place = places.get(task.id)!;
    let waitingFor: string[] = [];
    let humanGateTargetId: string | null = null;
    if (place === 'done') doneCount += 1;
    else if (place === 'working') {
      inProgressCount += 1;
      humanGateTargetId = humanGateExit(context, projectId, task, workflow);
    } else {
      // A blocker the read could not name, because its project would not open,
      // holds the task as the engine reads it. One that is provably gone does
      // not: the engine drops its link.
      waitingFor = links
        .filter((link) => link.blocked_task_id === task.id && places.get(link.blocker_task_id) !== 'done')
        .flatMap((link) => {
          const displayId = displayIds.get(link.blocker_task_id);
          if (displayId) return [`#${displayId}`];
          const blocker = { projectId: link.blocker_project_id, taskId: link.blocker_task_id };
          return linkEndState(context, blocker, workflow.id, present, unreadProjectIds) === 'held' ? [UNNAMED_BLOCKER_LABEL] : [];
        });
      if (waitingFor.length > 0) blockedCount += 1;
      else queuedCount += 1;
      if (isNeverStarted(projectId, task, lanesOf(projectId))) neverStartedCount += 1;
    }
    if (place !== 'done') {
      const stallReason = stallOf(projectId, task);
      if (stallReason !== null) stalledTasks.push({ taskId: task.id, displayId: task.display_id, reason: stallReason });
      boardTasks[task.id] = { waitingFor, humanGateTargetId, hasLinks: linked.has(task.id), stallReason };
    }
  }
  return {
    workflow,
    taskCount: places.size,
    doneCount,
    inProgressCount,
    queuedCount,
    blockedCount,
    neverStartedCount,
    boardTasks,
    agent: workflowAgentSummary(context, workflow.id),
    stalledTasks,
  };
}

/**
 * While the workflow runs: where a person may drag a task out of the human gate
 * it sits in. None for a task whose automations are paused, which a hand may
 * move anywhere but To Do, as a paused workflow's card.
 */
function humanGateExit(context: IpcContext, projectId: string, task: Task, workflow: Workflow): string | null {
  if (workflow.state !== 'running' || !canTaskRunAutomations(task).ok) return null;
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
  if (isInWorkflow(source, homeProjectId)) throw new WorkflowRequestError(`#${source.display_id} is already in a workflow.`);
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
  // What the form left out is the default: Column Settings on the board's base branch.
  const requestedSettings = parseRunSettingsInput(input);
  requireProfileOnBoard(context, projectId, requestedSettings.profile_id);
  const runSettings = mergeRunSettings(DEFAULT_RUN_SETTINGS, requestedSettings);

  if (workflow.state !== 'draft') {
    // A real task in To Do, on its own board, with the settings the form chose.
    const created = addWorkflowTask(context, homeProjectId, workflowId, {
      key: '',
      title,
      description: input.description ?? '',
      labels: input.labels ?? [],
      priority: input.priority ?? 0,
      project: projectId,
      runSettings,
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
      plan_approval: null,
      ...runSettings,
    });
  });
  return key;
}

/**
 * Edit a planned task (the Edit Task window before Start). A changed board
 * resets its route to every column there, and its base branch and profile,
 * which name the old board's, unless the same edit sets them.
 */
export function updatePlannedTask(context: IpcContext, homeProjectId: string, workflowId: string, key: string, input: Partial<WorkflowTaskInput>): void {
  const nextProjectId = input.projectId === undefined ? undefined : resolveProjectId(context, homeProjectId, input.projectId);
  const requestedSettings = parseRunSettingsInput(input);
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
    let current = runSettingsOf(planned);
    if (nextProjectId !== undefined) {
      const stored = nextProjectId === homeProjectId ? null : nextProjectId;
      if (stored !== planned.project_id) {
        if (planned.existing_task_id) throw new WorkflowRequestError('A task already on a board stays on its board.');
        planned.project_id = stored;
        planned.route_start_swimlane_id = null;
        planned.route_last_swimlane_id = null;
        planned.skipped_swimlane_ids = [];
        // Set against the old board's plan columns: it follows the new board's.
        planned.plan_approval = null;
        current = { ...current, base_branch: null, profile_id: null };
      }
    }
    const next = mergeRunSettings(current, requestedSettings);
    if (planned.existing_task_id && hasRunSettings(next)) {
      throw new WorkflowRequestError('A task taken in from its board keeps its own base branch, worktree and agent settings.');
    }
    requireProfileOnBoard(context, planned.project_id ?? homeProjectId, requestedSettings.profile_id);
    Object.assign(planned, next);
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

/** The task's Plan approval section: its own value, or null to follow its plan columns. */
export function setViewPlanApproval(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  key: string,
  planApproval: PlanApproval | null,
): void {
  const workflow = adoptLegacyPlanApproval(context, homeProjectId, requireWorkflow(homeProjectId, workflowId));
  requireViewMayChange(workflow);
  if (workflow.state === 'draft') {
    editDraft(homeProjectId, workflowId, (draft) => {
      const planned = requirePlanned(draft, key);
      planned.plan_approval = plannedPlanApproval(context, homeProjectId, planned, planApproval);
    });
    return;
  }
  const { projectId, task } = requireCreated(context, homeProjectId, workflowId, key);
  setTaskPlanApproval(context, homeProjectId, workflowId, { taskId: task.id, projectId }, planApproval);
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
