# MCP Server

## Overview

Kangentic exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives spawned agents tools to interact with the Kanban board. Agents can create tasks, search the board, view session statistics, and more - all through structured tool calls during their work.

Most supported agents are wired automatically; the mechanism differs per CLI. See [Discovery](#discovery) for the per-adapter delivery table.

This enables a key workflow: while working on a task, an agent identifies follow-up work (bugs, refactoring opportunities, improvements) and creates Kangentic tasks for them directly, without the user manually entering each one.

## How It Works

### Architecture

```
A Kangentic-spawned agent calls an MCP tool (e.g. kangentic_create_task)
  -> HTTP POST http://127.0.0.1:<port>/mcp/<projectId>
     (X-Kangentic-Token header, JSON-RPC body)
  -> In-process MCP HTTP server in Electron main (mcp-http-server.ts)
  -> Per-request McpServer + Streamable HTTP transport
  -> Tool handler runs in the same HTTP request against project DB
  -> Response returned in same HTTP request (no SSE, no file polling)
  -> Board refreshes via IPC event + toast notification
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| MCP HTTP Server | `src/main/agent/mcp-http-server.ts` | In-process Node `http` server using `@modelcontextprotocol/sdk` Streamable HTTP transport. Binds 127.0.0.1 by default (configurable via `mcpServer.bindAddress`), random `:0` port, random per-launch token validated via `X-Kangentic-Token`. See [Network Access](#network-access). |
| Task Tools | `src/main/agent/mcp-http/task-tools.ts` | Board/task/column mutations + related reads (`kangentic_create_task`, `kangentic_move_task`, `kangentic_reorder_tasks`, `kangentic_update_task`, `kangentic_link_pr`, `kangentic_update_column`, `kangentic_create_column`, `kangentic_delete_column`, `kangentic_delete_task`, `kangentic_list_columns`, `kangentic_find_task`, `kangentic_get_current_task`, etc.). |
| Profile Tools | `src/main/agent/mcp-http/profile-tools.ts` | Board Profile read + authoring (`kangentic_list_board_profiles`, `kangentic_create_board_profile`, `kangentic_update_board_profile`, `kangentic_delete_board_profile`). Entries are keyed by column NAME so a profile can be copied between projects; see [Board Profiles](#board-profiles). |
| Session Tools | `src/main/agent/mcp-http/session-tools.ts` | Session inspection, backlog, read-only SQL (`kangentic_list_sessions`, `kangentic_get_transcript`, `kangentic_get_session_files`, `kangentic_get_session_events`, `kangentic_get_activity_intervals`, `kangentic_query_db`, `kangentic_list_backlog`, etc.). |
| Steering Tools | `src/main/agent/mcp-http/steering-tools.ts` | The write side of the session surface (`kangentic_send_session_message`) plus its debugging read (`kangentic_get_session_messages_sent`). Kept out of `session-tools.ts` because the send needs live main-process singletons (SessionManager, TerminalSubmit) that `CommandContext` does not carry. |
| Session Send Coordinator | `src/main/agent/mcp-http/session-send.ts` | Delivery + guards behind the steering tools: per-target serialization, the sliding-window ceiling, the steer-chain depth backstop, deferred `deliverWhen: "idle"` delivery, and out-of-band provenance recording (the message itself carries no in-band prefix). |
| Project Tools | `src/main/agent/mcp-http/project-tools.ts` | Multi-project discovery (`kangentic_list_projects`). |
| Search Tools | `src/main/agent/mcp-http/search-tools.ts` | The single unified search (`kangentic_search`): tasks, backlog, session events, projects, and past conversations (keyword or, with `mode:"hybrid"`, semantic). The board-scoped `kangentic_search_tasks` lives in `task-tools.ts`. |
| Diagnostics Tools | `src/main/agent/mcp-http/diagnostics-tools.ts` | Read-only product tools backing crash records, persistent console logs, process metrics, IPC traffic recordings, and worktree state. |
| Tool Annotations | `src/main/agent/mcp-http/annotations.ts` | Shared `READ_ONLY_ANNOTATIONS` / `MUTATING_ANNOTATIONS` MCP tool-annotation constants. Every tool in every `*-tools.ts` file declares one of these (see the Tool annotations note below). |
| Browser Tools | `src/main/agent/mcp-http/browser-tools.ts` | Shipped `kangentic_browser_*` MCP tool family driving the embedded Browser pane via in-process CDP (no HTTP bridge, no lockfile). Gated by the global `browserAutomation.*` policy. |
| Usage Tools | `src/main/agent/mcp-http/usage-tools.ts` | Aggregated usage statistics (`kangentic_get_usage_stats`): tokens, cost, burn rate, and by-model / by-agent / by-effort breakdowns, per project or app-wide, over the shared time ranges. Reads the same usage-stats service as the in-app dashboard. |
| Command Handlers | `src/main/agent/commands/` | Per-domain handlers shared by the HTTP tools: task, column, profile (`profile-commands.ts`: the four `*_board_profile` commands plus the shared `resolveProfileSelector` used by create/update task), inventory, search, analytics, usage, backlog, handoff, inspect (`get_transcript`, `query_db`), session-files (`get_session_files`, `get_session_events`), and activity-interval (`get_activity_intervals`) commands. |
| Column Resolver | `src/main/agent/commands/column-resolver.ts` | Shared case-insensitive column name to swimlane lookup used by multiple handlers. |
| Task Ordering | `src/main/agent/commands/task-ordering.ts` | Pure ordinal-slot arithmetic shared by `handleMoveTask`'s same-column reposition and `handleReorderTasks`: slot clamping, prefix-merge reordering, and ordinal-to-raw-position translation. |
| MCP Config Delivery | Per-adapter, under `src/main/agent/adapters/<agent>/` | Each adapter delivers the per-launch URL + token through its own CLI's mechanism. See the [Discovery](#discovery) table. |
| Trust Managers | `adapters/claude/trust-manager.ts`, `adapters/codex/trust-manager.ts`, `adapters/gemini/trust-manager.ts`, `adapters/qwen-code/trust-manager.ts`, `adapters/grok/trust-manager.ts`, `adapters/antigravity/trust-manager.ts` | Pre-approve the spawn directory so the session is not blocked at startup: Claude in `~/.claude.json`, Codex via `[projects.'<path>'] trust_level` in `~/.codex/config.toml`, Gemini and Qwen via `trustedFolders.json`, Grok via `[folders.'<path>']` in `~/.grok/trusted_folders.toml` (an untrusted folder disables every configured MCP server; Grok's trust cascades to subdirectories, so only worktrees under an undecided root get their own entry), Antigravity via `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` (exact-path entries only - agy does not inherit ancestor trust, and an untrusted workspace disables hook execution). All six leave an explicit user decision alone, in either direction. |
| Board Refresh | `src/main/ipc/handlers/sessions.ts` | Forwards task-created/updated/backlog-changed events to renderer via IPC. |
| Dev-only DevTools | `src/devtools/mcp/register.ts`, `src/devtools/mcp/preview-tools.ts` | Registers the `kangentic_devtools_*` tools when `__KANGENTIC_DEV__` is set. Excluded from production builds at compile time. |

### Discovery

Delivery is per-adapter, because no two of these CLIs accept MCP config the same way. What every path has in common: the URL and token are per-launch, the user's global config is never mutated, and the entry is additive so the user's own MCP servers keep working.

| Agent | Mechanism | Token lands in |
|-------|-----------|----------------|
| Claude Code | `--mcp-config <sessionDir>/mcp.json` | session file (gitignored) |
| Codex CLI | `-c mcp_servers.kangentic.*` per-invocation overrides | process env (`KANGENTIC_MCP_TOKEN`) |
| Kimi Code | `--mcp-config-file <sessionDir>/mcp.json` | session file (gitignored) |
| GitHub Copilot CLI | `--additional-mcp-config @<path>` | session-adjacent file |
| Gemini CLI | `mcpServers` in `<cwd>/.gemini/settings.json` (`httpUrl`) | project file, stripped on exit |
| Qwen Code | `mcpServers` in `<cwd>/.qwen/settings.json` (`httpUrl`) | project file, stripped on exit |
| Droid | `<cwd>/.factory/mcp.json` with `${KANGENTIC_MCP_TOKEN}` | process env (file holds only the var name) |
| Grok Build | `[mcp_servers.kangentic]` sentinel block in `<cwd>/.grok/config.toml` with `${KANGENTIC_MCP_URL}` + `${KANGENTIC_MCP_TOKEN}`, plus `--allow "MCPTool(kangentic__*)"` pre-approval | process env (file holds only var names - the URL too, so the block is fully static) |
| OpenCode | `OPENCODE_CONFIG_CONTENT` env var | process env (local spawns only) |
| Antigravity CLI | Workspace plugin `<cwd>/.agents/plugins/kangentic/` (`serverUrl` + `X-Kangentic-Token` header; streamable HTTP, connects at the first agent turn) | project file, stripped on exit |
| Cursor, Oz CLI | Not wired | n/a |
| Aider, Ollama | Not possible - neither CLI is an MCP client | n/a |

The project-file rows (Gemini, Qwen, Droid, Grok, Antigravity) are additionally hidden from git while untracked: when Kangentic creates the file, the builder seeds it into the local `.git/info/exclude` so it never shows in `git status` and cannot ride a `git add -A` (shared mechanism in `src/main/agent/shared/git-exclude.ts`; a pre-existing user file keeps its git visibility).

Full per-adapter detail, including the Codex quoting contract and the Gemini folder-trust requirement, lives in [agent-integration.md](agent-integration.md).

#### Claude Code

Claude Code supports a `--mcp-config` flag that accepts a path to a JSON file containing MCP server definitions. Kangentic uses this to deliver its MCP server config without modifying `.mcp.json` (which may be tracked in git). When Kangentic spawns a session:

1. `CommandBuilder.createMergedSettings()` writes the kangentic MCP server config to `.kangentic/sessions/<sessionId>/mcp.json`. The entry is an HTTP MCP server pointing at the per-launch URL `http://127.0.0.1:<port>/mcp/<projectId>` with the `X-Kangentic-Token` header containing the per-launch token. In the same gated block it also appends `mcp__kangentic` to the merged settings' `permissions.allow` (append-if-absent) so the spawned agent does not prompt for kangentic tools in default mode (see Permissions).
2. `CommandBuilder.buildClaudeCommand()` adds `--mcp-config <path>` to the CLI command
3. `ensureMcpServerTrust()` adds "kangentic" to `enabledMcpjsonServers` in `~/.claude.json`
4. Claude Code starts, reads both `.mcp.json` (user servers) and the `--mcp-config` file (kangentic), and connects to the in-process HTTP MCP server over loopback. No child process is spawned for kangentic itself.
5. Claude Code calls `tools/list` and discovers all kangentic tools

This approach keeps `.mcp.json` completely untouched - no injection, no cleanup, no git noise. The `--mcp-config` flag is additive (not `--strict-mcp-config`), so user-configured servers like context7 continue to work normally. The token is rotated on every Kangentic launch, so a stale `mcp.json` from a previous run cannot be reused.


## Cross-Project Calls

Every Kangentic MCP tool accepts an optional `project` parameter, with two deliberate exceptions: `kangentic_get_current_task` (it resolves the project from the caller's own worktree) and the whole `kangentic_browser_*` family (see [Browser automation tool surface](#browser-automation-tool-surface-kangentic_browser_): no argument names another project, and driving is confined to the connection's own, with `kangentic_browser_close_pane`'s `includeOtherProjects` the one opt-in that reaches beyond it). Use it to route a tool call at a *different* Kangentic project than the one the MCP client is bound to - no need to switch projects in the UI or reconfigure MCP.

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
| `branchName` | string | No | Custom git branch name. Board tasks only - ignored when routed to the backlog. Rejected if the branch is already checked out anywhere; see the Branch conflict guard note below. |
| `baseBranch` | string | No | Base branch for the task. Board tasks only. |
| `useWorktree` | boolean | No | Whether to use a git worktree. Board tasks only. |
| `attachments` | array | No | File attachments: `[{ filePath: string, filename?: string }]`. Files are read from disk and stored in the project's `.kangentic/` directory. |
| `agentOverride` | string | No | Pin a specific agent for this task's entire lifetime (e.g. `"claude"`, `"codex"`). Locks against column moves. Omit to resolve column override -> project default -> app default. |
| `modelOverride` | string | No | Model to spawn this task with (e.g. `"opus"`, `"claude-opus-4-8"`, or the friendly `"Opus 4.8"`). Best-effort: a friendly name is converted to the CLI id; an unresolvable model errors at spawn time. Omit to resolve column override -> project default -> agent default. |
| `effortOverride` | string | No | Effort/reasoning level to spawn this task with (e.g. `"xhigh"`). Valid values are agent-specific. Omit to resolve column override -> project default -> agent default. |
| `permissionMode` | string | No | Permission mode to spawn this task with: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, or `"auto"`. Omit to resolve column override -> project default -> app default. |
| `autoCommand` | string | No | Slash command to run once the agent spawns for this task (e.g. `"/code-review"`, `"/release"`). Overrides the destination column's `auto_command` for this task only. MCP-only - not surfaced in the New Task dialog. |
| `profile` | string | No | Board Profile this task rides (name or id) - an alternate set of per-column agent/model/effort settings, applied as the task moves. Omit for "Default" (every column uses its own settings). See [kangentic_list_board_profiles](#kangentic_list_board_profiles). |
| `runMode` | string | No | How the task gets its agent settings: `"column_settings"` (the default - follow each column as the task moves) or `"agent_override"` (pin agent/model/effort/permission for the task's whole life). Any of the four `*Override` params implies `"agent_override"`, so pass this only to choose override mode without pinning anything - fields left unset then resolve dynamically until the task first spawns, which locks all four. Passing a pin together with `"column_settings"` is rejected as a contradiction. |
| `prUrl` | string | No | Pull request URL this task is about (e.g. `https://github.com/owner/repo/pull/123`). Board tasks only. |
| `prNumber` | number | No | Pull request number this task is about. This is the field the linker actually anchors on (Tier 1); it is derived from `prUrl` when omitted, so passing the URL alone is enough for a standard `/pull/<n>` URL. Board tasks only. |

**Filing a review task:** `prUrl` / `prNumber` are how a task names the PR it is about, and they are what links it. Writing the URL into `description` instead does **not** link it - the linker's anchors are git state and the stored `pr_number` only, never authored prose (see [PR Integration](pr-integration.md#the-confidence-ladder)). Both are applied as a follow-up update immediately after the row is created, so `pr_state` starts null; a forced resolve fires right after the write and fills in the live PR state, so the card shows its state chip without waiting for the background sweep.

`profile` is **mutually exclusive** with `agentOverride` / `modelOverride` / `effortOverride` / `permissionMode` / `runMode: "agent_override"`: a profile changes settings per column, those pin one value for the task's whole life. Passing both is rejected and nothing is created, rather than silently discarding one side (the repository enforces the same exclusivity on write). An unknown profile name is an error too - a typo must not quietly produce a task that looks tiered and runs on the plain board settings.

The mirror case is rejected for the same reason: any of the four pins alongside `runMode: "column_settings"`. Setting a pin already *is* asking for override mode, so pairing it with the opposite mode is a contradiction the repository would resolve silently in the pin's favour, discarding the mode the caller named. `runMode: "column_settings"` with no pins, or alongside `profile`, is fine - those agree.

If the target column has `auto_spawn` enabled, creating a task there will also spawn an agent session for it. Backlog items never auto-spawn.

**Branch conflict guard:** git allows a branch to be checked out in only one working tree at a time. When `branchName` names a branch that some worktree already holds - including the user's own main checkout - the tool refuses and creates nothing, rather than filing a task whose worktree can never be built. Without this guard the failure was invisible: the tool response is sent before auto-spawn runs, so the card appeared healthy while `git worktree add` failed a second later with `is already used by worktree at <path>`, leaving a null session and null worktree. The refusal names the branch and the path holding it, states that nothing was created, and says what to do - free the branch and re-run, or stop and tell the user, since the holder is often a checkout the calling agent cannot touch. The check is skipped for backlog items (which ignore `branchName`) and fails open if git cannot be probed. It is otherwise unconditional: it does not depend on the destination column's `auto_spawn` (a task filed into a quiet column today can be dragged into a spawning one tomorrow, and the conflict bites then), nor on `useWorktree` (passing `useWorktree: false` is rejected too, since that only moves the same collision to the branch-checkout step instead of avoiding it).

**Cross-project routing guard:** when `project` is omitted (so the task would default to the active project) but the title or description names a *different* registered project, the tool refuses with a routing-check error instead of creating the task. No task is created and no rate-limit slot is consumed. Re-run with `project: "<that project>"` to file it there, or with `project: "<active project>"` to confirm the active project. This catches the common cross-project triage case (filing a bug about one project from another) when the routing cue is only implied by the task text.

Runaway-loop safeguard: a single Kangentic launch can create at most 500 tasks via this tool (a high internal circuit breaker against a misbehaving agent, shared across board and backlog, not a user-tunable setting). Hitting it returns a clear error and creates nothing; the accumulated count resets when Kangentic restarts.

### kangentic_list_columns

List all non-archived columns with task counts.

No parameters. Returns column names, roles, and current task counts.

### Board Profiles

A **Board Profile** is a named alternate ladder of per-column strategy settings, so one task can
run Planning in Opus xhigh and Merge in Sonnet high while another rides a cheaper ladder over the
same board. Column *identity* (which columns exist, their name, order, role, color, icon) is
singular across profiles; only strategy is profile-scoped. Profiles live in `kangentic.json`, not
the database, so they are team-shared and travel through git. A task selects one with `profile` on
[kangentic_create_task](#kangentic_create_task) / [kangentic_update_task](#kangentic_update_task).

There is no stored "Default" profile. Default is synthetic: a task with no profile simply runs each
column's own settings, which is why it never appears in a listing.

**Entries are keyed by column NAME across this whole tool family.** Internally a profile keys its
entries by swimlane uuid so a rename cannot detach in-flight tasks, but a uuid is useless to an
agent and actively wrong across projects - the entire point of copying a profile into project X is
that X has its own columns with their own ids. Every tool below translates names to ids on write
and back to names on read, and an unknown column name fails the call rather than being silently
dropped.

**Three states per setting**, and the difference is load-bearing:

| Form | Meaning |
|------|---------|
| key omitted | Inherit whatever the column itself is configured with |
| key set to `null` | Clear to the agent default, overriding the column's own pin |
| key set to a value | Use that value in this column |

Because these tools all accept `project`, they are the practical way to keep profiles in sync as
models and strategies change: *"change every profile's Opus 4.8 to Opus 5"*, *"copy this board's
Heavy profile into project X"*, *"what differs between project A's and B's profiles"* (two
`kangentic_list_board_profiles` calls and a diff).

The per-column settings a profile may carry are `agentOverride`, `modelOverride`, `effortOverride`,
`permissionMode`, `autoCommand`, `autoSpawn`, `handoffContext`, `sessionTarget`,
`sessionSpawnStrategy`, and `planExitTarget` (a column *name*). To Do and Done columns never spawn
agents, so entries for them have no effect.

### kangentic_list_board_profiles

List the board's Board Profiles: id, name, description, and per-column settings keyed by column
name (only the columns each profile overrides). Returns JSON, because the primary uses are diffing
and copying, both of which need the exact structure back out - and because a `null` (clear) must
stay visibly distinct from an absent key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Read another project's profiles. Call twice to compare two boards. |

Entries for columns that no longer exist are omitted, so the listing reflects what will actually
apply.

### kangentic_create_board_profile

Create a Board Profile. Names must be unique on the board.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Profile name, unique on this board (e.g. `"Heavy"`, `"Frugal"`), max 100 chars |
| `description` | string | No | What this profile is for (max 500 chars) |
| `columns` | object | No | Per-column settings keyed by column name, e.g. `{"Planning": {"modelOverride": "opus", "effortOverride": "xhigh"}}`. Sparse: list only the columns this profile changes. |
| `project` | string | No | Create it on another project's board |

### kangentic_update_board_profile

Rename a profile, change its description, or retune its per-column settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `profile` | string | Yes | Profile name (case-insensitive) or id |
| `name` | string | No | New name. Must stay unique on the board. |
| `description` | string | No | New description. Pass an empty string to clear it. |
| `columns` | object | No | Per-column settings keyed by column name |
| `replaceColumns` | boolean | No | Replace the profile's entire column set instead of merging into it. Default `false`. |
| `project` | string | No | Update a profile on another project's board |

`columns` **merges** by default, so retuning one column does not wipe the rest - which is what makes
a sweep like *"change every profile's Opus 4.8 to Opus 5"* safe to run column by column. Pass
`replaceColumns: true` for a wholesale swap, the usual choice when copying a profile from another
board.

On the ACTIVE project this reaches live sessions, exactly as the Board Manager's own profile save
does: retuning `modelOverride` / `effortOverride` restarts or live-injects the sessions of tasks
riding the profile, and retuning `autoSpawn` for a column spawns or suspends the tasks already
sitting in it. A profile edit targeting a background project (via `project`) only writes the file;
see the blast-radius note under `kangentic_update_column`.

### kangentic_delete_board_profile

Delete a Board Profile.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `profile` | string | Yes | Profile name (case-insensitive) or id |
| `project` | string | No | Delete from another project's board |

Tasks riding the deleted profile are **not** rewritten; they fall back to each column's own settings,
and the response reports how many were affected. Rewriting those rows would make a delete far more
destructive than it looks and could not be undone by re-creating the profile.

Falling back to the column's own settings IS a settings change for a running session, so on the
active project it propagates like any other profile edit. Usually that just re-tunes the model or
effort and the session keeps running. The one case where it does not: if the deleted profile was
what turned `autoSpawn` **on** for a column whose own setting is off, the fallback is a true-to-false
flip, and the live session there is suspended (resumable by hand) rather than left running.

### kangentic_list_tasks

List tasks, optionally filtered by column. Tasks come back in board order (top to bottom within each column).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | No | Filter by column name. If omitted, returns all tasks. |

Each task reports a `position`: its zero-based ordinal slot within its own column, counting only
non-archived tasks. This is the same slot vocabulary
[kangentic_move_task](#kangentic_move_task)'s `position` and
[kangentic_reorder_tasks](#kangentic_reorder_tasks) accept, so the listing can be read and handed
straight back. It is deliberately not the raw stored `tasks.position` value, which develops gaps
as tasks are archived.

### kangentic_search_tasks

Search by keyword across both the board (active + archived tasks) and the backlog. This is the default tool for finding a task by title, description, or backlog label - it covers items whether or not they have been promoted from backlog to board. Use `scope` to narrow to a single surface.

A query of the form `#<number>` (e.g. `#42`) is a ticket lookup instead of a text search: it matches board tasks whose display ID (`#N`) prefix-matches the number (`#4` matches #4, #40, #41, ...) and returns no backlog items (they have no display ID). For an exact single-task lookup by number, `kangentic_find_task` with `displayId` is more direct.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword (case-insensitive). Backlog hits also match on labels. A `#<number>` query (e.g. `#42`) is a ticket lookup: board tasks by display-ID prefix, no text/backlog match. |
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
| `cwd` | string | No | Absolute working directory path. The tool extracts the worktree folder name from `.kangentic/worktrees/<folder>` and matches against `tasks.worktree_path`. |
| `branch` | string | No | Current git branch name. Exact (case-insensitive) match against `tasks.branch_name`. |

At least one parameter is required. Returns the same task fields as `kangentic_find_task` (id, displayId, title, description, column, branchName, baseBranch, worktreePath, prNumber, prUrl, useWorktree, status). It deliberately does NOT report reserved ports: this serializer is a per-project read and the ledger is in the GLOBAL database, so including them made every task lookup depend on a second database and cost one query per matched task. Use `kangentic_check_dev_ports`, which answers that question and probes each port besides. Returns `data: null` when no match is found, a single task object when one matches, or an array when multiple tasks match.

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

Also returns `taskOrder`: the column's tasks top to bottom, each with its `position` (the
zero-based ordinal slot described under [kangentic_list_tasks](#kangentic_list_tasks)). That makes
this a complete read-before-write call for
[kangentic_reorder_tasks](#kangentic_reorder_tasks). The rendered message caps the listing at 50
tasks and says how many were omitted; `data.taskOrder` always carries the whole column.

### kangentic_update_task

Update a task's title, description (full replace, in-place find/replace edits, or append), PR info, agent assignment, model/effort/permission overrides, priority, labels, base branch, worktree toggle, or attachments. To move a task between columns, use `kangentic_move_task` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `title` | string | No | New title (max 200 chars) |
| `description` | string | No | New description, replaces the entire description (max 50000 chars). Mutually exclusive with `descriptionEdits` and `appendDescription`; for an incremental change to a long description, prefer those instead - they cost far fewer tokens and cannot silently drop untouched sections. |
| `descriptionEdits` | array | No | Ordered exact-string replacements applied to the current description, like the file `Edit` tool: `[{ find: string, replace: string }]` (1-100 edits; each `find`/`replace` up to 50000 chars). Each `find` must be present and unique in the text as it stands after prior edits in the list, or the whole call fails and nothing is written. Mutually exclusive with `description`; may combine with `appendDescription` (edits apply first). |
| `appendDescription` | string | No | Text appended to the end of the current description, exactly as given (no separator inserted, max 50000 chars). Mutually exclusive with `description`; may combine with `descriptionEdits` (edits apply first, then this append). |
| `prUrl` | string | No | Pull request URL (e.g. `https://github.com/owner/repo/pull/123`). This is what links the task to a PR; a URL written into `description` does not. |
| `prNumber` | number | No | Pull request number. The field the linker anchors on (Tier 1); derived from `prUrl` when omitted, so a URL-only write can never strand the previous PR's number. A number-only write leaves `pr_url` pointing at the previous PR until the immediate link-time resolve re-points it, which is harmless: the resolve follows the number you gave. |
| `agent` | string | No | Agent name to assign (e.g. `"claude"`, `"codex"`). Empty string clears. |
| `priority` | number | No | Task priority 0-4 (0=none, 4=highest) |
| `labels` | string[] | No | Replace the task's label list. Pass `[]` to clear. |
| `baseBranch` | string | No | Base branch the task's worktree branches from (e.g. `"main"`) |
| `useWorktree` | boolean | No | Whether the task uses an isolated git worktree |
| `model` | string | No | Model override for this task (e.g. `"opus"`, `"claude-opus-4-8"`, or the friendly `"Opus 4.8"`). Best-effort friendly-name resolution. Pass empty string to clear. |
| `effort` | string | No | Effort/reasoning level override for this task (e.g. `"xhigh"`). Pass empty string to clear. |
| `permissionMode` | string | No | Permission mode override for this task: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, or `"auto"`. Pass empty string to clear. |
| `profile` | string | No | Board Profile this task rides (name or id) - an alternate set of per-column agent/model/effort settings, applied as the task moves. Pass empty string to clear it back to "Default". See [Board Profiles](#board-profiles). |
| `runMode` | string | No | How the task gets its agent settings: `"column_settings"` (follow each column, clearing the model/effort/permissionMode pins) or `"agent_override"` (pin them for the task's whole life, clearing the profile). Setting any pin implies `"agent_override"`, so pass this only to switch modes without pinning anything; setting a pin alongside `"column_settings"` is rejected as a contradiction (pass the pin as an empty string to clear it instead). Omit to leave the task's current mode alone. |
| `attachments` | array | No | File attachments to ADD to the task: `[{ filePath: string, filename?: string }]`. Additive - existing attachments are kept, not replaced. Use `kangentic_remove_task_attachment` to remove one. |

At least one updatable field is required.

Setting `prUrl` or `prNumber` also clears the task's stored PR state, so the three PR columns never disagree; a forced resolve fires immediately after the write and fills the state back in from the PR itself, so the card shows its state chip without waiting for the background sweep. The exception is a write that re-points nothing (the same `prUrl` and `prNumber` the task already holds, on a row whose `pr_state` is non-null): that is treated as a no-op, and both the clear and the resolve are skipped so the card's state chip does not blank and come back. See [PR Integration](pr-integration.md#where-pr-state-is-persisted).

`profile` is **mutually exclusive** with `model` / `effort` / `permissionMode` / `runMode:
"agent_override"` (and the task's `agent_override`): setting a profile clears the pins and forces
`runMode: "column_settings"`, and setting any pin clears the profile, so passing both in one call is
rejected rather than silently discarding one side. An unknown profile name is an error, not a fall
back to Default.

The mirror case is rejected too: a pin alongside `runMode: "column_settings"`, since a pin already
implies `"agent_override"`. The check is on truthiness, not presence, so the empty-string CLEAR
sentinel still pairs legally with `"column_settings"` - clearing a pin and following the columns
agree, and that is the natural way to write "stop pinning this and go back to the columns".

### kangentic_link_pr

Authoritatively resolve and link the pull request for a task's git branch using the `gh` CLI (`gh pr list --head <branch>`, plus by-number and by-commit fallbacks). Unlike the terminal-scraping auto-linker, this finds PRs opened by a human, the web UI, `git push`, scripts, or `gh api`, and works even when the task has no live session. Re-running refreshes the linked PR's state (`open`/`draft`/`merged`/`closed`). Use after opening a PR, or to backfill a task whose PR was never linked.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `project` | string | No | Project selector to target a different project |

Returns the linked PR (number, url, state) on success, or a message when no PR is found or the `gh` CLI is unavailable.

### kangentic_move_task

Move a task to a different column, optionally placing it at a chosen slot in that column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task, and moving OUT of Done un-archives it again so it returns to the board. Moving to To Do kills the session and removes the worktree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID (numeric display ID or full UUID) |
| `column` | string | Yes | Target column name (case-insensitive, e.g. `"Review"`, `"Done"`) |
| `position` | number | No | Zero-based ordinal slot among the column's tasks (not a raw stored position); the tasks at and below it shift down. Clamped to the column, so a value past the end lands last. Omit to append to the end of the column, which is the default. |

Naming the task's **current** column together with `position` repositions it in place. That path is
presentation only: it does not change the task's column, session, worktree, or `session_id`, and it
deliberately does not run the move lifecycle at all - so it cannot disturb a drag the user has in
flight for the same card. Repositioning counts slots among the *other* tasks in the column, so
`position: 0` is the top and the highest legal slot is one less than the column's length; moving
*into* a different column counts slots among that column's existing tasks, where the column's length
is the appending slot.

`position` has no useful effect when moving into Done, which archives the task and takes it off the
board.

To re-sequence several tasks at once, use [kangentic_reorder_tasks](#kangentic_reorder_tasks).

### kangentic_reorder_tasks

Set the order of tasks within one column, top to bottom, in a single atomic call. This is the tool
for sequencing a column by priority or execution order ("order To Do so the auth work comes first").

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name whose tasks are being reordered (case-insensitive) |
| `taskIds` | string[] | Yes | Task IDs (numeric display IDs or full UUIDs), in the order they should appear from the top. Every ID must already be in that column. |
| `project` | string | No | Project selector to target a different project |

**Prefix semantics.** The listed tasks take the top slots in the order given; any task in the column
you do not list keeps its relative order below them. So passing every ID sets the column's full
order, and passing three IDs pins those three to the top. Being a prefix rather than a strict
full-list contract is what makes the call safe against a live board: a task created between your
read and your write simply sinks below the ones you named instead of failing the call.

Read the current order first with [kangentic_list_tasks](#kangentic_list_tasks) or
[kangentic_get_column_detail](#kangentic_get_column_detail).

Reordering is presentation only. It never changes a task's column and never spawns, suspends, or
otherwise touches a session or worktree - use [kangentic_move_task](#kangentic_move_task) to change
a task's column. An ID that names a task in another column (or an archived one) is rejected rather
than silently moved. Duplicate IDs are rejected too.

Returns the column's resulting order as `{ id, displayId, position }` entries; the rendered message
echoes the first 25 display IDs.

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
| `autoSpawn` | boolean | No | Whether moving a task into this column auto-spawns an agent. For the ACTIVE project, changing it also applies to the tasks already in the column, immediately: switching it on spawns for each task with no session (never for a user-paused one, and never in To Do or Done), switching it off suspends the live sessions there |
| `autoCommand` | string \| null | No | Slash command template injected on agent spawn (e.g. `"/review --strict"`). `null` clears. |
| `agentOverride` | string \| null | No | Force a specific agent for this column. `null` uses project default. |
| `modelOverride` | string \| null | No | Adapter-specific model identifier passed at spawn time (e.g. Claude `"opus"`, `"sonnet"`, `"claude-opus-4-7"`). `null` inherits the agent default. For the ACTIVE project this reaches sessions already running in the column: a model change restarts them in place with `--resume`. |
| `effortOverride` | string \| null | No | Adapter-specific effort/reasoning level (e.g. Claude `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`). Valid values are agent-specific. `null` inherits the agent default. For the ACTIVE project this reaches sessions already running in the column: an effort change is injected live, without a restart. |
| `permissionMode` | string \| null | No | One of: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`. `null` uses project default. |
| `handoffContext` | boolean | No | Enable multi-agent handoff context preservation when entering this column |
| `planExitTargetColumn` | string \| null | No | Column to auto-move the task to when an agent in plan mode exits planning. `null` disables. |

At least one updatable field is required.

**Cross-project edits write the setting but do not reconcile.** When you target another board with
`project`, the column is updated and persisted to that project's `kangentic.json`, but no session
there is spawned, suspended, restarted, or injected. That is a blast-radius decision, not an
assumption that the project is idle: a background project CAN have live sessions (the Agent Monitor
and the sidebar's per-project agent counts exist for exactly that). Spawning creates a worktree and
checks out a branch in a checkout the user is not looking at, so the reconcile is held back and the
project's tasks pick the new settings up when they next spawn. The cost is that turning `autoSpawn`
off on a non-focused project leaves its agents running until it is next opened.

### kangentic_create_column

Add a new swimlane (column) to the board. Column names must be unique (case-insensitive) across
every lane, including the archived Done lane.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Column name, unique on this board (max 100 chars) |
| `description` | string | No | Free-form column purpose shown as a header tooltip and shared via `kangentic.json` (max 1000 chars) |
| `color` | string | No | Hex color (e.g. `"#71717a"`). Defaults to blue. |
| `icon` | string | No | Lucide icon name |
| `autoSpawn` | boolean | No | Whether moving a task into this column auto-spawns an agent. Defaults to `true`. |
| `autoCommand` | string | No | Slash command template injected on agent spawn (e.g. `"/review --strict"`) |
| `agentOverride` | string | No | Force a specific agent for this column. Omit to use the project default. |
| `modelOverride` | string | No | Adapter-specific model identifier passed at spawn time (e.g. Claude `"opus"`, `"sonnet"`) |
| `effortOverride` | string | No | Adapter-specific effort/reasoning level (e.g. Claude `"low"`, `"high"`, `"xhigh"`) |
| `permissionMode` | string | No | One of: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto` |
| `handoffContext` | boolean | No | Enable multi-agent handoff context preservation when entering this column |
| `planExitTargetColumn` | string | No | Column to auto-move the task to when an agent in plan mode exits planning |
| `position` | number | No | Zero-based ordinal slot among the board's columns (not a raw stored `position`); later columns shift right. Clamped between the role columns: a value below the lowest legal slot lands immediately after To Do (so `position: 0` does not come first), and a value at or past Done lands immediately before Done, never after it. Omit for the default placement just before Done. |

Roles are structural and cannot be set: every board already has its To Do and Done columns.

### kangentic_delete_column

Delete a swimlane (column) from the board. Refused in two cases, deliberately:

- **The column still holds tasks.** Move them with `kangentic_move_task` (or delete them) first.
  This tool never touches a task: bulk-moving or orphaning them is a far larger action than the
  caller asked for.
- **The column is a role column** (To Do / Done). The board depends on both. Rename one instead if
  you only want different wording.

Everything that pointed at the column is cleaned up in the same operation: lane transitions,
other columns' `planExitTargetColumn` values, Board Profile entries keyed to it, and any profile
`planExitTarget` naming it. The response reports the counts. The committed `kangentic.json` mirror
is rewritten too, which is load-bearing rather than cosmetic - see
[Board Config Sync](configuration.md#board-config-sync-kangenticjson): the file re-seeds the
database on project open, so a delete that left the file alone would be undone on the next open.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | Yes | Column name to delete (case-insensitive) |

This cannot be undone.

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

A query of the form `#<number>` (e.g. `#42`) is a shortcut for a ticket lookup: it returns only board tasks whose display ID (`#N`) prefix-matches the number (`#4` matches #4, #40, #41, ...), skipping the backlog, session-event, conversation, and project kinds entirely. This mirrors the desktop Quick Find palette and board search box, where the same `#<number>` syntax filters by ticket number.

Conversations are matched by **keyword** by default; pass `mode: "hybrid"` to also match them by **meaning** (semantic embedding fused with keyword) - the "have we solved this / seen this before?" recall path over past agent conversations. `mode` affects only the conversation corpus; tasks, backlog, session events, and projects are always keyword. Both modes fall back to keyword transparently when the conversation embedding layer is off. Conversation hits carry a `sessionId` + `turnUuid`; follow up with `kangentic_get_transcript` (`aroundUuid`) to read the neighboring turns.

Defaults to scoping the search to the active project. Pass `scope: "all"` to widen across every registered project (which also surfaces project-name hits so the agent can discover routing targets). Passing `project` forces `scope: "current"` since explicit project routing already specifies the target.

Conversation hits come from the structured transcript index (`memory_chunks` FTS5 + the sqlite-vec embeddings for semantic ranking), not the raw scrollback blob; they appear only when `memory.indexingEnabled` is on (the default), and rank semantically only when the embedding layer (`memory.semanticEnabled`) is also on. Per-kind hit caps prevent runaway results: 30 tasks, 20 backlog items, 50 session events, 10 projects, 20 conversations.

Pass `taskId` to restrict conversation hits to one task's history - e.g. "what was discussed in task #286 about X, and how does that affect the current work?" Resolve the display `"#N"` to its internal id first with `kangentic_find_task` or `kangentic_get_current_task`. `taskId` only scopes conversation hits; task/backlog/session-event/project hits are unaffected. Lexical matching filters by task in the FTS query itself; semantic matching over-fetches a wider vec0 candidate set and narrows it to the task afterward (sqlite-vec has no per-query `WHERE` filter).

This tool consolidates what were previously two tools (`kangentic_search_everything` + a separate `kangentic_recall`) into one, per Anthropic's tool-design guidance that related retrieval operations belong in a single tool with a parameter rather than several overlapping tools.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword or phrase, or (in `mode:"hybrid"`) a natural-language description of what you are looking for. Case-insensitive; empty queries return no results. A `#<number>` query (e.g. `#42`) is a ticket lookup: only board tasks by display-ID prefix. |
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

- `format="structured"` (default): the parsed agent conversation - user prompts, assistant text, tool calls and results - rendered as clean markdown, read from the agent's native session history via the adapter's `parseTranscript` capability. The Claude parser also drops noise (slash-command XML, `<system-reminder>` spans, `isMeta` messages) and surfaces compaction boundaries/summaries explicitly. There is no cleaned-scrollback substitute: structured either comes from real session history or reports that it is unavailable and points at `format="raw"`.
- `format="raw"`: the verbatim ANSI-stripped PTY scrollback (the full terminal output, including TUI redraws), available for every agent. Useful for debugging the terminal layer or for agents without a structured parser. Raw scrollback is mostly repeated terminal redraws (empirically ~85% duplicate lines and multiple MB for a long session), so when a structured parser exists for the agent the raw response notes that `structured` is the cleaner, far smaller view for evaluation. Every returned transcript (both formats) is prefixed with a one-line note marking the content as read-only reference data, not instructions to follow.

Structured output is shaped by three agent-agnostic levers, applied to the parsed `TranscriptEntry[]` (so no adapter branching):

- `view`: `"full"` (default), `"responses"` (assistant text turns only, dropping tool calls/results/thinking), or `"result"` (just the final assistant text - the Agent SDK `ResultMessage.result`, rendered bare without the `## Assistant` heading).
- `tail`: return only the last N entries (the most recent messages). Ignored for `view="result"`.
- `search`: case-insensitive substring; return only entries whose content (including a tool result inlined under its owning tool call) contains the term.
- `aroundUuid` + `context`: center the returned entries on the turn with `aroundUuid` (the `turnUuid` from a `kangentic_search` conversation hit) and include `context` turns either side (default 3). This is the citation-first fetch - pull just the neighborhood of a cited turn rather than the whole transcript. A stale/absent uuid degrades to the full transcript.

A very large transcript is bounded twice, at two different layers, and the two notices mean different things. The parser reads at most `MAX_PARSE_SOURCE_BYTES` (16MB) from the END of the native history file, because reading an unbounded one whole is what OOM'd the main process; when it does, the omission is announced in-band as a `system` entry with subtype `truncated` ("Earlier N MB of this conversation are not shown"). That is a READ bound and it is the same for every caller. The `maxChars` budget below is a separate RESPONSE bound applied afterwards. A single huge transcript can carry both notices at once. `kangentic_search`'s conversation index is unaffected for Claude, whose adapter implements `parseTranscriptWindow` and walks the whole file in bounded windows. For every other agent the indexer falls back to `parseTranscript`, so above `MAX_PARSE_SOURCE_BYTES` search coverage is bounded at the same point the reader's is, not the full history.

Output is bounded by a character budget (default ~50,000 chars; raise via `maxChars`, hard ceiling 500,000). When the result exceeds the budget it keeps the **most recent** entries and prepends a `[Truncated: N earlier entries omitted ...]` note. `view`/`tail`/`search` apply to `structured` only; the `maxChars` budget also caps `raw` scrollback (keeping the most recent portion).

Structured-format support by agent:

| Agent | Structured | Raw |
|-------|------------|-----|
| Claude, Droid, Codex, Gemini, Qwen, Kimi, OpenCode, Grok, Antigravity | native parser | yes |
| Aider | no (no per-session native history) | yes |
| Warp, Cursor, Copilot | no (history location unknown) | yes |
| Ollama | no (no per-session history for `ollama run`) | yes |

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

### kangentic_send_session_message

Send a message to another task's **running** agent session, exactly as if it had been typed into that session's input box. This is the write-side counterpart to the read-only session tools: `kangentic_get_session_events`, `kangentic_get_transcript`, and `kangentic_list_sessions` observe another agent, and this one steers it. Typical uses are handing off a decision, unblocking a stalled agent, answering a question a session is waiting on, and redirecting work a newer decision superseded.

Provide either `taskId` or `sessionId` (not both). A `taskId` resolves to that task's live session via the PTY registry, preferring the registry over the `task.session_id` column, which is known to drift.

**Delivery.** The message goes through the same bracketed-paste submit path a human paste uses (`TerminalSubmit.submitContent`): drain, chunked write, output settle, `\r`, then wait for submission evidence. It is not instant, and it is measurably slower when nobody has the target session's terminal open, because the paste engine's fast path needs the session subscribed. `delivered` means the message was handed to the session's input, not that the agent has finished reading it.

Against a **busy** target, treat `delivered` as weaker still. The paste engine's submission check accepts "at least 50 bytes of output arrived after the `\r`" as evidence, which a mid-turn session satisfies trivially from its own ambient streaming output. So a `delivered` result on a thinking session means the paste was written, not that it was confirmed submitted. Use `deliverWhen: "idle"` when you need the stronger guarantee.

A deferred (`"idle"`) delivery that later fails is not reported back - the tool call that queued it has already returned - so it is written as a `failed` row instead (and, for a delivery that threw, logged to the Electron main console too). That covers the target exiting or going unwritable before it ever flushed, which is otherwise silent: a `queued` result is not a promise the message landed.

**Attribution is out-of-band.** The message is delivered **verbatim** - no prefix, no marker, nothing prepended. Instead, every send ATTEMPT is recorded in the target project's `session_messages_sent` table (`session_id`, `caller_session_id`, `caller_task_id`, `caller_project_id`, `message`, `status`, `error`, `created_at`), with the caller resolved server-side from the URL segment rather than from a tool parameter, so an agent cannot omit or alter it through the tool's own arguments. See the caller-identity note under [Security](#security) for what that does and does not guarantee: it is honesty-by-default, not cryptographic attribution.

`status` is one of four values, so "did my message go through?" always has an answer when debugging:

| `status` | Meaning | Produced a turn? |
|----------|---------|------------------|
| `delivered` | Handed to the session's input | Yes |
| `queued` | Held for the next idle transition, then delivered | Yes |
| `refused` | A guard rejected it (self-send, dead session, target at a permission prompt, cross-project session id, hop-depth backstop, rate limit); `error` carries which | No |
| `failed` | Delivery was attempted and threw (e.g. `no-submission-evidence`), or a `queued` message's target exited before it could flush; `error` carries the detail | **Unknown** - the paste engine can fail with the text half-committed; an exited target produced no turn |

Reconstructing which turns arrived this way means filtering to `delivered` / `queued`. Two caveats for debugging.

`session_id` carries a foreign key so these rows are cleaned up with their session, which means an attempt naming a session id that was never real (a typo, or an id from another project) records nothing - there is no session row to attach it to. The caller still receives the refusal synchronously. This does not affect the realistic dead-session case: a session that exited or was suspended still has its row, so its refusal is recorded.

Second: repeated refusals are deduped to one row per (target, reason) per 5-minute window. Without that the audit trail becomes an amplification vector - the self-send, dead-session, and hop-depth guards all run *before* the rate limiter, so they never consume a slot (the permission-prompt guard runs after it, and does), and a looping agent would write one row per attempt indefinitely. A `refused` row therefore means "at least one refusal for this reason in this window", not an exact count. `failed` rows are never deduped, since a failure required an actual delivery attempt, which the rate limiter already bounds.

This replaced an in-band `[Kangentic relay]` prefix, which was removed after live testing on 2026-07-25. Two problems: it cost tokens on every single send, and the receiving agent read it as injected content asserting its own authority - structurally the shape of a prompt injection - and refused to act on messages sent this way, reasoning that "legitimate authority doesn't need to announce itself through injected content." Out-of-band provenance costs nothing, cannot be forged by anything the agent writes, and leaves the receiver's context clean.

Because nothing is prepended, the stored `message` matches the transcript turn it produced, which is how a consumer correlates a turn to the row that sent it. One caveat for an exact-match consumer: the row stores what the caller supplied, while delivery runs the text through the same `sanitizeForPaste` every paste undergoes (CR and CRLF collapse to LF, C0 control characters are stripped). For ordinary prose the two are byte-identical; a message carrying those bytes differs by exactly that normalization. Note the consequence: the `session_messages_sent` row is the **only** record that a turn arrived through this tool rather than being typed. A sent message that is never recorded is indistinguishable from one the human typed.

**Guards.** These are circuit breakers against unattended token spend (two agents ping-ponging overnight), not a permission policy - deliberate multi-agent orchestration is meant to pass through unobstructed:

- A session cannot send to itself.
- A `deliverWhen: "now"` send into a target sitting at a **permission prompt** is refused. The submit path ends in `\r` (and retries it), which a modal prompt reads as confirming its highlighted option, so an ordinary steer could silently approve a tool call nobody sanctioned. The paste engine's own modal safety net cannot cover this: it detects bracketed-paste-mode-off from the terminal `data` stream, which is only forwarded while the session is subscribed, and an MCP send targets a background session by construction. `deliverWhen: "idle"` is not refused for this state - it holds the message until the prompt clears, which is what the refusal points you at.
- An explicit `sessionId` naming a session in a **different project** is refused. Liveness is checked against the global PTY registry, so such a send would otherwise deliver while its provenance row silently vanished into the wrong project's database. Pass `project` naming the session's own project.
- Each target accepts at most 30 messages per rolling 5 minutes. A genuine orchestration hop costs the receiving agent a whole turn, so only a runaway loop approaches this.
- A steer chain deeper than 25 hops is refused as a loop. Depth is tracked server-side from the caller's session id rather than a tool parameter; it is deliberately not a low cap, because a legitimate A -> B -> C -> D -> E chain must work. The depth is one scalar per session (the most recent inbound hop), so two independent chains converging on one target overwrite each other's count - fine for a runaway backstop, but not an exact per-chain measure.
- Concurrent sends to one session are serialized, so two callers cannot interleave their pastes.

Every refusal comes back as a normal tool result with `isError: true` and text explaining what to do next.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (numeric display ID like `"42"` or full UUID). Resolves to that task's live session. Mutually exclusive with `sessionId`. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). Mutually exclusive with `taskId`. |
| `message` | string | Yes | The message to deliver. Write it as a self-contained prompt: it lands in a session that cannot see your conversation. |
| `deliverWhen` | string | No | `"now"` (default) delivers immediately, like a human typing mid-turn - a busy agent picks it up when its current turn ends. `"idle"` holds the message until the target finishes its turn. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

Returns `status` (`"delivered"` or `"queued"`), the resolved `sessionId`, the target's `targetActivity` at send time, and the `hopDepth` of this steer chain. `"queued"` is returned only for `deliverWhen: "idle"` against a busy target; if the target is already idle, `"idle"` delivers immediately rather than waiting for a transition that would never come.

### kangentic_get_session_messages_sent

Read the log of messages sent **into** a session by another agent via `kangentic_send_session_message`. This is the debugging counterpart to that tool: it answers "did my message actually go through?" for every attempt, including the ones that never produced a turn.

Provide either `taskId` or `sessionId` (not both). `taskId` returns messages across **all** of the task's sessions, which is usually what you want - a task accumulates sessions across resumes and agent handoffs, and you should not have to work out which session was live at the time.

Each entry carries the caller (`caller_session_id`, `caller_task_id`, `caller_project_id` - all null for a human-driven send), the exact `message` text, a `status`, and an `error` for anything that did not land cleanly. See the `status` table under `kangentic_send_session_message` for what each value means; the short version is that `delivered` and `queued` produced a turn, `refused` did not, and `failed` is genuinely unknown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (numeric display ID or full UUID). Covers every session the task has had. Mutually exclusive with `sessionId`. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). Mutually exclusive with `taskId`. |
| `status` | string | No | Only return attempts with this status: `delivered`, `queued`, `refused`, or `failed`. |
| `tail` | number | No | Return only the last N attempts (most recent). Default 100, hard cap 500. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

Returns `total` (matching the filter), `returned` (after `tail`), and the `messages` array. Note that a send naming a session id that was never real records nothing at all - see the foreign-key caveat above - so an empty result can also mean the target id was wrong.

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

### kangentic_get_activity_intervals

Read the durable activity-disposition history for a task or session: every span the agent spent `'active'` (working on its own) or `'idle'` (needing the user - covering both the `idle` and `permission` engine states) since Kangentic started tracking it. This SURVIVES app restarts and session end - it is written the moment the activity engine commits a transition, independent of the in-memory engine state and of `events.jsonl` (which records raw hook events, not committed transitions, and is not reliably retained). Use it to answer "how long has this task been waiting on me" or "how much of this session was the agent actually working vs blocked on approval/input". Provide either `taskId` (every session the task has ever accumulated - a resume creates a new session row) or `sessionId` (one session only).

Response shape:

- `intervals` - raw rows (`id`, `sessionId`, `taskId`, `disposition`, `state`, `previousState`, `enterTrigger`, `exitTrigger`, `startedMs`, `startedAt`, `endedMs`, `endedAt`, `durationMs`, `recordedAt`), oldest first. `startedAt`/`endedAt` are UTC ISO 8601 mirrors of `startedMs`/`endedMs` (stored, not computed on read) - `endedAt` is `null` exactly when `endedMs` is.
- `totals` - `{ activeMs, idleMs }`, summing `durationMs` across CLOSED intervals only.
- `openIntervals` - intervals still in progress (`durationMs` is `null` until closed), each with `startedAt` and a `liveElapsedMs` computed at read time so a still-parked task is not silently excluded from an elapsed-time answer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID. Returns intervals across every session the task has ever had. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). Returns intervals for that session only. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

### kangentic_reserve_dev_ports

Reserve free TCP ports before starting a dev server, so two agents working at the same time never
bind the same one.

Kangentic does not decide what a project's ports should be - the project already does, in
`angular.json`, a vite config, a compose file - so **nothing is reserved until something asks**.
What Kangentic can do that a project cannot is see every task and every project on the machine at
once. Reach for this only when the configured port might already be taken: several tasks sit in one
board column and run concurrently, and they all default to the same port.

Request every port you are about to bind in ONE call. A project needing an API and a frontend asks
for 2, because asking twice leaves a window where a sibling task takes the second. Each returned
port has been probed as genuinely free, not merely unclaimed. Fewer ports than requested means the
range ran out - fall back to the project's own configured ports for the rest.

Reservations persist for the life of the task, so a restart reuses the same ports. They are released
when the task (or its project) is deleted, and those are the only two release paths - nothing
reclaims in the background, so a range that fills up stays full.

The ledger spans every project in ONE Kangentic instance, not the machine: it lives in the global
database, whose path honours `KANGENTIC_DATA_DIR`, so a `/preview` keeps its own. The bind probe is
what holds across instances and against every other process on the machine.

The scan range is `devServer.portRangeStart` / `portRangeEnd` (default 7300-7499), chosen to miss the
common framework defaults - 3000, 4200, 4321, 5000, 5173, 8000, 8080.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | The task reserving the ports. Resolve it with `kangentic_get_current_task`. |
| `count` | number | No | How many ports to reserve (1-10). Default 1. Ask for all of them at once. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

### kangentic_check_dev_ports

Report what Kangentic has reserved for a task **and** what the machine actually says about those
ports. Reserves nothing.

Every port reported is probed, because a reservation is a promise rather than a fact. Reading the
ledger alone is silent about the case that bites most often: a dev server the user started outside
Kangentic entirely, on a port the ledger never handed out. Pass `ports` to ask about specific
numbers - the ones a project's own config pins - which is the only way to learn that short of trying
to bind and failing.

Each port comes back with two fields, giving four answers:

| `reservation` | `listening` | Means |
|---|---|---|
| `this-task` | `true` | Yours, server already running |
| `this-task` | `false` | Yours, nothing on it - free to start |
| `other-task` | either | Another task holds it; reserve a different one |
| `null` | `true` | **In use outside Kangentic** - taken, though nothing reserved it |
| `null` | `false` | Genuinely free |

The other task is deliberately not named: a caller needs to know a port is spoken for, not whose it
is. An empty result is the normal state for a task using its project's own configured ports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID. |
| `ports` | number[] | No | Extra ports to check alongside the task's own reservations (at most 20). Each is probed. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

Returns `data.ports` (the task's own reservations, unchanged) and `data.statuses` (one
`{ port, reservation, listening }` row per port checked).

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

Targeting is scoped to the connection's own project (the `<projectId>` segment of the MCP URL). Every **driving** tool (navigate, observe, interact, eval) takes an optional `sessionId` or `taskId`, which must name a pane in that project; one in another project is refused with the `foreign-project` error kind. Omit both and resolution walks a precedence chain: the pane registered under the caller's own sessionId, then the caller's own taskId (a separate step so a session rotation such as `/clear` still finds the task's pane), then the single pane open in the project (errors with candidates when more than one is open). A step that matches nothing falls through to the next, so a caller with no session segment (a human-driven client, or the two-segment `.kangentic/mcp-config.json` URL) still resolves normally. `kangentic_browser_list_panes` lists the panes you can drive.

No tool in the family takes a `project` argument, so there is no way to *drive* another project's pane. Two tools sit outside the driving rule above, both deliberately:

- `kangentic_browser_open_pane` takes neither `sessionId` nor `taskId`, because it always targets the caller's own task.
- `kangentic_browser_close_pane` reaches other projects only on an explicit `includeOtherProjects`, which widens `all` and also lets an explicitly named foreign `sessionId` / `taskId` resolve. That is a deliberate carve-out for "close all browsers": closing a pane is not reading or controlling someone else's page, and retention keeps a backgrounded project's panes alive, so those are exactly what such a request should reach. Without the flag it stays scoped like everything else. Note the asymmetry - a foreign pane can be *seen* (`list_panes` with `includeOtherProjects`) and *closed*, never driven.

Gating: the global **Agent Browser** settings tab controls the family, read live per request. `browserAutomation.enabled` is the master switch: when off, the entire `kangentic_browser_*` family is not registered, so the tools never appear in `tools/list` and the instructions omit their guidance section (they would be unusable anyway, and advertising them is wasted context). When `enabled` is on, the sub-capability gates apply: `allowInteraction` gates click/type/keypress/drag (off = observe-only); `allowNavigation` gates navigate; `allowEval` gates eval (off by default); `restrictNavigationToLocalhost` confines navigation to localhost/private hosts (off by default). With `enabled` on, each tool returns an actionable `{ kind, detail }` error when one of those sub-capabilities is gated off, when no driveable pane exists (`no-pane-open`), when the named pane belongs to another project (`foreign-project`), or when the window holding the pane is minimized and therefore composites no frames (`pane-not-rendering`). Screenshots have a further constraint: a window that is hidden or fully occluded also stops compositing, and Electron cannot report that to the main process, so `pane-not-rendering` does not catch it. Those captures instead fail after a short bound with a `driver-error` telling the user to bring the window to the front. Non-pixel tools (`query_dom`, `click`, `type`, and the rest) are unaffected and keep working against a backgrounded pane.

Tool categories (16 tools):
- **Discovery:** `kangentic_browser_list_panes` - list the Browser panes open in your project and their URLs. Each entry carries `sameProject` and `driveable`, and the response reports `otherProjectPaneCount` / `unknownProjectPaneCount` so an empty list is never mistaken for an idle machine. Pass `includeOtherProjects: true` to also list other projects' panes, which are visible but not driveable
- **Lifecycle:** `kangentic_browser_open_pane`, `kangentic_browser_close_pane` - open and put away panes (below)
- **Navigate:** `kangentic_browser_navigate` - point the pane at an http(s) URL
- **Observe:** `kangentic_browser_screenshot`, `kangentic_browser_screenshot_element`, `kangentic_browser_query_dom`, `kangentic_browser_query_all`, `kangentic_browser_bounding_box`, `kangentic_browser_console`, `kangentic_browser_wait`
- **Interact:** `kangentic_browser_click`, `kangentic_browser_type`, `kangentic_browser_keypress`, `kangentic_browser_drag`
- **Eval:** `kangentic_browser_eval` - evaluate a JavaScript expression in the loaded page; gated by `browserAutomation.allowEval`

### Opening and closing a pane

`kangentic_browser_open_pane` opens the Browser pane for the **caller's own task** and loads a URL, so an agent that hits `no-pane-open` can get itself unstuck instead of stopping to ask the user. It takes no `sessionId` / `taskId`: naming another task is exactly the cross-project hole the caller-scoping work closed, so the target is always the caller's own task and there is no argument that can widen it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | No | Absolute http(s) URL to load. Falls back to the task's saved Browser URL, then the project default. |
| `isolated` | boolean | No | Open a private offscreen LANE instead of the user's visible pane, and return its handle. Pass that handle back as `sessionId` on every later call, or the drive falls back to the shared pane and the isolation silently does nothing. See [Isolated browser lanes](#isolated-browser-lanes). |

The URL is part of the same call by necessity: a pane with no URL renders the empty state and registers no `<webview>` guest, so it is invisible to `list_panes`, `navigate`, `screenshot`, and every other tool in the family. An open-without-navigate would strand the agent in a state nothing can act on. When no `url` is passed and neither fallback exists, the tool fails with `no-url` rather than opening an unusable pane.

Behavior worth knowing:

- **It opens the task's detail window if one is not already open.** That changes what is on the user's screen, which is deliberate: refusing would put the agent right back at the dead end this tool exists to remove.
- **It returns only once the pane is registered and driveable**, resolved through the same `withGuest` chokepoint every driving tool uses, so the agent's very next call cannot race it. The wait is bounded (10s), after which it fails with `pane-open-timeout`. The one exception is a call that navigates nothing (the pane is already open and no `url` was passed): that returns the pane's registry status directly, having confirmed the guest is live but not that it is driveable.
- **It is idempotent.** Called again with a different `url`, it navigates the existing pane rather than reopening it; the response's `opened` / `navigated` flags say which happened.
- **It carries the `navigate` capability tier**, since it always loads a URL. Turning off "Allow navigation" in the Agent Browser settings therefore disables this tool too. The tier is checked before anything happens, so a gated-off call never opens a window or seeds a URL first.
- Refusals it can return besides the shared ones: `no-caller-task` (the connection is not bound to a task, e.g. a Command Terminal), `project-not-open` (the caller's project is not the one currently open in Kangentic, so no window can be mounted for its tasks), `browser-pane-disabled` (the project has the Browser pane turned off), `task-not-found`, `no-url`, `app-not-ready` (Kangentic is still starting, or its window is gone - also reachable from `close_pane`), and `url-seed-failed` (the URL could not be persisted before the pane was opened).

`kangentic_browser_close_pane` puts panes away exactly as the user's Browser pill does. It closes the pane, never the task-detail window hosting it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Close the pane for this session. |
| `taskId` | string | No | Close the pane for this task. |
| `all` | boolean | No | Close every pane in scope instead of a single target. Use for "close all browsers". Takes precedence over `sessionId` / `taskId`, which are ignored when set. |
| `includeOtherProjects` | boolean | No | Also close panes belonging to other projects. Widens `all` and an explicitly named target; it does not widen a bare no-argument call, which always means "my own pane". Default false. |

With no arguments it resolves the caller's own pane through the same precedence chain the driving tools use. Unlike opening, it does **not** require the caller's project to be the one currently open: retention keeps a backgrounded project's panes alive, and those are exactly what a "close everything" request should reach.

Scope is the caller's project by default, and the response always names the scope it applied (`this-project` / `all-projects`) plus `otherProjectPaneCount` for what it left alone, so a partial close is never reported as complete. `includeOtherProjects: true` is the explicit opt-in for a genuinely global close; it is off by default because another project may have an agent mid-verification in its pane. The response's `closed` and `skipped` arrays report what actually happened rather than what was attempted: a pane detached into its own pop-out window is the expected straggler, since it is mutually exclusive with the in-app mount and clearing the open flag does not unmount it.

Cookie isolation is per worktree (`persist:kngbrowser-<hash(worktreePath)>`) so concurrent worktrees' dev environments never share a `localhost` cookie jar. See [embedded-browser.md](embedded-browser.md).

### Shared target parameters

Every **driving** tool below takes the same optional target pair. They are listed in each tool's table for completeness; the resolution precedence and the `foreign-project` rule are described once, above.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Session whose Browser pane to target. Must name a pane in your own project. |
| `taskId` | string | No | Task whose Browser pane to target. An alternative to `sessionId`, likewise same-project. |

Omitting both resolves your own pane, then the single pane open in the project. Alongside the per-tool errors listed below, any driving tool can return the shared refusals raised while resolving and attaching to a pane: `no-pane-open`, `multiple-panes` (more than one is open and neither argument was given; the error carries the candidates), `foreign-project`, `pane-destroyed`, `pane-not-rendering`, `cdp-attach-failed`, `pane-busy`, and `driver-error`.

### An agent's browser survives the window closing

A browser an agent is using belongs to the agent, not to a piece of UI. The user is free to close the
task detail, move around the board, and switch projects without disconnecting an agent midway through
verifying something.

An Electron `<webview>` guest dies the instant its DOM node unmounts, so closing the task's detail
window really does destroy the visible pane. When that happens and the task still has a live agent
session, main hands the page off to an offscreen lane at the same URL, registered under the same
task. The agent's next call resolves to it through the ordinary caller-task rule, so nothing about
the agent changes - it does not know a hand-off happened and does not need to. Reopening the task's
Browser pane stands the hand-off lane down, because the visible pane is the better answer whenever it
exists and two surfaces for one task would make every implicit call ambiguous.

This is distinct from retention (`.claude/rules/retained-pane-never-remounts.md`), which keeps a
window that stays OPEN alive across a project switch. Retention covers the window staying; the
hand-off covers the window going away.

### Isolated browser lanes

`kangentic_browser_open_pane` accepts `isolated: true`, which opens a private browser LANE instead of
the task's shared pane and returns a `laneId`. Pass that id back as `sessionId` on every later
`kangentic_browser_*` call - forget it and the call silently falls back to the shared pane, which
undoes the isolation. Use a lane whenever several agents work on one task at the same time: without
one they all resolve to the same pane and interleave navigations, clicks and screenshots while each
believes it has exclusive control.

A lane is offscreen. It does not appear on screen, does not disturb the pane the user is looking at,
and cannot take their keyboard focus. It shares the task's worktree cookie jar, so it inherits
whatever the user is already signed into. Lanes are capped per task; past the cap `open_pane` returns
`lane-limit` and names the lanes to reuse. Close one with `kangentic_browser_close_pane`, which
destroys lanes directly. A lane is also destroyed when the session that opened it ends, when it goes
idle, and on app quit - so forgetting to close one leaks nothing.

`kangentic_browser_list_panes` reports a lane's `kind` so an agent can tell its own lane from the
task's shared pane.

`kangentic_browser_screenshot` additionally returns `dev-server-error` when the dev server is showing
a build-error overlay. Without it the tool returns a faithful picture of a full-screen red overlay,
which costs a turn to interpret - and when several agents share one dev server, the one that sees the
overlay is usually not the one who broke the build, so the error names that possibility. Detection is
by custom element (`vite-error-overlay`, `nextjs-portal`), so a dev server that renders neither
behaves exactly as before: no overlay recognized means "nothing detected", never "the page is fine".

Drives against one pane are SERIALIZED. Only one runs at a time per guest, so two agents sharing a
pane get slow-but-correct behavior instead of interleaved clicks, keystrokes and navigations. A
drive that cannot get its turn within 30s returns `pane-busy` rather than hanging. Serialization
fixes interleaving, not intent: it cannot stop another agent navigating away from the page you were
midway through verifying, so concurrent workers should take their own panes rather than share one.

The capability gate (`capabilityGate` in `src/main/browser/browser-pane-driver.ts`, the single source of the tier rules) adds four more: `automation-disabled` when the master switch is off, and `interaction-disabled` / `navigation-disabled` / `eval-disabled` for the tool's own tier. `automation-disabled` is reachable even though the family is not registered while the master switch is off, because the policy is read live per request: a switch flipped mid-session refuses the next call rather than waiting for a reconnect.

### kangentic_browser_list_panes

List the Browser panes open in your project, so you can discover a `sessionId` / `taskId` to drive or confirm the user has a dev server loaded. Returns an empty list when no pane is open. Not a driving tool: it takes no target pair.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeOtherProjects` | boolean | No | Also list panes in other projects. They are listed for visibility only and cannot be driven from this connection. Default false. |

Returns `{ automationEnabled, projectId, panes, otherProjectPaneCount, unknownProjectPaneCount }`. Each pane carries its `sessionId`, `taskId`, current URL, liveness / debugger-attached state, plus `sameProject` and `driveable`. The two counts are why an empty `panes` list is never mistaken for an idle machine.

### kangentic_browser_navigate

Point the pane at an http(s) URL. This navigates the in-app pane the user has open, not a general web browser; the pane's URL bar and the per-task saved URL both update. Capability tier: `navigate`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `url` | string | Yes | Absolute http(s) URL to load, e.g. `http://localhost:4200`. |

Returns `{ ok: true, url }` with the validated URL. The URL is checked before the pane is resolved, so a malformed URL or a non-http(s) scheme (`invalid-url`), or a non-local host while `restrictNavigationToLocalhost` is on (`navigation-host-blocked`), is refused without touching the pane.

### kangentic_browser_screenshot

Capture the pane's loaded page and return an inline image plus viewport and scale metadata for mapping image coordinates back to the page. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `fullPage` | boolean | No | Capture the full scrollable page instead of the viewport. Default false. |
| `format` | string | No | `png` or `jpeg`. Default `jpeg`. |
| `quality` | number | No | JPEG quality 1-100, ignored for png. Defaults to 80 for jpeg. |
| `maxBytes` | number | No | Soft cap on decoded image bytes; the capture downscales and recompresses to fit. |

Error modes beyond the shared set: `screenshot-failed` when CDP returns no data. A window that is hidden or fully occluded composites no frames and cannot be detected as such from the main process, so those captures fail after a short bound with a `driver-error` asking for the window to be brought forward. Non-pixel tools keep working against that same backgrounded pane.

### kangentic_browser_screenshot_element

Capture a screenshot clipped to a single element. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `selector` | string | Yes | CSS selector (or `text=` / `aria=` form) of the element to capture. |
| `format` | string | No | `png` or `jpeg`. Default `png`. |
| `quality` | number | No | JPEG quality 1-100, ignored for png. |
| `maxBytes` | number | No | Soft cap on decoded image bytes. |

Error modes: `selector-not-found` when nothing matches, `screenshot-failed` when the clip returns no data.

### kangentic_browser_query_dom

Read the `outerHTML` of the first element matching a selector. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `selector` | string | No | CSS selector (or `text=` / `aria=` form). Defaults to `html`. |
| `includeBox` | boolean | No | Also return the element's `{x, y, width, height}` viewport box. |

Returns `{ selector, outerHTML }`, plus `box` when `includeBox` is set. `box` is `null` when the element matched but CDP returned no usable box model. Error mode: `selector-not-found`.

### kangentic_browser_query_all

Measure every element matching a selector in one round-trip, instead of one call per element. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `selector` | string | Yes | CSS selector (or `text=` / `aria=` form). |
| `includeHtml` | boolean | No | Include each element's `outerHTML`, clipped to 1024 characters. |
| `limit` | number | No | Max elements to return. Default 100, max 1000. |

Returns one entry per match with its tag, box, and attributes (attributes are always included). Error modes: `evaluate-failed` when the page-side query throws, `query-failed` when it returns nothing.

### kangentic_browser_bounding_box

Read the raw CDP box model (content, padding, border, and margin quads) of one element. Use `query_dom` with `includeBox` for the simpler rectangle. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `selector` | string | Yes | CSS selector of the element. |

Returns `{ selector, ...boxModel }`. Error mode: `selector-not-found`.

### kangentic_browser_console

Read console messages captured from the pane. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `since` | string | No | ISO timestamp; only return entries at or after this time. |
| `level` | string | No | One of `log`, `warn`, `error`, `info`, `debug`, `verbose`, `all`. Default `all`. |
| `limit` | number | No | Max entries, newest last. Default 100, max 500. |

Each entry is `{ ts, level, text, url, lineNumber }`. The underlying ring holds the most recent 500 messages per attached pane and starts filling when the debugger attaches, so messages logged before that are not retrievable. This is the product tool for the user's own page, separate from the dev-only `kangentic_devtools_console`, which reads Kangentic's own renderer.

### kangentic_browser_wait

Poll until an element appears, optionally containing text, or until a string appears anywhere in the body. Capability tier: `observe`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `selector` | string | No | CSS selector to wait for. |
| `domText` | string | No | Text to wait for, within `selector` if given, else anywhere in `body`. |
| `timeoutMs` | number | No | Max wait. Default 30000, max 60000. |
| `intervalMs` | number | No | Poll interval. Default 250, max 5000. |

Returns `{ matched: true, matchedAt }` or `{ matched: false, timedOutAfterMs }`. A timeout is an ordinary result, not an error, so check `matched` rather than assuming success. Error mode: `missing-condition` when neither `selector` nor `domText` is given.

### kangentic_browser_click

Click an element by selector, or a point by coordinates. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `selector` | string | No | CSS selector (or `text=` / `aria=` form) to click at its center. |
| `x` | number | No | X coordinate. Use with `y` instead of `selector`. |
| `y` | number | No | Y coordinate. |
| `coordSpace` | string | No | `viewport` (default) or `image`, which maps screenshot pixels back via the device scale factor. |

Pass either `selector` or both `x` and `y`. Returns `{ ok: true }`, plus the mapped `dispatched: { x, y }` on the coordinate path. Error modes: `selector-not-found`, `missing-target` when neither form is supplied, and `coord-mapping-failed` when `coordSpace: "image"` is used but the device scale factor could not be read.

### kangentic_browser_type

Type text into the pane. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `text` | string | Yes | Text to type. |
| `selector` | string | No | CSS selector to focus before typing. Focus is taken by clicking the element's center. |
| `clearFirst` | boolean | No | Select-all and delete before typing. Requires `selector`, since it runs as part of focusing. |

Returns `{ ok: true }`. Error mode: `selector-not-found`. With no `selector`, the text goes to whatever the page currently has focused.

### kangentic_browser_keypress

Send a key or chord. Single printable characters are typed. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `keys` | string | Yes | Key or chord, e.g. `Enter`, `Escape`, `Tab`, `Ctrl+Shift+P`, `ArrowDown`. |

Returns `{ ok: true }`. Error mode: `unknown-key` when the combo cannot be parsed.

### kangentic_browser_drag

Drag from one element to another: mouse press, move in steps, release. Capability tier: `interact`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `fromSelector` | string | Yes | CSS selector of the drag source. |
| `toSelector` | string | Yes | CSS selector of the drop target. |
| `steps` | number | No | Intermediate move steps. Default 10, max 60. Raise it for libraries that need several move events to register a drag. |

Returns `{ ok: true }`. Error mode: `selector-not-found`, which covers either selector failing to match.

### kangentic_browser_eval

Evaluate a JavaScript expression in the loaded page's origin and return its value. Capability tier: `eval`, which is **off by default**: turn it on at Settings > Agent Browser > Allow eval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | No | Target pane by session. |
| `taskId` | string | No | Target pane by task. |
| `expression` | string | Yes | JavaScript expression to evaluate. The resolved value is returned. |

Returns `{ value }` with the serialized result. Error mode: `evaluate-failed`, carrying the page-side error text.

## Dev-only tool surface (`kangentic_devtools_*`)

When `developer.previewInspectionServer` is enabled in dev builds (the toggle is excluded from production binaries via `__KANGENTIC_DEV__` esbuild dead-code elimination), 32 additional `kangentic_devtools_*` tools are registered against the same MCP server. They wrap a localhost-only HTTP inspection bridge that powers agent-driven UI inspection and interaction. Implementation lives in `src/devtools/mcp/preview-tools.ts` (build-excluded from production).

Tool categories:
- **Discovery:** `list_instances` - enumerate running preview instances by lockfile
- **State:** `engine_state`, `renderer_state`, `store_state` - live ActivityStatsSnapshot, the fixed Zustand snapshot, and arbitrary store reads by name plus dot/bracket path. `store_state` also answers MAIN-side namespaces that are not Zustand stores: `detailOwners` returns the task-detail ownership map plus its recent mutation history (resolve / sync / release-all). That one exists because ownership was otherwise observable only by calling `requestOpen`, which focuses and can mount a window - probing changed what was being measured
- **Visual / DOM:** `screenshot`, `screenshot_element`, `query_dom`, `query_all`, `computed_style`, `bounding_box`, `bounding_box_all`, `accessibility_tree`, `mutations` - the `_all` variants measure every matching element in one call
- **React:** `react_query`, `react_tree`, `react_recent_renders` - fiber walker via `__REACT_DEVTOOLS_GLOBAL_HOOK__`. Caveat on `react_recent_renders`: in a Vite dev server it returns `[]`, because `@vitejs/plugin-react`'s react-refresh preamble installs the global hook AFTER preload has already looked for one, so the commit-ring wrapper is never attached. Read that `[]` as "not instrumented", never as "no React work happened" - use `event_loop_lag`'s `recentLongFrames` for render attribution instead
- **Performance:** `event_loop_lag` - the freeze flight recorder for BOTH the main process and the renderer. Timestamped stalls past a 75ms threshold answer when the thread blocked; the renderer's `recentLongFrames` answers what ran, listing each long animation frame's heaviest scripts with the source URL and function that registered them. The breakdown is the diagnosis: script time means JS, `styleLayoutMs` means a style or layout cost, and a script's `forcedLayoutMs` means it read geometry it had just invalidated. Both rings carry wall-clock stamps, so a spike and its frame join by timestamp. Note `capture_trace` is NOT a CPU profile (it bundles a session's activity-engine JSONL taps for replay)
- **Console:** `console` - CDP `Console.messageAdded` ring buffer (separate from product `tail_logs`)
- **Drive (interaction):** `click`, `type`, `keypress`, `drag`, `wait`, `script` - dispatched via Chrome DevTools Protocol (the `script` `eval` step returns its value and is gated by `developer.previewEvalEnabled`)
- **Eval:** `eval` - evaluate a JavaScript expression and return its serialized value; gated by `developer.previewEvalEnabled`
- **Cross-instance:** `run_command` - run a product MCP command inside a specific preview instance
- **Sessions:** `pty_input`, `inject_session_event`, `capture_trace` - `inject_session_event` and `pty_input` raw bytes are gated additionally by `developer.previewEvalEnabled`
- **Terminal:** `pty_pipeline`, `terminal_state`, `terminal_forensics` - `pty_pipeline` reports per-session backpressure (pending / in-flight bytes, paused, scrollback size). `terminal_state` is the cross-process join: every mounted xterm's grid and pixel geometry next to that session's PTY dimensions, with `ptyMatchesGrid` / `colsDrift` / `gridOverflowPx` derived, plus the main and renderer lifecycle traces merged by timestamp (fits, PTY resizes, repaint-settle decisions, replay start / write / abort / done). Neither process can see a grid-vs-PTY mismatch or a replay ordering bug alone, which is why this is one call rather than two. `terminal_forensics` narrows to ONE session and answers which rows rather than how many: the renderer's xterm viewport row by row, main's own frame re-parsed to rows, and the raw PTY byte ring with control bytes escaped. Text missing from the raw tail means the agent never sent it (upstream); present there and in main's grid but not the renderer's means it was lost in the IPC / queue / write path; present in both grids means the fault is paint. Capture while the TUI is idle - main's grid comes from a bare serialize with no tail fold, so a mid-stream capture can trail the renderer by a frame

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
- **Caller identity via URL path** - a spawned TASK session's URL carries a third segment, `/mcp/<projectId>/<callerSessionId>`, stamped into that session's own `mcp.json` at spawn by the two task-spawn chokepoints (`prepare-spawn.ts` and `transition-engine.ts`). The agent never chooses it through a tool parameter, so `kangentic_send_session_message` can refuse self-sends, track a steer chain, and attribute a sent message truthfully without trusting a caller-supplied field. This is honesty-by-default, not cryptographic attribution: the bearer token is one shared per-launch secret every spawned agent holds, and the segment is not validated against a real or connected session, so a process with the token (an agent has both it and shell access) can dial any caller id via a raw HTTP request. The guards it feeds are circuit breakers against a looping or careless agent, not a defense against a deliberately lying one. The segment is optional: a human-driven client, the per-project `.kangentic/mcp-config.json`, and a Command Terminal session (`transient-sessions.ts` does not pre-generate its PTY id, so it has none to stamp) all dial the two-segment URL and are treated as unattributed callers, never refused. An unattributed caller records `caller_session_id: null` and resets the steer-chain depth, so a send routed through a Command Terminal is indistinguishable from a human's.
- **Runaway-loop safeguard** - task creations are capped at a fixed 500 per app launch, enforced atomically by the shared `TaskCounter`. This is an internal circuit breaker against a looping agent, not a user-tunable knob; the count resets on restart.
- **Input validation** - Zod schemas enforce title (200 chars) and description (50000 chars for tasks; 10000 chars for backlog item descriptions) limits at the protocol level, and the command handlers validate again. A backlog item created via `kangentic_create_task` shares the task 50000-char Zod schema, so `handleCreateTask` enforces the 10000 backlog cap itself and rejects an over-cap backlog description rather than truncating it.
- **Column safety** - `kangentic_create_task` defaults to the To Do column; creating in an auto_spawn column intentionally triggers agent spawn. `kangentic_move_task_to_project` follows the same rule on the destination board: landing in an auto_spawn `column` there spawns an agent.
- **Destructive operations are explicit** - `kangentic_delete_task`, `kangentic_delete_backlog_item`, `kangentic_delete_column`, `kangentic_remove_task_attachment`, `kangentic_move_task`, and `kangentic_move_task_to_project` mutate the board. Agents must invoke them by name; there is no implicit fallback.
- **Column deletion never touches a task** - `kangentic_delete_column` refuses a column that still holds tasks, and refuses a role column (To Do / Done). Emptying a column is the caller's explicit, separate step; there is no `force` or bulk-move escape hatch.
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
