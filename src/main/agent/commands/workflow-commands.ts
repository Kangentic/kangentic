import type { Workflow } from '../../../shared/types';
import { WorkflowRepository } from '../../db/repositories/workflow-repository';
import { requireWorkflowRuntimeContext } from '../../workflows/workflow-runtime';
import { requestWorkflowAgentProjectAccess } from '../../workflows/workflow-agent';
import {
  WorkflowRequestError,
  addWorkflowTask,
  createWorkflow,
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
  type WorkflowView,
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

function describeState(workflow: Workflow): string {
  return workflow.state === 'draft' ? 'not started' : workflow.state === 'done' ? 'complete' : workflow.state;
}

/** The text an agent reads back for a workflow. */
export function formatWorkflow(view: WorkflowView): string {
  const { workflow } = view;
  const lines = [
    `Workflow "${workflow.title}" (id ${workflow.id}), ${describeState(workflow)}, revision ${workflow.revision}.`,
  ];
  if (workflow.brief) lines.push(`Brief: ${workflow.brief}`);
  if (view.tasks.length === 0) {
    lines.push('No tasks yet.');
  } else {
    const doneCount = view.tasks.filter((task) => task.place === 'done').length;
    if (workflow.state !== 'draft') lines.push(`${doneCount} of ${view.tasks.length} done.`);
    lines.push('Tasks:');
    for (const task of view.tasks) {
      const label = workflow.state === 'draft' ? `[${task.key}]` : task.key;
      const waits = task.waitsFor.length > 0 ? ` Waits for ${task.waitsFor.join(', ')}.` : '';
      const route = task.route.length > 0 ? task.route.join(' > ') : '(no columns: straight to Done)';
      lines.push(`- ${label} ${task.title}. In ${task.column}. Route: ${route}.${waits}`);
    }
  }
  return lines.join('\n');
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

function plannedTasksParam(params: Record<string, unknown>): PlannedTaskInput[] {
  const value = params.tasks;
  if (!Array.isArray(value)) throw new WorkflowRequestError('tasks must be a list.');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new WorkflowRequestError(`Task ${index + 1} must be an object.`);
    const record = entry as Record<string, unknown>;
    return {
      key: typeof record.key === 'string' ? record.key : '',
      title: typeof record.title === 'string' ? record.title : '',
      description: typeof record.description === 'string' ? record.description : null,
      project: typeof record.project === 'string' ? record.project : null,
      existingTask: typeof record.existingTask === 'string' ? record.existingTask : null,
      routeStart: typeof record.routeStart === 'string' ? record.routeStart : null,
      routeLast: typeof record.routeLast === 'string' ? record.routeLast : null,
      skip: Array.isArray(record.skip) ? record.skip.filter((name): name is string => typeof name === 'string') : null,
      labels: Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string') : null,
      priority: typeof record.priority === 'number' ? record.priority : null,
    };
  });
}

function linksParam(params: Record<string, unknown>): Array<{ blocker: string; blocked: string }> {
  const value = params.links ?? [];
  if (!Array.isArray(value)) throw new WorkflowRequestError('links must be a list.');
  return value.map((entry) => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      blocker: typeof record.blocker === 'string' ? record.blocker : '',
      blocked: typeof record.blocked === 'string' ? record.blocked : '',
    };
  });
}

export const handleSaveWorkflow: CommandHandler = (params, context) => {
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
    const workflow = selector
      ? resolveWorkflow(context.projectId, selector)
      : createWorkflow(context.projectId, { title, brief: stringParam(params, 'brief') });
    const saved = savePlan(runtime, context.projectId, workflow.id, {
      title,
      tasks,
      links,
      revision: selector ? (revisionValue as number | null | undefined) ?? null : null,
    });
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

export const handlePauseWorkflow: CommandHandler = async (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const result = await pauseWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id);
    return { success: true, message: `Paused "${result.workflow.title}" (${agentCount(result.paused)} paused). Nothing starts or moves until it is resumed.` };
  } catch (error) {
    return fail(error);
  }
};

export const handleResumeWorkflow: CommandHandler = async (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const result = await resumeWorkflow(requireWorkflowRuntimeContext(), context.projectId, workflow.id);
    return { success: true, message: `Resumed "${result.workflow.title}" (${agentCount(result.resumed)} resumed).` };
  } catch (error) {
    return fail(error);
  }
};

export const handleAddWorkflowTask: CommandHandler = (params, context) => {
  try {
    const workflow = workflowParam(params, context);
    const created = addWorkflowTask(requireWorkflowRuntimeContext(), context.projectId, workflow.id, {
      key: '',
      title: stringParam(params, 'title', true),
      description: stringParam(params, 'description'),
      project: stringParam(params, 'taskProject'),
      routeStart: stringParam(params, 'routeStart'),
      routeLast: stringParam(params, 'routeLast'),
      skip: stringListParam(params, 'skip'),
      waitsFor: stringListParam(params, 'waitsFor'),
    });
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
