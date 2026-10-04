import type Database from 'better-sqlite3';
import type {
  Swimlane,
  Task,
  TaskLink,
  Workflow,
  WorkflowDraft,
  WorkflowDraftLink,
  WorkflowDraftTask,
} from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
import { routeCandidates, routeColumns, todoColumn, doneColumn } from '../../shared/workflow-route';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { getProjectDb } from '../db/database';
import { writeTransaction } from '../db/transaction';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import { SessionRepository } from '../db/repositories/session-repository';
import { resolveTask } from '../agent/commands/task-resolver';
import { handleTaskMove } from '../ipc/handlers/task-move';
import { pauseTaskSession } from '../ipc/handlers/session-pause';
import { resumeTaskSession } from '../ipc/handlers/session-resume';
import { sendToRenderer } from '../ipc/send-to-renderer';
import type { IpcContext } from '../ipc/ipc-context';
import { wouldCreateCycle } from './engine/workflow-engine-core';
import { wakeWorkflowEngine } from './workflow-wake';
import { notifyWorkflowChanged } from './workflow-changed';
import { endWorkflowAgent } from './workflow-agent';
import { workflowTasks } from './workflow-tasks';

/**
 * The operations on a workflow: everything an agent (over MCP) or the
 * Workflows view does to one. Each validates everything first and writes in
 * one transaction per database, so a refused call leaves nothing half done,
 * and each answers with a sentence an agent can act on (a refusal names what
 * to fix).
 *
 * A workflow lives in its HOME project's database with its links; its tasks
 * live on their own boards. Every operation takes the home project id and
 * resolves the rest.
 */

/** A refusal meant for the caller: its message says what to change. */
export class WorkflowRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRequestError';
  }
}

/**
 * The most tasks one workflow plans, a sanity bound, not a design limit. 100
 * is what the canvas is measured at (the drag-perf run at 30 and 100 cards).
 */
export const MAX_WORKFLOW_TASKS = 100;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface WorkflowTaskView {
  key: string;
  taskId: string | null;
  displayId: number | null;
  projectId: string;
  title: string;
  /** Where it is: a column name, or "To Do (not created yet)" for a planned task. */
  column: string;
  place: 'planned' | 'todo' | 'working' | 'done';
  /** The columns it visits, in order. */
  route: string[];
  /** Keys of the tasks it waits for. */
  waitsFor: string[];
}

export interface WorkflowView {
  workflow: Workflow;
  homeProjectId: string;
  tasks: WorkflowTaskView[];
}

function projectRepos(projectId: string): { db: Database.Database; tasks: TaskRepository; lanes: Swimlane[] } {
  const db = getProjectDb(projectId);
  return { db, tasks: new TaskRepository(db), lanes: new SwimlaneRepository(db).list() };
}

export function requireWorkflow(homeProjectId: string, workflowId: string): Workflow {
  const workflow = new WorkflowRepository(getProjectDb(homeProjectId)).getById(workflowId);
  if (!workflow) throw new WorkflowRequestError(`No workflow "${workflowId}" in this project. List them with kangentic_list_workflows.`);
  return workflow;
}

export { workflowTasks };

export function readWorkflow(context: IpcContext, homeProjectId: string, workflowId: string): WorkflowView {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  if (workflow.state === 'draft') {
    const draft = workflow.draft ?? { tasks: [], links: [] };
    const tasks = draft.tasks.map((planned): WorkflowTaskView => {
      const projectId = planned.project_id ?? homeProjectId;
      const lanes = safeLanes(projectId);
      return {
        key: planned.key,
        taskId: planned.existing_task_id,
        displayId: null,
        projectId,
        title: planned.title,
        column: 'To Do (created at Start)',
        place: 'planned',
        route: routeColumns(lanes, routeOfDraft(planned)).map((lane) => lane.name),
        waitsFor: draft.links.filter((link) => link.blocked === planned.key).map((link) => link.blocker),
      };
    });
    return { workflow, homeProjectId, tasks };
  }

  const created = workflowTasks(context, homeProjectId, workflowId);
  const links = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflowId);
  const keyOf = (taskId: string): string => {
    const entry = created.find((candidate) => candidate.task.id === taskId);
    return entry ? `#${entry.task.display_id}` : `(removed ${taskId.slice(0, 8)})`;
  };
  const tasks = created.map(({ projectId, task }): WorkflowTaskView => {
    const lanes = safeLanes(projectId);
    const lane = lanes.find((candidate) => candidate.id === task.swimlane_id);
    const place = task.archived_at || lane?.role === 'done' ? 'done' : lane?.role === 'todo' ? 'todo' : 'working';
    return {
      key: `#${task.display_id}`,
      taskId: task.id,
      displayId: task.display_id,
      projectId,
      title: task.title,
      column: lane?.name ?? 'an unknown column',
      place,
      route: routeColumns(lanes, task).map((candidate) => candidate.name),
      waitsFor: links.filter((link) => link.blocked_task_id === task.id).map((link) => keyOf(link.blocker_task_id)),
    };
  });
  return { workflow, homeProjectId, tasks };
}

export function safeLanes(projectId: string): Swimlane[] {
  try {
    return new SwimlaneRepository(getProjectDb(projectId)).list();
  } catch {
    return [];
  }
}

function routeOfDraft(planned: WorkflowDraftTask): Pick<Task, 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'> {
  return {
    route_start_swimlane_id: planned.route_start_swimlane_id,
    route_last_swimlane_id: planned.route_last_swimlane_id,
    skipped_swimlane_ids: planned.skipped_swimlane_ids,
  };
}

// ---------------------------------------------------------------------------
// Creating and planning
// ---------------------------------------------------------------------------

export function createWorkflow(
  homeProjectId: string,
  input: { title?: string | null; brief?: string | null; sourceTaskId?: string | null },
): Workflow {
  const created = new WorkflowRepository(getProjectDb(homeProjectId)).create(input);
  notifyWorkflowChanged(homeProjectId, created.id);
  return created;
}

/** One planned task as a caller writes it: columns and projects by NAME. */
export interface PlannedTaskInput {
  key: string;
  title: string;
  description?: string | null;
  /** A registered project's name or id; omitted is the workflow's home project. */
  project?: string | null;
  /** A board task to take in at Start (its number or id), instead of creating one. */
  existingTask?: string | null;
  /** The first column of its route (a name); omitted is the first after To Do. */
  routeStart?: string | null;
  /** The last column of its route (a name); omitted is the one before Done. */
  routeLast?: string | null;
  /** Columns inside the route to skip, by name. */
  skip?: string[] | null;
  labels?: string[] | null;
  priority?: number | null;
}

export interface PlanInput {
  title?: string | null;
  tasks: PlannedTaskInput[];
  /** "blocked waits for blocker", by key. */
  links: Array<{ blocker: string; blocked: string }>;
  /** The revision the caller read; a save over a newer one is refused. */
  revision?: number | null;
}

export function resolveProjectId(context: IpcContext, homeProjectId: string, selector: string | null | undefined): string {
  if (!selector || !selector.trim()) return homeProjectId;
  const wanted = selector.trim().toLowerCase();
  const project = context.projectRepo.list().find(
    (candidate) => candidate.id === selector.trim() || candidate.name.trim().toLowerCase() === wanted,
  );
  if (!project) {
    const names = context.projectRepo.list().map((candidate) => candidate.name).join(', ');
    throw new WorkflowRequestError(`No project named "${selector}". Projects: ${names}.`);
  }
  return project.id;
}

function routeColumnId(lanes: Swimlane[], name: string | null | undefined, field: string, taskLabel: string): string | null {
  if (!name || !name.trim()) return null;
  const candidates = routeCandidates(lanes);
  const wanted = name.trim().toLowerCase();
  const lane = candidates.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
  if (!lane) {
    throw new WorkflowRequestError(
      `${taskLabel}: ${field} "${name}" is not a column a route can use. Use one of: ${candidates.map((candidate) => candidate.name).join(', ')}.`,
    );
  }
  return lane.id;
}

/**
 * Validate and store a not-started workflow's plan, replacing what it held.
 * Every problem is found before anything is written.
 */
export function savePlan(context: IpcContext, homeProjectId: string, workflowId: string, input: PlanInput): Workflow {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  if (workflow.state !== 'draft') {
    throw new WorkflowRequestError(
      `"${workflow.title}" has started, so its plan is its tasks now. Change it with kangentic_add_workflow_task, kangentic_link_workflow_tasks, kangentic_set_task_route or kangentic_remove_from_workflow.`,
    );
  }
  if (input.revision != null && input.revision !== workflow.revision) {
    throw new WorkflowRequestError(
      `"${workflow.title}" changed since you read it (revision ${workflow.revision}, you sent ${input.revision}). Read it again with kangentic_get_workflow and apply your change to what is there now.`,
    );
  }
  if (!Array.isArray(input.tasks)) throw new WorkflowRequestError('tasks must be a list.');
  if (input.tasks.length > MAX_WORKFLOW_TASKS) {
    throw new WorkflowRequestError(`A workflow plans at most ${MAX_WORKFLOW_TASKS} tasks; this one has ${input.tasks.length}.`);
  }

  const keys = new Set<string>();
  const takenExisting = new Set<string>();
  const planned: WorkflowDraftTask[] = input.tasks.map((entry, index) => {
    const label = `Task ${index + 1}${typeof entry?.key === 'string' ? ` ("${entry.key}")` : ''}`;
    if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) throw new WorkflowRequestError(`${label} needs a key.`);
    const key = entry.key.trim();
    if (keys.has(key)) throw new WorkflowRequestError(`Two tasks share the key "${key}". Keys must be unique.`);
    keys.add(key);
    if (typeof entry.title !== 'string' || !entry.title.trim()) throw new WorkflowRequestError(`${label} needs a title.`);

    const projectId = resolveProjectId(context, homeProjectId, entry.project);
    const { tasks, lanes } = projectRepos(projectId);

    let existingTaskId: string | null = null;
    if (entry.existingTask) {
      const existing = resolveTask(tasks, String(entry.existingTask));
      if (!existing) throw new WorkflowRequestError(`${label}: no task "${entry.existingTask}" on that board.`);
      const lane = lanes.find((candidate) => candidate.id === existing.swimlane_id);
      if (lane?.role !== 'todo' || existing.archived_at) {
        throw new WorkflowRequestError(`${label}: #${existing.display_id} is in ${lane?.name ?? 'another column'}. Only a task in To Do can join a workflow.`);
      }
      if (existing.workflow_id) throw new WorkflowRequestError(`${label}: #${existing.display_id} is already in a workflow.`);
      if (takenExisting.has(existing.id)) throw new WorkflowRequestError(`${label}: #${existing.display_id} is in the plan twice.`);
      takenExisting.add(existing.id);
      existingTaskId = existing.id;
    }

    const routeStart = routeColumnId(lanes, entry.routeStart, 'routeStart', label);
    const routeLast = routeColumnId(lanes, entry.routeLast, 'routeLast', label);
    const skipped = (entry.skip ?? []).map((name) => routeColumnId(lanes, name, 'skip', label)!).filter(Boolean);
    const candidates = routeCandidates(lanes);
    if (routeStart && routeLast && candidates.findIndex((lane) => lane.id === routeStart) > candidates.findIndex((lane) => lane.id === routeLast)) {
      throw new WorkflowRequestError(`${label}: routeStart comes after routeLast on this board.`);
    }

    return {
      key,
      title: entry.title.trim(),
      description: typeof entry.description === 'string' ? entry.description : '',
      project_id: projectId === homeProjectId ? null : projectId,
      existing_task_id: existingTaskId,
      route_start_swimlane_id: routeStart,
      route_last_swimlane_id: routeLast,
      skipped_swimlane_ids: [...new Set(skipped)],
      labels: Array.isArray(entry.labels) ? entry.labels.filter((label_): label_ is string => typeof label_ === 'string') : [],
      priority: typeof entry.priority === 'number' ? entry.priority : 0,
      canvas_x: null,
      canvas_y: null,
    };
  });

  // Keep where a hand placed each card when the agent saves again.
  const previous = new Map((workflow.draft?.tasks ?? []).map((task) => [task.key, task]));
  for (const task of planned) {
    const before = previous.get(task.key);
    if (before) {
      task.canvas_x = before.canvas_x;
      task.canvas_y = before.canvas_y;
    }
  }

  if (!Array.isArray(input.links)) throw new WorkflowRequestError('links must be a list (an empty one for none).');
  const links: WorkflowDraftLink[] = [];
  for (const link of input.links) {
    if (!link || typeof link.blocker !== 'string' || typeof link.blocked !== 'string') {
      throw new WorkflowRequestError('Each link needs a blocker key and a blocked key.');
    }
    if (!keys.has(link.blocker)) throw new WorkflowRequestError(`A link names "${link.blocker}", which is not a task key in this plan.`);
    if (!keys.has(link.blocked)) throw new WorkflowRequestError(`A link names "${link.blocked}", which is not a task key in this plan.`);
    if (links.some((existing) => existing.blocker === link.blocker && existing.blocked === link.blocked)) continue;
    const asCore = links.map((existing) => ({ blockerTaskId: existing.blocker, blockedTaskId: existing.blocked }));
    if (wouldCreateCycle(asCore, link.blocker, link.blocked)) {
      throw new WorkflowRequestError(`Linking "${link.blocked}" to wait for "${link.blocker}" closes a loop. A workflow's links cannot go in a circle.`);
    }
    links.push({ blocker: link.blocker, blocked: link.blocked });
  }

  const draft: WorkflowDraft = { tasks: planned, links };
  const saved = new WorkflowRepository(getProjectDb(homeProjectId)).saveDraft(workflowId, draft, {
    title: input.title ?? null,
    expectedRevision: input.revision ?? null,
  });
  notifyWorkflowChanged(homeProjectId, workflowId);
  return saved;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export interface StartResult {
  workflow: Workflow;
  createdCount: number;
  linkCount: number;
  supersededSource: number | null;
}

/**
 * Start a planned workflow: create its tasks in To Do on their boards (or take
 * in the board tasks it named), write its links, and let the engine start what
 * has nothing to wait for. The task it was made from moves to Done.
 */
export async function startWorkflow(context: IpcContext, homeProjectId: string, workflowId: string): Promise<StartResult> {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  if (workflow.state !== 'draft') throw new WorkflowRequestError(`"${workflow.title}" has already started.`);
  const draft = workflow.draft ?? { tasks: [], links: [] };
  if (draft.tasks.length === 0) throw new WorkflowRequestError(`"${workflow.title}" has no tasks yet. Save a plan with kangentic_save_workflow first.`);

  // Re-check everything the plan assumed, now: a board task it takes in may
  // have moved since the plan was saved.
  const byProject = new Map<string, WorkflowDraftTask[]>();
  for (const planned of draft.tasks) {
    const projectId = planned.project_id ?? homeProjectId;
    const { tasks, lanes } = projectRepos(projectId);
    if (!todoColumn(lanes) || !doneColumn(lanes)) {
      throw new WorkflowRequestError(`"${planned.title}" goes on a board with no To Do or no Done column, which a workflow needs.`);
    }
    if (planned.existing_task_id) {
      const existing = tasks.getById(planned.existing_task_id);
      const lane = existing ? lanes.find((candidate) => candidate.id === existing.swimlane_id) : undefined;
      if (!existing || existing.archived_at || lane?.role !== 'todo' || existing.workflow_id) {
        throw new WorkflowRequestError(`"${planned.title}" takes in a board task that is no longer in To Do. Save the plan again without it.`);
      }
    }
    const group = byProject.get(projectId) ?? [];
    group.push(planned);
    byProject.set(projectId, group);
  }

  // Create, one transaction per board.
  const idByKey = new Map<string, { projectId: string; taskId: string }>();
  for (const [projectId, plannedTasks] of byProject) {
    const { db, tasks, lanes } = projectRepos(projectId);
    const todo = todoColumn(lanes)!;
    writeTransaction(db, () => {
      for (const planned of plannedTasks) {
        const membership = {
          workflow_id: workflow.id,
          workflow_project_id: homeProjectId,
          route_start_swimlane_id: planned.route_start_swimlane_id,
          route_last_swimlane_id: planned.route_last_swimlane_id,
          skipped_swimlane_ids: planned.skipped_swimlane_ids,
          canvas_x: planned.canvas_x,
          canvas_y: planned.canvas_y,
        };
        if (planned.existing_task_id) {
          tasks.setWorkflowMembership(planned.existing_task_id, membership);
          idByKey.set(planned.key, { projectId, taskId: planned.existing_task_id });
        } else {
          const created = tasks.create({
            title: planned.title,
            description: planned.description,
            swimlane_id: todo.id,
            labels: planned.labels,
            priority: planned.priority,
            workflow: membership,
          });
          idByKey.set(planned.key, { projectId, taskId: created.id });
        }
      }
    })();
  }

  // Links and the state, in the home database.
  const homeDb = getProjectDb(homeProjectId);
  const linkRepository = new TaskLinkRepository(homeDb);
  writeTransaction(homeDb, () => {
    for (const link of draft.links) {
      const blocker = idByKey.get(link.blocker);
      const blocked = idByKey.get(link.blocked);
      if (!blocker || !blocked) continue;
      linkRepository.insert({
        workflow_id: workflow.id,
        blocker_project_id: blocker.projectId,
        blocker_task_id: blocker.taskId,
        blocked_project_id: blocked.projectId,
        blocked_task_id: blocked.taskId,
      });
    }
    new WorkflowRepository(homeDb).markStarted(workflow.id);
  })();

  for (const projectId of byProject.keys()) announceBoardChange(context, projectId);

  // The task it was made from is superseded, unless the plan took it in.
  let supersededSource: number | null = null;
  const takenIn = new Set(draft.tasks.map((task) => task.existing_task_id).filter(Boolean));
  if (workflow.source_task_id && !takenIn.has(workflow.source_task_id)) {
    supersededSource = await supersedeSourceTask(context, homeProjectId, workflow);
  }

  wakeWorkflowEngine();
  notifyWorkflowChanged(homeProjectId, workflowId);
  return {
    workflow: requireWorkflow(homeProjectId, workflowId),
    createdCount: draft.tasks.filter((task) => !task.existing_task_id).length,
    linkCount: draft.links.length,
    supersededSource,
  };
}

async function supersedeSourceTask(context: IpcContext, homeProjectId: string, workflow: Workflow): Promise<number | null> {
  const { tasks, lanes } = projectRepos(homeProjectId);
  const source = workflow.source_task_id ? tasks.getById(workflow.source_task_id) : undefined;
  if (!source || source.archived_at) return null;
  // Only a source still in To Do: one that started meanwhile is real work.
  if (lanes.find((lane) => lane.id === source.swimlane_id)?.role !== 'todo') return null;
  const done = doneColumn(lanes);
  if (!done) return null;
  const projectPath = context.projectRepo.getById(homeProjectId)?.path ?? null;
  await handleTaskMove(
    context,
    { taskId: source.id, targetSwimlaneId: done.id, targetPosition: tasks.list(done.id).length },
    'workflow',
    homeProjectId,
    projectPath,
    { moveReason: `Superseded by ${workflow.title}` },
  );
  return source.display_id;
}

/**
 * Every board holding a task of the workflow hears that its cards changed,
 * for a change that writes no task row: a pause, a resume, a rename. Each card
 * carries its workflow's state and name (its lock, its strip), and a paired
 * phone redraws them only on a board event.
 */
function announceWorkflowBoards(context: IpcContext, homeProjectId: string, workflowId: string): void {
  const projects = new Set(workflowTasks(context, homeProjectId, workflowId).map(({ projectId }) => projectId));
  for (const projectId of projects) announceBoardChange(context, projectId);
}

/** A quiet board reload for a board whose tasks a workflow wrote. */
function announceBoardChange(context: IpcContext, projectId: string): void {
  try {
    context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [] });
  } catch {
    // Announcing is best effort.
  }
  sendToRenderer(context.mainWindow, IPC.TASK_MOVED_BY_AUTOMATION, projectId);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Pause every task's agent at once. Nothing starts or moves until Resume. */
export async function pauseWorkflow(context: IpcContext, homeProjectId: string, workflowId: string): Promise<{ workflow: Workflow; paused: number }> {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  if (workflow.state !== 'running') throw new WorkflowRequestError(`"${workflow.title}" is ${describeState(workflow)}, so there is nothing to pause.`);
  new WorkflowRepository(getProjectDb(homeProjectId)).setState(workflowId, 'paused');
  // The header flips to Resume at once; the sessions suspend after.
  notifyWorkflowChanged(homeProjectId, workflowId);
  announceWorkflowBoards(context, homeProjectId, workflowId);
  let paused = 0;
  for (const { projectId, task } of workflowTasks(context, homeProjectId, workflowId)) {
    if (!task.session_id) continue;
    try {
      if (await pauseTaskSession(context, task.id, { projectId }) === 'paused') paused += 1;
    } catch (error) {
      console.warn(`[WORKFLOW] Could not pause #${task.display_id}:`, error);
    }
  }
  return { workflow: requireWorkflow(homeProjectId, workflowId), paused };
}

/** Resume every paused task's agent, each in the column it is in. */
export async function resumeWorkflow(context: IpcContext, homeProjectId: string, workflowId: string): Promise<{ workflow: Workflow; resumed: number }> {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  if (workflow.state !== 'paused') throw new WorkflowRequestError(`"${workflow.title}" is ${describeState(workflow)}, not paused.`);
  new WorkflowRepository(getProjectDb(homeProjectId)).setState(workflowId, 'running');
  notifyWorkflowChanged(homeProjectId, workflowId);
  announceWorkflowBoards(context, homeProjectId, workflowId);
  let resumed = 0;
  for (const { projectId, task } of workflowTasks(context, homeProjectId, workflowId)) {
    if (task.archived_at) continue;
    const lane = safeLanes(projectId).find((candidate) => candidate.id === task.swimlane_id);
    // To Do waits for the engine; Done is finished; a column with no agent has none to resume.
    if (!lane || lane.role === 'todo' || lane.role === 'done' || !lane.auto_spawn) continue;
    const hasSuspended = new SessionRepository(getProjectDb(projectId)).getLatestForTask(task.id)?.status === 'suspended';
    if (!hasSuspended && !task.session_id) continue;
    try {
      await resumeTaskSession(context, task.id, { projectId });
      resumed += 1;
    } catch (error) {
      console.warn(`[WORKFLOW] Could not resume #${task.display_id}:`, error);
    }
  }
  // Resume is also the user's way to retry a start that keeps failing.
  wakeWorkflowEngine(workflowId);
  return { workflow: requireWorkflow(homeProjectId, workflowId), resumed };
}

function describeState(workflow: Workflow): string {
  switch (workflow.state) {
    case 'draft': return 'not started';
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'done': return 'complete';
  }
}

// ---------------------------------------------------------------------------
// Changing a started workflow
// ---------------------------------------------------------------------------

interface ResolvedWorkflowTask {
  projectId: string;
  task: Task;
  lanes: Swimlane[];
}

function resolveWorkflowTask(context: IpcContext, homeProjectId: string, workflow: Workflow, selector: string, project?: string | null): ResolvedWorkflowTask {
  const projectId = resolveProjectId(context, homeProjectId, project);
  const { tasks, lanes } = projectRepos(projectId);
  const task = resolveTask(tasks, selector);
  if (!task) throw new WorkflowRequestError(`No task "${selector}" on that board.`);
  if (task.workflow_id !== workflow.id) throw new WorkflowRequestError(`#${task.display_id} is not in "${workflow.title}".`);
  return { projectId, task, lanes };
}

function placeOf(resolved: ResolvedWorkflowTask): 'todo' | 'working' | 'done' {
  const lane = resolved.lanes.find((candidate) => candidate.id === resolved.task.swimlane_id);
  if (resolved.task.archived_at || lane?.role === 'done') return 'done';
  return lane?.role === 'todo' ? 'todo' : 'working';
}

function requireStarted(workflow: Workflow, action: string): void {
  if (workflow.state === 'draft') {
    throw new WorkflowRequestError(`"${workflow.title}" has not started. Change its plan with kangentic_save_workflow instead of ${action}.`);
  }
  if (workflow.state === 'done') throw new WorkflowRequestError(`"${workflow.title}" is complete.`);
}

/** Make `blocked` wait for `blocker`. Only a task in To Do can wait, and not on one already done. */
export function linkTasks(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: { blocker: string; blockerProject?: string | null; blocked: string; blockedProject?: string | null },
): TaskLink {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireStarted(workflow, 'linking tasks');
  const blocker = resolveWorkflowTask(context, homeProjectId, workflow, input.blocker, input.blockerProject);
  const blocked = resolveWorkflowTask(context, homeProjectId, workflow, input.blocked, input.blockedProject);
  if (blocker.task.id === blocked.task.id) throw new WorkflowRequestError(WORKFLOW_REFUSALS.selfLink);
  if (placeOf(blocked) !== 'todo') {
    throw new WorkflowRequestError(WORKFLOW_REFUSALS.cannotWait(`#${blocked.task.display_id}`));
  }
  if (placeOf(blocker) === 'done') {
    throw new WorkflowRequestError(WORKFLOW_REFUSALS.blockerDone(`#${blocker.task.display_id}`));
  }
  const repository = new TaskLinkRepository(getProjectDb(homeProjectId));
  const existing = repository.listForWorkflow(workflowId).map((link) => ({ blockerTaskId: link.blocker_task_id, blockedTaskId: link.blocked_task_id }));
  if (wouldCreateCycle(existing, blocker.task.id, blocked.task.id)) {
    throw new WorkflowRequestError(WORKFLOW_REFUSALS.loop);
  }
  const link = repository.insert({
    workflow_id: workflowId,
    blocker_project_id: blocker.projectId,
    blocker_task_id: blocker.task.id,
    blocked_project_id: blocked.projectId,
    blocked_task_id: blocked.task.id,
  });
  new WorkflowRepository(getProjectDb(homeProjectId)).bumpRevision(workflowId);
  announceBoardChange(context, blocked.projectId);
  notifyWorkflowChanged(homeProjectId, workflowId);
  return link;
}

/** Remove a link. A task in To Do whose last blocker this was starts as soon as a slot is free. */
export function unlinkTasks(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: { blocker: string; blockerProject?: string | null; blocked: string; blockedProject?: string | null },
): boolean {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireStarted(workflow, 'unlinking tasks');
  const blocker = resolveWorkflowTask(context, homeProjectId, workflow, input.blocker, input.blockerProject);
  const blocked = resolveWorkflowTask(context, homeProjectId, workflow, input.blocked, input.blockedProject);
  const removed = new TaskLinkRepository(getProjectDb(homeProjectId)).delete(blocker.task.id, blocked.task.id);
  if (removed) {
    new WorkflowRepository(getProjectDb(homeProjectId)).bumpRevision(workflowId);
    announceBoardChange(context, blocked.projectId);
    wakeWorkflowEngine();
    notifyWorkflowChanged(homeProjectId, workflowId);
  }
  return removed;
}

/**
 * Change a started task's route. A task still in To Do can take any route; a
 * started one can only change what is ahead of it: the column it is in, and
 * every one before it, stay as they are.
 */
export function setTaskRoute(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: { task: string; project?: string | null; routeStart?: string | null; routeLast?: string | null; skip?: string[] | null },
): Task {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireStarted(workflow, 'setting a route');
  const resolved = resolveWorkflowTask(context, homeProjectId, workflow, input.task, input.project);
  const label = `#${resolved.task.display_id}`;
  const lanes = resolved.lanes;
  const next = {
    route_start_swimlane_id: input.routeStart === undefined ? resolved.task.route_start_swimlane_id : routeColumnId(lanes, input.routeStart, 'routeStart', label),
    route_last_swimlane_id: input.routeLast === undefined ? resolved.task.route_last_swimlane_id : routeColumnId(lanes, input.routeLast, 'routeLast', label),
    skipped_swimlane_ids: input.skip === undefined || input.skip === null
      ? resolved.task.skipped_swimlane_ids
      : [...new Set(input.skip.map((name) => routeColumnId(lanes, name, 'skip', label)!).filter(Boolean))],
  };
  return applyTaskRoute(context, homeProjectId, workflowId, resolved, next);
}

/** A started task's route, by swimlane ids (the Workflows view). Same rules as `setTaskRoute`. */
export function setTaskRouteByIds(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: { taskId: string; projectId: string; route: Pick<Task, 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'> },
): Task {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireStarted(workflow, 'setting a route');
  const resolved = resolveWorkflowTask(context, homeProjectId, workflow, input.taskId, input.projectId);
  return applyTaskRoute(context, homeProjectId, workflowId, resolved, input.route);
}

function applyTaskRoute(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  resolved: ResolvedWorkflowTask,
  next: Pick<Task, 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'>,
): Task {
  const label = `#${resolved.task.display_id}`;
  const place = placeOf(resolved);
  if (place === 'done') throw new WorkflowRequestError(WORKFLOW_REFUSALS.doneStays(label));
  const lanes = resolved.lanes;

  if (place === 'working') {
    const current = lanes.find((lane) => lane.id === resolved.task.swimlane_id);
    const before = routeColumns(lanes, resolved.task).filter((lane) => current && lane.position <= current.position).map((lane) => lane.id);
    const after = routeColumns(lanes, next).filter((lane) => current && lane.position <= current.position).map((lane) => lane.id);
    if (before.join() !== after.join()) {
      throw new WorkflowRequestError(WORKFLOW_REFUSALS.stepReached(label, current?.name ?? 'its column'));
    }
    if (current && routeColumns(lanes, next).length > 0 && next.route_last_swimlane_id) {
      const last = lanes.find((lane) => lane.id === next.route_last_swimlane_id);
      if (last && last.position < current.position) {
        throw new WorkflowRequestError(`${label} is already past ${last.name}. Its route can only end at or after ${current.name}.`);
      }
    }
  }

  const tasks = new TaskRepository(getProjectDb(resolved.projectId));
  tasks.setRoute(resolved.task.id, next);
  new WorkflowRepository(getProjectDb(homeProjectId)).bumpRevision(workflowId);
  announceBoardChange(context, resolved.projectId);
  wakeWorkflowEngine();
  notifyWorkflowChanged(homeProjectId, workflowId);
  return tasks.getById(resolved.task.id)!;
}

/** Add a task to a started workflow. It lands in To Do, and starts when nothing it waits for is left. */
export function addWorkflowTask(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: PlannedTaskInput & { waitsFor?: string[] | null },
): Task {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  requireStarted(workflow, 'adding a task');
  if (typeof input.title !== 'string' || !input.title.trim()) throw new WorkflowRequestError('The task needs a title.');
  const projectId = resolveProjectId(context, homeProjectId, input.project);
  const { db, tasks, lanes } = projectRepos(projectId);
  const todo = todoColumn(lanes);
  if (!todo) throw new WorkflowRequestError('That board has no To Do column.');
  const label = `"${input.title.trim()}"`;
  const membership = {
    workflow_id: workflowId,
    workflow_project_id: homeProjectId,
    route_start_swimlane_id: routeColumnId(lanes, input.routeStart, 'routeStart', label),
    route_last_swimlane_id: routeColumnId(lanes, input.routeLast, 'routeLast', label),
    skipped_swimlane_ids: (input.skip ?? []).map((name) => routeColumnId(lanes, name, 'skip', label)!).filter(Boolean),
    canvas_x: null,
    canvas_y: null,
  };
  // Resolve the blockers before anything is written.
  const blockers = (input.waitsFor ?? []).map((selector) => resolveWorkflowTask(context, homeProjectId, workflow, selector));
  const created = writeTransaction(db, () => tasks.create({
    title: input.title.trim(),
    description: typeof input.description === 'string' ? input.description : '',
    swimlane_id: todo.id,
    labels: Array.isArray(input.labels) ? input.labels : [],
    priority: typeof input.priority === 'number' ? input.priority : 0,
    workflow: membership,
  }))();
  const linkRepository = new TaskLinkRepository(getProjectDb(homeProjectId));
  for (const blocker of blockers) {
    if (placeOf(blocker) === 'done') continue;
    linkRepository.insert({
      workflow_id: workflowId,
      blocker_project_id: blocker.projectId,
      blocker_task_id: blocker.task.id,
      blocked_project_id: projectId,
      blocked_task_id: created.id,
    });
  }
  new WorkflowRepository(getProjectDb(homeProjectId)).bumpRevision(workflowId);
  announceBoardChange(context, projectId);
  wakeWorkflowEngine();
  notifyWorkflowChanged(homeProjectId, workflowId);
  return created;
}

/** Take a task out of its workflow: it stays where it is, as an ordinary task, its links removed. */
export function removeFromWorkflow(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: { task: string; project?: string | null },
): Task {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  const resolved = resolveWorkflowTask(context, homeProjectId, workflow, input.task, input.project);
  if (placeOf(resolved) === 'done') {
    throw new WorkflowRequestError(WORKFLOW_REFUSALS.doneStays(`#${resolved.task.display_id}`));
  }
  const tasks = new TaskRepository(getProjectDb(resolved.projectId));
  tasks.setWorkflowMembership(resolved.task.id, null);
  new TaskLinkRepository(getProjectDb(homeProjectId)).deleteForTask(resolved.task.id);
  new WorkflowRepository(getProjectDb(homeProjectId)).bumpRevision(workflowId);
  announceBoardChange(context, resolved.projectId);
  wakeWorkflowEngine();
  notifyWorkflowChanged(homeProjectId, workflowId);
  return tasks.getById(resolved.task.id)!;
}

/**
 * Delete a workflow. Not started: its plan goes, and nothing else changes. Started:
 * its unfinished tasks stay where they are as ordinary tasks, and its tasks in
 * Done stay in Done.
 */
export function deleteWorkflow(context: IpcContext, homeProjectId: string, workflowId: string): { workflow: Workflow; released: number } {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  let released = 0;
  if (workflow.state !== 'draft') {
    for (const { projectId, task } of workflowTasks(context, homeProjectId, workflowId)) {
      const lanes = safeLanes(projectId);
      const lane = lanes.find((candidate) => candidate.id === task.swimlane_id);
      if (task.archived_at || lane?.role === 'done') continue;
      new TaskRepository(getProjectDb(projectId)).setWorkflowMembership(task.id, null);
      released += 1;
      announceBoardChange(context, projectId);
    }
  }
  new WorkflowRepository(getProjectDb(homeProjectId)).delete(workflowId);
  // Its agent's conversation goes with it, and so does its session.
  endWorkflowAgent(context, workflowId).catch((error: unknown) => {
    console.error(`[WORKFLOW] Could not end the agent of ${workflowId.slice(0, 8)}:`, error);
  });
  notifyWorkflowChanged(homeProjectId, workflowId);
  return { workflow, released };
}

export function renameWorkflow(context: IpcContext, homeProjectId: string, workflowId: string, title: string): Workflow {
  requireWorkflow(homeProjectId, workflowId);
  const renamed = new WorkflowRepository(getProjectDb(homeProjectId)).rename(workflowId, title);
  notifyWorkflowChanged(homeProjectId, workflowId);
  announceWorkflowBoards(context, homeProjectId, workflowId);
  return renamed;
}

/** Find a workflow by id or (case-insensitive) title in a home project. */
export function resolveWorkflow(homeProjectId: string, selector: string): Workflow {
  const repository = new WorkflowRepository(getProjectDb(homeProjectId));
  const byId = repository.getById(selector.trim());
  if (byId) return byId;
  const wanted = selector.trim().toLowerCase();
  const matches = repository.listAll().filter((workflow) => workflow.title.trim().toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new WorkflowRequestError(`More than one workflow is named "${selector}". Use its id.`);
  throw new WorkflowRequestError(`No workflow "${selector}" in this project. List them with kangentic_list_workflows.`);
}
