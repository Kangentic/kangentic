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
 * - `move_task`, `reorder_tasks`, `list_tasks`, `list_columns`, `list_backlog` -
 *   NOT unsafe, but duplicates: the dedicated `move-task` and `read-board` verbs
 *   already cover moving a task and listing tasks/columns/backlog, with a
 *   cleaner contract (swimlaneId not column-name resolution; full Task/
 *   Swimlane objects, not LLM-prose-oriented summaries) and, for
 *   read-board, a live subscription these one-shot tools do not have.
 *   `move-task` carries a `targetPosition`, so within-column placement is
 *   already a phone capability through it; `reorder_tasks` would be a second
 *   contract for that same action, differing only in doing a whole column at
 *   once. If bulk re-sequencing from a phone is ever wanted, it belongs in
 *   `move-task`'s verb family with a real schema, not reached by omission here.
 *   Keeping them reachable through BOTH paths would mean two different
 *   contracts for the same action with no reason to prefer one - excluding
 *   them here keeps exactly one path per capability.
 * - `query_db` (raw SQL escape hatch - the research doc's explicit
 *   "minus code-execution verbs (no devtools/browser/raw-query_db)").
 * - `create_column` / `delete_column` - board STRUCTURE, not task CRUD, which is
 *   what this path exists for. Both are also the worst fit for a path that
 *   skips the `register*Tools` zod layer: `board-tool.ts` validates only that
 *   `params` is an object, so `delete_column`'s `params.column as string` and
 *   `create_column`'s 13 `String()`/`Number()`/`Boolean()` coercions would take
 *   arbitrary JSON with no narrowing. Reshaping a board from a phone is not a
 *   capability anyone has asked for; if it is ever wanted, give it a bespoke
 *   verb with its own schema rather than reaching it by omission here.
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
import { BOARD_TOOL_READ_NAMES, BOARD_TOOL_WRITE_NAMES } from '@kangentic/protocol';
import { commandHandlers } from '../../agent/commands';

export type BoardToolAccess = 'read' | 'mutate';

/**
 * Every `commandHandlers` key EXCEPT the excluded set below, classified
 * read vs mutate. The classification itself is the protocol package's
 * BOARD_TOOL_READ_NAMES / BOARD_TOOL_WRITE_NAMES tuples (the phone types
 * its `tool` field from the same source), so the two sides cannot drift;
 * `board-tool-allowlist.test.ts` fails if a new `commandHandlers` entry is
 * added without a classification (or exclusion), or if the protocol tuples
 * drift from `commandHandlers`'s actual key set.
 */
export const MOBILE_BOARD_TOOL_ACCESS: Readonly<Record<string, BoardToolAccess>> = Object.fromEntries([
  ...BOARD_TOOL_READ_NAMES.map((name): [string, BoardToolAccess] => [name, 'read']),
  ...BOARD_TOOL_WRITE_NAMES.map((name): [string, BoardToolAccess] => [name, 'mutate']),
]);

/** query_db is unsafe; create_column/delete_column are unvalidated board-structure edits; move_task/reorder_tasks/list_tasks/list_columns/list_backlog are safe but duplicate the dedicated move-task/read-board verbs - see the module doc comment. */
export const MOBILE_EXCLUDED_BOARD_TOOLS: ReadonlySet<string> = new Set([
  'query_db',
  'create_column',
  'delete_column',
  'move_task',
  'reorder_tasks',
  'list_tasks',
  'list_columns',
  'list_backlog',
  // Dev-server port reservations are about processes on the DEVELOPER'S
  // machine: an agent asks for ports it is about to bind, and the answer is
  // only meaningful next to the dev servers themselves. There is nothing for a
  // phone to do with one, and reserving from a phone would take a port out of
  // the pool with nothing ever binding it. Excluded rather than classified, so
  // neither name has to enter the published protocol tuples.
  'reserve_dev_ports',
  'check_dev_ports',
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
