import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { callHandler, runHandler, withProject, PROJECT_SELECTOR_DESCRIPTION } from './handler-helpers';
import type { RequestResolver } from './project-resolver';

/**
 * Register the read-focused tools on an McpServer:
 *   - Session inspection (list, history, transcript, files, events, handoff)
 *   - Backlog ops (list, search, promote)
 *   - Low-level SQL escape hatch (query_db)
 *
 * These don't mutate board state (except promote_backlog, which is a
 * backlog -> board move, grouped here because it's backlog-facing
 * rather than board-facing). Split from task-tools to keep each file
 * coherent and under the 500-line soft ceiling.
 *
 * Every tool accepts an optional `project` argument. Session and
 * transcript lookups take taskId/sessionId which are per-project
 * identifiers, so the selector scopes the lookup to a different
 * project's DB. query_db runs read-only SQL against the target
 * project's per-project SQLite file.
 */
export function registerSessionTools(server: McpServer, resolver: RequestResolver): void {
  // --- kangentic_list_sessions ---
  server.registerTool(
    'kangentic_list_sessions',
    {
      description: 'List all session records for a task with metadata: start/end times, exit codes, suspension reasons, cost, token counts, and duration. Use this to see how many sessions a task went through and their lifecycle details. Each record includes the Kangentic session id, agentSessionId, cwd, sessionType, and eventsJsonlPath. Pass `project` to list sessions from a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ taskId, project }) => withProject(resolver, project, (ctx) => callHandler('list_sessions', { taskId }, ctx, 'Failed to list sessions')),
  );

  // --- kangentic_get_session_history ---
  server.registerTool(
    'kangentic_get_session_history',
    {
      description: 'Read the agent\'s native session history file for a task. Returns the raw file content (Claude JSONL conversation, Codex rollout JSONL, or Gemini chat JSON) from the most recent session. Use this to understand what the agent did, what decisions were made, and the full conversation history. Large files are truncated to the most recent portion. Pass `project` to read a session history from a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ taskId, project }) => withProject(resolver, project, async (ctx) => {
      const result = await runHandler('get_session_history', { taskId }, ctx);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session history: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: result.message ?? 'No session history available.' }] };
    }),
  );

  // --- kangentic_list_backlog ---
  server.registerTool(
    'kangentic_list_backlog',
    {
      description: 'List items in the backlog staging area. The backlog holds work items before they are moved to the board. Items have priority levels and labels for organization. Pass `project` to list a different project\'s backlog.',
      inputSchema: z.object({
        priority: z.number().min(0).max(4).optional().describe('Filter by priority level: 0=none, 1=low, 2=medium, 3=high, 4=urgent.'),
        query: z.string().optional().describe('Search keyword to filter items by title, description, or labels (case-insensitive).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ priority, query, project }) => withProject(resolver, project, (ctx) => callHandler('list_backlog', {
      priority: priority ?? null,
      query: query ?? null,
    }, ctx, 'Failed to list backlog')),
  );

  // --- kangentic_search_backlog ---
  server.registerTool(
    'kangentic_search_backlog',
    {
      description: 'Search backlog tasks by keyword across titles, descriptions, and labels. Pass `project` to search a different project\'s backlog.',
      inputSchema: z.object({
        query: z.string().describe('Search keyword or phrase (case-insensitive).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ query, project }) => withProject(resolver, project, (ctx) => callHandler('search_backlog', { query }, ctx, 'Failed to search backlog')),
  );

  // --- kangentic_promote_backlog ---
  server.registerTool(
    'kangentic_promote_backlog',
    {
      description: 'Move one or more backlog tasks to the board, creating tasks in the specified column. Moved items are removed from the backlog. Find item IDs with kangentic_list_backlog or kangentic_search_backlog. Pass `project` to promote items in a different project.',
      inputSchema: z.object({
        itemIds: z.array(z.string()).describe('Backlog task IDs to move to the board.'),
        column: z.string().optional().describe('Target column name. Defaults to the To Do column.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ itemIds, column, project }) => withProject(resolver, project, (ctx) => callHandler('promote_backlog', {
      itemIds,
      column: column ?? null,
    }, ctx, 'Failed to move backlog tasks')),
  );

  // --- kangentic_update_backlog_item ---
  server.registerTool(
    'kangentic_update_backlog_item',
    {
      description: 'Update a backlog item\'s title, description, priority, or labels. Only the fields you provide are changed; omitted fields are left as-is. Note that `labels` is a full replacement (not additive) - pass the complete new label set. Find item IDs with kangentic_list_backlog or kangentic_search_backlog. Pass `project` to update a backlog item in a different project.',
      inputSchema: z.object({
        itemId: z.string().describe('Backlog item UUID (from kangentic_list_backlog or kangentic_search_backlog).'),
        title: z.string().max(200).optional().describe('New title (max 200 characters).'),
        description: z.string().max(10_000).optional().describe('New description (max 10,000 characters).'),
        priority: z.number().int().min(0).max(4).optional().describe('New priority level: 0=none, 1=low, 2=medium, 3=high, 4=urgent.'),
        labels: z.array(z.union([
          z.string(),
          z.object({ name: z.string(), color: z.string() }),
        ])).optional().describe('Full replacement label set. Strings, or {name, color} objects to also set the label color.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ itemId, title, description, priority, labels, project }) => withProject(resolver, project, (ctx) => callHandler('update_backlog_item', {
      itemId,
      title: title ?? null,
      description: description ?? null,
      priority: priority ?? null,
      labels: labels ?? null,
    }, ctx, 'Failed to update backlog item')),
  );

  // --- kangentic_delete_backlog_item ---
  server.registerTool(
    'kangentic_delete_backlog_item',
    {
      description: 'Permanently delete a backlog item and all of its attachments. This cannot be undone. Find item IDs with kangentic_list_backlog or kangentic_search_backlog. Pass `project` to delete a backlog item in a different project.',
      inputSchema: z.object({
        itemId: z.string().describe('Backlog item UUID to delete.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ itemId, project }) => withProject(resolver, project, (ctx) => callHandler('delete_backlog_item', { itemId }, ctx, 'Failed to delete backlog item')),
  );

  // --- kangentic_get_handoff_context ---
  server.registerTool(
    'kangentic_get_handoff_context',
    {
      description: 'Get the most recent handoff record for a task. Returns metadata about the cross-agent handoff: which agent handed off to which, when, and the path to the prior agent\'s native session history file. Use kangentic_get_session_history to read the actual session content. Pass `project` to read handoff context from a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ taskId, project }) => withProject(resolver, project, (ctx) => callHandler('get_handoff_context', {
      taskId: taskId ?? null,
    }, ctx, 'Failed to get handoff context')),
  );

  // --- kangentic_get_transcript ---
  server.registerTool(
    'kangentic_get_transcript',
    {
      description: 'Get the full ANSI-stripped session transcript for a task. Returns the complete terminal output from the agent session, useful for reviewing what an agent did, debugging issues, or auditing work. Find the task ID first with kangentic_find_task or kangentic_search_tasks. Pass `project` to read a transcript from a different project.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). Returns transcript from the most recent session for this task.'),
        sessionId: z.string().optional().describe('Session UUID for a specific session. Use kangentic_list_sessions to find session IDs.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ taskId, sessionId, project }) => withProject(resolver, project, (ctx) => callHandler('get_transcript', {
      taskId: taskId ?? null,
      sessionId: sessionId ?? null,
    }, ctx, 'Failed to get transcript')),
  );

  // --- kangentic_get_session_files ---
  server.registerTool(
    'kangentic_get_session_files',
    {
      description: 'Get the absolute paths to every per-session file: events.jsonl (activity log), status.json (usage/metrics), settings.json, commands.jsonl (MCP queue), mcp.json, responses/ dir, and the agent\'s native session history file (Claude JSONL, Codex JSONL, or Gemini JSON). Session directories are keyed by Kangentic PTY session id under .kangentic/sessions/<id>/. Each file entry includes an "exists" flag. Provide either taskId or sessionId. Pass `project` to inspect session files from a different project.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). Picks the latest session for the task by default.'),
        sessionId: z.string().optional().describe('Kangentic session UUID (the sessions.id column). Use kangentic_list_sessions to find session ids.'),
        sessionIndex: z.number().int().min(0).optional().describe('When taskId is given, which session to pick: 0 = newest (default), 1 = previous, etc. Sessions are ordered started_at DESC.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ taskId, sessionId, sessionIndex, project }) => withProject(resolver, project, async (ctx) => {
      const result = await runHandler('get_session_files', { taskId, sessionId, sessionIndex }, ctx);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session files: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    }),
  );

  // --- kangentic_get_session_events ---
  server.registerTool(
    'kangentic_get_session_events',
    {
      description: 'Read parsed events from a session\'s events.jsonl activity log without needing to locate or open the file yourself. Each line is a JSON event emitted by the Claude Code hook bridge (PreToolUse, PostToolUse, Stop, Notification, etc.). Use this for idle-detection debugging, tracing tool usage, or replaying what an agent did. Filters: tail (last N matching events, default 200, max 2000), since (epoch ms - drop events older than this), eventTypes (only return events whose hook_event_name/type is in this list). Provide either taskId or sessionId. Pass `project` to read events from a different project.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('Task ID (numeric display ID or UUID). Picks the latest session by default.'),
        sessionId: z.string().optional().describe('Kangentic session UUID (sessions.id column).'),
        sessionIndex: z.number().int().min(0).optional().describe('When taskId is given, which session to pick: 0 = newest (default).'),
        tail: z.number().int().min(1).max(2000).optional().describe('Return the last N matching events. Default 200, hard cap 2000.'),
        since: z.number().int().optional().describe('Epoch milliseconds. Only return events with timestamp >= since.'),
        eventTypes: z.array(z.string()).optional().describe('Only return events whose hook_event_name or type matches one of these (e.g. ["PreToolUse", "Stop", "Notification"]).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ taskId, sessionId, sessionIndex, tail, since, eventTypes, project }) => withProject(resolver, project, async (ctx) => {
      const result = await runHandler('get_session_events', { taskId, sessionId, sessionIndex, tail, since, eventTypes }, ctx);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get session events: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    }),
  );

  // --- kangentic_query_db ---
  server.registerTool(
    'kangentic_query_db',
    {
      description: 'Run a read-only SQL query against the current project database. Only SELECT, PRAGMA, and WITH (CTE) statements are allowed. Returns up to 100 rows as a markdown table. Useful for debugging, inspecting internal state, and answering questions about sessions, tasks, transcripts, handoffs, and other project data. Key tables: tasks, swimlanes, sessions, session_transcripts, handoffs, actions, swimlane_transitions, backlog_items. tasks columns: id (uuid), display_id (numeric, the "#N" shown in UI), title, description, swimlane_id, position, agent, session_id, worktree_path, branch_name (NOT "branch"), pr_number, pr_url, base_branch, use_worktree, labels (JSON array), priority, archived_at, created_at, updated_at. sessions columns: id (PTY/Kangentic session UUID, drives the .kangentic/sessions/<id>/ directory name), task_id, session_type (e.g. "claude", "codex"), agent_session_id (the agent CLI resume id - NOT named "claude_session_id"), command, cwd, permission_mode, prompt, status (running/suspended/exited/queued), exit_code, started_at, suspended_at, exited_at, suspended_by, plus metrics: total_cost_usd, total_input_tokens, total_output_tokens, model_id, model_display_name, total_duration_ms, tool_call_count, lines_added, lines_removed, files_changed. To read on-disk session files, prefer kangentic_get_session_files / kangentic_get_session_events instead of constructing paths manually. Use PRAGMA table_info(<table>) to discover columns of any other table. Pass `project` to query a different project\'s DB.',
      inputSchema: z.object({
        sql: z.string().describe('SQL query to execute. Must be a SELECT, PRAGMA, or WITH statement. Examples: "SELECT * FROM session_transcripts", "SELECT name, sql FROM sqlite_master WHERE type=\'table\'", "PRAGMA table_info(sessions)"'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
    },
    async ({ sql, project }) => withProject(resolver, project, (ctx) => callHandler('query_db', { sql }, ctx, 'Query error')),
  );
}
