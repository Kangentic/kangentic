import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { callHandler, runHandler, withProject, detectCrossProjectMention, sanitizeProjectName, PROJECT_SELECTOR_DESCRIPTION, type TaskCounter } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import type { BoardHit, BacklogHit, SearchScope } from '../commands/search-commands';
import { TASK_DESCRIPTION_MAX_LENGTH, handleMoveTaskToProject } from '../commands/task-commands';

/**
 * Build the create_task routing-check refusal shown when the call
 * defaulted to the active project but the task text named one or more
 * other registered projects. Names a concrete re-run for each option:
 * file into a mentioned project, or confirm the active project. Names
 * are sanitized for safe single-line display.
 */
function buildRoutingCheckMessage(activeName: string, mentioned: string[]): string {
  const safeActive = sanitizeProjectName(activeName);
  const safeMentioned = mentioned.map((name) => `"${sanitizeProjectName(name)}"`);
  if (safeMentioned.length === 1) {
    return `Routing check: this task was about to be created in the active project "${safeActive}", but its text mentions the registered project ${safeMentioned[0]}. No task was created. Re-run kangentic_create_task with project: ${safeMentioned[0]} to file it there, or with project: "${safeActive}" to confirm the active project.`;
  }
  return `Routing check: this task was about to be created in the active project "${safeActive}", but its text mentions these other registered projects: ${safeMentioned.join(', ')}. No task was created. Re-run kangentic_create_task with project set to the intended one (e.g. project: ${safeMentioned[0]}), or with project: "${safeActive}" to confirm the active project.`;
}

/**
 * Register the board/task/column management tools on an McpServer.
 * These are the mutation-heavy tools - creating, moving, updating tasks
 * and columns - plus read-side helpers that are specifically about the
 * board (list_columns, find_task, etc.).
 *
 * Every tool accepts an optional `project` argument (except
 * `kangentic_get_current_task`, which is inherently scoped to the
 * running agent's CWD/branch and therefore to its own project). When
 * `project` is set, the tool resolves to a different project's board
 * before executing and annotates the response with the target
 * project's name so the caller can confirm where the action landed.
 *
 * create_task is rate-limited via `taskCounter` to cap runaway agents.
 */
export function registerTaskTools(
  server: McpServer,
  resolver: RequestResolver,
  taskCounter: TaskCounter,
): void {
  // --- kangentic_create_task ---
  server.registerTool(
    'kangentic_create_task',
    {
      description: 'Create a task on the Kangentic board (default: the To Do column on the active board) or in the backlog. This is the only task-creation tool - use it whenever the user asks to "create a task", "add a todo", "add to backlog", or similar. ATTACHMENTS RULE: When the user\'s prompt references local files by absolute path (design handoffs, mockups, screenshots, specs, READMEs, transcripts), pass those paths in `attachments` on this same call. Default to attaching, not omitting. Do not require a second user request to add them. The only exception is files the user explicitly named as "for context only, don\'t attach." With no `column` argument, the task always lands in the active board\'s To Do column - never the backlog. Pass `column: "Backlog"` (case-insensitive) to create a backlog item instead. Pass any other column name (e.g. "Planning", "Code Review") to land directly in that board column. Board tasks get a git branch and are ready to work on immediately. If the user\'s prompt names a different Kangentic project, pass that name as `project` to route the task to that project instead of the active default - do not rely on the active default when the user clearly targeted another project. The name counts however it is phrased, not just the explicit "create a task in X" form: "create a task in X to fix ...", "the X to do board", "add a bug to the X board", "in X", and "X\'s backlog" all target project X. Use kangentic_list_projects to find valid selectors. LABELS WITH A LONG DESCRIPTION: due to a known large-payload limitation, when this call carries both a long description (roughly 1KB or more) and labels, the labels can be dropped before they reach the server. In that case create the task here (you may omit labels), then set labels with a separate labels-only kangentic_update_task call right after.',
      inputSchema: z.object({
        title: z.string().max(200).describe('Task title (max 200 characters)'),
        description: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).optional().describe('Task description. Supports markdown.'),
        column: z.string().optional().describe('Target column name. Defaults to the To Do column on the active board. Use kangentic_list_columns to see board columns. Pass "Backlog" (case-insensitive) to create a backlog item instead of a board task. Only route to the backlog when the user explicitly asks for the backlog.'),
        priority: z.number().int().min(0).max(4).optional().describe('Priority: 0=none (default), 1=low, 2=medium, 3=high, 4=urgent. Applies to both board tasks and backlog items.'),
        labels: z.array(z.union([
          z.string(),
          z.object({
            name: z.string(),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Hex color (e.g. "#ef4444")'),
          }),
        ])).optional().describe('Labels for categorization. Each entry can be a plain string or an object with name and hex color (e.g. ["bug", { "name": "frontend", "color": "#3b82f6" }]). Applies to both board tasks and backlog items.'),
        branchName: z.string().optional().describe('Custom git branch name for the task (e.g. "bugfix/login-screen"). If omitted, a branch name is auto-generated from the title. Board tasks only - ignored for backlog.'),
        baseBranch: z.string().optional().describe('Base branch to create the task branch from (e.g. "develop", "main"). Defaults to the project setting. Board tasks only - ignored for backlog.'),
        useWorktree: z.boolean().optional().describe('Whether to use a git worktree for isolation. Defaults to the project setting. Set false to work in the main repo. Board tasks only - ignored for backlog.'),
        attachments: z.array(z.object({
          filePath: z.string().describe('Absolute path to the file to attach'),
          filename: z.string().optional().describe('Override display filename'),
        })).optional().describe('File attachments. Always include here any local files the user referenced in the prompt by absolute path - reading a file for context does not replace attaching it. Each entry needs `filePath` (absolute) and may override the display `filename`. Skip only when the user explicitly said the file is "for context only, don\'t attach."'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ title, description, column, priority, labels, branchName, baseBranch, useWorktree, attachments, project }) => withProject(resolver, project, (ctx, resolved) => {
      // Routing guardrail: when the caller defaulted to the active
      // project (no explicit selector) but the task text names a
      // DIFFERENT registered project, refuse instead of silently filing
      // into the active project. Runs BEFORE tryReserve so a tripped
      // guardrail doesn't burn a quota slot (same reasoning as the
      // resolution-failure path). Only fires on the default path; an
      // explicit `project` selector is a deliberate choice we honor.
      // The raw `project` check is load-bearing, not redundant with
      // resolved.isDefault: resolveProject also returns isDefault=true for
      // an explicit selector that names the active project (makeResolved
      // short-circuits to the default context), so without this clause an
      // explicit self-targeting create would wrongly trip the guardrail.
      if (resolved.isDefault && (project === undefined || project.trim() === '')) {
        const mentioned = detectCrossProjectMention(resolver, `${title} ${description ?? ''}`);
        if (mentioned.length > 0) {
          return Promise.resolve({
            content: [{ type: 'text' as const, text: buildRoutingCheckMessage(resolved.projectName, mentioned) }],
            isError: true,
          });
        }
      }
      // Atomic reserve AFTER project resolution so typoed project
      // selectors (which fail in resolveProject above) don't burn
      // quota slots meant to cap actual task creations.
      // No await between the check and the increment, so this can't race.
      if (!taskCounter.tryReserve()) {
        return Promise.resolve({
          content: [{ type: 'text' as const, text: `Task-creation limit reached: this Kangentic MCP server already created its maximum of ${taskCounter.limit()} tasks since the app launched (a runaway-loop safeguard). Restart Kangentic to reset.` }],
          isError: true,
        });
      }
      return callHandler('create_task', {
        title,
        description: description ?? '',
        column: column ?? null,
        priority: priority ?? null,
        labels: labels ?? null,
        branchName: branchName ?? null,
        baseBranch: baseBranch ?? null,
        useWorktree: useWorktree ?? null,
        attachments: attachments ?? null,
      }, ctx, 'Failed to create task');
    }, { alwaysAnnotate: true }),
  );

  // --- kangentic_list_columns ---
  server.registerTool(
    'kangentic_list_columns',
    {
      description: 'List all columns (swimlanes) on the Kangentic board. Returns column names, roles, and task counts. Pass `project` to list columns from a different project.',
      inputSchema: z.object({
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ project }) => withProject(resolver, project, async (ctx) => {
      const response = await runHandler('list_columns', {}, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list columns: ${response.error}` }], isError: true };
      }
      const columns = response.data as Array<{ name: string; role: string | null; taskCount: number }>;
      const lines = columns.map((column) => {
        const roleTag = column.role ? ` (${column.role})` : '';
        return `- ${column.name}${roleTag}: ${column.taskCount} task(s)`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }),
  );

  // --- kangentic_list_tasks ---
  server.registerTool(
    'kangentic_list_tasks',
    {
      description: 'List tasks on the Kangentic board. Optionally filter by column name. Pass `project` to list tasks from a different project.',
      inputSchema: z.object({
        column: z.string().optional().describe('Filter by column name. If omitted, returns all tasks.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ column, project }) => withProject(resolver, project, async (ctx) => {
      const response = await runHandler('list_tasks', { column: column ?? null }, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list tasks: ${response.error}` }], isError: true };
      }
      const tasks = response.data as Array<{ id: string; displayId: number; title: string; description: string; column: string }>;
      if (tasks.length === 0) {
        const filterNote = column ? ` in "${column}"` : '';
        return { content: [{ type: 'text' as const, text: `No tasks found${filterNote}.` }] };
      }
      const lines = tasks.map((task) => {
        const descriptionPreview = task.description
          ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
          : '';
        return `- [${task.column}] ${task.title}${descriptionPreview} (#${task.displayId}, id: ${task.id})`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }),
  );

  // --- kangentic_search_tasks ---
  server.registerTool(
    'kangentic_search_tasks',
    {
      description: 'Search by keyword across BOTH the board (active + completed/archived tasks) AND the backlog. This is the default tool to reach for when you want to find a task by title, description, or backlog label - it covers items regardless of whether they have been promoted from backlog to board. Use `scope` to narrow to one surface, and `status` to narrow board hits to active or completed. Pass `project` to search a different project.',
      inputSchema: z.object({
        query: z.string().describe('Search keyword or phrase to match against task titles and descriptions (case-insensitive). Backlog hits also match on labels.'),
        scope: z.enum(['board', 'backlog', 'both']).optional().describe('Which surface to search. "both" (default) covers board tasks and backlog items in one call. "board" restricts to the kanban board. "backlog" restricts to backlog items.'),
        status: z.enum(['active', 'completed', 'all']).optional().describe('Filter board hits by status. "active" = on the board, "completed" = in Done/archived. Ignored for backlog hits. Defaults to "all".'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scope, status, project }) => withProject(resolver, project, async (ctx) => {
      const effectiveScope: SearchScope = scope ?? 'both';
      const response = await runHandler('search_tasks', {
        query,
        status: status ?? 'all',
        scope: effectiveScope,
      }, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to search tasks: ${response.error}` }], isError: true };
      }
      const results = response.data as {
        tasks: BoardHit[];
        backlog: BacklogHit[];
        totalActive: number;
        totalCompleted: number;
        totalBacklog: number;
        scope: SearchScope;
      };

      const totalHits = results.tasks.length + results.backlog.length;
      if (totalHits === 0) {
        return { content: [{ type: 'text' as const, text: `No tasks matching "${query}" found (scope: ${results.scope}).` }] };
      }

      const sections: string[] = [];

      if (effectiveScope === 'both') {
        sections.push(`Found ${totalHits} item(s) matching "${query}" (${results.totalActive} active, ${results.totalCompleted} completed, ${results.totalBacklog} backlog):`);
      } else if (effectiveScope === 'board') {
        sections.push(`Found ${results.tasks.length} board task(s) matching "${query}" (${results.totalActive} active, ${results.totalCompleted} completed):`);
      } else {
        sections.push(`Found ${results.totalBacklog} backlog item(s) matching "${query}":`);
      }

      if (results.tasks.length > 0) {
        if (effectiveScope === 'both') sections.push(`\nBoard (${results.tasks.length}):`);
        const taskLines = results.tasks.map((task) => {
          const descriptionPreview = task.description
            ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
            : '';
          const statusTag = task.status === 'completed' ? ' [completed]' : ` [${task.column}]`;
          return `- ${task.title}${statusTag}${descriptionPreview} (#${task.displayId}, id: ${task.id})`;
        });
        sections.push(taskLines.join('\n'));
      }

      if (results.backlog.length > 0) {
        if (effectiveScope === 'both') sections.push(`\nBacklog (${results.backlog.length}):`);
        const backlogLines = results.backlog.map((item) => {
          const labelString = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
          const descriptionPreview = item.description
            ? ` - ${item.description.slice(0, 100)}${item.description.length > 100 ? '...' : ''}`
            : '';
          return `- ${item.title} (${item.priorityLabel})${labelString}${descriptionPreview} (id: ${item.id})`;
        });
        sections.push(backlogLines.join('\n'));
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    }),
  );

  // --- kangentic_get_task_stats ---
  server.registerTool(
    'kangentic_get_task_stats',
    {
      description: 'Get session metrics and statistics for tasks. Returns token usage, cost, duration, tool calls, and lines changed. Can query a specific task or get a summary across all completed tasks, optionally filtered by keyword. Pass `project` to query a different project.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). If omitted, returns aggregate stats across completed tasks.'),
        query: z.string().optional().describe('Filter completed tasks by keyword in title/description before aggregating stats.'),
        sortBy: z.enum(['tokens', 'cost', 'duration', 'toolCalls', 'linesChanged']).optional().describe('Sort results by this metric (descending). Defaults to "tokens". Only applies when querying multiple tasks.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ taskId, query, sortBy, project }) => withProject(resolver, project, (ctx) => callHandler('get_task_stats', {
      taskId: taskId ?? null,
      query: query ?? null,
      sortBy: sortBy ?? 'tokens',
    }, ctx, 'Failed to get task stats')),
  );

  // --- kangentic_find_task ---
  server.registerTool(
    'kangentic_find_task',
    {
      description: 'Find a task or backlog item by display ID (e.g. 24, the "#24" shown in the UI), UUID, branch name, title keyword, or PR number. Returns full board-task details (branch_name, worktree, PR info, column) and/or matching backlog items. The `id` (UUID) and `title` filters span both board and backlog; `displayId`, `branch`, and `prNumber` are board-only since backlog items don\'t carry those fields. Use displayId for the fastest exact lookup when the user references a task by its "#N" identifier. Pass `project` to look up a task in a different project.',
      inputSchema: z.object({
        displayId: z.number().int().positive().optional().describe('Numeric task display ID shown in the UI (e.g. 24 for "#24"). Board-only, exact match.'),
        id: z.string().optional().describe('Full UUID. Matches against board-task UUIDs and backlog-item UUIDs.'),
        branch: z.string().optional().describe('Git branch name to search for (matches the tasks.branch_name column, exact or partial, e.g. "feature/92294"). Board-only.'),
        title: z.string().optional().describe('Keyword to search in titles (case-insensitive). Matches board tasks and backlog items.'),
        prNumber: z.number().optional().describe('Pull request number to search for. Board-only.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ displayId, id, branch, title, prNumber, project }) => {
      if (displayId === undefined && !id && !branch && !title && prNumber === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Provide at least one search parameter: displayId, id, branch, title, or prNumber.' }],
          isError: true,
        };
      }
      return withProject(resolver, project, (ctx) => callHandler('find_task', {
        displayId: displayId ?? null,
        id: id ?? null,
        branch: branch ?? null,
        title: title ?? null,
        prNumber: prNumber ?? null,
      }, ctx, 'Failed to find task'));
    },
  );

  // --- kangentic_get_current_task ---
  // Intentionally does NOT accept `project`. This tool resolves the task
  // that owns the agent's own CWD/branch, which is by definition in the
  // project the agent is running inside. Cross-project lookup makes no
  // sense here.
  server.registerTool(
    'kangentic_get_current_task',
    {
      description: 'Resolve the Kangentic task that corresponds to the current working directory and/or git branch. Use this at the start of work in a worktree to confirm which task you are operating on (e.g. before commits, PRs, or merge-back). Pass the agent\'s CWD and/or current branch name. Matches against tasks.worktree_path (full path or .kangentic/worktrees/<slug> segment) and tasks.branch_name. Returns the same shape as kangentic_find_task.',
      inputSchema: z.object({
        cwd: z.string().optional().describe('Absolute working directory path. The tool extracts the worktree slug from .kangentic/worktrees/<slug> and matches against tasks.worktree_path.'),
        branch: z.string().optional().describe('Current git branch name. Exact (case-insensitive) match against tasks.branch_name.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ cwd, branch }) => {
      if (!cwd && !branch) {
        return {
          content: [{ type: 'text' as const, text: 'Provide at least one of: cwd, branch.' }],
          isError: true,
        };
      }
      const defaultContext = resolver.defaultContextResolved().context;
      return callHandler('get_current_task', { cwd: cwd ?? null, branch: branch ?? null }, defaultContext, 'Failed to get current task');
    },
  );

  // --- kangentic_board_summary ---
  server.registerTool(
    'kangentic_board_summary',
    {
      description: 'Get a high-level summary of the Kangentic board: task counts per column, active sessions, completed task count, and aggregate cost/token usage across all sessions. Pass `project` to summarize a different project.',
      inputSchema: z.object({
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ project }) => withProject(resolver, project, (ctx) => callHandler('board_summary', {}, ctx, 'Failed to get board summary')),
  );

  // --- kangentic_get_column_detail ---
  server.registerTool(
    'kangentic_get_column_detail',
    {
      description: 'Get detailed configuration for a board column: automation settings (auto-spawn, auto-command, permission mode), plan exit target, role, and visual settings. Pass `project` to inspect a column in a different project.',
      inputSchema: z.object({
        column: z.string().describe('Column name (case-insensitive).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ column, project }) => withProject(resolver, project, (ctx) => callHandler('get_column_detail', { column }, ctx, 'Failed to get column detail')),
  );

  // --- kangentic_update_task ---
  server.registerTool(
    'kangentic_update_task',
    {
      description: 'Update an existing task. Supports title, description (full replace, in-place find/replace edits, or append), PR info, agent assignment, priority, labels, base branch, worktree toggle, and attaching files. To move a task between columns, use kangentic_move_task instead. Find the task ID first with kangentic_find_task. Pass `project` to update a task in a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        title: z.string().max(200).optional().describe('New task title (max 200 characters).'),
        description: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).optional().describe('New task description (markdown). Replaces the entire description. For an incremental change to a long description, prefer descriptionEdits or appendDescription instead - they cost far fewer tokens and cannot silently drop untouched sections. Mutually exclusive with descriptionEdits and appendDescription.'),
        descriptionEdits: z.array(z.object({
          find: z.string().min(1).max(TASK_DESCRIPTION_MAX_LENGTH).describe('Exact text to find in the current description. Must appear exactly once.'),
          replace: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).describe('Text to replace it with.'),
        })).min(1).max(100).describe('Ordered exact-string replacements applied to the current description, like the file Edit tool. Each edit\'s `find` must be present and unique in the text as it stands after the prior edits in the list; a missing or non-unique `find` fails the entire call and writes nothing. Mutually exclusive with `description`; may be combined with `appendDescription` (edits apply first, then the append).').optional(),
        appendDescription: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).optional().describe('Text appended to the end of the current description, exactly as given (no separator is inserted). Mutually exclusive with `description`; may be combined with `descriptionEdits` (edits apply first, then this append).'),
        prUrl: z.string().url().optional().describe('Pull request URL (e.g. https://github.com/owner/repo/pull/123).'),
        prNumber: z.number().int().positive().optional().describe('Pull request number.'),
        agent: z.string().optional().describe('Agent name to assign (e.g. "claude", "codex"). Pass empty string to clear.'),
        priority: z.number().int().min(0).max(4).optional().describe('Task priority 0-4 (0 = none, 4 = highest).'),
        labels: z.array(z.string()).optional().describe('Replace the task\'s label list. Pass [] to clear all labels. If this same call also sets a long description (roughly 1KB or more), set labels in a separate labels-only update instead, or they may be dropped before reaching the server.'),
        baseBranch: z.string().optional().describe('Base branch the task\'s worktree branches from (e.g. "main").'),
        useWorktree: z.boolean().optional().describe('Whether the task uses an isolated git worktree.'),
        attachments: z.array(z.object({
          filePath: z.string().describe('Absolute path to the file to attach'),
          filename: z.string().optional().describe('Override display filename'),
        })).optional().describe('File attachments to ADD to the task. This is additive - existing attachments are kept, not replaced. Each entry needs `filePath` (absolute) and may override the display `filename`. Use kangentic_remove_task_attachment to remove one.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, title, description, descriptionEdits, appendDescription, prUrl, prNumber, agent, priority, labels, baseBranch, useWorktree, attachments, project }) => {
      if (
        title === undefined && description === undefined && descriptionEdits === undefined && appendDescription === undefined &&
        prUrl === undefined && prNumber === undefined &&
        agent === undefined && priority === undefined && labels === undefined && baseBranch === undefined &&
        useWorktree === undefined && attachments === undefined
      ) {
        return { content: [{ type: 'text' as const, text: 'Provide at least one field to update.' }], isError: true };
      }
      if (description !== undefined && (descriptionEdits !== undefined || appendDescription !== undefined)) {
        return { content: [{ type: 'text' as const, text: 'Pass either `description` (full replace) or `descriptionEdits`/`appendDescription` (in-place edits), not both.' }], isError: true };
      }
      return withProject(resolver, project, (ctx) => callHandler('update_task', {
        taskId,
        title: title ?? null,
        description: description ?? null,
        descriptionEdits: descriptionEdits ?? null,
        appendDescription: appendDescription ?? null,
        prUrl: prUrl ?? null,
        prNumber: prNumber ?? null,
        agent: agent ?? null,
        priority: priority ?? null,
        labels: labels ?? null,
        baseBranch: baseBranch ?? null,
        useWorktree: useWorktree ?? null,
        attachments: attachments ?? null,
      }, ctx, 'Failed to update task'));
    },
  );

  // --- kangentic_link_pr ---
  server.registerTool(
    'kangentic_link_pr',
    {
      description: 'Authoritatively resolve and link the pull request for a task\'s git branch using the gh CLI (`gh pr list --head <branch>`). Unlike the terminal-scraping auto-linker, this finds PRs opened by a human, the web UI, `git push`, scripts, or `gh api`, and works even when the task has no live session. Re-running refreshes the linked PR\'s state (open/draft/merged/closed). Use after opening a PR, or to backfill a task whose PR was never linked. Find the task ID first with kangentic_find_task. Pass `project` to target a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, project }) => withProject(resolver, project, (ctx) => callHandler('link_pr', { taskId }, ctx, 'Failed to resolve PR')),
  );

  // --- kangentic_move_task ---
  server.registerTool(
    'kangentic_move_task',
    {
      description: 'Move a task to a different column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task. Moving to To Do kills the session and removes the worktree. If the user\'s prompt names a different Kangentic project, pass that name as `project` to route the move to that project instead of the active default. The name counts however it is phrased: "move task #7 in X to Done", "on the X board", and "in X" all target project X.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        column: z.string().describe('Target column name (case-insensitive, e.g. "Review", "In Progress", "Done").'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, column, project }) => withProject(resolver, project, (ctx) => callHandler('move_task', { taskId, column }, ctx, 'Failed to move task')),
  );

  // --- kangentic_move_task_to_project ---
  server.registerTool(
    'kangentic_move_task_to_project',
    {
      description: 'Relocate a task from the To Do column of one project\'s board to a different project\'s board. Only tasks in To Do can be moved (a task outside To Do may have a live session or worktree that cannot cross projects - move it to To Do first). Preserves title, description, labels, priority, creation time, and attachments; assigns a new task ID and display number in the target project. Lands in the target board\'s To Do column by default, or pass `column` to land in a different target column. `targetProject` is required - use kangentic_list_projects to find valid names. `project` optionally selects the source project (defaults to the active one) the same way it does on other tools.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID) of the To Do task in the source project.'),
        targetProject: z.string().min(1, 'targetProject is required and must name a different project than the source.').describe('Destination project name (case-insensitive) or UUID. Must be a different project than the source.'),
        column: z.string().optional().describe('Target column on the destination board (case-insensitive). Defaults to the destination board\'s To Do column.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, targetProject, column, project }) => {
      const target = resolver.resolveProject(targetProject);
      if ('error' in target) {
        return { content: [{ type: 'text' as const, text: target.error }], isError: true };
      }
      const sourceResolved = resolver.resolveProject(project);
      if ('error' in sourceResolved) {
        return { content: [{ type: 'text' as const, text: sourceResolved.error }], isError: true };
      }
      if (sourceResolved.projectId === target.projectId) {
        return {
          content: [{ type: 'text' as const, text: 'Source and target are the same project. Use kangentic_move_task to move a task between columns within a project.' }],
          isError: true,
        };
      }
      try {
        const response = handleMoveTaskToProject({ taskId, column }, sourceResolved.context, target.context);
        return response.success
          ? { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data ?? {}) }] }
          : { content: [{ type: 'text' as const, text: response.error ?? 'Failed to move task to project' }], isError: true };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  // --- kangentic_update_column ---
  server.registerTool(
    'kangentic_update_column',
    {
      description: 'Update a swimlane (column) configuration. Supports renaming, setting a free-form description, recoloring, toggling auto-spawn, setting an auto-command template, overriding the agent for the column, changing permission mode, enabling handoff context, and setting a plan-exit target column. Use kangentic_get_column_detail to inspect current values first. Pass `project` to update a column in a different project.',
      inputSchema: z.object({
        column: z.string().describe('Column name to update (case-insensitive, e.g. "Review").'),
        name: z.string().max(100).optional().describe('New column name.'),
        description: z.string().max(1000).nullable().optional().describe('Free-form description of the column\'s purpose, shown as a header tooltip and shared with the team via kangentic.json. Null to clear.'),
        color: z.string().optional().describe('Hex color (e.g. "#71717a").'),
        icon: z.string().nullable().optional().describe('Lucide icon name, or null to clear.'),
        autoSpawn: z.boolean().optional().describe('Whether moving a task into this column auto-spawns an agent.'),
        autoCommand: z.string().max(4000).nullable().optional().describe('Slash command template injected when an agent spawns in this column (e.g. "/review --strict"). Null to clear.'),
        agentOverride: z.string().nullable().optional().describe('Force a specific agent for this column (e.g. "codex"). Null to use project default.'),
        modelOverride: z.string().max(200).nullable().optional().describe('Adapter-specific model identifier passed at spawn time (e.g. Claude "opus", "sonnet", "claude-opus-4-7"). Null to inherit the agent default.'),
        effortOverride: z.string().max(50).nullable().optional().describe('Adapter-specific effort/reasoning level passed at spawn time (e.g. Claude "low", "medium", "high", "xhigh", "max"). Valid values are agent-specific. Null to inherit the agent default.'),
        permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']).nullable().optional().describe('Permission mode for agents spawned in this column. Null to use project default.'),
        handoffContext: z.boolean().optional().describe('Enable multi-agent handoff context preservation when entering this column.'),
        planExitTargetColumn: z.string().nullable().optional().describe('Column to auto-move the task to when an agent in plan mode exits planning. Null to disable.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ column, name, description, color, icon, autoSpawn, autoCommand, agentOverride, modelOverride, effortOverride, permissionMode, handoffContext, planExitTargetColumn, project }) => withProject(resolver, project, (ctx) => callHandler('update_column', {
      column,
      name: name ?? undefined,
      description: description === undefined ? undefined : description,
      color: color ?? undefined,
      icon: icon === undefined ? undefined : icon,
      autoSpawn: autoSpawn ?? undefined,
      autoCommand: autoCommand === undefined ? undefined : autoCommand,
      agentOverride: agentOverride === undefined ? undefined : agentOverride,
      modelOverride: modelOverride === undefined ? undefined : modelOverride,
      effortOverride: effortOverride === undefined ? undefined : effortOverride,
      permissionMode: permissionMode === undefined ? undefined : permissionMode,
      handoffContext: handoffContext ?? undefined,
      planExitTargetColumn: planExitTargetColumn === undefined ? undefined : planExitTargetColumn,
    }, ctx, 'Failed to update column')),
  );

  // --- kangentic_delete_task ---
  server.registerTool(
    'kangentic_delete_task',
    {
      description: 'Permanently delete a task from the Kangentic board. This removes the task, its attachments, and session records. The associated worktree and branch may also be cleaned up. Find the task ID first with kangentic_find_task or kangentic_search_tasks. Pass `project` to delete a task in a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, project }) => withProject(resolver, project, (ctx) => callHandler('delete_task', { taskId }, ctx, 'Failed to delete task')),
  );

  // --- kangentic_remove_task_attachment ---
  server.registerTool(
    'kangentic_remove_task_attachment',
    {
      description: 'Remove one attachment by its attachment ID, from a board task or a backlog item - the ID alone determines which. Find attachment IDs with kangentic_query_db (e.g. `SELECT id, filename, task_id FROM task_attachments` for board tasks, or `SELECT id, filename, backlog_task_id FROM backlog_attachments` for backlog items). Pass `project` to remove an attachment in a different project.',
      inputSchema: z.object({
        attachmentId: z.string().describe('Attachment UUID (board task_attachments.id or backlog backlog_attachments.id).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ attachmentId, project }) => withProject(resolver, project, (ctx) => callHandler('remove_attachment', { attachmentId }, ctx, 'Failed to remove attachment')),
  );
}
