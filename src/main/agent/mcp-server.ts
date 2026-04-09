/**
 * Kangentic MCP Server
 *
 * A stdio-based MCP server that Claude Code discovers via settings.json.
 * Allows agents to create and query tasks on the Kangentic board.
 *
 * Usage: node mcp-server.js <commandsPath> <responsesDir>
 *
 * Communication with the Electron main process uses a file-based command queue:
 *   - Commands are appended as JSON lines to <commandsPath>
 *   - Responses are written to <responsesDir>/<requestId>.json
 *
 * IMPORTANT: Only console.error() for logging. stdout is reserved for JSON-RPC.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const commandsPath = process.argv[2];
const responsesDir = process.argv[3];

if (!commandsPath || !responsesDir) {
  console.error('[mcp-server] Usage: node mcp-server.js <commandsPath> <responsesDir>');
  process.exit(1);
}

const POLL_INTERVAL_MS = 100;
// 30s ceiling stays well under MCP SDK client default of 60s; 10s was too
// tight for cold-start DB open + migrations on Windows.
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_TASKS_PER_SESSION = 50;

let taskCreationCount = 0;

interface CommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

/**
 * Send a command to the Electron main process via the file-based queue
 * and poll for the response.
 */
async function sendCommand(method: string, params: Record<string, unknown>): Promise<CommandResponse> {
  const requestId = randomUUID();
  const command = JSON.stringify({ id: requestId, method, params, ts: Date.now() });

  // Ensure parent directory exists
  const commandsDirectory = path.dirname(commandsPath);
  fs.mkdirSync(commandsDirectory, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });

  // Append command as a JSON line
  fs.appendFileSync(commandsPath, command + '\n');

  // Poll for response file
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(responsePath, 'utf-8');
      const response: CommandResponse = JSON.parse(raw);
      // Clean up response file
      try { fs.unlinkSync(responsePath); } catch { /* best effort */ }
      return response;
    } catch {
      // Response not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms: ${method}`);
}

const server = new McpServer({
  name: 'kangentic',
  version: '1.0.0',
});

// --- kangentic_create_task ---
server.registerTool(
  'kangentic_create_task',
  {
    description: 'Create a task on the Kangentic board (default: the To Do column on the active board) or in the backlog. This is the only task-creation tool - use it whenever the user asks to "create a task", "add a todo", "add to backlog", or similar. With no `column` argument, the task always lands in the active board\'s To Do column - never the backlog. Pass `column: "Backlog"` (case-insensitive) to create a backlog item instead. Pass any other column name (e.g. "Planning", "Code Review") to land directly in that board column. Board tasks get a git branch and are ready to work on immediately.',
    inputSchema: z.object({
      title: z.string().max(200).describe('Task title (max 200 characters)'),
      description: z.string().max(10000).optional().describe('Task description. Supports markdown.'),
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
      })).optional().describe('File attachments (array of file paths)'),
    }),
  },
  async ({ title, description, column, priority, labels, branchName, baseBranch, useWorktree, attachments }) => {
    console.error('[mcp] create_task params:', JSON.stringify({ title, description: description?.slice(0, 100), column }));
    if (taskCreationCount >= MAX_TASKS_PER_SESSION) {
      return {
        content: [{ type: 'text' as const, text: `Rate limit reached: maximum ${MAX_TASKS_PER_SESSION} tasks per session.` }],
        isError: true,
      };
    }

    try {
      const response = await sendCommand('create_task', {
        title,
        description: description ?? '',
        column: column ?? null,
        priority: priority ?? null,
        labels: labels ?? null,
        branchName: branchName ?? null,
        baseBranch: baseBranch ?? null,
        useWorktree: useWorktree ?? null,
        attachments: attachments ?? null,
      });

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create task: ${response.error}` }],
          isError: true,
        };
      }

      taskCreationCount++;
      return {
        content: [{
          type: 'text' as const,
          text: response.message ?? `Created task "${title}".`,
        }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error creating task: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// --- kangentic_list_columns ---
server.registerTool(
  'kangentic_list_columns',
  {
    description: 'List all columns (swimlanes) on the Kangentic board. Returns column names, roles, and task counts.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const response = await sendCommand('list_columns', {});

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list columns: ${response.error}` }],
          isError: true,
        };
      }

      const columns = response.data as Array<{ name: string; role: string | null; taskCount: number }>;
      const lines = columns.map((column) => {
        const roleTag = column.role ? ` (${column.role})` : '';
        return `- ${column.name}${roleTag}: ${column.taskCount} task(s)`;
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error listing columns: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// --- kangentic_list_tasks ---
server.registerTool(
  'kangentic_list_tasks',
  {
    description: 'List tasks on the Kangentic board. Optionally filter by column name.',
    inputSchema: z.object({
      column: z.string().optional().describe('Filter by column name. If omitted, returns all tasks.'),
    }),
  },
  async ({ column }) => {
    try {
      const response = await sendCommand('list_tasks', { column: column ?? null });

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list tasks: ${response.error}` }],
          isError: true,
        };
      }

      const tasks = response.data as Array<{ id: string; displayId: number; title: string; description: string; column: string }>;
      if (tasks.length === 0) {
        const filterNote = column ? ` in "${column}"` : '';
        return {
          content: [{ type: 'text' as const, text: `No tasks found${filterNote}.` }],
        };
      }

      const lines = tasks.map((task) => {
        const descriptionPreview = task.description
          ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
          : '';
        return `- [${task.column}] ${task.title}${descriptionPreview} (#${task.displayId}, id: ${task.id})`;
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error listing tasks: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// --- kangentic_search_tasks ---
server.registerTool(
  'kangentic_search_tasks',
  {
    description: 'Search board tasks by keyword across titles and descriptions. Searches both active and completed (archived) tasks. Does not search backlog tasks - use kangentic_search_backlog for that.',
    inputSchema: z.object({
      query: z.string().describe('Search keyword or phrase to match against task titles and descriptions (case-insensitive).'),
      status: z.enum(['active', 'completed', 'all']).optional().describe('Filter by task status. "active" = on the board, "completed" = in Done/archived. Defaults to "all".'),
    }),
  },
  async ({ query, status }) => {
    try {
      const response = await sendCommand('search_tasks', {
        query,
        status: status ?? 'all',
      });

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to search tasks: ${response.error}` }],
          isError: true,
        };
      }

      const results = response.data as {
        tasks: Array<{ id: string; displayId: number; title: string; description: string; column: string; status: string }>;
        totalActive: number;
        totalCompleted: number;
      };

      if (results.tasks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No tasks matching "${query}" found.` }],
        };
      }

      const summary = `Found ${results.tasks.length} task(s) matching "${query}" (${results.totalActive} active, ${results.totalCompleted} completed):`;
      const lines = results.tasks.map((task) => {
        const descriptionPreview = task.description
          ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
          : '';
        const statusTag = task.status === 'completed' ? ' [completed]' : ` [${task.column}]`;
        return `- ${task.title}${statusTag}${descriptionPreview} (#${task.displayId}, id: ${task.id})`;
      });

      return {
        content: [{ type: 'text' as const, text: `${summary}\n${lines.join('\n')}` }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error searching tasks: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// --- kangentic_get_task_stats ---
server.registerTool(
  'kangentic_get_task_stats',
  {
    description: 'Get session metrics and statistics for tasks. Returns token usage, cost, duration, tool calls, and lines changed. Can query a specific task or get a summary across all completed tasks, optionally filtered by keyword.',
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). If omitted, returns aggregate stats across completed tasks.'),
      query: z.string().optional().describe('Filter completed tasks by keyword in title/description before aggregating stats.'),
      sortBy: z.enum(['tokens', 'cost', 'duration', 'toolCalls', 'linesChanged']).optional().describe('Sort results by this metric (descending). Defaults to "tokens". Only applies when querying multiple tasks.'),
    }),
  },
  async ({ taskId, query, sortBy }) => {
    try {
      const response = await sendCommand('get_task_stats', {
        taskId: taskId ?? null,
        query: query ?? null,
        sortBy: sortBy ?? 'tokens',
      });

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get task stats: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error getting task stats: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// --- kangentic_find_task ---
server.registerTool(
  'kangentic_find_task',
  {
    description: 'Find a task by display ID (e.g. 24, the "#24" shown in the UI), task UUID, branch name, title keyword, or PR number. Returns full task details including branch_name, worktree, PR info, and current column. Use displayId for the fastest exact lookup when the user references a task by its "#N" identifier.',
    inputSchema: z.object({
      displayId: z.number().int().positive().optional().describe('Numeric task display ID shown in the UI (e.g. 24 for "#24"). Exact match.'),
      id: z.string().optional().describe('Full task UUID. Exact match.'),
      branch: z.string().optional().describe('Git branch name to search for (matches the tasks.branch_name column, exact or partial, e.g. "feature/92294").'),
      title: z.string().optional().describe('Keyword to search in task titles (case-insensitive).'),
      prNumber: z.number().optional().describe('Pull request number to search for.'),
    }),
  },
  async ({ displayId, id, branch, title, prNumber }) => {
    if (displayId === undefined && !id && !branch && !title && prNumber === undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Provide at least one search parameter: displayId, id, branch, title, or prNumber.' }],
        isError: true,
      };
    }
    try {
      const response = await sendCommand('find_task', {
        displayId: displayId ?? null,
        id: id ?? null,
        branch: branch ?? null,
        title: title ?? null,
        prNumber: prNumber ?? null,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to find task: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error finding task: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_current_task ---
server.registerTool(
  'kangentic_get_current_task',
  {
    description: 'Resolve the Kangentic task that corresponds to the current working directory and/or git branch. Use this at the start of work in a worktree to confirm which task you are operating on (e.g. before commits, PRs, or merge-back). Pass the agent\'s CWD and/or current branch name. Matches against tasks.worktree_path (full path or .kangentic/worktrees/<slug> segment) and tasks.branch_name. Returns the same shape as kangentic_find_task.',
    inputSchema: z.object({
      cwd: z.string().optional().describe('Absolute working directory path. The tool extracts the worktree slug from .kangentic/worktrees/<slug> and matches against tasks.worktree_path.'),
      branch: z.string().optional().describe('Current git branch name. Exact (case-insensitive) match against tasks.branch_name.'),
    }),
  },
  async ({ cwd, branch }) => {
    if (!cwd && !branch) {
      return {
        content: [{ type: 'text' as const, text: 'Provide at least one of: cwd, branch.' }],
        isError: true,
      };
    }
    try {
      const response = await sendCommand('get_current_task', {
        cwd: cwd ?? null,
        branch: branch ?? null,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get current task: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting current task: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_board_summary ---
server.registerTool(
  'kangentic_board_summary',
  {
    description: 'Get a high-level summary of the Kangentic board: task counts per column, active sessions, completed task count, and aggregate cost/token usage across all sessions.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const response = await sendCommand('board_summary', {});
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get board summary: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting board summary: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_session_history ---
server.registerTool(
  'kangentic_get_session_history',
  {
    description: 'Get the session history for a task: how many sessions it went through, when they started/ended, exit codes, suspension reasons, and per-session metrics. Each record now includes the Kangentic session id, agentSessionId (agent CLI resume id), cwd, sessionType, and the absolute eventsJsonlPath - feed any of these into kangentic_get_session_events / kangentic_get_session_files instead of guessing paths. Find the task ID first with kangentic_find_task or kangentic_search_tasks.',
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
    }),
  },
  async ({ taskId }) => {
    try {
      const response = await sendCommand('get_session_history', { taskId });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session history: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting session history: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_column_detail ---
server.registerTool(
  'kangentic_get_column_detail',
  {
    description: 'Get detailed configuration for a board column: automation settings (auto-spawn, auto-command, permission mode), plan exit target, role, and visual settings.',
    inputSchema: z.object({
      column: z.string().describe('Column name (case-insensitive).'),
    }),
  },
  async ({ column }) => {
    try {
      const response = await sendCommand('get_column_detail', { column });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get column detail: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting column detail: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_update_task ---
server.registerTool(
  'kangentic_update_task',
  {
    description: 'Update an existing task. Supports title, description, PR info, agent assignment, priority, labels, base branch, and worktree toggle. To move a task between columns, use kangentic_move_task instead. Find the task ID first with kangentic_find_task.',
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
      title: z.string().max(200).optional().describe('New task title (max 200 characters).'),
      description: z.string().max(10000).optional().describe('New task description (markdown). Replaces the entire description.'),
      prUrl: z.string().url().optional().describe('Pull request URL (e.g. https://github.com/owner/repo/pull/123).'),
      prNumber: z.number().int().positive().optional().describe('Pull request number.'),
      agent: z.string().optional().describe('Agent name to assign (e.g. "claude", "codex"). Pass empty string to clear.'),
      priority: z.number().int().min(0).max(4).optional().describe('Task priority 0-4 (0 = none, 4 = highest).'),
      labels: z.array(z.string()).optional().describe('Replace the task\'s label list. Pass [] to clear all labels.'),
      baseBranch: z.string().optional().describe('Base branch the task\'s worktree branches from (e.g. "main").'),
      useWorktree: z.boolean().optional().describe('Whether the task uses an isolated git worktree.'),
    }),
  },
  async ({ taskId, title, description, prUrl, prNumber, agent, priority, labels, baseBranch, useWorktree }) => {
    if (
      title === undefined && description === undefined && prUrl === undefined && prNumber === undefined &&
      agent === undefined && priority === undefined && labels === undefined && baseBranch === undefined && useWorktree === undefined
    ) {
      return {
        content: [{ type: 'text' as const, text: 'Provide at least one field to update.' }],
        isError: true,
      };
    }
    try {
      const response = await sendCommand('update_task', {
        taskId,
        title: title ?? null,
        description: description ?? null,
        prUrl: prUrl ?? null,
        prNumber: prNumber ?? null,
        agent: agent ?? null,
        priority: priority ?? null,
        labels: labels ?? null,
        baseBranch: baseBranch ?? null,
        useWorktree: useWorktree ?? null,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to update task: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? `Task updated.` }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error updating task: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_move_task ---
server.registerTool(
  'kangentic_move_task',
  {
    description: 'Move a task to a different column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task. Moving to To Do kills the session and removes the worktree.',
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
      column: z.string().describe('Target column name (case-insensitive, e.g. "Review", "In Progress", "Done").'),
    }),
  },
  async ({ taskId, column }) => {
    try {
      const response = await sendCommand('move_task', { taskId, column });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to move task: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? 'Task moved.' }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error moving task: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_update_column ---
server.registerTool(
  'kangentic_update_column',
  {
    description: 'Update a swimlane (column) configuration. Supports renaming, recoloring, toggling auto-spawn, setting an auto-command template, overriding the agent for the column, changing permission mode, enabling handoff context, and setting a plan-exit target column. Use kangentic_get_column_detail to inspect current values first.',
    inputSchema: z.object({
      column: z.string().describe('Column name to update (case-insensitive, e.g. "Review").'),
      name: z.string().max(100).optional().describe('New column name.'),
      color: z.string().optional().describe('Hex color (e.g. "#71717a").'),
      icon: z.string().nullable().optional().describe('Lucide icon name, or null to clear.'),
      autoSpawn: z.boolean().optional().describe('Whether moving a task into this column auto-spawns an agent.'),
      autoCommand: z.string().max(4000).nullable().optional().describe('Slash command template injected when an agent spawns in this column (e.g. "/review --strict"). Null to clear.'),
      agentOverride: z.string().nullable().optional().describe('Force a specific agent for this column (e.g. "codex"). Null to use project default.'),
      permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']).nullable().optional().describe('Permission mode for agents spawned in this column. Null to use project default.'),
      handoffContext: z.boolean().optional().describe('Enable multi-agent handoff context preservation when entering this column.'),
      planExitTargetColumn: z.string().nullable().optional().describe('Column to auto-move the task to when an agent in plan mode exits planning. Null to disable.'),
    }),
  },
  async ({ column, name, color, icon, autoSpawn, autoCommand, agentOverride, permissionMode, handoffContext, planExitTargetColumn }) => {
    try {
      const response = await sendCommand('update_column', {
        column,
        name: name ?? undefined,
        color: color ?? undefined,
        icon: icon === undefined ? undefined : icon,
        autoSpawn: autoSpawn ?? undefined,
        autoCommand: autoCommand === undefined ? undefined : autoCommand,
        agentOverride: agentOverride === undefined ? undefined : agentOverride,
        permissionMode: permissionMode === undefined ? undefined : permissionMode,
        handoffContext: handoffContext ?? undefined,
        planExitTargetColumn: planExitTargetColumn === undefined ? undefined : planExitTargetColumn,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to update column: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? 'Column updated.' }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error updating column: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_delete_task ---
server.registerTool(
  'kangentic_delete_task',
  {
    description: 'Permanently delete a task from the Kangentic board. This removes the task, its attachments, and session records. The associated worktree and branch may also be cleaned up. Find the task ID first with kangentic_find_task or kangentic_search_tasks.',
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
    }),
  },
  async ({ taskId }) => {
    console.error('[mcp] delete_task params:', JSON.stringify({ taskId }));
    try {
      const response = await sendCommand('delete_task', { taskId });

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to delete task: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: response.message ?? 'Task deleted.' }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error deleting task: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// --- kangentic_list_backlog ---
server.registerTool(
  'kangentic_list_backlog',
  {
    description: 'List items in the backlog staging area. The backlog holds work items before they are moved to the board. Items have priority levels and labels for organization.',
    inputSchema: z.object({
      priority: z.number().min(0).max(4).optional().describe('Filter by priority level: 0=none, 1=low, 2=medium, 3=high, 4=urgent.'),
      query: z.string().optional().describe('Search keyword to filter items by title, description, or labels (case-insensitive).'),
    }),
  },
  async ({ priority, query }) => {
    try {
      const response = await sendCommand('list_backlog', {
        priority: priority ?? null,
        query: query ?? null,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list backlog: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error listing backlog: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_search_backlog ---
server.registerTool(
  'kangentic_search_backlog',
  {
    description: 'Search backlog tasks by keyword across titles, descriptions, and labels.',
    inputSchema: z.object({
      query: z.string().describe('Search keyword or phrase (case-insensitive).'),
    }),
  },
  async ({ query }) => {
    try {
      const response = await sendCommand('search_backlog', { query });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to search backlog: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error searching backlog: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_promote_backlog ---
server.registerTool(
  'kangentic_promote_backlog',
  {
    description: 'Move one or more backlog tasks to the board, creating tasks in the specified column. Moved items are removed from the backlog. Find item IDs with kangentic_list_backlog or kangentic_search_backlog.',
    inputSchema: z.object({
      itemIds: z.array(z.string()).describe('Backlog task IDs to move to the board.'),
      column: z.string().optional().describe('Target column name. Defaults to the To Do column.'),
    }),
  },
  async ({ itemIds, column }) => {
    try {
      const response = await sendCommand('promote_backlog', {
        itemIds,
        column: column ?? null,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to move backlog tasks: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? `Moved ${itemIds.length} item(s) to the board.` }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error moving backlog tasks: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_handoff_context ---
server.registerTool(
  'kangentic_get_handoff_context',
  {
    description: 'Get the full handoff context for a task. Call this when you are continuing work started by a previous agent. Returns the prior session transcript, git changes, commit messages, and metrics. Use this for structured access to the prior agent\'s work.',
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
      section: z.enum(['all', 'decisions', 'changes', 'transcript', 'metrics']).optional()
        .describe('Which section to retrieve. "all" returns everything. "decisions" returns commit messages. "changes" returns file change list. "transcript" returns the full session transcript. "metrics" returns cost/token/duration stats. Defaults to "all".'),
    }),
  },
  async ({ taskId, section }) => {
    try {
      const response = await sendCommand('get_handoff_context', {
        taskId: taskId ?? null,
        section: section ?? 'all',
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get handoff context: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting handoff context: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_transcript ---
server.registerTool(
  'kangentic_get_transcript',
  {
    description: 'Get the full ANSI-stripped session transcript for a task. Returns the complete terminal output from the agent session, useful for reviewing what an agent did, debugging issues, or auditing work. Find the task ID first with kangentic_find_task or kangentic_search_tasks.',
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). Returns transcript from the most recent session for this task.'),
      sessionId: z.string().optional().describe('Session UUID for a specific session. Use kangentic_get_session_history to find session IDs.'),
    }),
  },
  async ({ taskId, sessionId }) => {
    try {
      const response = await sendCommand('get_transcript', {
        taskId: taskId ?? null,
        sessionId: sessionId ?? null,
      });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get transcript: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? 'No transcript available.' }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting transcript: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_session_files ---
server.registerTool(
  'kangentic_get_session_files',
  {
    description: 'Get the absolute paths to every per-session file the runtime maintains for a session: events.jsonl (activity log), status.json (usage/metrics), settings.json (Claude Code settings + hooks), commands.jsonl (MCP queue), mcp.json, responses/ dir, and handoff-context.md. Use this to skip the "where is the events.jsonl?" dance - the runtime keys session directories by the Kangentic PTY session id (NOT agent_session_id) and always under the project root .kangentic/sessions/<id>/ (NOT under a worktree). Each file entry includes an "exists" flag. Provide either taskId or sessionId.',
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). Picks the latest session for the task by default.'),
      sessionId: z.string().optional().describe('Kangentic session UUID (the sessions.id column). Use kangentic_get_session_history to find session ids.'),
      sessionIndex: z.number().int().min(0).optional().describe('When taskId is given, which session to pick: 0 = newest (default), 1 = previous, etc. Sessions are ordered started_at DESC.'),
    }),
  },
  async ({ taskId, sessionId, sessionIndex }) => {
    try {
      const response = await sendCommand('get_session_files', { taskId, sessionId, sessionIndex });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session files: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting session files: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_get_session_events ---
server.registerTool(
  'kangentic_get_session_events',
  {
    description: 'Read parsed events from a session\'s events.jsonl activity log without needing to locate or open the file yourself. Each line is a JSON event emitted by the Claude Code hook bridge (PreToolUse, PostToolUse, Stop, Notification, etc.). Use this for idle-detection debugging, tracing tool usage, or replaying what an agent did. Filters: tail (last N matching events, default 200, max 2000), since (epoch ms - drop events older than this), eventTypes (only return events whose hook_event_name/type is in this list). Provide either taskId or sessionId.',
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID (numeric display ID or UUID). Picks the latest session by default.'),
      sessionId: z.string().optional().describe('Kangentic session UUID (sessions.id column).'),
      sessionIndex: z.number().int().min(0).optional().describe('When taskId is given, which session to pick: 0 = newest (default).'),
      tail: z.number().int().min(1).max(2000).optional().describe('Return the last N matching events. Default 200, hard cap 2000.'),
      since: z.number().int().optional().describe('Epoch milliseconds. Only return events with timestamp >= since.'),
      eventTypes: z.array(z.string()).optional().describe('Only return events whose hook_event_name or type matches one of these (e.g. ["PreToolUse", "Stop", "Notification"]).'),
    }),
  },
  async ({ taskId, sessionId, sessionIndex, tail, since, eventTypes }) => {
    try {
      const response = await sendCommand('get_session_events', { taskId, sessionId, sessionIndex, tail, since, eventTypes });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session events: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error getting session events: ${errorMessage}` }], isError: true };
    }
  },
);

// --- kangentic_query_db ---
server.registerTool(
  'kangentic_query_db',
  {
    description: 'Run a read-only SQL query against the current project database. Only SELECT, PRAGMA, and WITH (CTE) statements are allowed. Returns up to 100 rows as a markdown table. Useful for debugging, inspecting internal state, and answering questions about sessions, tasks, transcripts, handoffs, and other project data. Key tables: tasks, swimlanes, sessions, session_transcripts, handoffs, actions, swimlane_transitions, backlog_items. tasks columns: id (uuid), display_id (numeric, the "#N" shown in UI), title, description, swimlane_id, position, agent, session_id, worktree_path, branch_name (NOT "branch"), pr_number, pr_url, base_branch, use_worktree, labels (JSON array), priority, archived_at, created_at, updated_at. sessions columns: id (PTY/Kangentic session UUID, drives the .kangentic/sessions/<id>/ directory name), task_id, session_type (e.g. "claude", "codex"), agent_session_id (the agent CLI resume id - NOT named "claude_session_id"), command, cwd, permission_mode, prompt, status (running/suspended/exited/queued), exit_code, started_at, suspended_at, exited_at, suspended_by, plus metrics: total_cost_usd, total_input_tokens, total_output_tokens, model_id, model_display_name, total_duration_ms, tool_call_count, lines_added, lines_removed, files_changed. To read on-disk session files, prefer kangentic_get_session_files / kangentic_get_session_events instead of constructing paths manually. Use PRAGMA table_info(<table>) to discover columns of any other table.',
    inputSchema: z.object({
      sql: z.string().describe('SQL query to execute. Must be a SELECT, PRAGMA, or WITH statement. Examples: "SELECT * FROM session_transcripts", "SELECT name, sql FROM sqlite_master WHERE type=\'table\'", "PRAGMA table_info(sessions)"'),
    }),
  },
  async ({ sql }) => {
    try {
      const response = await sendCommand('query_db', { sql });
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Query error: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.message ?? 'No results.' }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error running query: ${errorMessage}` }], isError: true };
    }
  },
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-server] Kangentic MCP server started');
}

main().catch((error) => {
  console.error('[mcp-server] Fatal error:', error);
  process.exit(1);
});
