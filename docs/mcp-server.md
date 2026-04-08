# MCP Server

## Overview

Kangentic exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude Code agents tools to interact with the Kanban board. Agents can create tasks, search the board, view session statistics, and more - all through structured tool calls during their work.

This enables a key workflow: while working on a task, an agent identifies follow-up work (bugs, refactoring opportunities, improvements) and creates Kangentic tasks for them directly, without the user manually entering each one.

## How It Works

### Architecture

```
Claude Code agent calls MCP tool (e.g. kangentic_create_task)
  -> MCP server (stdio Node.js process, spawned by Claude Code)
  -> Writes command to .kangentic/sessions/<sessionId>/commands.jsonl
  -> Electron main process (CommandBridge) watches file via FileWatcher
  -> Processes command via TaskRepository / SwimlaneRepository
  -> Writes response to .kangentic/sessions/<sessionId>/responses/<requestId>.json
  -> MCP server reads response, returns result to Claude Code
  -> Board refreshes via IPC event + toast notification
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| MCP Server | `src/main/agent/mcp-server.ts` | Stdio MCP server using official SDK. Bundled by esbuild into single JS file. |
| Command Bridge | `src/main/agent/command-bridge.ts` | Watches commands.jsonl, processes commands via DB repositories, writes responses. |
| Command Handlers | `src/main/agent/commands/` | Extracted per-domain handlers: task, inventory, search, analytics, backlog commands. |
| Column Resolver | `src/main/agent/commands/column-resolver.ts` | Shared case-insensitive column name to swimlane lookup used by multiple handlers. |
| MCP Config Delivery | `src/main/agent/adapters/claude/command-builder.ts` | Writes session `mcp.json` and adds `--mcp-config` flag to CLI command. |
| Trust Manager | `src/main/agent/adapters/claude/trust-manager.ts` | Pre-approves kangentic MCP server in `~/.claude.json`. |
| Board Refresh | `src/main/ipc/handlers/sessions.ts` | Forwards task-created/updated/backlog-changed events to renderer via IPC. |

### Discovery

Claude Code supports a `--mcp-config` flag that accepts a path to a JSON file containing MCP server definitions. Kangentic uses this to deliver its MCP server config without modifying `.mcp.json` (which may be tracked in git). When Kangentic spawns a session:

1. `CommandBuilder.createMergedSettings()` writes the kangentic MCP server config to `.kangentic/sessions/<sessionId>/mcp.json`
2. `CommandBuilder.buildClaudeCommand()` adds `--mcp-config <path>` to the CLI command
3. `ensureMcpServerTrust()` adds "kangentic" to `enabledMcpjsonServers` in `~/.claude.json`
4. Claude Code starts, reads both `.mcp.json` (user servers) and the `--mcp-config` file (kangentic), spawns `node mcp-server.js` as a child process
5. Claude Code calls `tools/list` and discovers all kangentic tools

This approach keeps `.mcp.json` completely untouched - no injection, no cleanup, no git noise. The `--mcp-config` flag is additive (not `--strict-mcp-config`), so user-configured servers like context7 continue to work normally.


## Available Tools

### kangentic_create_task

Create a new task on the board. Defaults to the To Do column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title (max 200 chars) |
| `description` | string | No | Task description, supports markdown (max 10000 chars) |
| `column` | string | No | Target column name (case-insensitive). Defaults to To Do. |
| `branchName` | string | No | Custom git branch name |
| `baseBranch` | string | No | Base branch for the task |
| `useWorktree` | boolean | No | Whether to use a git worktree |
| `attachments` | array | No | File attachments: `[{ filePath: string, filename?: string }]`. Files are read from disk and stored in the project's `.kangentic/` directory. |

If the target column has `auto_spawn` enabled, creating a task there will also spawn an agent session for it.

Rate limit: 50 task creations per session.

### kangentic_list_columns

List all non-archived columns with task counts.

No parameters. Returns column names, roles, and current task counts.

### kangentic_list_tasks

List tasks, optionally filtered by column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | No | Filter by column name. If omitted, returns all tasks. |

### kangentic_search_tasks

Search tasks by keyword across titles and descriptions. Includes both active and archived tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword (case-insensitive) |
| `status` | string | No | Filter: "active", "completed", or "all" (default) |

### kangentic_find_task

Find a task by display ID, UUID, branch name, title keyword, or PR number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `displayId` | number | No | Numeric task display ID shown in UI (e.g. `24` for "#24"). Exact match. |
| `id` | string | No | Full task UUID. Exact match. |
| `branch` | string | No | Git branch name (matches the `tasks.branch_name` column, partial) |
| `title` | string | No | Title keyword (case-insensitive) |
| `prNumber` | number | No | Pull request number |

At least one parameter is required.

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

### kangentic_get_task_stats

Get session metrics for a specific task or across all tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Specific task ID. If omitted, returns aggregate stats. |
| `query` | string | No | Filter tasks by keyword before aggregating |
| `sortBy` | string | No | Sort metric: "tokens", "cost", "duration", "toolCalls", "linesChanged" |

### kangentic_get_session_history

Get the session history for a task: start/end times, exit codes, suspension info, and metrics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

### kangentic_get_column_detail

Get detailed column configuration: auto-spawn, permission mode, plan exit target, and visual settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name (case-insensitive) |

### kangentic_update_task

Update a task's title, description, PR info, agent assignment, priority, labels, base branch, or worktree toggle. To move a task between columns, use `kangentic_move_task` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `title` | string | No | New title (max 200 chars) |
| `description` | string | No | New description (max 10000 chars) |
| `prUrl` | string | No | Pull request URL (e.g. `https://github.com/owner/repo/pull/123`) |
| `prNumber` | number | No | Pull request number |
| `agent` | string | No | Agent name to assign (e.g. `"claude"`, `"codex"`). Empty string clears. |
| `priority` | number | No | Task priority 0-4 (0=none, 4=highest) |
| `labels` | string[] | No | Replace the task's label list. Pass `[]` to clear. |
| `baseBranch` | string | No | Base branch the task's worktree branches from (e.g. `"main"`) |
| `useWorktree` | boolean | No | Whether the task uses an isolated git worktree |

At least one updatable field is required.

### kangentic_move_task

Move a task to a different column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task. Moving to To Do kills the session and removes the worktree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `column` | string | Yes | Target column name (case-insensitive, e.g. `"Review"`, `"Done"`) |

### kangentic_update_column

Update a swimlane (column) configuration. Use `kangentic_get_column_detail` to inspect current values first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name to update (case-insensitive) |
| `name` | string | No | New column name (max 100 chars) |
| `color` | string | No | Hex color (e.g. `"#71717a"`) |
| `icon` | string \| null | No | Lucide icon name, or `null` to clear |
| `autoSpawn` | boolean | No | Whether moving a task into this column auto-spawns an agent |
| `autoCommand` | string \| null | No | Slash command template injected on agent spawn (e.g. `"/review --strict"`). `null` clears. |
| `agentOverride` | string \| null | No | Force a specific agent for this column. `null` uses project default. |
| `permissionMode` | string \| null | No | One of: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`. `null` uses project default. |
| `handoffContext` | boolean | No | Enable multi-agent handoff context preservation when entering this column |
| `planExitTargetColumn` | string \| null | No | Column to auto-move the task to when an agent in plan mode exits planning. `null` disables. |

At least one updatable field is required.

### kangentic_list_backlog

List items in the backlog staging area. Items have priority levels and labels for organization.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `priority` | number | No | Filter by priority: 0=none, 1=low, 2=medium, 3=high, 4=urgent |
| `query` | string | No | Search keyword to filter by title, description, or labels |

### kangentic_create_backlog_task

Create a new task in the backlog staging area for work not yet ready for the board.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title (max 200 chars) |
| `description` | string | No | Task description, supports markdown (max 10000 chars) |
| `priority` | number | No | Priority: 0=none (default), 1=low, 2=medium, 3=high, 4=urgent |
| `labels` | array | No | String labels for categorization |
| `attachments` | array | No | File attachments: `[{ filePath: string, filename?: string }]` |

Rate limit: shared with task creation (50 per session).

### kangentic_search_backlog

Search backlog tasks by keyword across titles, descriptions, and labels.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword (case-insensitive) |

### kangentic_promote_backlog

Move backlog tasks to the board, creating tasks in the specified column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemIds` | array | Yes | Backlog task IDs to move |
| `column` | string | No | Target column name. Defaults to To Do. |

Attachments on promoted backlog tasks are automatically copied to the new task.

### kangentic_get_handoff_context

Get full handoff context for a task, including transcript, git changes, and session metrics. Used during cross-agent handoff to package context from one agent's session for another.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |
| `section` | string | No | Which section to return: `all` (default), `decisions`, `changes`, `transcript`, or `metrics` |

### kangentic_get_transcript

Get the ANSI-stripped session transcript for a task or session. At least one of `taskId` or `sessionId` must be provided.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (returns transcript for the task's latest session) |
| `sessionId` | string | No | Session ID (returns transcript for a specific session) |

### kangentic_query_db

Run a read-only SQL query against the project database. The connection uses `PRAGMA query_only = ON` to prevent any write operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | Yes | SQL query to execute |

## Configuration

### Project Setting

The MCP server is enabled by default. To disable it for a specific project:

**Settings > Agent > MCP Server** - toggle off "Allow agents to create tasks via MCP"

When disabled:
- No `--mcp-config` flag is added to the CLI command
- No session `mcp.json` is created
- No CommandBridge is created for sessions

Config key: `mcpServer.enabled` (boolean, default `true`)

### Permissions

The `.claude/settings.json` file includes a wildcard permission entry (`mcp__kangentic`) that pre-approves all kangentic MCP tools at once. Agents can use any kangentic tool without prompting for approval. This avoids maintaining a separate permission entry for each individual tool name.

## Security

- **Project isolation** - each MCP server instance is scoped to one project via session-specific file paths
- **Rate limiting** - maximum 50 task creations per session
- **Input validation** - Zod schemas enforce title (200 chars) and description (10000 chars) limits at the protocol level; the CommandBridge validates again
- **Column safety** - defaults to To Do; creating in an auto_spawn column intentionally triggers agent spawn
- **No destructive operations** - read and create/update only; no delete or move (which could trigger agent spawns)
- **Console safety** - MCP server uses `console.error()` only; stdout is reserved for JSON-RPC

## File-Based Command Queue

The MCP server process runs outside the Electron main process (spawned by Claude Code). Communication uses a file-based queue:

### Commands (MCP server writes)

`<project>/.kangentic/sessions/<sessionId>/commands.jsonl`

Each line is a JSON object:
```json
{"id":"<uuid>","method":"create_task","params":{"title":"..."},"ts":1234567890}
```

### Responses (Electron main process writes)

`<project>/.kangentic/sessions/<sessionId>/responses/<requestId>.json`

```json
{"success":true,"data":{"taskId":"...","title":"...","column":"To Do"},"message":"Created task..."}
```

The MCP server polls for the response file (100ms interval, 10s timeout), reads it, and deletes it after processing.

## Build

The MCP server is written in TypeScript and bundled by esbuild into a single `mcp-server.js` file:

- **Dev mode** (`npm start`): bundled in `scripts/dev.js` alongside main/preload
- **Production** (`npm run build`): bundled in `scripts/build.js`
- **Packaging**: listed in `electron-builder.yml` `asarUnpack` so it runs outside the asar archive

Dependencies (`@modelcontextprotocol/sdk`, `zod`) are bundled inline - not shipped in `node_modules`.

## Troubleshooting

### MCP tools not showing up

1. Check the session's MCP config: `.kangentic/sessions/<sessionId>/mcp.json` should contain a `kangentic` entry under `mcpServers`
2. Check the CLI command includes `--mcp-config` pointing to the session's `mcp.json`
3. Check `~/.claude.json`: the project path should have `"kangentic"` in `enabledMcpjsonServers`
4. Verify the bundled server exists: `.vite/build/mcp-server.js`
5. Test the server manually: `node .vite/build/mcp-server.js test-cmd.jsonl test-resp` (should print "[mcp-server] Kangentic MCP server started" to stderr)

### Agent uses TodoWrite instead of kangentic_create_task

The agent may not know about the MCP tools. Ask explicitly: "Use the kangentic_create_task tool to create a task called X". Claude Code discovers the tools but may default to its built-in task system without prompting.

### Command timeout

If the MCP server reports timeouts, the CommandBridge in the main process may not be processing commands. Check:
- Session is still running (not suspended/exited)
- `.kangentic/sessions/<sessionId>/commands.jsonl` has content
- No errors in the Electron main process console
