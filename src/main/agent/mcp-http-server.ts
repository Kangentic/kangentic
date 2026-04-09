/**
 * Kangentic in-process MCP HTTP server.
 *
 * Hosts the kangentic_* MCP tools directly inside Electron main via
 * Node's built-in `http` module + `@modelcontextprotocol/sdk` Streamable
 * HTTP transport. Tool handlers run synchronously against the project
 * DB via the `commandHandlers` map -- no subprocess, no file bridge,
 * no offset tracking.
 *
 * URL shape: http://127.0.0.1:<port>/mcp/<projectId>
 * Auth: random per-launch token, validated via `X-Kangentic-Token` header
 * Bind: 127.0.0.1 only -- loopback skips Windows Defender Firewall
 *       prompts and is unreachable from other machines.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { commandHandlers } from './commands';
import type { CommandContext, CommandResponse } from './commands';

const SERVER_NAME = 'kangentic';
const SERVER_VERSION = '1.0.0';
const MAX_TASKS_PER_SESSION = 50;

/**
 * Builds a CommandContext for a given project. The HTTP server calls this
 * once per request -- main process owns the project lifecycle and provides
 * the factory at startup time.
 */
export type ProjectContextFactory = (projectId: string) => CommandContext | null;

/**
 * Atomic create_task rate-limit counter shared across all requests served
 * by one server-launch. Encapsulated as a getter+mutator pair so the
 * check-and-increment is impossible to race in the JS event loop.
 */
interface TaskCounter {
  /** Reserve one slot. Returns false if the rate-limit ceiling is reached. */
  tryReserve(): boolean;
}

export interface McpHttpServerHandle {
  /** Full URL with port substituted in. Pass to claude --mcp-config or write into mcp.json. */
  baseUrl: string;
  /** Random per-launch token. Clients must send it as `X-Kangentic-Token`. */
  token: string;
  /** Build a project-scoped URL for the given project ID. */
  urlForProject(projectId: string): string;
  /** Synchronously stop accepting new connections and close the server. */
  close(): void;
}

/**
 * Start the HTTP server. Resolves once it's listening; the OS picks a
 * free port via `.listen(0)`.
 */
export async function startMcpHttpServer(
  buildContext: ProjectContextFactory,
): Promise<McpHttpServerHandle> {
  const token = randomBytes(32).toString('hex');
  const expectedTokenBuffer = Buffer.from(token, 'utf-8');
  // Per-server-launch rate-limit counter for create_task, shared across
  // every request served by this main process. tryReserve() is the only
  // entry point so the check-and-increment is atomic against the JS
  // event loop -- no await between read and write.
  const taskCounter: TaskCounter = (() => {
    let count = 0;
    return {
      tryReserve: () => {
        if (count >= MAX_TASKS_PER_SESSION) return false;
        count++;
        return true;
      },
    };
  })();

  const httpServer: Server = createServer((req, res) => {
    handleHttpRequest(req, res, expectedTokenBuffer, buildContext, taskCounter)
      .catch((error) => {
        console.error('[mcp-http] Request handler crashed:', error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else if (!res.writableEnded) {
          res.end();
        }
      });
  });

  // Permanent error listener so any post-listen server-level errors (e.g.,
  // EMFILE under heavy load, EADDRINUSE if a stale binding lingers) get
  // logged instead of crashing main with an unhandled "error" event.
  httpServer.on('error', (error) => {
    console.error('[mcp-http] Server error:', error);
  });

  // Bind 127.0.0.1 explicitly. NOT 'localhost' (which can resolve to ::1
  // on IPv6-preferring systems and miss the 127.0.0.1 binding) and NOT
  // 0.0.0.0 (which exposes the port to the network and triggers a Windows
  // Defender Firewall prompt). Loopback v4 works identically on Windows,
  // macOS, and Linux.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw new Error('[mcp-http] Failed to obtain HTTP server address after listen()');
  }
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

  console.log(`[mcp-http] Listening on ${baseUrl}`);

  return {
    baseUrl,
    token,
    urlForProject: (projectId: string) => `${baseUrl}/${projectId}`,
    close: () => {
      try {
        httpServer.close();
      } catch (error) {
        console.error('[mcp-http] close() failed:', error);
      }
    },
  };
}

/** Validates the URL path and token, then dispatches to a per-request McpServer. */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedTokenBuffer: Buffer,
  buildContext: ProjectContextFactory,
  taskCounter: TaskCounter,
): Promise<void> {
  // Token check first -- cheapest reject path. Constant-time compare so a
  // local timing oracle can't byte-by-byte recover the token. Pure
  // belt-and-suspenders since we already bind 127.0.0.1 only and the
  // attacker would need same-machine code execution to even try.
  const headerToken = req.headers['x-kangentic-token'];
  if (typeof headerToken !== 'string') {
    res.statusCode = 401;
    res.end();
    return;
  }
  const headerTokenBuffer = Buffer.from(headerToken, 'utf-8');
  if (
    headerTokenBuffer.length !== expectedTokenBuffer.length ||
    !timingSafeEqual(headerTokenBuffer, expectedTokenBuffer)
  ) {
    res.statusCode = 401;
    res.end();
    return;
  }

  // Parse projectId from URL path. Expected: /mcp/<projectId>
  // (the SDK transport handles JSON-RPC body parsing -- we just route).
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'mcp') {
    res.statusCode = 404;
    res.end();
    return;
  }
  const projectId = segments[1];

  const context = buildContext(projectId);
  if (!context) {
    res.statusCode = 404;
    res.end();
    return;
  }

  // Per-request McpServer + transport. Stateless mode, plain JSON
  // responses (no SSE), built-in DNS rebinding protection on top of the
  // 127.0.0.1 bind for belt-and-suspenders.
  const mcpServer = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerKangenticTools(mcpServer, context, taskCounter);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1', `127.0.0.1:${req.socket.localPort ?? ''}`, 'localhost', '[::1]'],
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    // If connect() or handleRequest() threw before the response was
    // committed, write a 500 so the client doesn't hang waiting for a
    // body that will never arrive.
    console.error('[mcp-http] Per-request dispatch failed:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    // Best-effort cleanup of the per-request transport. The McpServer
    // has no per-instance heavy state to release.
    try { await transport.close(); } catch { /* already closed */ }
  }
}

/**
 * Invoke a handler (which may be sync or async) and return the raw
 * CommandResponse, converting any thrown error into a failure response.
 * Used by tools that need to apply custom result formatting.
 */
async function runHandler(
  handlerName: keyof typeof commandHandlers,
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> {
  try {
    const handler = commandHandlers[handlerName];
    if (!handler) {
      return { success: false, error: `Unknown command: ${String(handlerName)}` };
    }
    return await Promise.resolve(handler(params, context));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Run a handler and wrap its result as a default-shaped MCP tool result.
 * Tools that need custom formatting use `runHandler` directly instead.
 */
async function callHandler(
  handlerName: keyof typeof commandHandlers,
  params: Record<string, unknown>,
  context: CommandContext,
  fallbackText: string,
) {
  const response = await runHandler(handlerName, params, context);
  if (!response.success) {
    return {
      content: [{ type: 'text' as const, text: response.error ?? fallbackText }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data ?? {}) }],
  };
}

/** Register every kangentic_* tool against the given McpServer. */
function registerKangenticTools(
  server: McpServer,
  context: CommandContext,
  taskCounter: TaskCounter,
): void {
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
      // Atomic reserve: bumps the counter only if we're under the cap.
      // No await between the check and the increment, so this can't race.
      if (!taskCounter.tryReserve()) {
        return {
          content: [{ type: 'text' as const, text: `Rate limit reached: maximum ${MAX_TASKS_PER_SESSION} tasks per session.` }],
          isError: true,
        };
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
      }, context, 'Failed to create task');
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
      const response = await runHandler('list_columns', {}, context);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list columns: ${response.error}` }], isError: true };
      }
      const columns = response.data as Array<{ name: string; role: string | null; taskCount: number }>;
      const lines = columns.map((column) => {
        const roleTag = column.role ? ` (${column.role})` : '';
        return `- ${column.name}${roleTag}: ${column.taskCount} task(s)`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
      const response = await runHandler('list_tasks', { column: column ?? null }, context);
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
      const response = await runHandler('search_tasks', { query, status: status ?? 'all' }, context);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to search tasks: ${response.error}` }], isError: true };
      }
      const results = response.data as {
        tasks: Array<{ id: string; displayId: number; title: string; description: string; column: string; status: string }>;
        totalActive: number;
        totalCompleted: number;
      };
      if (results.tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: `No tasks matching "${query}" found.` }] };
      }
      const summary = `Found ${results.tasks.length} task(s) matching "${query}" (${results.totalActive} active, ${results.totalCompleted} completed):`;
      const lines = results.tasks.map((task) => {
        const descriptionPreview = task.description
          ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
          : '';
        const statusTag = task.status === 'completed' ? ' [completed]' : ` [${task.column}]`;
        return `- ${task.title}${statusTag}${descriptionPreview} (#${task.displayId}, id: ${task.id})`;
      });
      return { content: [{ type: 'text' as const, text: `${summary}\n${lines.join('\n')}` }] };
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
    async ({ taskId, query, sortBy }) => callHandler('get_task_stats', {
      taskId: taskId ?? null,
      query: query ?? null,
      sortBy: sortBy ?? 'tokens',
    }, context, 'Failed to get task stats'),
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
      return callHandler('find_task', {
        displayId: displayId ?? null,
        id: id ?? null,
        branch: branch ?? null,
        title: title ?? null,
        prNumber: prNumber ?? null,
      }, context, 'Failed to find task');
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
      return callHandler('get_current_task', { cwd: cwd ?? null, branch: branch ?? null }, context, 'Failed to get current task');
    },
  );

  // --- kangentic_board_summary ---
  server.registerTool(
    'kangentic_board_summary',
    {
      description: 'Get a high-level summary of the Kangentic board: task counts per column, active sessions, completed task count, and aggregate cost/token usage across all sessions.',
      inputSchema: z.object({}),
    },
    async () => callHandler('board_summary', {}, context, 'Failed to get board summary'),
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
    async ({ taskId }) => callHandler('get_session_history', { taskId }, context, 'Failed to get session history'),
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
    async ({ column }) => callHandler('get_column_detail', { column }, context, 'Failed to get column detail'),
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
        return { content: [{ type: 'text' as const, text: 'Provide at least one field to update.' }], isError: true };
      }
      return callHandler('update_task', {
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
      }, context, 'Failed to update task');
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
    async ({ taskId, column }) => callHandler('move_task', { taskId, column }, context, 'Failed to move task'),
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
    async ({ column, name, color, icon, autoSpawn, autoCommand, agentOverride, permissionMode, handoffContext, planExitTargetColumn }) => callHandler('update_column', {
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
    }, context, 'Failed to update column'),
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
    async ({ taskId }) => callHandler('delete_task', { taskId }, context, 'Failed to delete task'),
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
    async ({ priority, query }) => callHandler('list_backlog', {
      priority: priority ?? null,
      query: query ?? null,
    }, context, 'Failed to list backlog'),
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
    async ({ query }) => callHandler('search_backlog', { query }, context, 'Failed to search backlog'),
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
    async ({ itemIds, column }) => callHandler('promote_backlog', {
      itemIds,
      column: column ?? null,
    }, context, 'Failed to move backlog tasks'),
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
    async ({ taskId, section }) => callHandler('get_handoff_context', {
      taskId: taskId ?? null,
      section: section ?? 'all',
    }, context, 'Failed to get handoff context'),
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
    async ({ taskId, sessionId }) => callHandler('get_transcript', {
      taskId: taskId ?? null,
      sessionId: sessionId ?? null,
    }, context, 'Failed to get transcript'),
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
      const result = await runHandler('get_session_files', { taskId, sessionId, sessionIndex }, context);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session files: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
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
      const result = await runHandler('get_session_events', { taskId, sessionId, sessionIndex, tail, since, eventTypes }, context);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session events: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
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
    async ({ sql }) => callHandler('query_db', { sql }, context, 'Query error'),
  );
}

