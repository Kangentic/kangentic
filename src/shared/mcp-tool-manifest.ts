/**
 * Single source of truth for the user-facing MCP tool catalogue.
 *
 * The Kangentic MCP server registers tools across the `*-tools.ts` files in
 * `src/main/agent/mcp-http/`. Two surfaces enumerate those tools for humans:
 * the Settings -> MCP Server "Available Tools" list (`McpServerTab.tsx`) and
 * `docs/mcp-server.md`. Before this manifest existed both hardcoded their own
 * copies and drifted: the panel listed 10 of 46 registered tools.
 *
 * This manifest is the one list both the panel and the parity test read, so
 * the catalogue cannot silently drift from the registrations again. Every
 * registered tool MUST have an entry here, and every entry MUST name a real
 * registered tool. `tests/unit/mcp-tool-list-parity.test.ts` enforces both
 * directions plus presence in `docs/mcp-server.md`; the convention is
 * documented in `.claude/rules/mcp-tool-list-parity.md`.
 *
 * The panel renders every entry as a pill, grouped by `category` in
 * `MCP_TOOL_CATEGORIES` order, so the complete tool catalogue is visible
 * (the dev-leaning diagnostics group sorts last under its own header). The
 * array below is ordered to mirror that grouping; `category`, not array
 * position, is what drives the panel grouping.
 *
 * Each panel pill deep-links to its entry on the live docs page
 * (`MCP_SERVER_DOCS_URL`) via `mcpToolDocsUrl(tool.name)`; the docs page uses
 * one anchor per tool named after the registered tool, so the link is derived
 * from `name` with no per-tool hardcoding.
 */

export type McpToolCategoryId = 'tasks' | 'board' | 'sessions' | 'browser' | 'diagnostics';

export interface McpToolManifestEntry {
  /** Registered tool name. MUST match a registerTool('...') literal under src/main/agent/mcp-http/*-tools.ts. */
  name: string;
  /** User-facing label shown in the settings panel, e.g. 'Create Task'. */
  label: string;
  /** One-line user-facing blurb. */
  blurb: string;
  /** Grouping for the panel and docs. */
  category: McpToolCategoryId;
}

/** Categories in panel render order. The diagnostics group sorts last under its own header. */
export const MCP_TOOL_CATEGORIES: { id: McpToolCategoryId; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'board', label: 'Board' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'browser', label: 'Browser Automation' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export const MCP_TOOL_MANIFEST: McpToolManifestEntry[] = [
  // ── Tasks (task-tools.ts) - operations on individual tasks ──
  { name: 'kangentic_create_task', label: 'Create Task', blurb: 'add a task to any board column or the backlog', category: 'tasks' },
  { name: 'kangentic_list_tasks', label: 'List Tasks', blurb: 'browse tasks, optionally filtered by column', category: 'tasks' },
  { name: 'kangentic_search_tasks', label: 'Search Tasks', blurb: 'keyword search across board and backlog tasks', category: 'tasks' },
  { name: 'kangentic_find_task', label: 'Find Task', blurb: 'look up a task by ID, branch, title, or PR number', category: 'tasks' },
  { name: 'kangentic_get_current_task', label: 'Current Task', blurb: 'resolve the task for the current directory or branch', category: 'tasks' },
  { name: 'kangentic_get_task_stats', label: 'Task Stats', blurb: 'token usage, cost, duration, and lines changed per task', category: 'tasks' },
  { name: 'kangentic_update_task', label: 'Update Task', blurb: 'edit title, description (full, in-place find/replace, or append), PR info, agent, model, effort, permission mode, run mode, priority, labels, base branch, worktree, and attachments', category: 'tasks' },
  { name: 'kangentic_move_task', label: 'Move Task', blurb: 'move a task between columns and place it at a slot, running the same lifecycle as a drag', category: 'tasks' },
  { name: 'kangentic_reorder_tasks', label: 'Reorder Tasks', blurb: 'set the top-to-bottom order of tasks within one column', category: 'tasks' },
  { name: 'kangentic_move_task_to_project', label: 'Move Task to Project', blurb: 'relocate a To Do task to another project\'s board', category: 'tasks' },
  { name: 'kangentic_link_pr', label: 'Link PR', blurb: 'resolve and attach a task pull request via the gh CLI', category: 'tasks' },
  { name: 'kangentic_delete_task', label: 'Delete Task', blurb: 'permanently remove a task, its attachments, and session records', category: 'tasks' },
  { name: 'kangentic_remove_task_attachment', label: 'Remove Attachment', blurb: 'detach a file from a board task or backlog item by attachment ID', category: 'tasks' },

  // ── Board (columns from task-tools.ts, backlog from session-tools.ts, projects/search from project-tools.ts + search-tools.ts) ──
  { name: 'kangentic_list_columns', label: 'List Columns', blurb: 'see every board column with its task counts', category: 'board' },
  { name: 'kangentic_get_column_detail', label: 'Column Detail', blurb: 'automation, permission mode, and config for a column', category: 'board' },
  { name: 'kangentic_update_column', label: 'Update Column', blurb: 'rename, recolor, and configure a column automation', category: 'board' },
  { name: 'kangentic_create_column', label: 'Create Column', blurb: 'add a board column, placed before Done by default', category: 'board' },
  { name: 'kangentic_delete_column', label: 'Delete Column', blurb: 'remove an empty, non-role column and every reference to it', category: 'board' },
  { name: 'kangentic_list_board_profiles', label: 'List Board Profiles', blurb: 'see the board\'s named per-column agent/model/effort presets', category: 'board' },
  { name: 'kangentic_create_board_profile', label: 'Create Board Profile', blurb: 'add a named preset of per-column agent/model/effort settings', category: 'board' },
  { name: 'kangentic_update_board_profile', label: 'Update Board Profile', blurb: 'rename a profile or retune its per-column settings, across projects', category: 'board' },
  { name: 'kangentic_delete_board_profile', label: 'Delete Board Profile', blurb: 'remove a profile; tasks riding it fall back to each column\'s own settings', category: 'board' },
  { name: 'kangentic_board_summary', label: 'Board Summary', blurb: 'counts, label vocabulary, active sessions, and aggregate cost across the board', category: 'board' },
  { name: 'kangentic_get_usage_stats', label: 'Usage Stats', blurb: 'tokens, cost, burn rate, and by-model / by-agent usage for a project or all projects over a time range', category: 'board' },
  { name: 'kangentic_list_backlog', label: 'List Backlog', blurb: 'see items staged in the backlog', category: 'board' },
  { name: 'kangentic_promote_backlog', label: 'Promote Backlog', blurb: 'move backlog items onto the board as tasks', category: 'board' },
  { name: 'kangentic_update_backlog_item', label: 'Update Backlog Item', blurb: 'edit a backlog item title, description, priority, labels, or attachments', category: 'board' },
  { name: 'kangentic_delete_backlog_item', label: 'Delete Backlog Item', blurb: 'permanently remove a backlog item and its attachments', category: 'board' },
  { name: 'kangentic_list_projects', label: 'List Projects', blurb: 'every Kangentic project registered on this machine', category: 'board' },
  { name: 'kangentic_search', label: 'Search', blurb: 'unified search across tasks, backlog, session events, projects, and past conversations (keyword or semantic)', category: 'board' },

  // ── Sessions (session-tools.ts, steering-tools.ts) - per-task session history,
  //    transcripts, handoff, and the one write-side tool that steers a live session ──
  { name: 'kangentic_list_sessions', label: 'List Sessions', blurb: 'session records for a task with timings, cost, and exit info', category: 'sessions' },
  { name: 'kangentic_get_session_history', label: 'Session History', blurb: 'read the native agent session transcript file for a task', category: 'sessions' },
  { name: 'kangentic_get_session_files', label: 'Session Files', blurb: 'absolute paths to a session activity, status, and history files', category: 'sessions' },
  { name: 'kangentic_get_session_events', label: 'Session Events', blurb: 'parsed activity events from a session log', category: 'sessions' },
  { name: 'kangentic_get_activity_intervals', label: 'Activity Intervals', blurb: 'durable history of active vs idle time for a task or session', category: 'sessions' },
  { name: 'kangentic_reserve_dev_ports', label: 'Reserve Dev Ports', blurb: 'claim free TCP ports before starting a dev server, so concurrent agents never collide', category: 'sessions' },
  { name: 'kangentic_check_dev_ports', label: 'Check Dev Ports', blurb: 'which ports a task holds, and what is actually listening', category: 'sessions' },
  { name: 'kangentic_get_handoff_context', label: 'Handoff Context', blurb: 'the most recent cross-agent handoff record for a task', category: 'sessions' },
  { name: 'kangentic_get_transcript', label: 'Get Transcript', blurb: 'read what the agent on another task or project said', category: 'sessions' },
  { name: 'kangentic_send_session_message', label: 'Send Session Message', blurb: 'send a message to another task\'s running agent to steer it', category: 'sessions' },
  { name: 'kangentic_get_session_messages_sent', label: 'Sent Session Messages', blurb: 'log of messages sent into a session, and whether each landed', category: 'sessions' },

  // ── Browser Automation (browser-tools.ts) ──
  { name: 'kangentic_browser_list_panes', label: 'List Browser Panes', blurb: 'open embedded Browser panes and their URLs', category: 'browser' },
  { name: 'kangentic_browser_open_pane', label: 'Open Browser Pane', blurb: "open the agent's own task Browser pane and load a URL", category: 'browser' },
  { name: 'kangentic_browser_close_pane', label: 'Close Browser Pane', blurb: 'put Browser panes away, one or all in the project', category: 'browser' },
  { name: 'kangentic_browser_navigate', label: 'Navigate', blurb: 'point a task Browser pane at a URL', category: 'browser' },
  { name: 'kangentic_browser_screenshot', label: 'Screenshot', blurb: 'capture the Browser pane as an image', category: 'browser' },
  { name: 'kangentic_browser_screenshot_element', label: 'Screenshot Element', blurb: 'capture a single element in the Browser pane', category: 'browser' },
  { name: 'kangentic_browser_query_dom', label: 'Query DOM', blurb: 'get the HTML and box of an element', category: 'browser' },
  { name: 'kangentic_browser_query_all', label: 'Query All', blurb: 'measure every element matching a selector', category: 'browser' },
  { name: 'kangentic_browser_bounding_box', label: 'Bounding Box', blurb: 'the CDP box model of an element', category: 'browser' },
  { name: 'kangentic_browser_console', label: 'Browser Console', blurb: 'read recent console messages from the pane', category: 'browser' },
  { name: 'kangentic_browser_wait', label: 'Wait', blurb: 'wait for an element or text to appear', category: 'browser' },
  { name: 'kangentic_browser_click', label: 'Click', blurb: 'click an element or a point in the pane', category: 'browser' },
  { name: 'kangentic_browser_type', label: 'Type', blurb: 'type text into the Browser pane', category: 'browser' },
  { name: 'kangentic_browser_keypress', label: 'Keypress', blurb: 'send a key or chord to the pane', category: 'browser' },
  { name: 'kangentic_browser_drag', label: 'Drag', blurb: 'drag from one element to another', category: 'browser' },
  { name: 'kangentic_browser_eval', label: 'Eval', blurb: 'evaluate JavaScript in the page (off by default)', category: 'browser' },

  // ── Diagnostics (diagnostics-tools.ts; query_db from session-tools.ts) - dev-leaning, rendered last ──
  { name: 'kangentic_query_db', label: 'Query Database', blurb: 'run a read-only SQL query against the project database', category: 'diagnostics' },
  { name: 'kangentic_tail_logs', label: 'Tail Logs', blurb: 'read recent lines from the Kangentic console log', category: 'diagnostics' },
  { name: 'kangentic_get_recent_crashes', label: 'Recent Crashes', blurb: 'list recent crash records with source-mapped stacks', category: 'diagnostics' },
  { name: 'kangentic_get_process_metrics', label: 'Process Metrics', blurb: 'memory and CPU per Electron process', category: 'diagnostics' },
  { name: 'kangentic_get_ipc_log', label: 'IPC Log', blurb: 'recent IPC traffic with timings and errors', category: 'diagnostics' },
  { name: 'kangentic_list_worktrees', label: 'List Worktrees', blurb: 'enumerate worktrees with branch and dirty state', category: 'diagnostics' },
];

/** Live docs reference for the MCP server. Each tool's heading anchor is its registered name. */
export const MCP_SERVER_DOCS_URL = 'https://kangentic.com/mcp-server/';

/** Deep link to a tool's entry on the docs page. Anchor = manifest/registered tool name. */
export function mcpToolDocsUrl(toolName: string): string {
  return `${MCP_SERVER_DOCS_URL}#${toolName}`;
}
