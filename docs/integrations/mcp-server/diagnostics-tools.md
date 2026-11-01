---
type: Reference
title: Diagnostics tools
description: "Read-only MCP tools for debugging Kangentic itself: query_db under query_only, tail_logs, get_recent_crashes, get_process_metrics, get_ipc_log (needs developer.recordIpcTraffic) and list_worktrees with ahead and behind counts."
tags: [mcp, diagnostics, logs]
sources:
  - resource: src/main/agent/mcp-http/diagnostics-tools.ts
  - resource: src/main/agent/mcp-http/session-tools.ts
    title: kangentic_query_db registration
  - resource: src/main/agent/commands/inspect-commands.ts
---
# Diagnostics tools

## kangentic_query_db

Run a read-only SQL query against the project database. The connection uses `PRAGMA query_only = ON` to prevent any write operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | Yes | SQL query to execute |

It returns up to 100 rows as a markdown table. A cell is cut at 20,000 characters when the result
is one row, which is how an agent reads a long value such as a run's detail or a description, and
at 1,000 across several rows. When any cell was cut, the last line names the columns and says to
select one row or use `substr(column, start, length)`. The flat 120-character cut before task #952
cut the very values an agent asked for.

The tool description also tells the agent that each `sessions` row is one run of a conversation
and that a resume adds a row. `total_cost_usd` and `total_duration_ms` are cumulative for the whole
conversation as of that run, so the latest row of an `agent_session_id` is its total, never a SUM
across its rows. It lists `isolated_swimlane_id` and `start_head_sha` among the `sessions` columns.

## kangentic_tail_logs

Read recent lines from the kangentic console log at `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`, merged with the app's global fallback at `<configDir>/logs/<YYYY-MM-DD>.log` (where the log mirror writes while no project is open, so a global subsystem such as the mobile bridge keeps its trace across the gap). The two files are combined and sorted by timestamp before the filters apply. Errors and warnings are always captured; `info`, `debug`, and `log` levels are captured only when `developer.persistConsoleLogs` is on. Useful for diagnosing "the action didn't work" or following up on a `console.error` trace. Returns formatted text lines plus structured `items: LogEntry[]` for typed access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Log date in `YYYY-MM-DD` format. Defaults to today (UTC). |
| `since` | string | No | Return only entries with `ts >= since` (ISO 8601). |
| `level` | `error` \| `warn` \| `info` \| `debug` \| `log` | No | Filter by log level. |
| `source` | `main` \| `renderer` \| `preload` | No | Filter by log source process. |
| `limit` | number | No | Maximum entries to return. Default 200, max 2000. |
| `project` | string | No | Project selector (name or UUID). Defaults to URL-path project. |

## kangentic_get_recent_crashes

List recent crash records from `<projectRoot>/.kangentic/logs/crashes/` (falling back to the app's own config directory for a crash recorded with no project open). Each record contains the timestamp, kind (`main-uncaught-exception`, `main-unhandled-rejection`, `render-process-gone`, `gpu-process-gone`, `preload-error`, `renderer-window-error`, `renderer-unhandled-rejection`), source-mapped stack, and version info captured at crash time. Always-on capture - no toggle required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum records to return. Default 10, max 50. |
| `sinceTs` | string | No | Return only crashes with `ts >= sinceTs` (ISO 8601). |
| `project` | string | No | Project selector. |

## kangentic_get_process_metrics

Live snapshot of memory + CPU usage per Electron process (main, renderer, GPU, utility) plus version + uptime info. Useful when investigating "why is kangentic slow / heavy" or filing a bug report. Reads `app.getMetrics()` on demand; not project-scoped. No parameters. The per-process `privateBytes` is the Windows commit figure (in KB, like the rest of the table), which is what the low-memory warning measures; the two model workers appear by service name (`kangentic-dictation`, `kangentic-embeddings`). `main` carries the main process's own `process.memoryUsage()` in bytes (`rssBytes`, `heapTotalBytes`, `heapUsedBytes`, `externalBytes`, `arrayBuffersBytes`), which is the only way to tell V8 heap from Node external allocations from Chromium's own footprint without attaching an inspector to the live process.

## kangentic_get_ipc_log

Read recent IPC traffic from `<projectRoot>/.kangentic/logs/ipc-<YYYY-MM-DD>.jsonl`. Each entry has `channel`, `args`, `result`, `durationMs`, and (on failure) `error`. Inbound `ipcMain.handle` invocations (renderer to main) leave `direction` absent; outbound `webContents.send` pushes (main to renderer, e.g. the `task:createdByAgent` board-invalidation events) set `direction: "out"`, and a push dropped because the window was destroyed carries an `error` with name `PushDropped`. Only available when `developer.recordIpcTraffic` is on. Channels carrying secrets (settings writes, MCP config, auth) are stored as `{ redacted: true, channel }`. An oversized `args`/`result` payload (e.g. a large list) is stored as `{ truncated: true, serializedChars, preview }` instead of the full value, keeping each log line small.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Log date in `YYYY-MM-DD` format. Defaults to today (UTC). |
| `since` | string | No | Return only entries with `ts >= since` (ISO 8601). |
| `channel` | string | No | Filter to a single IPC channel (e.g. `task:create`). |
| `limit` | number | No | Maximum entries to return. Default 200, max 2000. |
| `project` | string | No | Project selector. |

## kangentic_list_worktrees

Enumerate worktrees for one or every registered project. Each `WorktreeRecord` carries path, branch, the base branch its work is based on (`baseRef`: the task's own base, else the base it was cut from, else the project default; the main checkout included), dirty flag, commits ahead/behind that base (measured against `origin/<base>` first, then the local ref; the branch's own upstream only when no base resolves, which then says how current the branch is with its own remote rather than with the base), and last-commit timestamp. Pure read-only and never fetches: the counts are as current as the remote-tracking refs, which the background fetch scheduler keeps refreshed for the focused project. Useful for finding a task's branch, locating dirty work, or checking whether a tree is behind the base it was cut from.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project selector. When omitted, enumerates worktrees across every registered project. |
