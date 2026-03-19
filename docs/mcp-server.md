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
| MCP Config Delivery | `src/main/agent/command-builder.ts` | Writes session `mcp.json` and adds `--mcp-config` flag to CLI command. |
| Trust Manager | `src/main/agent/trust-manager.ts` | Pre-approves kangentic MCP server in `~/.claude.json`. |
| Board Refresh | `src/main/ipc/handlers/sessions.ts` | Forwards task-created/updated events to renderer via IPC. |

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

Create a new task on the board. Defaults to the Backlog column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title (max 200 chars) |
| `description` | string | No | Task description, supports markdown (max 10000 chars) |
| `column` | string | No | Target column name (case-insensitive). Defaults to Backlog. |
| `branchName` | string | No | Custom git branch name |
| `baseBranch` | string | No | Base branch for the task |
| `useWorktree` | boolean | No | Whether to use a git worktree |

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

Find a task by branch name, title keyword, or PR number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch` | string | No | Git branch name (partial match) |
| `title` | string | No | Title keyword (case-insensitive) |
| `prNumber` | number | No | Pull request number |

At least one parameter is required.

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

Update a task's title or description.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |
| `title` | string | No | New title (max 200 chars) |
| `description` | string | No | New description (max 10000 chars) |

At least one of `title` or `description` is required.

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

The `.claude/settings.json` file includes pre-approved permissions for all kangentic MCP tools. Agents can use the tools without prompting for approval.

## Security

- **Project isolation** - each MCP server instance is scoped to one project via session-specific file paths
- **Rate limiting** - maximum 50 task creations per session
- **Input validation** - Zod schemas enforce title (200 chars) and description (10000 chars) limits at the protocol level; the CommandBridge validates again
- **Column safety** - defaults to Backlog; creating in an auto_spawn column intentionally triggers agent spawn
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
{"success":true,"data":{"taskId":"...","title":"...","column":"Backlog"},"message":"Created task..."}
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
