/**
 * The board-tool names a phone may pass in a board-tool-read /
 * board-tool-write request's `tool` field. Each name is the desktop's
 * INTERNAL command-registry key (src/main/agent/commands/index.ts
 * `commandHandlers`), not a public MCP tool name, and this is NOT the MCP
 * protocol - see the desktop's board-tool-allowlist.ts doc comment for the
 * full rationale and the deliberate exclusions (query_db, move_task,
 * list_tasks, list_columns, list_backlog).
 *
 * The desktop builds its enforcement allowlist FROM these tuples, so its
 * allowlist parity test (board-tool-allowlist.test.ts, which diffs the
 * allowlist against the real `commandHandlers` key set) transitively keeps
 * this protocol surface honest: a tool renamed or removed desktop-side
 * fails that test instead of silently breaking phones.
 */
export const BOARD_TOOL_READ_NAMES = [
  'search_tasks',
  'find_task',
  'get_current_task',
  'get_task_stats',
  'get_usage_stats',
  'board_summary',
  'list_sessions',
  'get_session_history',
  'get_column_detail',
  'get_handoff_context',
  'get_transcript',
  'get_session_files',
  'get_session_events',
] as const;

export const BOARD_TOOL_WRITE_NAMES = [
  'create_task',
  'update_task',
  'delete_task',
  'link_pr',
  'remove_attachment',
  'update_column',
  'create_backlog_task',
  'promote_backlog',
  'update_backlog_item',
  'delete_backlog_item',
] as const;

export type BoardToolReadName = (typeof BOARD_TOOL_READ_NAMES)[number];
export type BoardToolWriteName = (typeof BOARD_TOOL_WRITE_NAMES)[number];
export type BoardToolName = BoardToolReadName | BoardToolWriteName;

export function isBoardToolReadName(value: string): value is BoardToolReadName {
  return (BOARD_TOOL_READ_NAMES as readonly string[]).includes(value);
}

export function isBoardToolWriteName(value: string): value is BoardToolWriteName {
  return (BOARD_TOOL_WRITE_NAMES as readonly string[]).includes(value);
}
