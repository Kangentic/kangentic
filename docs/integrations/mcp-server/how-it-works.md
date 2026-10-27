---
type: Reference
title: How the MCP server works
description: How the in-process MCP HTTP server authenticates (per-launch X-Kangentic-Token, loopback bind, DNS rebinding allowlist, caller URL segment), how each agent CLI receives its config, how tool annotations drive plan-mode approval, and the enable switch, permissions and 401/404 troubleshooting.
tags: [mcp, server, security, discovery, config]
sources:
  - resource: src/main/agent/mcp-http-server.ts
  - resource: src/main/agent/mcp-http/annotations.ts
  - resource: src/main/agent/mcp-http/caller-url.ts
  - resource: src/main/agent/mcp-http/caller-task.ts
  - resource: src/main/agent/mcp-http/workflow-agent-scope.ts
  - resource: src/main/agent/mcp-http/answer-search-trace.ts
  - resource: src/main/pty/readers/wsl-mcp-relay.ts
  - resource: src/main/agent/commands/column-resolver.ts
  - resource: src/main/agent/commands/column-enums.ts
  - resource: src/main/agent/commands/task-ordering.ts
  - resource: src/main/agent/shared/git-exclude.ts
  - resource: src/main/ipc/handlers/sessions.ts
  - resource: src/main/agent/adapters/claude/trust-manager.ts
  - resource: src/main/agent/adapters/codex/trust-manager.ts
  - resource: src/main/agent/adapters/gemini/trust-manager.ts
  - resource: src/main/agent/adapters/qwen-code/trust-manager.ts
  - resource: src/main/agent/adapters/grok/trust-manager.ts
  - resource: src/main/agent/adapters/antigravity/trust-manager.ts
  - resource: src/shared/mcp-tool-manifest.ts
    title: MCP_TOOL_MANIFEST
---
# How the MCP server works

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
| Profile Tools | `src/main/agent/mcp-http/profile-tools.ts` | Board Profile read + authoring (`kangentic_list_board_profiles`, `kangentic_create_board_profile`, `kangentic_update_board_profile`, `kangentic_delete_board_profile`). Entries are keyed by column NAME so a profile can be copied between projects; see [Board Profiles](profile-tools.md#board-profiles). |
| Automation Tools | `src/main/agent/mcp-http/automation-tools.ts` | Column automation read, write, run log, and re-run (`kangentic_list_automations`, `kangentic_set_automations`, `kangentic_get_automation_runs`, `kangentic_run_automation`). See [Column automations](automation-tools.md#column-automations). |
| Workflow Tools | `src/main/agent/mcp-http/workflow-tools.ts` | Plan, start and change a workflow of linked tasks (`kangentic_list_workflows`, `kangentic_get_workflow`, `kangentic_save_workflow`, `kangentic_start_workflow`, `kangentic_pause_workflow`, `kangentic_resume_workflow`, `kangentic_add_workflow_task`, `kangentic_link_workflow_tasks`, `kangentic_unlink_workflow_tasks`, `kangentic_set_task_route`, `kangentic_remove_from_workflow`, `kangentic_request_project_access`, `kangentic_delete_workflow`). See [Workflows](workflow-tools.md#workflows). |
| Session Tools | `src/main/agent/mcp-http/session-tools.ts` | Session inspection, backlog, read-only SQL (`kangentic_list_sessions`, `kangentic_get_transcript`, `kangentic_get_session_files`, `kangentic_get_session_events`, `kangentic_get_activity_intervals`, `kangentic_query_db`, `kangentic_list_backlog`, etc.). |
| Steering Tools | `src/main/agent/mcp-http/steering-tools.ts` | The write side of the session surface (`kangentic_send_session_message`) plus its debugging read (`kangentic_get_session_messages_sent`). Kept out of `session-tools.ts` because the send needs live main-process singletons (SessionManager, TerminalSubmit) that `CommandContext` does not carry. |
| Background Shell Tools | `src/main/agent/mcp-http/background-shell-tools.ts` | `kangentic_mark_background_service`: the calling agent marks background shells it started as services, so they stop holding its session. Acts only on the session in the caller URL, through `SessionManager`, so it is registered beside the steering tools rather than in `session-tools.ts`. |
| Session Send Coordinator | `src/main/agent/mcp-http/session-send.ts` | Delivery + guards behind the steering tools: per-target serialization, the sliding-window ceiling, the steer-chain depth backstop, deferred `deliverWhen: "idle"` delivery, and out-of-band provenance recording (the message itself carries no in-band prefix). |
| Project Tools | `src/main/agent/mcp-http/project-tools.ts` | Multi-project discovery (`kangentic_list_projects`). |
| Search Tools | `src/main/agent/mcp-http/search-tools.ts` | The single unified search (`kangentic_search`): tasks, backlog, session events, projects, past conversations (keyword or, with `mode:"hybrid"`, semantic) and commits, with `groupBy: "task"` and `relatedToTask`. The ranking runs in the retrieval worker. The board-scoped `kangentic_search_tasks` lives in `task-tools.ts`. |
| Caller URL | `src/main/agent/mcp-http/caller-url.ts` | Appends the calling session to the MCP URL as a path segment. An `answer-<chatId>` caller is a Knowledge Graph answer run, which the server gives `kangentic_search` alone. A `workflow-<workflowId>` caller is a workflow's own agent. |
| Caller Task | `src/main/agent/mcp-http/caller-task.ts` | The calling agent's own task, looked up once per request from the session in the URL. The browser tools scope their default pane to it, and `kangentic_move_task`'s workflow lock lets a task's own agent move it. |
| Workflow Agent Scope | `src/main/agent/mcp-http/workflow-agent-scope.ts` | For a `workflow-` caller, registers only the read-only tools and the planning tools (save, add task, link, unlink, set route, remove from workflow, request project access), never start, pause, resume, delete or any browser or steering tool. The planning tools lose their `workflow` and `project` arguments and act on the caller's own workflow. `kangentic_get_workflow` reads the caller's own workflow when `workflow` is left out, and the one it names otherwise. |
| Answer Search Trace | `src/main/agent/mcp-http/answer-search-trace.ts` | For an `answer-` caller, enforces the per-question search budget and publishes each search's query and hits, which the Ask handler forwards to the map as a step line and rings. |
| Diagnostics Tools | `src/main/agent/mcp-http/diagnostics-tools.ts` | Read-only product tools backing crash records, persistent console logs, process metrics, IPC traffic recordings, and worktree state. |
| Tool Annotations | `src/main/agent/mcp-http/annotations.ts` | Shared `READ_ONLY_ANNOTATIONS` / `MUTATING_ANNOTATIONS` MCP tool-annotation constants. Every tool in every `*-tools.ts` file declares one of these (see [Tool annotations](#tool-annotations)). |
| Browser Tools | `src/main/agent/mcp-http/browser-tools.ts` | Shipped `kangentic_browser_*` MCP tool family driving the embedded Browser pane via in-process CDP (no HTTP bridge, no lockfile). Gated by the global `browserAutomation.*` policy. |
| Usage Tools | `src/main/agent/mcp-http/usage-tools.ts` | Aggregated usage statistics (`kangentic_get_usage_stats`): tokens, cost, burn rate, and by-model / by-agent / by-effort / by-subagent-type breakdowns, per project or app-wide, over the shared time ranges. Reads the same usage-stats service as the in-app dashboard. |
| Command Handlers | `src/main/agent/commands/` | Per-domain handlers shared by the HTTP tools: task, column, profile (`profile-commands.ts`: the four `*_board_profile` commands plus the shared `resolveProfileSelector` used by create/update task), inventory, search, analytics, usage, backlog, handoff, inspect (`get_transcript`, `query_db`), session-files (`get_session_files`, `get_session_events`), activity-interval (`get_activity_intervals`), task-report (`task-report-commands.ts`: `get_task_report`, which reads the completed task view's report and git changes through `CommandContext` callbacks), automation (`automation-commands.ts`: `list_automations`, `set_automations`, `get_automation_runs`, `run_automation`), dev-port (`dev-port-commands.ts`: `reserve_dev_ports`, `check_dev_ports`), and workflow (`workflow-commands.ts`: the thirteen workflow tools, thin shells over `src/main/workflows/workflow-service.ts`) commands. |
| Column Resolver | `src/main/agent/commands/column-resolver.ts` | Shared case-insensitive column name to swimlane lookup used by multiple handlers, and the single place that decides how the done column is treated: `listActiveSwimlanes` (Done excluded; search, profiles, task stats, and the post-delete remaining-columns list), `listBoardColumns` / `isBoardColumn` (Done included; the board read tools), and `resolveColumn`'s `includeArchivedDone` and `refuseDone` options, which every by-name lookup of Done goes through. |
| Task Ordering | `src/main/agent/commands/task-ordering.ts` | Pure ordinal-slot arithmetic shared by `handleMoveTask`'s same-column reposition and `handleReorderTasks`: slot clamping, prefix-merge reordering, and ordinal-to-raw-position translation. |
| Column Enums | `src/main/agent/commands/column-enums.ts` | The valid value sets for a column's enum fields (`COLUMN_ENUM_FIELDS`: `permissionMode`, `sessionTarget`, `sessionSpawnStrategy`, `autoCommandMode`) and the `parseEnumParam` helper that narrows them, shared by the column handlers and the profile handlers. This is the only narrowing on the mobile-bridge path, which routes into `commandHandlers` directly and validates just that `params` is an object, so none of the tool files' zod schemas are in front of it. |
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
| Gemini CLI | `mcpServers` in `<cwd>/.gemini/settings.json` (`httpUrl`) | process env: the file holds only `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}` references, and the entry is stripped when the folder's last session exits |
| Qwen Code | `--mcp-config <sessionDir>/mcp.json` (0.16+); `mcpServers` in `<cwd>/.qwen/settings.json` (`httpUrl`) before 0.16 | session file (gitignored) on 0.16+; the project file before, stripped when the folder's last session exits |
| Droid | `<cwd>/.factory/mcp.json` with `${KANGENTIC_MCP_TOKEN}` | process env (file holds only the var name) |
| Grok Build | `[mcp_servers.kangentic]` sentinel block in `<cwd>/.grok/config.toml` with `${KANGENTIC_MCP_URL}` + `${KANGENTIC_MCP_TOKEN}`, plus `--allow "MCPTool(kangentic__*)"` pre-approval | process env (file holds only var names - the URL too, so the block is fully static) |
| OpenCode | `OPENCODE_CONFIG_CONTENT` env var | process env (local spawns only) |
| Antigravity CLI | Workspace plugin `<cwd>/.agents/plugins/kangentic/` (`serverUrl` + `X-Kangentic-Token` header; streamable HTTP, connects at the first agent turn) | project file, stripped when the folder's last session exits |
| Cursor CLI | `<cwd>/.cursor/mcp.json` entry with `${env:KANGENTIC_MCP_URL}` + `${env:KANGENTIC_MCP_TOKEN}`, plus `--approve-mcps` | process env (file holds only var references; stripped when the folder's last session exits) |
| Oz CLI, Goose CLI | Not wired | n/a |
| Aider, Ollama | Not possible - neither CLI is an MCP client | n/a |

Each adapter declares its row as `kangenticMcp` (`'per-session'` or `'shared-folder'`), and
`tests/unit/kangentic-mcp-delivery.test.ts` drives every real builder to hold the declaration to
what it does. Droid and Antigravity are `'shared-folder'`: the session's URL is
written literally into a project file every session in that folder shares, so the last session to
start decides the URL the others read. That is why they cannot carry a workflow agent's caller
scope (`canBeWorkflowAgent`). Gemini's, Grok's and Cursor's files are static and their URLs are
per-process env references, and Qwen's config is a per-session file, so they are `'per-session'`.

A project-file row's entry is held per session (`SharedFolderHolds`, keyed by the session's own id
and recording the folder the build wrote), and the folder's last session to end strips it. A
session that ends while a later session of the same task runs releases only its own hold.

The project-file rows (Gemini, Qwen, Droid, Grok, Antigravity, Cursor) are additionally hidden from git while untracked: when Kangentic creates the file, the builder seeds it into the local `.git/info/exclude` so it never shows in `git status` and cannot ride a `git add -A` (shared mechanism in `src/main/agent/shared/git-exclude.ts`; a pre-existing user file keeps its git visibility).

Full per-adapter detail, including the Codex quoting contract and the Gemini folder-trust requirement, lives in each agent's concept, listed in the [agents index](../agents/index.md).

#### Claude Code

Claude Code supports a `--mcp-config` flag that accepts a path to a JSON file containing MCP server definitions. Kangentic uses this to deliver its MCP server config without modifying `.mcp.json` (which may be tracked in git). When Kangentic spawns a session:

1. `CommandBuilder.createMergedSettings()` writes the kangentic MCP server config to `.kangentic/sessions/<sessionId>/mcp.json`. The entry is an HTTP MCP server pointing at the per-launch URL `http://127.0.0.1:<port>/mcp/<projectId>` with the `X-Kangentic-Token` header containing the per-launch token. In the same gated block it also appends `mcp__kangentic` to the merged settings' `permissions.allow` (append-if-absent) so the spawned agent does not prompt for kangentic tools in default mode (see Permissions).
2. `CommandBuilder.buildClaudeCommand()` adds `--mcp-config <path>` to the CLI command
3. `ClaudeAdapter.ensureTrust()` (`ensureClaudeSpawnConfig()`) adds "kangentic" to `enabledMcpjsonServers` in `~/.claude.json`, in the same write that trusts the working directory
4. Claude Code starts, reads both `.mcp.json` (user servers) and the `--mcp-config` file (kangentic), and connects to the in-process HTTP MCP server over loopback. No child process is spawned for kangentic itself.
5. Claude Code calls `tools/list` and discovers all kangentic tools

This approach keeps `.mcp.json` completely untouched - no injection, no cleanup, no git noise. The `--mcp-config` flag is additive (not `--strict-mcp-config`), so user-configured servers like context7 continue to work normally. The token is rotated on every Kangentic launch, so a stale `mcp.json` from a previous run cannot be reused.


## Tool list and annotations

Each tool family has its own concept, listed in the [MCP server index](index.md). The
**Settings -> MCP Server** panel lists every tool in one collapsible group per
category. Every visit opens with each group open except Diagnostics, which starts closed. Each
tool's cell deep-links to that tool's entry on the live docs page
(`https://kangentic.com/mcp-server/`, anchored by the tool name), opening it in the default
browser, and its tooltip says what the tool does. A Documentation row above the groups opens
the page itself.

### Tool annotations

Every registered tool declares MCP `annotations` from the shared constants
in `src/main/agent/mcp-http/annotations.ts`: read-only tools carry
`readOnlyHint: true, idempotentHint: true`; mutating tools carry
`readOnlyHint: false, idempotentHint: false`. Mutating covers both the board/backlog writers
(`create` / `update` / `delete` / `move` / `promote` / `link`) and the `kangentic_browser_*` tools
that change the loaded page (navigate, click, type, keypress, drag, eval). This is load-bearing for
plan mode: Claude Code auto-approves read-only-annotated tools without a permission prompt while
planning, so the plan-mode auto-approval surface for Kangentic's own tools is exactly the read-only
set. Its mutating tools still prompt in plan mode by design (allow rules do not punch through the
plan-mode gate, and the plan tool approval hook, which answers other servers' allowed tools under
automatic plan approval, never covers `mcp__kangentic__*`). The
`tests/unit/mcp-tool-list-parity.test.ts` guard fails the build if a tool is registered without one
of the two shared annotation constants, and separately checks the board/backlog verb prefixes and
the browser capability tiers are annotated mutating.

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

**An agent CLI installed in a WSL distro** reaches the server without either key. On WSL's default NAT network the distro's `127.0.0.1` is its own, so the session's MCP entry is a stdio server instead of the URL: `sh <session>/wsl-hooks/wsl-hook.sh mcp <url>`, the hook transport's script (`wsl-hook-transport.ts`). It writes each JSON-RPC line into the session's `wsl-hooks/requests/` folder with the token from its environment (`KANGENTIC_MCP_TOKEN`; Claude sets it in the server's `env`, Codex forwards it by name through `env_vars`, so it never travels in argv). Kangentic's `WslHookInbox` posts each one to this server over loopback exactly as an HTTP client would (`relayMcpMessage`, `src/main/pty/readers/wsl-mcp-relay.ts`), so the token check and the DNS-rebinding allowlist decide as for any client, and the relay posts nowhere but `/mcp/` paths on `127.0.0.1`. Messages are relayed concurrently, so a long tool call never holds up a hook's answer, and every request and answer file is deleted as soon as it is read. Measured from Ubuntu on Windows 11: 30 to 70 ms a message once the bridge is up. A listener on the WSL adapter was the alternative, rejected because Windows classes that adapter as a Public network, blocks inbound traffic there by default, and asks the user to allow the app (an administrator, on Public) the first time it listens; a dismissed prompt blocks it for good. A distro on mirrored networking shares this machine's loopback and gets the URL as a local agent does.

**Whether agents can reach it** is the MCP connection row's question, first in Settings > MCP Server (`checkMcpConnection`, `src/main/agent/mcp-connection-check.ts`). It posts an authenticated `initialize` to the open project's loopback URL, which also catches a server that never started (startup only logs that; the row shows its error), then checks from each WSL distro the project's CLI paths point into: through the stdio bridge on NAT networking, a connect to the loopback port on mirrored. The row reads Connected, or Failed with the error the check hit, and nothing more. Opening the tab skips a stopped distro, since reaching it would start it; Test connection checks it anyway. The same check runs at an agent session's first output (`McpConnectionWatch`), each place once until it answers, and the first failure in a run raises one persistent toast, "Couldn't reach the MCP server", with the same error and an Open settings button.

**Remote OpenCode sessions are not automatically wired**, and widening these settings does not change that: `opencode attach <url>` (which Kangentic spawns in OpenCode's remote-execution mode) is a stateless HTTP client to a server that was started, and had its config fixed, independently and earlier. It has no config-push mechanism (`opencode attach --help` lists only `--dir`, `--continue`, `--session`, `--fork`, `--username`, `--password`), so env vars Kangentic sets on the attach process are never read by the already-running server. This holds even when the target server is on the same machine.

### Permissions

Claude Code sessions Kangentic spawns never see a permission prompt for Kangentic's own tools, and Grok Build's do not either (`--allow "MCPTool(kangentic__*)"`). Every other agent applies its own approval rules to Kangentic's tools as to any MCP server, so it may ask before a call in its terminal. For Claude, three layers cover the axes (which mode, which project):

1. **Auto-allow injection (all projects, default / acceptEdits mode).** Whenever the MCP server is attached, `CommandBuilder.createMergedSettings()` appends `mcp__kangentic` to `permissions.allow` in the per-session merged `settings.json` (`.kangentic/sessions/<sessionId>/settings.json`). This is gated on the same condition as the session `mcp.json` write and is append-if-absent, so a committed project rule or a Claude "always allow" grant is not duplicated. It lives only in the regenerated per-session settings, never written back to the user's own settings files, and an explicit user `deny` of `mcp__kangentic` still wins (deny outranks allow). So the no-prompt behavior holds for every project, not just ones that committed a rule.
2. **Read-only annotations (all projects, plan mode).** Allow rules do not punch through plan mode. Plan-mode auto-approval comes from the tools' `readOnlyHint` annotations (see [Tool annotations](#tool-annotations)): read-only tools run without a prompt while planning; mutating tools still prompt, by design. While a plan is approved automatically, the plan approval hook answers a planning prompt for ANOTHER server's tool the allow rules in the project's or the user's Claude settings name, so an unattended Planning session does not stall on it ([Bridge scripts](../agents/bridge-scripts.md#plan-approval-bridgejs)). It always leaves Kangentic's own tools out, so this layer is unchanged.
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
- **Honest mutating annotations** - mutating tools carry `readOnlyHint: false`, so the plan-mode auto-approval surface for Kangentic's own tools is exactly the read-only set. Deletes, moves, and creates always prompt while planning, even though the auto-allow injection pre-approves them in default mode, and even under automatic plan approval: the plan tool approval hook excludes `mcp__kangentic__*`.

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
