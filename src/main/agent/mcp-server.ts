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
const COMMAND_TIMEOUT_MS = 10_000;
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
    description: 'Create a new task on the Kangentic board. Use this when you identify work that should be tracked separately (bugs, refactoring opportunities, follow-ups, improvements).',
    inputSchema: {
      title: z.string().max(200).describe('Task title (max 200 characters)'),
      description: z.string().max(10000).optional().describe('Task description. Supports markdown.'),
      column: z.string().optional().describe('Target column name. Defaults to the Backlog column. Use kangentic_list_columns to see available columns.'),
      branchName: z.string().optional().describe('Custom git branch name for the task (e.g. "bugfix/login-screen"). If omitted, a branch name is auto-generated from the title.'),
      baseBranch: z.string().optional().describe('Base branch to create the task branch from (e.g. "develop", "main"). Defaults to the project setting.'),
      useWorktree: z.boolean().optional().describe('Whether to use a git worktree for isolation. Defaults to the project setting. Set false to work in the main repo.'),
    },
  },
  async ({ title, description, column, branchName, baseBranch, useWorktree }) => {
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
        branchName: branchName ?? null,
        baseBranch: baseBranch ?? null,
        useWorktree: useWorktree ?? null,
      });

      if (!response.success) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create task: ${response.error}` }],
          isError: true,
        };
      }

      taskCreationCount++;
      const data = response.data as { taskId: string; title: string; column: string };
      return {
        content: [{
          type: 'text' as const,
          text: response.message ?? `Created task "${data.title}" in ${data.column} column (id: ${data.taskId})`,
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
    inputSchema: {},
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
    inputSchema: {
      column: z.string().optional().describe('Filter by column name. If omitted, returns all tasks.'),
    },
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

      const tasks = response.data as Array<{ id: string; title: string; description: string; column: string }>;
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
        return `- [${task.column}] ${task.title}${descriptionPreview} (id: ${task.id})`;
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
    description: 'Search tasks by keyword across titles and descriptions. Searches both active and completed (archived) tasks.',
    inputSchema: {
      query: z.string().describe('Search keyword or phrase to match against task titles and descriptions (case-insensitive).'),
      status: z.enum(['active', 'completed', 'all']).optional().describe('Filter by task status. "active" = on the board, "completed" = in Done/archived. Defaults to "all".'),
    },
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
        tasks: Array<{ id: string; title: string; description: string; column: string; status: string }>;
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
        return `- ${task.title}${statusTag}${descriptionPreview} (id: ${task.id})`;
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
    inputSchema: {
      taskId: z.string().optional().describe('Specific task ID to get stats for. If omitted, returns aggregate stats across completed tasks.'),
      query: z.string().optional().describe('Filter completed tasks by keyword in title/description before aggregating stats.'),
      sortBy: z.enum(['tokens', 'cost', 'duration', 'toolCalls', 'linesChanged']).optional().describe('Sort results by this metric (descending). Defaults to "tokens". Only applies when querying multiple tasks.'),
    },
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
    description: 'Find a task by branch name, title keyword, or PR number. Returns full task details including branch, worktree, PR info, and current column. Use this to check if a task exists for a given branch or feature.',
    inputSchema: {
      branch: z.string().optional().describe('Git branch name to search for (exact or partial match, e.g. "feature/92294" or "bugfix/login").'),
      title: z.string().optional().describe('Keyword to search in task titles (case-insensitive).'),
      prNumber: z.number().optional().describe('Pull request number to search for.'),
    },
  },
  async ({ branch, title, prNumber }) => {
    if (!branch && !title && prNumber === undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Provide at least one search parameter: branch, title, or prNumber.' }],
        isError: true,
      };
    }
    try {
      const response = await sendCommand('find_task', {
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

// --- kangentic_board_summary ---
server.registerTool(
  'kangentic_board_summary',
  {
    description: 'Get a high-level summary of the Kangentic board: task counts per column, active sessions, completed task count, and aggregate cost/token usage across all sessions.',
    inputSchema: {},
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
    description: 'Get the session history for a task: how many sessions it went through, when they started/ended, exit codes, and whether they were suspended by user or system. Find the task ID first with kangentic_find_task or kangentic_search_tasks.',
    inputSchema: {
      taskId: z.string().describe('Task ID to get session history for.'),
    },
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
    inputSchema: {
      column: z.string().describe('Column name (case-insensitive).'),
    },
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
    description: 'Update an existing task\'s title, description, or PR info. Find the task ID first with kangentic_find_task or kangentic_search_tasks.',
    inputSchema: {
      taskId: z.string().describe('Task ID to update.'),
      title: z.string().max(200).optional().describe('New task title (max 200 characters).'),
      description: z.string().max(10000).optional().describe('New task description (markdown). Replaces the entire description.'),
      prUrl: z.string().url().optional().describe('Pull request URL (e.g. https://github.com/owner/repo/pull/123).'),
      prNumber: z.number().int().positive().optional().describe('Pull request number.'),
    },
  },
  async ({ taskId, title, description, prUrl, prNumber }) => {
    if (!title && description === undefined && prUrl === undefined && prNumber === undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Provide at least one field to update: title, description, prUrl, or prNumber.' }],
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
