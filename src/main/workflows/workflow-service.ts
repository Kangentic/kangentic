import type Database from 'better-sqlite3';
import type {
  BoardProfile,
  PermissionMode,
  PlanApproval,
  Swimlane,
  Task,
  TaskCreateInput,
  TaskLink,
  TaskRunMode,
  Workflow,
  WorkflowDraft,
  WorkflowDraftLink,
  WorkflowDraftTask,
  WorkflowTaskRunSettings,
} from '../../shared/types';
import { routeCandidates, routeColumns, todoColumn, doneColumn } from '../../shared/workflow-route';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { DEFAULT_RUN_SETTINGS, PERMISSION_MODES, RUN_MODES, hasRunSettings, isPermissionMode, isRunMode } from '../../shared/workflow-run-settings';
import { isValidGitBranchName } from '../../shared/git-utils';
import { getExistingProjectDb, getProjectDb } from '../db/database';
import { writeTransaction } from '../db/transaction';
import { TaskRepository, applyProfileExclusivity } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SUPERSEDED_MOVE_REASON_PREFIX, WorkflowRepository } from '../db/repositories/workflow-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import { SessionRepository } from '../db/repositories/session-repository';
import { resolveTask } from '../agent/commands/task-resolver';
import { findProfile } from '../agent/commands/profile-commands';
import { agentRegistry } from '../agent/agent-registry';
import { validateSpawnOverrides } from '../agent/mcp-http/spawn-override-validation';
import { handleTaskMove } from '../ipc/handlers/task-move';
import { pauseTaskSession } from '../ipc/handlers/session-pause';
import { resumeTaskSession } from '../ipc/handlers/session-resume';
import type { IpcContext } from '../ipc/ipc-context';
import { wouldCreateCycle } from './engine/workflow-engine-core';
import { MAX_WORKFLOW_TASKS } from './workflow-limits';
import { wakeWorkflowEngine } from './workflow-wake';
import { notifyWorkflowChanged } from './workflow-changed';
import { announceBoardChange } from './workflow-board-announce';
import { endWorkflowAgent } from './workflow-agent';
import { linkEndState, readWorkflowTasks, workflowTasks } from './workflow-tasks';
import { isInWorkflow } from './workflow-home';

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

export { MAX_WORKFLOW_TASKS };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface WorkflowTaskView {
  key: string;
  taskId: string | null;
  displayId: number | null;
  projectId: string;
  /**
   * Its board's project name when that is not the workflow's own project, else
   * null. Task numbers count per board, so two boards can each have a #7.
   */
  board: string | null;
  title: string;
  /** Where it is: a column name, or "To Do (not created yet)" for a planned task. */
  column: string;
  place: 'planned' | 'todo' | 'working' | 'done';
  /** The columns it visits, in order. */
  route: string[];
  /** Keys of the tasks it waits for. */
  waitsFor: string[];
  /** How it runs: the planned task's settings before Start, the task row's after. */
  runSettings: WorkflowTaskRunSettings;
  /** The name of its Board Profile on its board, when it rides one that still exists. */
  profileName: string | null;
}

export interface WorkflowView {
  workflow: Workflow;
  homeProjectId: string;
  tasks: WorkflowTaskView[];
}

/**
 * A board's database, tasks and columns. The id can come from a plan, which
 * outlives a board that is deleted later, so the read never creates the
 * database again; Start refuses such a board by name before it gets here.
 */
function projectRepos(projectId: string): { db: Database.Database; tasks: TaskRepository; lanes: Swimlane[] } {
  const db = getExistingProjectDb(projectId);
  if (!db) throw new WorkflowRequestError('That board is no longer in Kangentic.');
  return { db, tasks: new TaskRepository(db), lanes: new SwimlaneRepository(db).list() };
}

/** A workflow in its home. A home that is gone has none, and its database is not created again. */
export function requireWorkflow(homeProjectId: string, workflowId: string): Workflow {
  const homeDb = getExistingProjectDb(homeProjectId);
  const workflow = homeDb ? new WorkflowRepository(homeDb).getById(workflowId) : undefined;
  if (!workflow) throw new WorkflowRequestError(`${WORKFLOW_REFUSALS.notFound(workflowId)} List them with kangentic_list_workflows.`);
  return workflow;
}

export { workflowTasks };

export function readWorkflow(context: IpcContext, homeProjectId: string, workflowId: string): WorkflowView {
  const workflow = requireWorkflow(homeProjectId, workflowId);
  // Asked once per task and once per link, of a few boards: each board's name
  // is read from the projects table once.
  const boardNames = new Map<string, string>();
  const boardOf = (projectId: string): string | null => {
    if (projectId === homeProjectId) return null;
    let name = boardNames.get(projectId);
    if (name === undefined) {
      name = context.projectRepo.getById(projectId)?.name ?? projectId;
      boardNames.set(projectId, name);
    }
    return name;
  };
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
        board: boardOf(projectId),
        title: planned.title,
        column: 'To Do (created at Start)',
        place: 'planned',
        route: routeColumns(lanes, routeOfDraft(planned)).map((lane) => lane.name),
        waitsFor: draft.links.filter((link) => link.blocked === planned.key).map((link) => link.blocker),
        runSettings: runSettingsOf(planned),
        profileName: profileNameOn(context, projectId, planned.profile_id),
      };
    });
    return { workflow, homeProjectId, tasks };
  }

  const { tasks: created, unreadProjectIds } = readWorkflowTasks(context, homeProjectId, workflowId);
  const present = new Set(created.map(({ task }) => task.id));
  const links = new TaskLinkRepository(getProjectDb(homeProjectId)).listForWorkflow(workflowId);
  // A blocker on another board is named with its board, since its number alone
  // can match a task on this one. One the read could not find is named by its
  // board when it still holds (its project would not open), and left out when
  // it is provably gone, since the engine drops that link.
  const blockerKeys = (link: TaskLink): string[] => {
    const entry = created.find((candidate) => candidate.task.id === link.blocker_task_id);
    if (entry) {
      const board = boardOf(entry.projectId);
      return [board === null ? `#${entry.task.display_id}` : `#${entry.task.display_id} on "${board}"`];
    }
    const blocker = { projectId: link.blocker_project_id, taskId: link.blocker_task_id };
    if (linkEndState(context, blocker, workflowId, present, unreadProjectIds) === 'gone') return [];
    return [`a task on "${boardOf(link.blocker_project_id) ?? 'this board'}" that could not be read`];
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
      board: boardOf(projectId),
      title: task.title,
      column: lane?.name ?? 'an unknown column',
      place,
      route: routeColumns(lanes, task).map((candidate) => candidate.name),
      waitsFor: links.filter((link) => link.blocked_task_id === task.id).flatMap(blockerKeys),
      runSettings: runSettingsOf(task),
      profileName: profileNameOn(context, projectId, task.profile_id),
    };
  });
  return { workflow, homeProjectId, tasks };
}

/** The run settings of a planned task or a task row, and nothing else of it. */
export function runSettingsOf(source: WorkflowTaskRunSettings): WorkflowTaskRunSettings {
  return {
    base_branch: source.base_branch,
    use_worktree: source.use_worktree,
    run_mode: source.run_mode,
    profile_id: source.profile_id,
    agent_override: source.agent_override,
    model_override: source.model_override,
    effort_override: source.effort_override,
    permission_mode: source.permission_mode,
  };
}

/** A board's Board Profiles, or none when its project or config cannot be read. */
function boardProfilesOf(context: IpcContext, projectId: string): BoardProfile[] {
  try {
    const projectPath = context.projectRepo.getById(projectId)?.path;
    return projectPath ? context.boardConfigManager.getBoardProfiles(projectPath) : [];
  } catch {
    return [];
  }
}

function profileNameOn(context: IpcContext, projectId: string, profileId: string | null): string | null {
  if (!profileId) return null;
  return boardProfilesOf(context, projectId).find((profile) => profile.id === profileId)?.name ?? null;
}

/** A board's columns, or none when its database cannot be read or its project is gone. */
export function safeLanes(projectId: string): Swimlane[] {
  try {
    const db = getExistingProjectDb(projectId);
    return db ? new SwimlaneRepository(db).list() : [];
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
  /** The branch its worktree is cut from; omitted is the board's base branch. */
  baseBranch?: string | null;
  /** Worktree (true) or the project folder (false); omitted is the project's setting. */
  useWorktree?: boolean | null;
  /** Column Settings (the default) or Agent Override. A pin below implies Agent Override. */
  runMode?: TaskRunMode | null;
  /** A Board Profile on its board, by name or id; Column Settings only. */
  profile?: string | null;
  agentOverride?: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
  permissionMode?: PermissionMode | null;
}

export interface PlanInput {
  title?: string | null;
  tasks: PlannedTaskInput[];
  /** "blocked waits for blocker", by key. */
  links: Array<{ blocker: string; blocked: string }>;
  /** The revision the caller read; a save over a newer one is refused. */
  revision?: number | null;
  /**
   * Who approves plans for the workflow's tasks. Undefined leaves it as it is;
   * null makes it follow the plan columns again. Changes no plan, so it moves no
   * revision beyond the save's own.
   */
  planApproval?: PlanApproval | null;
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
 * Refuse a route that starts after it ends. An empty route sends a task
 * straight to Done when its blockers clear, with no agent having worked it,
 * so every writer of a route checks this, not only the plan.
 */
function refuseReversedRoute(lanes: Swimlane[], routeStart: string | null, routeLast: string | null, taskLabel: string): void {
  if (!routeStart || !routeLast) return;
  const candidates = routeCandidates(lanes);
  if (candidates.findIndex((lane) => lane.id === routeStart) > candidates.findIndex((lane) => lane.id === routeLast)) {
    throw new WorkflowRequestError(`${taskLabel}: routeStart comes after routeLast on this board.`);
  }
}

/** The text labels of an agent's input, dropping anything that is not text. */
function textLabels(labels: unknown): string[] {
  return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string') : [];
}

// ---------------------------------------------------------------------------
// A planned task's run settings
// ---------------------------------------------------------------------------

/**
 * Lay requested run settings over current ones by the task row's own rule
 * (`applyProfileExclusivity`): a profile clears the four pins and means Column
 * Settings, a pin or Agent Override clears the profile, and Column Settings
 * clears the pins. `requested` holds only what the caller set.
 */
export function mergeRunSettings(current: WorkflowTaskRunSettings, requested: Partial<WorkflowTaskRunSettings>): WorkflowTaskRunSettings {
  const next: WorkflowTaskRunSettings = { ...current, ...requested };
  return { ...next, ...applyProfileExclusivity(next, requested) };
}

/** Run settings as `TaskRepository.create` takes them, so a created task carries exactly what was planned. */
export function runSettingsCreateInput(
  settings: WorkflowTaskRunSettings,
): Pick<TaskCreateInput, 'baseBranch' | 'useWorktree' | 'run_mode' | 'profile_id' | 'agent_override' | 'model_override' | 'effort_override' | 'permission_mode'> {
  return {
    // Absent, not empty: no base branch is the board's, which the task row stores as null.
    ...(settings.base_branch ? { baseBranch: settings.base_branch } : {}),
    useWorktree: settings.use_worktree === null ? null : settings.use_worktree === 1,
    run_mode: settings.run_mode,
    profile_id: settings.profile_id,
    agent_override: settings.agent_override,
    model_override: settings.model_override,
    effort_override: settings.effort_override,
    permission_mode: settings.permission_mode,
  };
}

/** A text setting as stored: trimmed, and blank is unset. */
function settingText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireRegisteredAgent(agent: string | null, prefix: string): void {
  if (agent && !agentRegistry.has(agent)) {
    throw new WorkflowRequestError(`${prefix}agentOverride "${agent}" is not a registered agent. Valid values: ${agentRegistry.list().join(', ')}.`);
  }
}

function requireBranchName(branch: string | null, prefix: string): void {
  if (branch && !isValidGitBranchName(branch)) {
    throw new WorkflowRequestError(`${prefix}baseBranch "${branch}" is not a valid git branch name.`);
  }
}

/** A Board Profile on the task's own board, by name or id, else a refusal that names that board's profiles. */
function resolvePlannedProfile(context: IpcContext, projectId: string, selector: string, prefix: string): string {
  const profiles = boardProfilesOf(context, projectId);
  const match = findProfile(profiles, selector);
  if (match) return match.id;
  const names = profiles.map((profile) => profile.name).join(', ') || '(none defined)';
  throw new WorkflowRequestError(
    `${prefix}no Board Profile matches "${selector}" on that task's board. Its profiles: ${names}. Omit profile to use Default (every column uses its own settings).`,
  );
}

/**
 * A planned task's run settings from an agent's save: checked, its profile
 * found on the task's own board, and laid over the defaults, so what was left
 * out is Column Settings on the board's base branch. Model and effort are
 * checked against the agent's CLI by the command handler, which can wait for it.
 */
function resolvePlannedRunSettings(context: IpcContext, projectId: string, entry: PlannedTaskInput, prefix: string): WorkflowTaskRunSettings {
  const agentOverride = settingText(entry.agentOverride);
  const modelOverride = settingText(entry.modelOverride);
  const effortOverride = settingText(entry.effortOverride);
  const permissionMode = entry.permissionMode ?? null;
  const profileSelector = settingText(entry.profile);
  const runMode = entry.runMode ?? null;
  if (runMode !== null && !isRunMode(runMode)) {
    throw new WorkflowRequestError(`${prefix}runMode "${String(runMode)}" is not valid. Valid values: ${RUN_MODES.join(', ')}.`);
  }
  if (permissionMode !== null && !isPermissionMode(permissionMode)) {
    throw new WorkflowRequestError(`${prefix}permissionMode "${String(permissionMode)}" is not valid. Valid values: ${PERMISSION_MODES.join(', ')}.`);
  }
  const pinned = agentOverride !== null || modelOverride !== null || effortOverride !== null || permissionMode !== null;
  // Refused rather than resolved, as kangentic_create_task refuses them: the
  // exclusivity rule would quietly keep one half of what was asked for.
  if (profileSelector && (pinned || runMode === 'agent_override')) {
    throw new WorkflowRequestError(
      `${prefix}pass either profile (Column Settings, which change per column as the task moves) or the agentOverride, modelOverride, effortOverride and permissionMode pins (Agent Override, one set for the whole task), not both.`,
    );
  }
  if (runMode === 'column_settings' && pinned) {
    throw new WorkflowRequestError(
      `${prefix}the agentOverride, modelOverride, effortOverride and permissionMode pins mean runMode "agent_override". Drop runMode "column_settings", or drop the pins.`,
    );
  }
  requireRegisteredAgent(agentOverride, prefix);
  const baseBranch = settingText(entry.baseBranch);
  requireBranchName(baseBranch, prefix);
  const requested: Partial<WorkflowTaskRunSettings> = {
    base_branch: baseBranch,
    use_worktree: entry.useWorktree === true ? 1 : entry.useWorktree === false ? 0 : null,
    profile_id: profileSelector ? resolvePlannedProfile(context, projectId, profileSelector, prefix) : null,
    agent_override: agentOverride,
    model_override: modelOverride,
    effort_override: effortOverride,
    permission_mode: permissionMode,
  };
  if (runMode !== null) requested.run_mode = runMode;
  return mergeRunSettings(DEFAULT_RUN_SETTINGS, requested);
}

type RunSettingsTextField = 'base_branch' | 'profile_id' | 'agent_override' | 'model_override' | 'effort_override';
const RUN_SETTINGS_TEXT_FIELDS: readonly RunSettingsTextField[] = ['base_branch', 'profile_id', 'agent_override', 'model_override', 'effort_override'];

/**
 * The run settings a Workflows view edit sets (`WorkflowTaskInput`), checked,
 * since a type is not a guarantee over IPC. Only the fields present come back,
 * so an edit that leaves one out leaves it as it is.
 */
export function parseRunSettingsInput(input: Readonly<Partial<Record<keyof WorkflowTaskRunSettings, unknown>>>): Partial<WorkflowTaskRunSettings> {
  const parsed: Partial<WorkflowTaskRunSettings> = {};
  for (const field of RUN_SETTINGS_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') throw new WorkflowRequestError(`${field} must be text.`);
    parsed[field] = settingText(value);
  }
  const useWorktree = input.use_worktree;
  if (useWorktree !== undefined) {
    if (useWorktree !== null && useWorktree !== 0 && useWorktree !== 1) throw new WorkflowRequestError('use_worktree must be 1, 0 or null.');
    parsed.use_worktree = useWorktree === 1 ? 1 : useWorktree === 0 ? 0 : null;
  }
  if (input.run_mode !== undefined) {
    if (!isRunMode(input.run_mode)) throw new WorkflowRequestError(`run_mode must be one of: ${RUN_MODES.join(', ')}.`);
    parsed.run_mode = input.run_mode;
  }
  if (input.permission_mode !== undefined) {
    if (input.permission_mode !== null && !isPermissionMode(input.permission_mode)) {
      throw new WorkflowRequestError(`permission_mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
    }
    parsed.permission_mode = isPermissionMode(input.permission_mode) ? input.permission_mode : null;
  }
  requireRegisteredAgent(parsed.agent_override ?? null, '');
  requireBranchName(parsed.base_branch ?? null, '');
  return parsed;
}

/**
 * Check each planned task's model and effort against what its agent's CLI
 * offers, as `kangentic_create_task` does, so a typo is refused at the save
 * rather than failing when the task first runs. The agent is the task's
 * override, else its To Do column's, else its project's default. An agent that
 * lists nothing, or a probe that does not answer in time, accepts the value.
 */
export async function checkPlannedModels(context: IpcContext, homeProjectId: string, tasks: readonly PlannedTaskInput[]): Promise<void> {
  for (const [index, entry] of tasks.entries()) {
    await checkPlannedModel(context, homeProjectId, entry, `Task ${index + 1}${entry.key ? ` ("${entry.key}")` : ''}`);
  }
}

/** One task's model and effort, checked as `checkPlannedModels` checks each; a refusal starts with `label`. */
export async function checkPlannedModel(context: IpcContext, homeProjectId: string, entry: PlannedTaskInput, label: string): Promise<void> {
  const modelOverride = settingText(entry.modelOverride);
  const effortOverride = settingText(entry.effortOverride);
  if (!modelOverride && !effortOverride) return;
  const projectId = resolveProjectId(context, homeProjectId, entry.project);
  let cliPathOverrides: Record<string, string | null | undefined> = {};
  let discoveredModelsByAgent: Record<string, string[]> = {};
  try {
    const config = context.configManager.load();
    cliPathOverrides = config.agent?.cliPaths ?? {};
    discoveredModelsByAgent = config.discoveredModelsByAgent ?? {};
  } catch {
    // An unreadable config checks against the default CLI paths.
  }
  const rejection = await validateSpawnOverrides({
    agentOverride: settingText(entry.agentOverride),
    modelOverride,
    effortOverride,
    laneAgentOverride: todoColumn(safeLanes(projectId))?.agent_override ?? null,
    projectDefaultAgent: context.projectRepo.getById(projectId)?.default_agent ?? null,
    cliPathOverrides,
    discoveredModelsByAgent,
  });
  if (rejection) throw new WorkflowRequestError(`${label}: ${rejection}`);
}

/** A profile the view set must be on the task's own board: one from another board would silently run Default. */
export function requireProfileOnBoard(context: IpcContext, projectId: string, profileId: string | null | undefined): void {
  if (!profileId) return;
  if (boardProfilesOf(context, projectId).some((profile) => profile.id === profileId)) return;
  const name = context.projectRepo.getById(projectId)?.name ?? 'that';
  throw new WorkflowRequestError(`That profile is not on the ${name} board. Choose one of its profiles, or Default.`);
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
  const draft = validatePlan(context, homeProjectId, workflow.draft, input);
  const db = getProjectDb(homeProjectId);
  const repository = new WorkflowRepository(db);
  const saved = writeTransaction(db, () => {
    // Before the draft, whose write reads the row back for the caller.
    if (input.planApproval !== undefined) repository.setPlanApproval(workflowId, input.planApproval);
    return repository.saveDraft(workflowId, draft, {
      title: input.title ?? null,
      expectedRevision: input.revision ?? null,
    });
  })();
  notifyWorkflowChanged(homeProjectId, workflowId);
  return saved;
}

/**
 * A new workflow and its first plan, for `kangentic_save_workflow` without a
 * `workflow`. The plan is checked before the workflow exists, and the two are
 * written in one transaction, so a refused save leaves no empty workflow
 * behind for the user to find in the picker.
 */
export function createWorkflowWithPlan(
  context: IpcContext,
  homeProjectId: string,
  workflowInput: { brief?: string | null },
  input: PlanInput,
): Workflow {
  const draft = validatePlan(context, homeProjectId, null, input);
  const db = getProjectDb(homeProjectId);
  const repository = new WorkflowRepository(db);
  const saved = writeTransaction(db, () => {
    const created = repository.create({ title: input.title ?? null, brief: workflowInput.brief ?? null });
    if (input.planApproval !== undefined) repository.setPlanApproval(created.id, input.planApproval);
    return repository.saveDraft(created.id, draft, { title: input.title ?? null });
  })();
  notifyWorkflowChanged(homeProjectId, saved.id);
  return saved;
}

/**
 * A plan as a draft, checked: the planned tasks with their boards, routes and
 * run settings resolved, and the links. Writes nothing. `previous` is the
 * draft it replaces, whose hand-placed card positions carry over.
 */
function validatePlan(context: IpcContext, homeProjectId: string, previous: WorkflowDraft | null, input: PlanInput): WorkflowDraft {
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
      if (isInWorkflow(existing, projectId)) throw new WorkflowRequestError(`${label}: #${existing.display_id} is already in a workflow.`);
      if (takenExisting.has(existing.id)) throw new WorkflowRequestError(`${label}: #${existing.display_id} is in the plan twice.`);
      takenExisting.add(existing.id);
      existingTaskId = existing.id;
    }

    const routeStart = routeColumnId(lanes, entry.routeStart, 'routeStart', label);
    const routeLast = routeColumnId(lanes, entry.routeLast, 'routeLast', label);
    const skipped = (entry.skip ?? []).map((name) => routeColumnId(lanes, name, 'skip', label)!).filter(Boolean);
    refuseReversedRoute(lanes, routeStart, routeLast, label);

    const runSettings = resolvePlannedRunSettings(context, projectId, entry, `${label}: `);
    // A task taken in keeps the settings it has on its board; Start only adds it to the workflow.
    if (existingTaskId && hasRunSettings(runSettings)) {
      throw new WorkflowRequestError(
        `${label}: a task taken in with existingTask keeps its own base branch, worktree and agent settings. Drop baseBranch, useWorktree, runMode, profile and the overrides from it.`,
      );
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
      labels: textLabels(entry.labels),
      priority: typeof entry.priority === 'number' ? entry.priority : 0,
      canvas_x: null,
      canvas_y: null,
      ...runSettings,
    };
  });

  // Keep where a hand placed each card when the agent saves again.
  const previousByKey = new Map((previous?.tasks ?? []).map((task) => [task.key, task]));
  for (const task of planned) {
    const before = previousByKey.get(task.key);
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

  return { tasks: planned, links };
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
    // A plan outlives a board deleted after it was saved. Checked against the
    // registry, not the file, so a file a failed delete left behind gets no tasks.
    if (!context.projectRepo.getById(projectId)) {
      throw new WorkflowRequestError(`"${planned.title}" goes on a board that is no longer in Kangentic. Save the plan again without it.`);
    }
    const { tasks, lanes } = projectRepos(projectId);
    if (!todoColumn(lanes) || !doneColumn(lanes)) {
      throw new WorkflowRequestError(`"${planned.title}" goes on a board with no To Do or no Done column, which a workflow needs.`);
    }
    if (planned.existing_task_id) {
      const existing = tasks.getById(planned.existing_task_id);
      const lane = existing ? lanes.find((candidate) => candidate.id === existing.swimlane_id) : undefined;
      if (!existing || existing.archived_at || lane?.role !== 'todo' || isInWorkflow(existing, projectId)) {
        throw new WorkflowRequestError(`"${planned.title}" takes in a board task that is no longer in To Do. Save the plan again without it.`);
      }
    }
    const group = byProject.get(projectId) ?? [];
    group.push(planned);
    byProject.set(projectId, group);
  }

  // Create, one transaction per board. Start is not one transaction: a board's
  // tasks and the home database's links and state are separate files, which no
  // single transaction spans. A write that fails after an earlier board
  // committed (a later board, or the home write) undoes what those boards
  // hold, so the workflow stays a draft that a retry of Start can start: a
  // taken-in task still a member would fail the re-check above, and a created
  // one would be created twice. Every write is local SQLite and the re-checks
  // have run, so getting here needs a disk failure.
  const idByKey = new Map<string, { projectId: string; taskId: string }>();
  const committed: StartBoardWrite[] = [];
  try {
    for (const [projectId, plannedTasks] of byProject) {
      const { db, tasks, lanes } = projectRepos(projectId);
      const todo = todoColumn(lanes)!;
      const written: StartBoardWrite = { projectId, createdTaskIds: [], takenInTaskIds: [] };
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
            written.takenInTaskIds.push(planned.existing_task_id);
          } else {
            const created = tasks.create({
              title: planned.title,
              description: planned.description,
              swimlane_id: todo.id,
              labels: planned.labels,
              priority: planned.priority,
              // Base branch, Worktree or Project, and Column Settings or Agent Override, as planned.
              ...runSettingsCreateInput(planned),
              workflow: membership,
            });
            idByKey.set(planned.key, { projectId, taskId: created.id });
            written.createdTaskIds.push(created.id);
          }
        }
      })();
      // Only once the board's transaction has committed: one that threw rolled itself back.
      committed.push(written);
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
  } catch (error) {
    undoStartWrites(committed);
    throw error;
  }

  for (const projectId of byProject.keys()) announceBoardChange(context, projectId);

  // The task it was made from is superseded, unless the plan took it in. The
  // workflow has started by now, so a failed supersede leaves the source in To
  // Do and never fails Start: the engine still has to wake for the new tasks.
  let supersededSource: number | null = null;
  const takenIn = new Set(draft.tasks.map((task) => task.existing_task_id).filter(Boolean));
  if (workflow.source_task_id && !takenIn.has(workflow.source_task_id)) {
    try {
      supersededSource = await supersedeSourceTask(context, homeProjectId, workflow);
    } catch (error) {
      console.error(`[WORKFLOW] Started ${workflowId.slice(0, 8)}, but could not move its source task to Done:`, error);
    }
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

/** What Start wrote to one board, committed. */
interface StartBoardWrite {
  projectId: string;
  createdTaskIds: string[];
  takenInTaskIds: string[];
}

/**
 * Take back what a Start that failed part way had committed to its boards:
 * the tasks it created are deleted, and the board tasks it took in leave the
 * workflow. Best effort, and it never throws: the failure that got here may be
 * the disk under one of these boards too, and that error is the one to report.
 */
function undoStartWrites(committed: ReadonlyArray<StartBoardWrite>): void {
  for (const { projectId, createdTaskIds, takenInTaskIds } of committed) {
    try {
      const { db, tasks } = projectRepos(projectId);
      writeTransaction(db, () => {
        for (const taskId of takenInTaskIds) tasks.setWorkflowMembership(taskId, null);
      })();
      for (const taskId of createdTaskIds) tasks.delete(taskId);
    } catch (undoError) {
      console.error(`[WORKFLOW] Could not undo a failed Start on project ${projectId.slice(0, 8)}:`, undoError);
    }
  }
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
    // The Done row's "Superseded by" line finds this move by its prefix
    // (`WorkflowRepository.listSupersessions`).
    { moveReason: `${SUPERSEDED_MOVE_REASON_PREFIX}${workflow.title}` },
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

/**
 * A task a new one waits for: a task id of the workflow's on any of its boards,
 * else a number or id on the home board. A number alone cannot name a task on
 * another board, since numbers count per board; its id can.
 */
function resolveBlocker(context: IpcContext, homeProjectId: string, workflow: Workflow, selector: string): ResolvedWorkflowTask {
  const member = workflowTasks(context, homeProjectId, workflow.id).find((entry) => entry.task.id === selector);
  if (!member) return resolveWorkflowTask(context, homeProjectId, workflow, selector);
  return { projectId: member.projectId, task: member.task, lanes: projectRepos(member.projectId).lanes };
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
  // Checked on the merged route: changing one end can reverse it against the other.
  refuseReversedRoute(lanes, next.route_start_swimlane_id, next.route_last_swimlane_id, label);

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

/**
 * Add a task to a started workflow. It lands in To Do, on its own board, and
 * starts when nothing it waits for is left. `runSettings` is what the
 * Workflows view's Add task already checked; without it the settings are read
 * from the input's agent-facing fields.
 */
export function addWorkflowTask(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  input: PlannedTaskInput & { waitsFor?: string[] | null; runSettings?: WorkflowTaskRunSettings },
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
  refuseReversedRoute(lanes, membership.route_start_swimlane_id, membership.route_last_swimlane_id, label);
  const runSettings = input.runSettings ?? resolvePlannedRunSettings(context, projectId, input, `${label}: `);
  // Resolve the blockers before anything is written.
  const blockers = (input.waitsFor ?? []).map((selector) => resolveBlocker(context, homeProjectId, workflow, selector));
  const created = writeTransaction(db, () => tasks.create({
    title: input.title.trim(),
    description: typeof input.description === 'string' ? input.description : '',
    swimlane_id: todo.id,
    labels: textLabels(input.labels),
    priority: typeof input.priority === 'number' ? input.priority : 0,
    ...runSettingsCreateInput(runSettings),
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
  // Two databases, so two writes: links first. A failure after it leaves a
  // member with no links, which the user can remove again; the other order
  // would leave links to a task outside the workflow, and a dependent waiting
  // on it would never start (a blocker the workflow cannot see is never done).
  new TaskLinkRepository(getProjectDb(homeProjectId)).deleteForTask(resolved.task.id);
  tasks.setWorkflowMembership(resolved.task.id, null);
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

/**
 * Who approves plans for the workflow's tasks. Allowed in any state, like a
 * rename: it changes no plan, and after Start the inspector is where it is
 * changed. The board announcement is what makes every live session's approver
 * read the new value (`plan-approval-writer.ts` listens on the board bus).
 */
export function setWorkflowPlanApproval(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  planApproval: PlanApproval | null,
): void {
  requireWorkflow(homeProjectId, workflowId);
  new WorkflowRepository(getProjectDb(homeProjectId)).setPlanApproval(workflowId, planApproval);
  notifyWorkflowChanged(homeProjectId, workflowId);
  announceWorkflowBoards(context, homeProjectId, workflowId);
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
  throw new WorkflowRequestError(`${WORKFLOW_REFUSALS.notFound(selector)} List them with kangentic_list_workflows.`);
}
