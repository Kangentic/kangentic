# MCP Server

## Overview

Kangentic exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude Code agents tools to interact with the Kanban board. Agents can create tasks, search the board, view session statistics, and more - all through structured tool calls during their work.

This enables a key workflow: while working on a task, an agent identifies follow-up work (bugs, refactoring opportunities, improvements) and creates Kangentic tasks for them directly, without the user manually entering each one.

## How It Works

### Architecture

```
Claude Code agent calls MCP tool (e.g. kangentic_create_task)
  -> HTTP POST http://127.0.0.1:<port>/mcp/<projectId>
     (X-Kangentic-Token header, JSON-RPC body)
  -> In-process MCP HTTP server in Electron main (mcp-http-server.ts)
  -> Per-request McpServer + Streamable HTTP transport
  -> Tool handler runs synchronously against project DB
  -> Response returned in same HTTP request (no SSE, no file polling)
  -> Board refreshes via IPC event + toast notification
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| MCP HTTP Server | `src/main/agent/mcp-http-server.ts` | In-process Node `http` server using `@modelcontextprotocol/sdk` Streamable HTTP transport. Binds 127.0.0.1 by default (configurable via `mcpServer.bindAddress`), random `:0` port, random per-launch token validated via `X-Kangentic-Token`. See [Network Access](#network-access). |
| Task Tools | `src/main/agent/mcp-http/task-tools.ts` | Board/task/column mutations + related reads (`kangentic_create_task`, `kangentic_move_task`, `kangentic_update_task`, `kangentic_link_pr`, `kangentic_update_column`, `kangentic_delete_task`, `kangentic_list_columns`, `kangentic_find_task`, `kangentic_get_current_task`, etc.). |
| Session Tools | `src/main/agent/mcp-http/session-tools.ts` | Session inspection, backlog, read-only SQL (`kangentic_list_sessions`, `kangentic_get_transcript`, `kangentic_get_session_files`, `kangentic_get_session_events`, `kangentic_query_db`, `kangentic_list_backlog`, etc.). |
| Project Tools | `src/main/agent/mcp-http/project-tools.ts` | Multi-project discovery (`kangentic_list_projects`). |
| Search Tools | `src/main/agent/mcp-http/search-tools.ts` | The single unified search (`kangentic_search`): tasks, backlog, session events, projects, and past conversations (keyword or, with `mode:"hybrid"`, semantic). The board-scoped `kangentic_search_tasks` lives in `task-tools.ts`. |
| Diagnostics Tools | `src/main/agent/mcp-http/diagnostics-tools.ts` | Read-only product tools backing crash records, persistent console logs, process metrics, IPC traffic recordings, and worktree state. |
| Tool Annotations | `src/main/agent/mcp-http/annotations.ts` | Shared `READ_ONLY_ANNOTATIONS` / `MUTATING_ANNOTATIONS` MCP tool-annotation constants. Every tool in every `*-tools.ts` file declares one of these (see the Tool annotations note below). |
| Browser Tools | `src/main/agent/mcp-http/browser-tools.ts` | Shipped `kangentic_browser_*` MCP tool family driving the embedded Browser pane via in-process CDP (no HTTP bridge, no lockfile). Gated by the global `browserAutomation.*` policy. |
| Usage Tools | `src/main/agent/mcp-http/usage-tools.ts` | Aggregated usage statistics (`kangentic_get_usage_stats`): tokens, cost, burn rate, and by-model / by-agent / by-effort breakdowns, per project or app-wide, over the shared time ranges. Reads the same usage-stats service as the in-app dashboard. |
| Command Handlers | `src/main/agent/commands/` | Per-domain handlers shared by the HTTP tools: task, column, inventory, search, analytics, usage, backlog, handoff, inspect (`get_transcript`, `query_db`), and session-files (`get_session_files`, `get_session_events`) commands. |
| Column Resolver | `src/main/agent/commands/column-resolver.ts` | Shared case-insensitive column name to swimlane lookup used by multiple handlers. |
| MCP Config Delivery | `src/main/agent/adapters/claude/command-builder.ts` | Writes session `mcp.json` (with the per-launch URL + token) and adds `--mcp-config` flag to CLI command. |
| Trust Manager | `src/main/agent/adapters/claude/trust-manager.ts` | Pre-approves kangentic MCP server in `~/.claude.json`. |
| Board Refresh | `src/main/ipc/handlers/sessions.ts` | Forwards task-created/updated/backlog-changed events to renderer via IPC. |
| Dev-only DevTools | `src/devtools/mcp/register.ts`, `src/devtools/mcp/preview-tools.ts` | Registers the `kangentic_devtools_*` tools when `__KANGENTIC_DEV__` is set. Excluded from production builds at compile time. |

### Discovery

Claude Code supports a `--mcp-config` flag that accepts a path to a JSON file containing MCP server definitions. Kangentic uses this to deliver its MCP server config without modifying `.mcp.json` (which may be tracked in git). When Kangentic spawns a session:

1. `CommandBuilder.createMergedSettings()` writes the kangentic MCP server config to `.kangentic/sessions/<sessionId>/mcp.json`. The entry is an HTTP MCP server pointing at the per-launch URL `http://127.0.0.1:<port>/mcp/<projectId>` with the `X-Kangentic-Token` header containing the per-launch token. In the same gated block it also appends `mcp__kangentic` to the merged settings' `permissions.allow` (append-if-absent) so the spawned agent does not prompt for kangentic tools in default mode (see Permissions).
2. `CommandBuilder.buildClaudeCommand()` adds `--mcp-config <path>` to the CLI command
3. `ensureMcpServerTrust()` adds "kangentic" to `enabledMcpjsonServers` in `~/.claude.json`
4. Claude Code starts, reads both `.mcp.json` (user servers) and the `--mcp-config` file (kangentic), and connects to the in-process HTTP MCP server over loopback. No child process is spawned for kangentic itself.
5. Claude Code calls `tools/list` and discovers all kangentic tools

This approach keeps `.mcp.json` completely untouched - no injection, no cleanup, no git noise. The `--mcp-config` flag is additive (not `--strict-mcp-config`), so user-configured servers like context7 continue to work normally. The token is rotated on every Kangentic launch, so a stale `mcp.json` from a previous run cannot be reused.


## Cross-Project Calls

Every Kangentic MCP tool except `kangentic_get_current_task` accepts an optional `project` parameter. Use it to route a tool call at a *different* Kangentic project than the one the MCP client is bound to - no need to switch projects in the UI or reconfigure MCP.

| Parameter | Type | Description |
|-----------|------|-------------|
| `project` | string | Project name (case-insensitive exact) or project UUID. Omit to target the active project. |

When `project` is set the tool response is prefixed with `[Project: <name> (<shortId>)]` so the caller can confirm where the action landed. `kangentic_create_task` always emits this prefix, including when it falls back to the active project, so a misrouted create is visible up front. Column resolution, `baseBranch` / `branchName` / `useWorktree`, auto-spawn side effects, and session lookups all apply against the *target* project.

`kangentic_get_current_task` is intentionally excluded: it resolves the agent's own CWD/branch, so cross-project lookup makes no sense there.

`kangentic_move_task_to_project` is also excluded from the `[Project: ...]` prefix: it resolves two projects at once (source via `project`, destination via `targetProject`) rather than routing a single call through one target, so its response message already states the source and destination context directly (e.g. "was #7 ... now #12 in the To Do column").

Use `kangentic_list_projects` (below) to discover valid selectors.

### kangentic_list_projects

List every Kangentic project registered on this machine. Use the returned name or id as the `project` argument on any other `kangentic_*` tool.

No parameters. Returns each project's `name`, `id`, `path`, `lastOpened` timestamp, and an `isActive` flag marking the project the MCP client is bound to.

## Available Tools

The **Settings -> MCP Server** panel lists every tool below as a pill, grouped by the same
categories. Each pill deep-links to that tool's entry on the live docs page
(`https://kangentic.com/mcp-server/`, anchored by the tool name), opening it in the default
browser.

**Tool annotations.** Every registered tool declares MCP `annotations` from the shared constants
in `src/main/agent/mcp-http/annotations.ts`: read-only tools carry
`readOnlyHint: true, idempotentHint: true`; mutating tools carry
`readOnlyHint: false, idempotentHint: false`. Mutating covers both the board/backlog writers
(`create` / `update` / `delete` / `move` / `promote` / `link`) and the `kangentic_browser_*` tools
that change the loaded page (navigate, click, type, keypress, drag, eval). This is load-bearing for
plan mode: Claude Code auto-approves read-only-annotated tools without a permission prompt while
planning, so the plan-mode auto-approval surface is exactly the read-only set. Mutating tools still
prompt in plan mode by design (allow rules do not punch through the plan-mode gate). The
`tests/unit/mcp-tool-list-parity.test.ts` guard fails the build if a tool is registered without one
of the two shared annotation constants, and separately checks the board/backlog verb prefixes and
the browser capability tiers are annotated mutating.

### kangentic_create_task

Create a task on the board (default: the To Do column on the active board) or in the backlog. This is the only task-creation tool. Pass `column: "Backlog"` (case-insensitive) to create a backlog item instead of a board task. With no `column`, the task always lands in the active board's To Do column - never the backlog.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title (max 200 chars) |
| `description` | string | No | Task description, supports markdown (max 50000 chars for a board task; a backlog item is capped at 10000 and an over-cap backlog description is rejected) |
| `column` | string | No | Target column name (case-insensitive). Defaults to To Do. Pass `"Backlog"` to route to the backlog staging area instead of the board. |
| `priority` | number | No | Priority: 0=none (default), 1=low, 2=medium, 3=high, 4=urgent. Applies to both board tasks and backlog items. |
| `labels` | array | No | Labels for categorization. Each entry is a string or `{ name, color }` object with hex color. Applies to both board tasks and backlog items. |
| `branchName` | string | No | Custom git branch name. Board tasks only - ignored when routed to the backlog. |
| `baseBranch` | string | No | Base branch for the task. Board tasks only. |
| `useWorktree` | boolean | No | Whether to use a git worktree. Board tasks only. |
| `attachments` | array | No | File attachments: `[{ filePath: string, filename?: string }]`. Files are read from disk and stored in the project's `.kangentic/` directory. |
| `agentOverride` | string | No | Pin a specific agent for this task's entire lifetime (e.g. `"claude"`, `"codex"`). Locks against column moves. Omit to resolve column override -> project default -> app default. |
| `modelOverride` | string | No | Model to spawn this task with (e.g. `"opus"`, `"claude-opus-4-8"`, or the friendly `"Opus 4.8"`). Best-effort: a friendly name is converted to the CLI id; an unresolvable model errors at spawn time. Omit to resolve column override -> project default -> agent default. |
| `effortOverride` | string | No | Effort/reasoning level to spawn this task with (e.g. `"xhigh"`). Valid values are agent-specific. Omit to resolve column override -> project default -> agent default. |
| `permissionMode` | string | No | Permission mode to spawn this task with: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, or `"auto"`. Omit to resolve column override -> project default -> app default. |
| `autoCommand` | string | No | Slash command to run once the agent spawns for this task (e.g. `"/code-review"`, `"/release"`). Overrides the destination column's `auto_command` for this task only. MCP-only - not surfaced in the New Task dialog. |

If the target column has `auto_spawn` enabled, creating a task there will also spawn an agent session for it. Backlog items never auto-spawn.

**Cross-project routing guard:** when `project` is omitted (so the task would default to the active project) but the title or description names a *different* registered project, the tool refuses with a routing-check error instead of creating the task. No task is created and no rate-limit slot is consumed. Re-run with `project: "<that project>"` to file it there, or with `project: "<active project>"` to confirm the active project. This catches the common cross-project triage case (filing a bug about one project from another) when the routing cue is only implied by the task text.

Runaway-loop safeguard: a single Kangentic launch can create at most 500 tasks via this tool (a high internal circuit breaker against a misbehaving agent, shared across board and backlog, not a user-tunable setting). Hitting it returns a clear error and creates nothing; the accumulated count resets when Kangentic restarts.

### kangentic_list_columns

List all non-archived columns with task counts.

No parameters. Returns column names, roles, and current task counts.

### kangentic_list_tasks

List tasks, optionally filtered by column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | No | Filter by column name. If omitted, returns all tasks. |

### kangentic_search_tasks

Search by keyword across both the board (active + archived tasks) and the backlog. This is the default tool for finding a task by title, description, or backlog label - it covers items whether or not they have been promoted from backlog to board. Use `scope` to narrow to a single surface.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword (case-insensitive). Backlog hits also match on labels. |
| `scope` | `'board' \| 'backlog' \| 'both'` | No | Which surface to search. Defaults to `"both"`. |
| `status` | string | No | Filter board hits: `"active"`, `"completed"`, or `"all"` (default). Ignored for backlog hits. |

Results are grouped under `Board (N):` and `Backlog (N):` sections so the agent can see at a glance which surface each hit came from.

### kangentic_find_task

Find a task or backlog item by display ID, UUID, branch name, title keyword, or PR number. Returns matching board tasks (with full `branch_name`, `worktree_path`, PR info) and any matching backlog items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `displayId` | number | No | Numeric task display ID shown in UI (e.g. `24` for "#24"). Board-only, exact match. |
| `id` | string | No | Full UUID. Matches both board task UUIDs and backlog item UUIDs. |
| `branch` | string | No | Git branch name (matches the `tasks.branch_name` column, partial). Board-only. |
| `title` | string | No | Title keyword (case-insensitive). Matches board tasks and backlog items. |
| `prNumber` | number | No | Pull request number. Board-only. |

`displayId`, `branch`, and `prNumber` are skipped against the backlog because backlog items don't carry those fields. At least one parameter is required.

### kangentic_get_current_task

Resolve the task that corresponds to the current working directory and/or git branch. Use at the start of work in a worktree to confirm which task you are operating on (e.g. before commits, PRs, or merge-back).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Absolute working directory path. The tool extracts the worktree slug from `.kangentic/worktrees/<slug>` and matches against `tasks.worktree_path`. |
| `branch` | string | No | Current git branch name. Exact (case-insensitive) match against `tasks.branch_name`. |

At least one parameter is required. Returns the same task fields as `kangentic_find_task` (id, displayId, title, description, column, branchName, baseBranch, worktreePath, prNumber, prUrl, useWorktree, status). Returns `data: null` when no match is found, a single task object when one matches, or an array when multiple tasks match.

### kangentic_board_summary

Get a high-level board overview: task counts per column, active sessions, completed tasks, and aggregate cost/token metrics.

No parameters.

### kangentic_get_usage_stats

Aggregated agent-usage statistics for one project or rolled up across every registered
project: tokens in/out, cost, burn rate ($/hr approximate + tokens/hr), sessions, tool
calls, line churn, compactions, and by-model / by-agent / by-effort breakdowns (a null
effort means the agent default; a session that switches effort mid-run attributes all
its usage to the last-applied value). This is the same data the in-app usage dashboard
shows, over the same time ranges.

Reads the durable usage ledgers (`usage_history` per-session totals and
`conversation_turn_usage` per-turn time series), so totals survive task and session
deletion. Usage from in-flight sessions is excluded until they finalize. Two token
semantics coexist by design and never reconcile: KPI token totals are per-session
context-window snapshots, while the time series carries true per-turn tokens. The $/hr
burn rate allocates each session's reported cost across its turns proportionally by
token share - API-equivalent and approximate; subscription sessions reporting $0 count
tokens but no cost.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `period` | string | No | Time range: "live" (trailing 2 hours), "today", "week", "month", or "all" (default). "today"/"week"/"month" start at the machine's local midnight / Monday / 1st of month. |
| `allProjects` | boolean | No | Roll up across every registered project, with per-project sub-totals. Takes precedence over `project`. |
| `includeSeries` | boolean | No | Include the bucketed token/cost time series in the response (larger). Default: false (KPIs + breakdowns only). |
| `project` | string | No | Project name or UUID to target a different project than the active one. |

### kangentic_get_task_stats

Get session metrics for a specific task or across all tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Specific task ID. If omitted, returns aggregate stats. |
| `query` | string | No | Filter tasks by keyword before aggregating |
| `sortBy` | string | No | Sort metric: "tokens", "cost", "duration", "toolCalls", "linesChanged" |

### kangentic_list_sessions

List all session records for a task with metadata: start/end times, exit codes, suspension reasons, cost, token counts, and duration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

### kangentic_get_session_history

Read the agent's native session history file for a task. Returns the raw file content (Claude JSONL, Codex rollout JSONL, or Gemini chat JSON) from the most recent session. Large files are truncated to the most recent portion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

### kangentic_get_column_detail

Get detailed column configuration: description, auto-spawn, permission mode, plan exit target, and visual settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name (case-insensitive) |

### kangentic_update_task

Update a task's title, description (full replace, in-place find/replace edits, or append), PR info, agent assignment, model/effort/permission overrides, priority, labels, base branch, worktree toggle, or attachments. To move a task between columns, use `kangentic_move_task` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `title` | string | No | New title (max 200 chars) |
| `description` | string | No | New description, replaces the entire description (max 50000 chars). Mutually exclusive with `descriptionEdits` and `appendDescription`; for an incremental change to a long description, prefer those instead - they cost far fewer tokens and cannot silently drop untouched sections. |
| `descriptionEdits` | array | No | Ordered exact-string replacements applied to the current description, like the file `Edit` tool: `[{ find: string, replace: string }]` (1-100 edits; each `find`/`replace` up to 50000 chars). Each `find` must be present and unique in the text as it stands after prior edits in the list, or the whole call fails and nothing is written. Mutually exclusive with `description`; may combine with `appendDescription` (edits apply first). |
| `appendDescription` | string | No | Text appended to the end of the current description, exactly as given (no separator inserted, max 50000 chars). Mutually exclusive with `description`; may combine with `descriptionEdits` (edits apply first, then this append). |
| `prUrl` | string | No | Pull request URL (e.g. `https://github.com/owner/repo/pull/123`) |
| `prNumber` | number | No | Pull request number |
| `agent` | string | No | Agent name to assign (e.g. `"claude"`, `"codex"`). Empty string clears. |
| `priority` | number | No | Task priority 0-4 (0=none, 4=highest) |
| `labels` | string[] | No | Replace the task's label list. Pass `[]` to clear. |
| `baseBranch` | string | No | Base branch the task's worktree branches from (e.g. `"main"`) |
| `useWorktree` | boolean | No | Whether the task uses an isolated git worktree |
| `model` | string | No | Model override for this task (e.g. `"opus"`, `"claude-opus-4-8"`, or the friendly `"Opus 4.8"`). Best-effort friendly-name resolution. Pass empty string to clear. |
| `effort` | string | No | Effort/reasoning level override for this task (e.g. `"xhigh"`). Pass empty string to clear. |
| `permissionMode` | string | No | Permission mode override for this task: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, or `"auto"`. Pass empty string to clear. |
| `attachments` | array | No | File attachments to ADD to the task: `[{ filePath: string, filename?: string }]`. Additive - existing attachments are kept, not replaced. Use `kangentic_remove_task_attachment` to remove one. |

At least one updatable field is required.

### kangentic_link_pr

Authoritatively resolve and link the pull request for a task's git branch using the `gh` CLI (`gh pr list --head <branch>`, plus by-number and by-commit fallbacks). Unlike the terminal-scraping auto-linker, this finds PRs opened by a human, the web UI, `git push`, scripts, or `gh api`, and works even when the task has no live session. Re-running refreshes the linked PR's state (`open`/`draft`/`merged`/`closed`). Use after opening a PR, or to backfill a task whose PR was never linked.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `project` | string | No | Project selector to target a different project |

Returns the linked PR (number, url, state) on success, or a message when no PR is found or the `gh` CLI is unavailable.

### kangentic_move_task

Move a task to a different column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task. Moving to To Do kills the session and removes the worktree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `column` | string | Yes | Target column name (case-insensitive, e.g. `"Review"`, `"Done"`) |

### kangentic_move_task_to_project

Relocate a task from the To Do column of one project's board to a different project's board. Only tasks in To Do can be moved - a task outside To Do may have a live session or worktree that cannot cross projects, so move it to To Do first (the tool also rejects a nominally-To-Do task that still has a live `session_id` or an on-disk worktree, as a defensive check). Preserves title, description, labels, priority, creation time, and attachments; assigns a new task ID and display number in the target project. Lands in the target board's To Do column by default. Landing in an `auto_spawn`-enabled `column` on the destination board spawns an agent there, the same as `kangentic_create_task`. `targetProject` must differ from the resolved source project - a same-project call is rejected with a pointer to `kangentic_move_task` instead. If any attachment fails to copy to the destination, the whole move is rolled back (the newly-created target task and its copied attachments are removed) and the source task is left untouched, so a partial-copy failure never duplicates or loses a task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) of the To Do task in the source project |
| `targetProject` | string | Yes | Destination project name (case-insensitive) or UUID. Must differ from the source project. |
| `column` | string | No | Target column on the destination board (case-insensitive). Defaults to the destination board's To Do column. |
| `project` | string | No | Source project name (case-insensitive) or UUID - not the destination. Omit to target the active project. |

### kangentic_update_column

Update a swimlane (column) configuration. Use `kangentic_get_column_detail` to inspect current values first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name to update (case-insensitive) |
| `name` | string | No | New column name (max 100 chars) |
| `description` | string \| null | No | Free-form column purpose shown as a header tooltip and shared via `kangentic.json` (max 1000 chars). `null` clears. |
| `color` | string | No | Hex color (e.g. `"#71717a"`) |
| `icon` | string \| null | No | Lucide icon name, or `null` to clear |
| `autoSpawn` | boolean | No | Whether moving a task into this column auto-spawns an agent |
| `autoCommand` | string \| null | No | Slash command template injected on agent spawn (e.g. `"/review --strict"`). `null` clears. |
| `agentOverride` | string \| null | No | Force a specific agent for this column. `null` uses project default. |
| `modelOverride` | string \| null | No | Adapter-specific model identifier passed at spawn time (e.g. Claude `"opus"`, `"sonnet"`, `"claude-opus-4-7"`). `null` inherits the agent default. |
| `effortOverride` | string \| null | No | Adapter-specific effort/reasoning level (e.g. Claude `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`). Valid values are agent-specific. `null` inherits the agent default. |
| `permissionMode` | string \| null | No | One of: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`. `null` uses project default. |
| `handoffContext` | boolean | No | Enable multi-agent handoff context preservation when entering this column |
| `planExitTargetColumn` | string \| null | No | Column to auto-move the task to when an agent in plan mode exits planning. `null` disables. |

At least one updatable field is required.

### kangentic_delete_task

Permanently delete a task from the board. Removes the task, its attachments, and session records. The associated worktree and branch may also be cleaned up. This cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID like `"42"` or full UUID). |

Find task IDs with `kangentic_find_task` or `kangentic_search_tasks`.

### kangentic_remove_task_attachment

Remove one attachment by its attachment ID, from a board task or a backlog item - the ID alone determines which surface owns it. This cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `attachmentId` | string | Yes | Attachment UUID (board `task_attachments.id` or backlog `backlog_attachments.id`) |

Find attachment IDs with `kangentic_query_db`, e.g. `SELECT id, filename, task_id FROM task_attachments` for board tasks, or `SELECT id, filename, backlog_task_id FROM backlog_attachments` for backlog items.

### kangentic_list_backlog

List items in the backlog staging area. Items have priority levels and labels for organization.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `priority` | number | No | Filter by priority: 0=none, 1=low, 2=medium, 3=high, 4=urgent |
| `query` | string | No | Search keyword to filter by title, description, or labels |

### kangentic_search

The single unified search tool for agents. One query across the active project (or all registered projects) covering: board tasks (active + archived, title and description), backlog items (title and description), session events (the structured tool_start/tool_end/idle stream from agent runs), past agent conversations, and project names/paths. Returns a per-kind grouped result with snippets so an agent can pinpoint the matching task, backlog item, session event, conversation turn, or project in one call instead of issuing `kangentic_search_tasks` + `kangentic_get_session_events` separately. (`kangentic_search_tasks` already spans board + backlog within a single project; reach for `kangentic_search` when you also need session events, past conversations, semantic matching, or cross-project scope.)

Conversations are matched by **keyword** by default; pass `mode: "hybrid"` to also match them by **meaning** (semantic embedding fused with keyword) - the "have we solved this / seen this before?" recall path over past agent conversations. `mode` affects only the conversation corpus; tasks, backlog, session events, and projects are always keyword. Both modes fall back to keyword transparently when the conversation embedding layer is off. Conversation hits carry a `sessionId` + `turnUuid`; follow up with `kangentic_get_transcript` (`aroundUuid`) to read the neighboring turns.

Defaults to scoping the search to the active project. Pass `scope: "all"` to widen across every registered project (which also surfaces project-name hits so the agent can discover routing targets). Passing `project` forces `scope: "current"` since explicit project routing already specifies the target.

Conversation hits come from the structured transcript index (`memory_chunks` FTS5 + the sqlite-vec embeddings for semantic ranking), not the raw scrollback blob; they appear only when `memory.indexingEnabled` is on (the default), and rank semantically only when the embedding layer (`memory.semanticEnabled`) is also on. Per-kind hit caps prevent runaway results: 30 tasks, 20 backlog items, 50 session events, 10 projects, 20 conversations.

Pass `taskId` to restrict conversation hits to one task's history - e.g. "what was discussed in task #286 about X, and how does that affect the current work?" Resolve the display `"#N"` to its internal id first with `kangentic_find_task` or `kangentic_get_current_task`. `taskId` only scopes conversation hits; task/backlog/session-event/project hits are unaffected. Lexical matching filters by task in the FTS query itself; semantic matching over-fetches a wider vec0 candidate set and narrows it to the task afterward (sqlite-vec has no per-query `WHERE` filter).

This tool consolidates what were previously two tools (`kangentic_search_everything` + a separate `kangentic_recall`) into one, per Anthropic's tool-design guidance that related retrieval operations belong in a single tool with a parameter rather than several overlapping tools.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword or phrase, or (in `mode:"hybrid"`) a natural-language description of what you are looking for. Case-insensitive; empty queries return no results. |
| `scope` | `'current' \| 'all'` | No | `"current"` (default) searches only the active or `project`-routed project. `"all"` widens to every registered project. Ignored (forced to `"current"`) when `project` is set. |
| `mode` | `'keyword' \| 'hybrid'` | No | How conversations are matched. `"hybrid"` (default) fuses keyword + semantic embedding; `"keyword"` is lexical-only. Only affects the conversation corpus. |
| `taskId` | string | No | Restrict conversation hits to this task's internal id (not the display `"#N"`). Other hit kinds are unaffected. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. Forces `scope: "current"`. |

### kangentic_promote_backlog

Move backlog tasks to the board, creating tasks in the specified column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemIds` | array | Yes | Backlog task IDs to move |
| `column` | string | No | Target column name. Defaults to To Do. |

Attachments on promoted backlog tasks are automatically copied to the new task. Find item IDs with `kangentic_list_backlog` or `kangentic_search_tasks` (with `scope: "backlog"`).

### kangentic_update_backlog_item

Update a backlog item's title, description, priority, labels, or attachments. Only the fields you provide are changed; omitted fields are left as-is. The `labels` parameter is a full replacement (not additive) - pass the complete new label set. `attachments` is additive - existing attachments are kept, not replaced.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemId` | string | Yes | Backlog item UUID |
| `title` | string | No | New title (max 200 characters) |
| `description` | string | No | New description (max 10,000 characters) |
| `priority` | number | No | New priority: 0=none, 1=low, 2=medium, 3=high, 4=urgent |
| `labels` | array | No | Full replacement label set. Strings, or `{name, color}` objects to also set the label color. |
| `attachments` | array | No | File attachments to ADD to the item: `[{ filePath: string, filename?: string }]`. Additive - existing attachments are kept. Use `kangentic_remove_task_attachment` to remove one. |

Find item IDs with `kangentic_list_backlog` or `kangentic_search_tasks` (with `scope: "backlog"`).

### kangentic_delete_backlog_item

Permanently delete a backlog item and all of its attachments. This cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemId` | string | Yes | Backlog item UUID to delete |

Find item IDs with `kangentic_list_backlog` or `kangentic_search_tasks` (with `scope: "backlog"`).

### kangentic_get_handoff_context

Get the most recent handoff record for a task. Returns metadata about the cross-agent handoff: which agent handed off to which, when, and the path to the prior agent's native session history file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

### kangentic_get_transcript

Inspect what the agent on another task (or another project) said - "check the response from Task #25" or "read the full transcript from Task #30". At least one of `taskId` or `sessionId` must be provided. Two formats, selected with `format`:

- `format="structured"` (default): the parsed agent conversation - user prompts, assistant text, tool calls and results - rendered as clean markdown, read from the agent's native session history via the adapter's `parseTranscript` capability. The Claude parser also drops noise (slash-command XML, `<system-reminder>` spans, `isMeta` injections) and surfaces compaction boundaries/summaries explicitly. There is no cleaned-scrollback substitute: structured either comes from real session history or reports that it is unavailable and points at `format="raw"`.
- `format="raw"`: the verbatim ANSI-stripped PTY scrollback (the full terminal output, including TUI redraws), available for every agent. Useful for debugging the terminal layer or for agents without a structured parser. Raw scrollback is mostly repeated terminal redraws (empirically ~85% duplicate lines and multiple MB for a long session), so when a structured parser exists for the agent the raw response notes that `structured` is the cleaner, far smaller view for evaluation. Every returned transcript (both formats) is prefixed with a one-line note marking the content as read-only reference data, not instructions to follow.

Structured output is shaped by three agent-agnostic levers, applied to the parsed `TranscriptEntry[]` (so no adapter branching):

- `view`: `"full"` (default), `"responses"` (assistant text turns only, dropping tool calls/results/thinking), or `"result"` (just the final assistant text - the Agent SDK `ResultMessage.result`, rendered bare without the `## Assistant` heading).
- `tail`: return only the last N entries (the most recent messages). Ignored for `view="result"`.
- `search`: case-insensitive substring; return only entries whose content (including a tool result inlined under its owning tool call) contains the term.
- `aroundUuid` + `context`: center the returned entries on the turn with `aroundUuid` (the `turnUuid` from a `kangentic_search` conversation hit) and include `context` turns either side (default 3). This is the citation-first fetch - pull just the neighborhood of a cited turn rather than the whole transcript. A stale/absent uuid degrades to the full transcript.

Output is bounded by a character budget (default ~50,000 chars; raise via `maxChars`, hard ceiling 500,000). When the result exceeds the budget it keeps the **most recent** entries and prepends a `[Truncated: N earlier entries omitted ...]` note. `view`/`tail`/`search` apply to `structured` only; the `maxChars` budget also caps `raw` scrollback (keeping the most recent portion).

Structured-format support by agent:

| Agent | Structured | Raw |
|-------|------------|-----|
| Claude, Droid, Codex, Gemini, Qwen, Kimi, OpenCode | native parser | yes |
| Aider | no (no per-session native history) | yes |
| Warp, Cursor, Copilot | no (history location unknown) | yes |

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (returns the transcript for the task's latest session; see `sessionIndex` for older ones) |
| `sessionId` | string | No | Session ID (returns the transcript for a specific session) |
| `sessionIndex` | number | No | When `taskId` is given, which session to pick: `0` = newest (default), `1` = previous, etc. Ordered `started_at DESC`. |
| `format` | string | No | `"structured"` (default) or `"raw"`. |
| `view` | string | No | Structured only. `"full"` (default), `"responses"`, or `"result"`. Ignored for raw. |
| `tail` | number | No | Structured only. Last N entries (most recent). Hard cap 2000. Ignored for `view="result"` and for raw. |
| `search` | string | No | Structured only. Case-insensitive substring; keep only entries containing it. Ignored for raw. |
| `aroundUuid` | string | No | Structured only. Center the entries on this turn uuid (from a `kangentic_search` conversation hit). Ignored for raw. |
| `context` | number | No | Structured only. Turns either side of `aroundUuid` (default 3, max 50). Ignored without `aroundUuid`. |
| `maxChars` | number | No | Override the default ~50,000-char output cap (hard ceiling 500,000). Applies to structured and raw. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

### kangentic_get_session_files

Get the absolute paths to every per-session file: `events.jsonl` (activity log), `status.json` (usage/metrics), `settings.json`, `commands.jsonl` (MCP queue), `mcp.json`, the `responses/` directory, and the agent's native session history file (Claude JSONL, Codex JSONL, or Gemini JSON). Session directories are keyed by Kangentic PTY session id under `.kangentic/sessions/<id>/`. Each file entry includes an `exists` flag. Provide either `taskId` or `sessionId`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID. Picks the latest session for the task by default. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). |
| `sessionIndex` | number | No | When `taskId` is given, which session to pick: `0` = newest (default), `1` = previous, etc. Ordered `started_at DESC`. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

### kangentic_get_session_events

Read parsed events from a session's `events.jsonl` activity log without locating or opening the file yourself. Each line is a JSON event emitted by the Claude Code hook bridge (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`, etc.). Useful for idle-detection debugging, tracing tool usage, or replaying what an agent did. Provide either `taskId` or `sessionId`. Files over 1MB are read as a bounded tail window (the last 1MB): the response sets `truncated: true` and `totalBytes`, the `since`/`eventTypes` filters apply within the scanned window, and a huge file may therefore return fewer than `tail` matches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID. Picks the latest session by default. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). |
| `sessionIndex` | number | No | When `taskId` is given, which session to pick: `0` = newest (default). |
| `tail` | number | No | Return the last N matching events. Default 200, hard cap 2000. |
| `since` | number | No | Epoch milliseconds. Only return events with `timestamp >= since`. |
| `eventTypes` | string[] | No | Only return events whose `hook_event_name` or `type` is in this list (e.g. `["PreToolUse", "Stop", "Notification"]`). |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

### kangentic_query_db

Run a read-only SQL query against the project database. The connection uses `PRAGMA query_only = ON` to prevent any write operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | Yes | SQL query to execute |

### kangentic_tail_logs

Read recent lines from the kangentic console log at `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`. Errors and warnings are always captured; `info`, `debug`, and `log` levels are captured only when `developer.persistConsoleLogs` is on. Useful for diagnosing "the action didn't work" or following up on a `console.error` trace. Returns formatted text lines plus structured `items: LogEntry[]` for typed access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Log date in `YYYY-MM-DD` format. Defaults to today (UTC). |
| `since` | string | No | Return only entries with `ts >= since` (ISO 8601). |
| `level` | `error` \| `warn` \| `info` \| `debug` \| `log` | No | Filter by log level. |
| `source` | `main` \| `renderer` \| `preload` | No | Filter by log source process. |
| `limit` | number | No | Maximum entries to return. Default 200, max 2000. |
| `project` | string | No | Project selector (name or UUID). Defaults to URL-path project. |

### kangentic_get_recent_crashes

List recent crash records from `<projectRoot>/.kangentic/logs/crashes/`. Each record contains the timestamp, kind (`main-uncaught-exception`, `main-unhandled-rejection`, `render-process-gone`, `preload-error`, `renderer-window-error`, `renderer-unhandled-rejection`), source-mapped stack, and version info captured at crash time. Always-on capture - no toggle required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum records to return. Default 10, max 50. |
| `sinceTs` | string | No | Return only crashes with `ts >= sinceTs` (ISO 8601). |
| `project` | string | No | Project selector. |

### kangentic_get_process_metrics

Live snapshot of memory + CPU usage per Electron process (main, renderer, GPU, utility) plus version + uptime info. Useful when investigating "why is kangentic slow / heavy" or filing a bug report. Reads `app.getMetrics()` on demand; not project-scoped. No parameters.

### kangentic_get_ipc_log

Read recent IPC traffic from `<projectRoot>/.kangentic/logs/ipc-<YYYY-MM-DD>.jsonl`. Each entry has `channel`, `args`, `result`, `durationMs`, and (on failure) `error`. Inbound `ipcMain.handle` invocations (renderer to main) leave `direction` absent; outbound `webContents.send` pushes (main to renderer, e.g. the `task:createdByAgent` board-invalidation events) set `direction: "out"`, and a push dropped because the window was destroyed carries an `error` with name `PushDropped`. Only available when `developer.recordIpcTraffic` is on. Channels carrying secrets (settings writes, MCP config, auth) are stored as `{ redacted: true, channel }`. An oversized `args`/`result` payload (e.g. a large list) is stored as `{ truncated: true, serializedChars, preview }` instead of the full value, keeping each log line small.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Log date in `YYYY-MM-DD` format. Defaults to today (UTC). |
| `since` | string | No | Return only entries with `ts >= since` (ISO 8601). |
| `channel` | string | No | Filter to a single IPC channel (e.g. `task:create`). |
| `limit` | number | No | Maximum entries to return. Default 200, max 2000. |
| `project` | string | No | Project selector. |

### kangentic_list_worktrees

Enumerate worktrees for one or every registered project. Each `WorktreeRecord` carries path, branch, baseRef, dirty flag, commits ahead/behind upstream, and last-commit timestamp. Pure read-only, useful for finding a task's branch, locating dirty work, or reasoning about merge state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project selector. When omitted, enumerates worktrees across every registered project. |

## Browser automation tool surface (`kangentic_browser_*`)

These **shipped** tools let an agent drive the embedded **Browser pane** of a task (an Electron `<webview>` showing the user's own dev server, e.g. `ng serve` on `http://localhost:4200`). They are distinct from the dev-only `kangentic_devtools_*` tools below, which debug Kangentic itself. They attach Chrome DevTools Protocol to the pane's guest webContents in-process (no HTTP bridge, no lockfile). Implementation: `src/main/agent/mcp-http/browser-tools.ts` plus `src/main/browser/` (pane registry, driver, shared CDP driver).

Targeting: every tool takes an optional `sessionId` or `taskId`; omit both to use the single open pane (errors with candidates when more than one is open). `kangentic_browser_list_panes` lists open panes.

Gating: the global **Agent Browser** settings tab controls the family, read live per request. `browserAutomation.enabled` is the master switch: when off, the entire `kangentic_browser_*` family is not registered, so the tools never appear in `tools/list` and the instructions omit their guidance section (they would be unusable anyway, and advertising them is wasted context). When `enabled` is on, the sub-capability gates apply: `allowInteraction` gates click/type/keypress/drag (off = observe-only); `allowNavigation` gates navigate; `allowEval` gates eval (off by default); `restrictNavigationToLocalhost` confines navigation to localhost/private hosts (off by default). With `enabled` on, each tool returns an actionable `{ kind, detail }` error when one of those sub-capabilities is gated off or no driveable pane exists.

Tool categories (14 tools):
- **Discovery:** `kangentic_browser_list_panes` - list open Browser panes and their URLs
- **Navigate:** `kangentic_browser_navigate` - point the pane at an http(s) URL
- **Observe:** `kangentic_browser_screenshot`, `kangentic_browser_screenshot_element`, `kangentic_browser_query_dom`, `kangentic_browser_query_all`, `kangentic_browser_bounding_box`, `kangentic_browser_console`, `kangentic_browser_wait`
- **Interact:** `kangentic_browser_click`, `kangentic_browser_type`, `kangentic_browser_keypress`, `kangentic_browser_drag`
- **Eval:** `kangentic_browser_eval` - evaluate a JavaScript expression in the loaded page; gated by `browserAutomation.allowEval`

Cookie isolation is per worktree (`persist:kngbrowser-<hash(worktreePath)>`) so concurrent worktrees' dev environments never share a `localhost` cookie jar. See [embedded-browser.md](embedded-browser.md).

## Dev-only tool surface (`kangentic_devtools_*`)

When `developer.previewInspectionServer` is enabled in dev builds (the toggle is excluded from production binaries via `__KANGENTIC_DEV__` esbuild dead-code elimination), 28 additional `kangentic_devtools_*` tools are registered against the same MCP server. They wrap a localhost-only HTTP inspection bridge that powers agent-driven UI inspection and interaction. Implementation lives in `src/devtools/mcp/preview-tools.ts` (build-excluded from production).

Tool categories:
- **Discovery:** `list_instances` - enumerate running preview instances by lockfile
- **State:** `engine_state`, `renderer_state`, `store_state` - live ActivityStatsSnapshot, the fixed Zustand snapshot, and arbitrary store reads by name plus dot/bracket path
- **Visual / DOM:** `screenshot`, `screenshot_element`, `query_dom`, `query_all`, `computed_style`, `bounding_box`, `bounding_box_all`, `accessibility_tree`, `mutations` - the `_all` variants measure every matching element in one call
- **React:** `react_query`, `react_tree`, `react_recent_renders` - fiber walker via `__REACT_DEVTOOLS_GLOBAL_HOOK__`
- **Console:** `console` - CDP `Console.messageAdded` ring buffer (separate from product `tail_logs`)
- **Drive (interaction):** `click`, `type`, `keypress`, `drag`, `wait`, `script` - dispatched via Chrome DevTools Protocol (the `script` `eval` step returns its value and is gated by `developer.previewEvalEnabled`)
- **Eval:** `eval` - evaluate a JavaScript expression and return its serialized value; gated by `developer.previewEvalEnabled`
- **Cross-instance:** `run_command` - run a product MCP command inside a specific preview instance
- **Sessions:** `pty_input`, `inject_session_event`, `capture_trace` - `inject_session_event` and `pty_input` raw bytes are gated additionally by `developer.previewEvalEnabled`

These tools are excluded from production builds at compile time and have no effect in shipped binaries.

## Configuration

### Project Setting

The MCP server is enabled by default. To disable it for a specific project:

**Settings > Agent > MCP Server** - toggle off "Allow agents to create tasks via MCP"

When disabled:
- No `--mcp-config` flag is added to the CLI command
- No session `mcp.json` is created
- No CommandBridge is created for sessions

Config key: `mcpServer.enabled` (boolean, default `true`)

### Network Access

Two advanced config keys, both read once at app startup (changing either requires a restart), are not exposed in the Settings UI - set them by hand-editing the global `config.json`: `mcpServer.bindAddress` (string, default `'127.0.0.1'`) is the interface the HTTP server listens on - widening this beyond loopback (`0.0.0.0` for every interface) is what actually exposes the server to other machines; `mcpServer.callbackHost` (string, optional, default unset) is allowlisted alongside `bindAddress` for the DNS-rebinding-protection check (see Security below), so a real client naming that host in its request is not rejected.

Both default to today's exact loopback-only behavior. `urlForProject` (used by every local consumer - `.kangentic/mcp-config.json`, per-session `mcp.json`) always stays on `127.0.0.1` regardless of `bindAddress`.

That keeps locally-spawned agents working for the default and for a **wildcard** bind, since `0.0.0.0` (and `::`) bind loopback along with every other interface. Known limitation: it does **not** hold for a bind to one specific non-loopback interface (e.g. `bindAddress: '10.0.0.5'`). That leaves loopback unbound, so every local agent gets a `127.0.0.1` URL the server is not listening on and its MCP calls fail with a connection error. Prefer a wildcard `bindAddress` plus a `callbackHost` naming the reachable address.

Widening `bindAddress` alone is not enough for an external client to actually connect: `bindAddress: '0.0.0.0'` binds every interface, but a real client's request carries a `Host` header naming the machine's actual LAN/VPN address (e.g. `10.0.0.5`), not `0.0.0.0` - so `mcpServer.callbackHost` also needs to be set to that same reachable address, or the request is rejected by DNS-rebinding protection even though the socket accepted the connection.

To point an external MCP client (a manually-run remote OpenCode server's own `opencode.json`, a second machine's Claude Desktop, etc.) at Kangentic: read the URL and token Kangentic already writes to `.kangentic/mcp-config.json` for that project (see Discovery above) and substitute the reachable `callbackHost` for that file's `127.0.0.1`. There is no separate delivery mechanism - Kangentic does not push this config anywhere itself, and the port and token both rotate on every Kangentic restart, so this is not a durable setup.

**Remote OpenCode sessions are not automatically wired**, and widening these settings does not change that: `opencode attach <url>` (which Kangentic spawns in OpenCode's remote-execution mode) is a stateless HTTP client to a server that was started, and had its config fixed, independently and earlier. It has no config-push mechanism (`opencode attach --help` lists only `--dir`, `--continue`, `--session`, `--fork`, `--username`, `--password`), so env vars Kangentic sets on the attach process are never read by the already-running server. This holds even when the target server is on the same machine.

### Permissions

Agents Kangentic spawns never see a permission prompt for Kangentic's own tools. Three layers cover the axes (which mode, which project):

1. **Auto-allow injection (all projects, default / acceptEdits mode).** Whenever the MCP server is attached, `CommandBuilder.createMergedSettings()` appends `mcp__kangentic` to `permissions.allow` in the per-session merged `settings.json` (`.kangentic/sessions/<sessionId>/settings.json`). This is gated on the same condition as the session `mcp.json` write and is append-if-absent, so a committed project rule or a Claude "always allow" grant is not duplicated. It lives only in the regenerated per-session settings, never written back to the user's own settings files, and an explicit user `deny` of `mcp__kangentic` still wins (deny outranks allow). So the no-prompt behavior holds for every project, not just ones that committed a rule.
2. **Read-only annotations (all projects, plan mode).** Allow rules do not punch through plan mode. Plan-mode auto-approval comes from the tools' `readOnlyHint` annotations (see the Tool annotations note under Available Tools): read-only tools run without a prompt while planning; mutating tools still prompt, by design.
3. **Auto-mode classifier allow rule (all projects, auto mode).** `--permission-mode auto` runs its OWN natural-language classifier that does not honor `permissions.allow`, so the same `createMergedSettings()` also appends a plain-language rule (`KANGENTIC_AUTO_MODE_ALLOW_RULE`) to `autoMode.allow`, seeding the array with `$defaults` when absent so the classifier's built-in rules are preserved. Without it a headless, board-driven auto-mode session (e.g. a Code Review column) could soft-deny Kangentic's own board/session tools even though they are allowed by default. Append-if-absent, per-session only, and the built-in `$defaults` stay in effect.

The committed `.claude/settings.json` `mcp__kangentic` entry remains for humans running `claude` outside Kangentic; inside Kangentic the injection makes it redundant but harmless (deduped).

## Security

- **Loopback bind by default** - the HTTP server binds to `127.0.0.1:0` (random port) unless a user opts into a wider `mcpServer.bindAddress` (see Network Access above). Loopback is not reachable from other machines and does not trigger a Windows Defender Firewall prompt. Not `localhost` (which can resolve to `::1` on IPv6-preferring systems) and not `0.0.0.0` unless explicitly configured.
- **Per-launch token** - every Kangentic launch generates a fresh 32-byte random `X-Kangentic-Token`. Clients without the token get `401`. Comparison is constant-time (`timingSafeEqual`) so a local timing oracle cannot byte-by-byte recover the token. This becomes the primary defense once a user widens `bindAddress`.
- **DNS rebinding protection** - the Streamable HTTP transport enforces a host allowlist (`127.0.0.1`, `localhost`, `[::1]`, plus the configured `bindAddress`/`callbackHost` when set) on top of the bind.
- **Project routing via URL path** - the URL embeds the project ID (`/mcp/<projectId>`). A stale `mcp.json` for a different project cannot be reused against the current launch.
- **Runaway-loop safeguard** - task creations are capped at a fixed 500 per app launch, enforced atomically by the shared `TaskCounter`. This is an internal circuit breaker against a looping agent, not a user-tunable knob; the count resets on restart.
- **Input validation** - Zod schemas enforce title (200 chars) and description (50000 chars for tasks; 10000 chars for backlog item descriptions) limits at the protocol level, and the command handlers validate again. A backlog item created via `kangentic_create_task` shares the task 50000-char Zod schema, so `handleCreateTask` enforces the 10000 backlog cap itself and rejects an over-cap backlog description rather than truncating it.
- **Column safety** - `kangentic_create_task` defaults to the To Do column; creating in an auto_spawn column intentionally triggers agent spawn. `kangentic_move_task_to_project` follows the same rule on the destination board: landing in an auto_spawn `column` there spawns an agent.
- **Destructive operations are explicit** - `kangentic_delete_task`, `kangentic_delete_backlog_item`, `kangentic_remove_task_attachment`, `kangentic_move_task`, and `kangentic_move_task_to_project` mutate the board. Agents must invoke them by name; there is no implicit fallback.
- **Cross-project relocation is scoped to To Do** - `kangentic_move_task_to_project` refuses to relocate a task outside the To Do column, since only a To Do task is guaranteed to have no live session or worktree that would be stranded in the source project's repo.
- **Honest mutating annotations** - mutating tools carry `readOnlyHint: false`, so the plan-mode auto-approval surface is exactly the read-only set. Deletes, moves, and creates always prompt while planning, even though the auto-allow injection pre-approves them in default mode.

## Build

The MCP server runs in-process inside the Electron main bundle - there is no separate `mcp-server.js` and no child process spawned for Kangentic itself.

- **Dev mode** (`npm start`): `mcp-http-server.ts` and the per-domain tool registrations under `mcp-http/` are part of the main esbuild bundle in `scripts/dev.js`.
- **Production** (`npm run build`): same modules included in the main bundle by `scripts/build.js`.
- **Dev-only devtools tools** (`src/devtools/mcp/`): excluded from production via `__KANGENTIC_DEV__` esbuild dead-code elimination.

Dependencies (`@modelcontextprotocol/sdk`, `zod`) are bundled into the main process JS - not shipped in `node_modules`.

## Troubleshooting

### MCP tools not showing up

1. Check the session's MCP config: `.kangentic/sessions/<sessionId>/mcp.json` should contain a `kangentic` entry under `mcpServers` with a `type: "http"`, a `url` pointing at `http://127.0.0.1:<port>/mcp/<projectId>`, and an `X-Kangentic-Token` header.
2. Check the CLI command includes `--mcp-config` pointing to the session's `mcp.json`.
3. Check `~/.claude.json`: the project path should have `"kangentic"` in `enabledMcpjsonServers`.
4. Verify the in-process server is listening: look for `[mcp-http] Listening on http://127.0.0.1:<port>/mcp` in the Electron main console at launch.
5. The token rotates on every launch - if you started Kangentic after the agent was spawned, the agent's `mcp.json` still references the old token. Restart the session.

### Agent uses TodoWrite instead of kangentic_create_task

The agent may not know about the MCP tools. Ask explicitly: "Use the kangentic_create_task tool to create a task called X". Claude Code discovers the tools but may default to its built-in task system without prompting.

### Tool call returns 401

The agent is sending the wrong token. The token is regenerated per launch; close and respawn the session so its `mcp.json` is rewritten with the current token.

### Tool call returns 404

Either the URL path doesn't match `/mcp/<projectId>` (probably a malformed `mcp.json`), or the project ID is no longer registered (deleted while the agent was running). Check `kangentic_list_projects`.
