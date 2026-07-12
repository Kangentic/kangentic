/**
 * The `tool` field a phone's `board-tool-read`/`board-tool-write` request
 * names is the INTERNAL command-registry key from
 * src/main/agent/commands/index.ts (`commandHandlers`, e.g. 'create_task',
 * 'update_task'), not a public MCP tool name. Despite the "tool"/"params"
 * shape, this is NOT the MCP protocol - no agent, LLM, or JSON-RPC
 * round-trip is involved anywhere in this path. It routes straight into
 * `commandHandlers`, reusing the exact same handlers + board-mutation
 * side-effect fan-out the actual MCP server also happens to dispatch into,
 * without re-deriving the `register*Tools` layer's zod schemas, defaulting,
 * rate limiting, or LLM-facing prose formatting - the same kind of direct
 * reuse read-board/move-task/etc. do against their own repositories/
 * handleTaskMove. This exists for the long tail of task/backlog CRUD
 * (create, edit, delete, link PR, ...) that does not warrant a bespoke
 * verb each.
 *
 * Deliberately excluded rather than reachable-by-omission:
 * - `move_task`, `list_tasks`, `list_columns`, `list_backlog` - NOT unsafe,
 *   but duplicates: the dedicated `move-task` and `read-board` verbs
 *   already cover moving a task and listing tasks/columns/backlog, with a
 *   cleaner contract (swimlaneId not column-name resolution; full Task/
 *   Swimlane objects, not LLM-prose-oriented summaries) and, for
 *   read-board, a live subscription these one-shot tools do not have.
 *   Keeping them reachable through BOTH paths would mean two different
 *   contracts for the same action with no reason to prefer one - excluding
 *   them here keeps exactly one path per capability.
 * - `query_db` (raw SQL escape hatch - the research doc's explicit
 *   "minus code-execution verbs (no devtools/browser/raw-query_db)").
 * - Everything NOT in `commandHandlers` at all: the `kangentic_browser_*`
 *   family and the dev-only `kangentic_devtools_*` family are registered
 *   through entirely separate registries, never through `commandHandlers` -
 *   so building this allowlist FROM `commandHandlers`'s keys excludes them
 *   for free, with no separate name-matching needed. The same is true of
 *   the diagnostics tools (`tail_logs`, `get_recent_crashes`,
 *   `get_process_metrics`, `get_ipc_log`, `list_worktrees`) and the
 *   remaining cross-project tools (`list_projects`, unified `search`,
 *   `move_task_to_project`) - none of them are `commandHandlers` entries,
 *   so none of them are reachable here.
 */
import { commandHandlers } from '../../agent/commands';

export type BoardToolAccess = 'read' | 'mutate';

/**
 * Every `commandHandlers` key EXCEPT the excluded set below, classified
 * read vs mutate. `board-tool-allowlist.test.ts` fails if a new
 * `commandHandlers` entry is added without a classification (or exclusion)
 * here, or if this table drifts from `commandHandlers`'s actual key set.
 */
export const MOBILE_BOARD_TOOL_ACCESS: Readonly<Record<string, BoardToolAccess>> = {
  create_task: 'mutate',
  update_task: 'mutate',
  delete_task: 'mutate',
  link_pr: 'mutate',
  remove_attachment: 'mutate',
  update_column: 'mutate',
  search_tasks: 'read',
  find_task: 'read',
  get_current_task: 'read',
  get_task_stats: 'read',
  get_usage_stats: 'read',
  board_summary: 'read',
  list_sessions: 'read',
  get_session_history: 'read',
  get_column_detail: 'read',
  create_backlog_task: 'mutate',
  promote_backlog: 'mutate',
  update_backlog_item: 'mutate',
  delete_backlog_item: 'mutate',
  get_handoff_context: 'read',
  get_transcript: 'read',
  get_session_files: 'read',
  get_session_events: 'read',
};

/** query_db is unsafe; move_task/list_tasks/list_columns/list_backlog are safe but duplicate the dedicated move-task/read-board verbs - see the module doc comment. */
export const MOBILE_EXCLUDED_BOARD_TOOLS: ReadonlySet<string> = new Set([
  'query_db',
  'move_task',
  'list_tasks',
  'list_columns',
  'list_backlog',
]);

/** True only for a `commandHandlers` key that is both classified here and not on the exclusion list. */
export function isKnownMobileBoardTool(tool: string): boolean {
  return tool in commandHandlers && !MOBILE_EXCLUDED_BOARD_TOOLS.has(tool) && tool in MOBILE_BOARD_TOOL_ACCESS;
}

/** Deny-by-default: an unknown tool, or a known tool whose access class does not match the requested verb, is refused. */
export function isBoardToolAllowedForVerb(tool: string, verb: 'board-tool-read' | 'board-tool-write'): boolean {
  if (!isKnownMobileBoardTool(tool)) return false;
  const access = MOBILE_BOARD_TOOL_ACCESS[tool];
  return verb === 'board-tool-read' ? access === 'read' : access === 'mutate';
}
