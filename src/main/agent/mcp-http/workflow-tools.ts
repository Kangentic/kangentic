import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { callHandler, withProject, PROJECT_SELECTOR_DESCRIPTION } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';

/**
 * The workflow tools (#732): a workflow is a set of linked tasks that run
 * through their boards on their own. Each task has a route (the columns it
 * visits) and starts when every task it waits for reaches Done.
 *
 * A workflow is planned as a whole (`kangentic_save_workflow`, whole-list
 * replace, like `kangentic_set_automations`), started by the user, and then
 * changed piece by piece. Every handler validates what it is given and refuses
 * with what to fix, writing nothing.
 */

const WORKFLOW_DESCRIPTION = 'The workflow\'s id, or its exact title (case-insensitive). List them with kangentic_list_workflows.';
const TASK_SELECTOR_DESCRIPTION = 'Task number (e.g. "42") or full id.';
const TASK_PROJECT_DESCRIPTION = 'The project the task is on, when it is not this workflow\'s project (name or id).';
const COLUMN_NAME_DESCRIPTION = 'A column name on that task\'s board, between To Do and Done.';

const PLANNED_TASK_SCHEMA = z.object({
  key: z.string().max(60).describe('A short key for this task, unique in the plan, used by links ("api", "ui").'),
  title: z.string().max(300).describe('The task\'s title.'),
  description: z.string().max(40_000).optional().describe('What the task\'s agent should do. Write the plan into it: the agent reads it as its brief.'),
  project: z.string().optional().describe('Put the task on another registered project\'s board (name or id) when its work is in that repository. Omit for this project. Use only projects the user named.'),
  existingTask: z.string().optional().describe('Take in a task already in To Do on that board (its number or id) instead of creating one.'),
  routeStart: z.string().optional().describe(`The first column it visits. ${COLUMN_NAME_DESCRIPTION} Omit to start in the first column after To Do.`),
  routeLast: z.string().optional().describe(`The last column it visits before Done. ${COLUMN_NAME_DESCRIPTION} Omit to visit through the column before Done.`),
  skip: z.array(z.string()).optional().describe('Columns inside its route it skips, such as one that only plans the work, for a small, well-understood task. Never skip a column the user\'s process depends on without asking.'),
  labels: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(4).optional(),
});

export function registerWorkflowTools(server: McpServer, resolver: RequestResolver): void {
  server.registerTool(
    'kangentic_list_workflows',
    {
      description: 'List this project\'s workflows with their state (not started, running, paused) and progress. Finished workflows are left out unless includeFinished is set.',
      inputSchema: z.object({
        includeFinished: z.boolean().optional().describe('Include workflows whose tasks are all in Done.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ includeFinished, project }) => withProject(resolver, project, (ctx) => callHandler('list_workflows', { includeFinished: includeFinished ?? false }, ctx, 'Failed to list workflows')),
  );

  server.registerTool(
    'kangentic_get_workflow',
    {
      description: 'Read one workflow: its state, its revision (pass it back to kangentic_save_workflow), and each task with its column, route and what it waits for.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workflow, project }) => withProject(resolver, project, (ctx) => callHandler('get_workflow', { workflow }, ctx, 'Failed to read the workflow')),
  );

  server.registerTool(
    'kangentic_save_workflow',
    {
      description: 'Save the plan of a workflow that has not started: its title, every planned task, and the links between them. Replaces the whole plan, so read it first with kangentic_get_workflow and send it back with your change, passing the revision you read; a save over a newer revision is refused so the user\'s own edits win. Omit `workflow` to create a new one. Nothing appears on any board until the user starts it. Plan as few tasks as the work allows (one capable agent finishing a larger task costs less than several sharing it); link a task to another only when it needs that task\'s code merged first, and let everything else run side by side.',
      inputSchema: z.object({
        workflow: z.string().optional().describe(`${WORKFLOW_DESCRIPTION} Omit to create a new workflow.`),
        title: z.string().max(200).optional().describe('The workflow\'s name. Give a new workflow one when you first save it.'),
        brief: z.string().max(40_000).optional().describe('For a new workflow only: what it was made from.'),
        tasks: z.array(PLANNED_TASK_SCHEMA).max(60).describe('Every planned task, in run order for tasks that can start together.'),
        links: z.array(z.object({
          blocker: z.string().describe('The key of the task that must reach Done first.'),
          blocked: z.string().describe('The key of the task that waits for it.'),
        })).optional().describe('"blocked waits for blocker to reach Done". No loops.'),
        revision: z.number().int().optional().describe('The revision kangentic_get_workflow reported. Required when saving an existing workflow you read.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, title, brief, tasks, links, revision, project }) => withProject(resolver, project, (ctx) => callHandler(
      'save_workflow',
      { workflow: workflow ?? null, title: title ?? null, brief: brief ?? null, tasks, links: links ?? [], revision: revision ?? null },
      ctx,
      'Failed to save the workflow',
    )),
  );

  server.registerTool(
    'kangentic_start_workflow',
    {
      description: 'Start a planned workflow: its tasks appear in To Do on their boards, and each starts on its own once every task it waits for is in Done, as agent slots allow. The task it was made from moves to Done. Start only when the user asks to.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, project }) => withProject(resolver, project, (ctx) => callHandler('start_workflow', { workflow }, ctx, 'Failed to start the workflow')),
  );

  server.registerTool(
    'kangentic_pause_workflow',
    {
      description: 'Pause a running workflow: every task\'s agent pauses at once, and nothing starts or moves until it is resumed.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, project }) => withProject(resolver, project, (ctx) => callHandler('pause_workflow', { workflow }, ctx, 'Failed to pause the workflow')),
  );

  server.registerTool(
    'kangentic_resume_workflow',
    {
      description: 'Resume a paused workflow: each task\'s agent resumes in the column it is in, and waiting tasks start again as their blockers finish.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, project }) => withProject(resolver, project, (ctx) => callHandler('resume_workflow', { workflow }, ctx, 'Failed to resume the workflow')),
  );

  server.registerTool(
    'kangentic_add_workflow_task',
    {
      description: 'Add a task to a started workflow. It lands in To Do and starts once nothing it waits for is left and an agent slot is free.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        title: z.string().max(300),
        description: z.string().max(40_000).optional(),
        taskProject: z.string().optional().describe('Put it on another project\'s board (name or id). Omit for this workflow\'s project.'),
        routeStart: z.string().optional().describe(COLUMN_NAME_DESCRIPTION),
        routeLast: z.string().optional().describe(COLUMN_NAME_DESCRIPTION),
        skip: z.array(z.string()).optional().describe('Columns inside its route it skips.'),
        waitsFor: z.array(z.string()).optional().describe('Task numbers or ids in this workflow it waits for.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, title, description, taskProject, routeStart, routeLast, skip, waitsFor, project }) => withProject(resolver, project, (ctx) => callHandler(
      'add_workflow_task',
      { workflow, title, description: description ?? null, taskProject: taskProject ?? null, routeStart: routeStart ?? null, routeLast: routeLast ?? null, skip: skip ?? null, waitsFor: waitsFor ?? null },
      ctx,
      'Failed to add the task',
    )),
  );

  const LINK_SCHEMA = z.object({
    workflow: z.string().describe(WORKFLOW_DESCRIPTION),
    blocker: z.string().describe(`The task that must reach Done first. ${TASK_SELECTOR_DESCRIPTION}`),
    blockerProject: z.string().optional().describe(TASK_PROJECT_DESCRIPTION),
    blocked: z.string().describe(`The task that waits. ${TASK_SELECTOR_DESCRIPTION}`),
    blockedProject: z.string().optional().describe(TASK_PROJECT_DESCRIPTION),
    project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
  });

  server.registerTool(
    'kangentic_link_workflow_tasks',
    {
      description: 'Make one task in a started workflow wait for another to reach Done. Only a task still in To Do can wait, and only for one not yet done; a link that would close a loop is refused.',
      inputSchema: LINK_SCHEMA,
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, blocker, blockerProject, blocked, blockedProject, project }) => withProject(resolver, project, (ctx) => callHandler(
      'link_workflow_tasks',
      { workflow, blocker, blockerProject: blockerProject ?? null, blocked, blockedProject: blockedProject ?? null },
      ctx,
      'Failed to link the tasks',
    )),
  );

  server.registerTool(
    'kangentic_unlink_workflow_tasks',
    {
      description: 'Remove a link in a started workflow. A task in To Do whose last blocker this was starts as soon as an agent slot is free.',
      inputSchema: LINK_SCHEMA,
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, blocker, blockerProject, blocked, blockedProject, project }) => withProject(resolver, project, (ctx) => callHandler(
      'unlink_workflow_tasks',
      { workflow, blocker, blockerProject: blockerProject ?? null, blocked, blockedProject: blockedProject ?? null },
      ctx,
      'Failed to unlink the tasks',
    )),
  );

  server.registerTool(
    'kangentic_set_task_route',
    {
      description: 'Change which columns a task in a started workflow visits. A task in To Do can take any route; one that has started can only change the columns after the one it is in. Pass only what changes.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        task: z.string().describe(TASK_SELECTOR_DESCRIPTION),
        taskProject: z.string().optional().describe(TASK_PROJECT_DESCRIPTION),
        routeStart: z.string().nullable().optional().describe(`${COLUMN_NAME_DESCRIPTION} null for the first column after To Do.`),
        routeLast: z.string().nullable().optional().describe(`${COLUMN_NAME_DESCRIPTION} null for the column before Done.`),
        skip: z.array(z.string()).optional().describe('The complete list of columns to skip; an empty list skips none.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, task, taskProject, routeStart, routeLast, skip, project }) => withProject(resolver, project, (ctx) => {
      const params: Record<string, unknown> = { workflow, task, taskProject: taskProject ?? null };
      if (routeStart !== undefined) params.routeStart = routeStart;
      if (routeLast !== undefined) params.routeLast = routeLast;
      if (skip !== undefined) params.skip = skip;
      return callHandler('set_task_route', params, ctx, 'Failed to set the route');
    }),
  );

  server.registerTool(
    'kangentic_remove_from_workflow',
    {
      description: 'Take a task out of its workflow. It stays where it is, as an ordinary task, and its links are removed. A task in Done stays with its workflow.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        task: z.string().describe(TASK_SELECTOR_DESCRIPTION),
        taskProject: z.string().optional().describe(TASK_PROJECT_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, task, taskProject, project }) => withProject(resolver, project, (ctx) => callHandler(
      'remove_from_workflow',
      { workflow, task, taskProject: taskProject ?? null },
      ctx,
      'Failed to remove the task',
    )),
  );

  server.registerTool(
    'kangentic_delete_workflow',
    {
      description: 'Delete a workflow. One not started loses its plan and nothing else changes. A started one\'s unfinished tasks stay where they are as ordinary tasks; its tasks in Done stay in Done. Delete only when the user asks to.',
      inputSchema: z.object({
        workflow: z.string().describe(WORKFLOW_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ workflow, project }) => withProject(resolver, project, (ctx) => callHandler('delete_workflow', { workflow }, ctx, 'Failed to delete the workflow')),
  );
}
