import type { PermissionMode, PlanApproval, TaskRunMode, Workflow, WorkflowAgentFailure } from '../../../shared/types';
import { resolveEffortSelector, resolveSpacedModelName } from '../../../shared/model-id';
import { PERMISSION_MODES, RUN_MODES, isPermissionMode, isRunMode } from '../../../shared/workflow-run-settings';
import { isPlanApproval } from '../../../shared/plan-approval';
import { WORKFLOW_REFUSALS } from '../../../shared/workflow-refusals';
import { WorkflowRepository } from '../../db/repositories/workflow-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { requireWorkflowRuntimeContext } from '../../workflows/workflow-runtime';
import { requestWorkflowAgentProjectAccess } from '../../workflows/workflow-agent';
import { describeState, formatWorkflow } from '../../workflows/workflow-format';
import {
  WorkflowRequestError,
  addWorkflowTask,
  checkPlannedModel,
  checkPlannedModels,
  createWorkflowWithPlan,
  deleteWorkflow,
  linkTasks,
  pauseWorkflow,
  readWorkflow,
  removeFromWorkflow,
  resolveProjectId,
  resolveWorkflow,
  resumeWorkflow,
  savePlan,
  setTaskRoute,
  startWorkflow,
  unlinkTasks,
  type PlannedTaskInput,
} from '../../workflows/workflow-service';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

/**
 * The MCP workflow commands: thin shells over `workflow-service.ts`, which
 * owns every rule. Each validates its own parameters, since a command handler
 * can be reached without a zod schema in front of it, and answers a refusal
 * as an error the agent can act on.
 *
 * The home project is the request's project (`context.projectId`); a planned
 * task names another project by name to go on that board.
 */

function fail(error: unknown): CommandResponse {
  if (error instanceof WorkflowRequestError) return { success: false, error: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, error: `The workflow could not be changed: ${message}` };
}

function stringParam(params: Record<string, unknown>, key: string, required: true): string;
function stringParam(params: Record<string, unknown>, key: string, required?: false): string | null;
function stringParam(params: Record<string, unknown>, key: string, required = false): string | null {
  const value = params[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new WorkflowRequestError(`${key} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new WorkflowRequestError(`${key} must be text.`);
  return value;
}

function stringListParam(params: Record<string, unknown>, key: string): string[] | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new WorkflowRequestError(`${key} must be a list of names.`);
  }
  return value as string[];
}

function workflowParam(params: Record<string, unknown>, context: CommandContext): Workflow {
  return resolveWorkflow(context.projectId, stringParam(params, 'workflow', true));
}

function agentCount(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

export const handleListWorkflows: CommandHandler = (params, context) => {
  try {
    const includeFinished = params.includeFinished === true;
    const repository = new WorkflowRepository(context.getProjectDb());
    const workflows = includeFinished ? repository.listAll() : repository.listOpen();
    if (workflows.length === 0) {
      return { success: true, message: includeFinished ? 'This project has no workflows.' : 'This project has no unfinished workflows.', data: [] };
    }
    const runtime = requireWorkflowRuntimeContext();
    const lines = workflows.map((workflow) => {
      const view = readWorkflow(runtime, context.projectId, workflow.id);
      const done = view.tasks.filter((task) => task.place === 'done').length;
      const progress = workflow.state === 'draft' ? `${view.tasks.length} planned tasks` : `${done} of ${view.tasks.length} done`;
      return `- "${workflow.title}" (id ${workflow.id}): ${describeState(workflow)}, ${progress}, revision ${workflow.revision}.`;
    });
    return { success: true, message: lines.join('\n'), data: workflows.map((workflow) => ({ id: workflow.id, title: workflow.title, state: workflow.state })) };
  } catch (error) {
    return fail(error);
  }
};

export const handleGetWorkflow: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const view = readWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id);
    return { success: true, message: formatWorkflow(view), data: view };
  } catch (error) {
    return fail(error);
  }
};

/** An enum-valued run setting: absent is null, anything outside the set is refused with the set. */
function enumSetting<T extends string>(
  raw: string | null,
  isMember: (value: unknown) => value is T,
  valid: readonly T[],
  field: string,
  label: string,
): T | null {
  if (raw === null) return null;
  if (!isMember(raw)) throw new WorkflowRequestError(`${label}: ${field} "${raw}" is not valid. Valid values: ${valid.join(', ')}.`);
  return raw;
}

type RunSettingsParams = Pick<
  PlannedTaskInput,
  'baseBranch' | 'useWorktree' | 'runMode' | 'profile' | 'agentOverride' | 'modelOverride' | 'effortOverride' | 'permissionMode'
>;

/**
 * One task's run settings, as kangentic_save_workflow and
 * kangentic_add_workflow_task both take them. Refused on a wrong type rather
 * than dropped: a dropped one would make a task that runs differently from
 * what was asked. Each refusal starts with `label`.
 */
function runSettingsParams(record: Record<string, unknown>, label: string): RunSettingsParams {
  const setting = (field: string): string | null => {
    const raw = record[field];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') throw new WorkflowRequestError(`${label}: ${field} must be text.`);
    return raw;
  };
  const useWorktree = record.useWorktree;
  if (useWorktree !== undefined && useWorktree !== null && typeof useWorktree !== 'boolean') {
    throw new WorkflowRequestError(`${label}: useWorktree must be true (its own worktree) or false (the project folder).`);
  }
  // A friendly versioned name ("Opus 4.8") converts to the CLI id, as kangentic_create_task's does.
  const modelOverride = setting('modelOverride');
  const effortOverride = setting('effortOverride');
  return {
    baseBranch: setting('baseBranch'),
    useWorktree: typeof useWorktree === 'boolean' ? useWorktree : null,
    runMode: enumSetting<TaskRunMode>(setting('runMode'), isRunMode, RUN_MODES, 'runMode', label),
    profile: setting('profile'),
    agentOverride: setting('agentOverride'),
    modelOverride: modelOverride ? resolveSpacedModelName(modelOverride) : null,
    effortOverride: effortOverride ? resolveEffortSelector(effortOverride) : null,
    permissionMode: enumSetting<PermissionMode>(setting('permissionMode'), isPermissionMode, PERMISSION_MODES, 'permissionMode', label),
  };
}

/**
 * A planned task's field, refused on a wrong type rather than dropped, as the
 * run settings are: `project: 5` dropped would put the task on the home board,
 * and `skip: "Planning"` dropped would route it through Planning.
 */
function plannedText(record: Record<string, unknown>, field: string, label: string): string | null {
  const raw = record[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new WorkflowRequestError(`${label}: ${field} must be text.`);
  return raw;
}

/**
 * A task's own plan approval: absent or null follows its plan columns, anything
 * outside the two values is refused. Narrowed here as well as in the zod schema:
 * the mobile bridge reaches handlers with no schema in front of them.
 */
function planApprovalParam(record: Record<string, unknown>, label: string): PlanApproval | null {
  const raw = record.planApproval;
  if (raw === undefined || raw === null) return null;
  if (!isPlanApproval(raw)) throw new WorkflowRequestError(`${label}: ${WORKFLOW_REFUSALS.planApprovalValue}`);
  return raw;
}

function plannedTextList(record: Record<string, unknown>, field: string, label: string): string[] | null {
  const raw = record[field];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new WorkflowRequestError(`${label}: ${field} must be a list of names.`);
  }
  return raw as string[];
}

function plannedTasksParam(params: Record<string, unknown>): PlannedTaskInput[] {
  const value = params.tasks;
  if (!Array.isArray(value)) throw new WorkflowRequestError('tasks must be a list.');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new WorkflowRequestError(`Task ${index + 1} must be an object.`);
    const record = entry as Record<string, unknown>;
    const label = `Task ${index + 1}${typeof record.key === 'string' ? ` ("${record.key}")` : ''}`;
    const priority = record.priority;
    if (priority !== undefined && priority !== null && typeof priority !== 'number') {
      throw new WorkflowRequestError(`${label}: priority must be a number.`);
    }
    return {
      // A missing or wrong-typed key or title reads as missing, which the plan's
      // own validation refuses with what to send instead.
      key: typeof record.key === 'string' ? record.key : '',
      title: typeof record.title === 'string' ? record.title : '',
      description: plannedText(record, 'description', label),
      project: plannedText(record, 'project', label),
      existingTask: plannedText(record, 'existingTask', label),
      routeStart: plannedText(record, 'routeStart', label),
      routeLast: plannedText(record, 'routeLast', label),
      skip: plannedTextList(record, 'skip', label),
      labels: plannedTextList(record, 'labels', label),
      priority: typeof priority === 'number' ? priority : null,
      ...runSettingsParams(record, label),
      planApproval: planApprovalParam(record, label),
    };
  });
}

function linksParam(params: Record<string, unknown>): Array<{ blocker: string; blocked: string }> {
  const value = params.links ?? [];
  if (!Array.isArray(value)) throw new WorkflowRequestError('links must be a list.');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new WorkflowRequestError(`Link ${index + 1} must be an object with blocker and blocked.`);
    const record = entry as Record<string, unknown>;
    // A missing or wrong-typed end reads as an unknown key, which the plan's
    // validation refuses by name.
    return {
      blocker: typeof record.blocker === 'string' ? record.blocker : '',
      blocked: typeof record.blocked === 'string' ? record.blocked : '',
    };
  });
}

export const handleSaveWorkflow: CommandHandler = async (params, context) => {
  try {
    const runtime = requireWorkflowRuntimeContext();
    const selector = stringParam(params, 'workflow');
    const revisionValue = params.revision;
    if (revisionValue !== undefined && revisionValue !== null && (typeof revisionValue !== 'number' || !Number.isInteger(revisionValue))) {
      throw new WorkflowRequestError('revision must be the whole number kangentic_get_workflow reported.');
    }
    const tasks = plannedTasksParam(params);
    const links = linksParam(params);
    const title = stringParam(params, 'title');
    const brief = stringParam(params, 'brief');
    // The workflow-level planApproval is gone: plan approval is set per task.
    // A null is accepted and ignored, since older kangentic_get_workflow output
    // told agents to send `planApproval null` back.
    if (params.planApproval !== undefined && params.planApproval !== null) {
      throw new WorkflowRequestError(WORKFLOW_REFUSALS.planApprovalPerTask);
    }
    // Models and efforts are checked against each agent's CLI first, which can
    // take a moment; everything else is checked before anything is written. A
    // new workflow is created only with a plan that passed, in the same write,
    // so a refused save leaves no empty workflow behind.
    await checkPlannedModels(runtime, context.projectId, tasks);
    const saved = selector
      ? savePlan(runtime, context.projectId, resolveWorkflow(context.projectId, selector).id, {
        title,
        tasks,
        links,
        revision: (revisionValue as number | null | undefined) ?? null,
      })
      : createWorkflowWithPlan(runtime, context.projectId, { brief }, { title, tasks, links, revision: null });
    const taskCount = saved.draft?.tasks.length ?? 0;
    const linkCount = saved.draft?.links.length ?? 0;
    return {
      success: true,
      message: `Saved: ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}, ${linkCount} ${linkCount === 1 ? 'link' : 'links'}. "${saved.title}" (id ${saved.id}) is at revision ${saved.revision}. The user starts the workflow when they are ready.`,
      data: { id: saved.id, revision: saved.revision },
    };
  } catch (error) {
    return fail(error);
  }
};

export const handleStartWorkflow: CommandHandler = async (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const runtime = requireWorkflowRuntimeContext();
    const result = await startWorkflow(runtime, context.projectId, workflow.id);
    const total = readWorkflow(runtime, context.projectId, workflow.id).tasks.length;
    const superseded = result.supersededSource ? ` #${result.supersededSource} moved to Done.` : '';
    return {
      success: true,
      message: `Started "${result.workflow.title}": ${total} ${total === 1 ? 'task' : 'tasks'}, ${result.linkCount} ${result.linkCount === 1 ? 'link' : 'links'}. Tasks with nothing to wait for start as agent slots allow.${superseded}`,
      data: { id: result.workflow.id },
    };
  } catch (error) {
    return fail(error);
  }
};

/** Who paused or resumed, for the workflow's log line: the phone, the agent of a task, or an MCP client. */
function controlSource(context: CommandContext): string {
  if (context.via === 'phone') return 'the phone';
  if (context.callerTaskId) {
    try {
      const caller = new TaskRepository(context.getProjectDb()).getById(context.callerTaskId);
      if (caller) return `the agent of #${caller.display_id}`;
    } catch {
      // The caller's board may be another project's: the id still names it.
    }
    return `the agent of task ${context.callerTaskId.slice(0, 8)}`;
  }
  return 'an MCP client';
}

/** " #917 and #918 could not be paused." for the reply, or nothing. */
function failedClause(failed: WorkflowAgentFailure[], verb: string): string {
  if (failed.length === 0) return '';
  const labels = failed.map((failure) => `#${failure.displayId}`);
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return ` ${list} could not be ${verb}.`;
}

export const handlePauseWorkflow: CommandHandler = async (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const { workflow: paused, ...report } = await pauseWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id, controlSource(context));
    return {
      success: true,
      message: `Paused "${paused.title}" (${agentCount(report.paused)} paused).${failedClause(report.failed, 'paused')} The workflow starts and moves nothing until it is resumed.`,
      data: report,
    };
  } catch (error) {
    return fail(error);
  }
};

export const handleResumeWorkflow: CommandHandler = async (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const { workflow: resumed, ...report } = await resumeWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id, controlSource(context));
    return {
      success: true,
      message: `Resumed "${resumed.title}" (${agentCount(report.resumed)} resumed, ${report.started} started, ${report.alreadyRunning} already running).${failedClause(report.failed, 'brought back')}`,
      data: report,
    };
  } catch (error) {
    return fail(error);
  }
};

export const handleAddWorkflowTask: CommandHandler = async (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const runtime = requireWorkflowRuntimeContext();
    const title = stringParam(params, 'title', true);
    // The run settings kangentic_save_workflow takes, through the same checks
    // and refusals, labelled as addWorkflowTask labels its own.
    const label = `"${title.trim()}"`;
    const input: PlannedTaskInput & { waitsFor: string[] | null } = {
      key: '',
      title,
      description: stringParam(params, 'description'),
      project: stringParam(params, 'taskProject'),
      routeStart: stringParam(params, 'routeStart'),
      routeLast: stringParam(params, 'routeLast'),
      skip: stringListParam(params, 'skip'),
      waitsFor: stringListParam(params, 'waitsFor'),
      ...runSettingsParams(params, label),
      planApproval: planApprovalParam(params, label),
    };
    // Its model and effort against its agent's CLI, which can take a moment;
    // everything else is checked by addWorkflowTask, before it writes.
    await checkPlannedModel(runtime, context.projectId, input, label);
    const created = addWorkflowTask(runtime, context.projectId, workflow.id, input);
    return {
      success: true,
      message: `Added #${created.display_id} "${created.title}" to "${workflow.title}" in To Do. It starts when nothing it waits for is left and an agent slot is free.`,
      data: { id: created.id, displayId: created.display_id },
    };
  } catch (error) {
    return fail(error);
  }
};

function linkInput(params: Record<string, unknown>) {
  return {
    blocker: stringParam(params, 'blocker', true),
    blockerProject: stringParam(params, 'blockerProject'),
    blocked: stringParam(params, 'blocked', true),
    blockedProject: stringParam(params, 'blockedProject'),
  };
}

export const handleLinkWorkflowTasks: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const input = linkInput(params);
    linkTasks(requireWorkflowRuntimeContext(), context.projectId, workflow.id, input);
    return { success: true, message: `Linked: ${input.blocked} now waits for ${input.blocker} to reach Done.` };
  } catch (error) {
    return fail(error);
  }
};

export const handleUnlinkWorkflowTasks: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const input = linkInput(params);
    const removed = unlinkTasks(requireWorkflowRuntimeContext(), context.projectId, workflow.id, input);
    return {
      success: true,
      message: removed
        ? `Unlinked: ${input.blocked} no longer waits for ${input.blocker}. If nothing else holds it, it starts as soon as an agent slot is free.`
        : `${input.blocked} was not waiting for ${input.blocker}. Nothing changed.`,
    };
  } catch (error) {
    return fail(error);
  }
};

export const handleSetTaskRoute: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(params, key);
    const updated = setTaskRoute(requireWorkflowRuntimeContext(), context.projectId, workflow.id, {
      task: stringParam(params, 'task', true),
      project: stringParam(params, 'taskProject'),
      routeStart: has('routeStart') ? stringParam(params, 'routeStart') : undefined,
      routeLast: has('routeLast') ? stringParam(params, 'routeLast') : undefined,
      skip: has('skip') ? stringListParam(params, 'skip') ?? [] : undefined,
    });
    const view = readWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id);
    const route = view.tasks.find((task) => task.taskId === updated.id)?.route ?? [];
    return { success: true, message: `#${updated.display_id}'s route is now ${route.length > 0 ? route.join(' > ') : 'straight to Done'}.` };
  } catch (error) {
    return fail(error);
  }
};

export const handleRemoveFromWorkflow: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const removed = removeFromWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id, {
      task: stringParam(params, 'task', true),
      project: stringParam(params, 'taskProject'),
    });
    return { success: true, message: `Removed #${removed.display_id} from "${workflow.title}". It stays where it is, as an ordinary task.` };
  } catch (error) {
    return fail(error);
  }
};

export const handleRequestProjectAccess: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const runtime = requireWorkflowRuntimeContext();
    const projectId = resolveProjectId(runtime, context.projectId, stringParam(params, 'readProject', true));
    const access = requestWorkflowAgentProjectAccess(runtime, context.projectId, workflow.id, projectId);
    const messages: Record<typeof access.when, string> = {
      home: `${access.name} is this workflow's own project, which you read already.`,
      already: `${access.name} is readable already, at ${access.path}.`,
      'next-turn': `Granted: ${access.name}, at ${access.path}. End your turn now; Kangentic restarts you on this conversation with it readable and tells you when it is ready.`,
      now: `Granted: ${access.name}, at ${access.path}. Kangentic is restarting you on this conversation with it readable.`,
      'next-start': `Granted: ${access.name}, at ${access.path}. The workflow's agent reads it from its next start.`,
      unsupported: `Granted: ${access.name}, but this agent cannot read another project's checkout, so the grant takes effect only for an agent that can.`,
    };
    return { success: true, message: messages[access.when], data: { projectId, path: access.path } };
  } catch (error) {
    return fail(error);
  }
};

export const handleDeleteWorkflow: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const result = deleteWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id);
    const message = result.workflow.state === 'draft'
      ? `Deleted "${result.workflow.title}" and its planned tasks. Nothing else changed.`
      : `Deleted "${result.workflow.title}". Its ${result.released} unfinished tasks stay where they are, as ordinary tasks.`;
    return { success: true, message };
  } catch (error) {
    return fail(error);
  }
};
