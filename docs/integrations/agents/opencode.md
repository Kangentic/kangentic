---
type: Reference
title: OpenCode
description: How Kangentic detects OpenCode, builds its command, merges settings, tracks activity through a plugin, captures the session id, and attaches to a remote server.
tags: [agents, adapter, opencode]
sources:
  - resource: src/main/agent/adapters/opencode/
---
# OpenCode

## CLI Detection

`config.agent.cliPaths.opencode` override, then `PATH` lookup for `opencode` (with the `.cmd` shim on Windows for `npm i -g opencode-ai` installs; under a PowerShell or Git Bash host the spawn chokepoint launches the sibling `.ps1` or sh shim instead, see [cross-platform.md](../../cross-platform.md#npm-cmd-shims-under-powershell-and-git-bash)), then the standard Unix fallback paths. Distributed via Homebrew, Scoop, Chocolatey, Pacman, the curl|sh installer, and `npm i -g opencode-ai` - all install methods publish the same `opencode` binary name. The version probe runs `opencode --version` and strips an optional `opencode ` product prefix from the output.

## Command Building

`src/main/agent/adapters/opencode/command-builder.ts`

```
opencode [--session <id>] [--prompt <text>]
```

Important shape constraints (verified against /anomalyco/opencode docs):

- The TUI's positional argument is a **project directory**, not a prompt. Initial prompts must go through `--prompt <text>` or OpenCode tries to chdir into the prompt text. The PTY layer already sets the shell cwd, so Kangentic never emits a positional or `--dir` value.
- Resume uses `--session <id>` (alias `-s`) on the TUI command - not the `run` subcommand. The prompt is omitted on resume so the user continues the prior conversation (mirrors Claude's `--resume` convention).
- Windows shells get embedded `"` characters in the prompt rewritten to `'` to keep the cmd.exe / PowerShell quoting parser happy.

## Permission Modes

The `permissions` list exposes two entries in OpenCode's own vocabulary: `plan` (label "Plan", OpenCode's built-in read-only agent) and `acceptEdits` (label "Build", full tool access). The stored `PermissionMode` enum values are reused for compatibility, so a swimlane set to `acceptEdits` under Claude continues to mean "Build" under OpenCode. On a fresh spawn the mode sets OpenCode's `--agent`: `plan` gives `--agent plan`, `acceptEdits` and `bypassPermissions` give `--agent build`, and `default`, `dontAsk` and `auto` give no flag, deferring to the user's `default_agent`. A resume passes only `--session <id>`, because the saved session already has an agent and the user may have switched it with Tab. There is no `--dangerously-skip-permissions` flag in TUI mode (it exists only on the non-interactive `opencode run` subcommand). `bypassPermissions`, `default`, `dontAsk` and `auto` sit outside the `permissions` list and are still accepted by `mapPermissionModeToAgent` for mixed-agent projects. Users who want auto-approval must enable it in `opencode.json`. The default mode is `acceptEdits`.

## Settings Merge

None. OpenCode reads MCP and provider configuration from `opencode.json` (project) or `~/.config/opencode/opencode.json` (global). `removeHooks` only removes the activity plugin (next subsection). The Kangentic MCP server IS wired in for a local-mode spawn - `buildOpenCodeEnv` (`command-builder.ts`) emits an inline `mcp.kangentic` entry via the `OPENCODE_CONFIG_CONTENT` env var per PTY spawn, deep-merged over the user's own config so their `mcp.*` entries are preserved (see [MCP Server](../../mcp-server.md)). It is NOT wired in for a remote-mode spawn (`opencode attach <url>`) - see the Remote Execution subsection below.

## Activity Plugin

Local-mode spawns install the Kangentic activity plugin by copying `kangentic-activity.mjs` into `<projectRoot>/.opencode/plugins/`, where OpenCode auto-discovers plugins at TUI startup. The copy is byte-compare idempotent, and removal verifies a sentinel comment on line 1 so a user-authored plugin at the same path is never touched. The plugin runs inline in the OpenCode process and writes activity events straight to the session's `events.jsonl`, reading its output path from the `KANGENTIC_EVENTS_PATH` env var exported by the PTY spawn flow. Note the install lands at the PROJECT ROOT, not the task worktree. Concurrent sessions in one project hold the plugin per session (`OpenCodeAdapter.hookHolds`), and the hold records the project root, so a worktree session's release (which names the worktree) removes the plugin once the root's last session ends.

The plugin file is hidden from git via the shared `.git/info/exclude` mechanism (`src/main/agent/shared/git-exclude.ts`, see [Antigravity](antigravity.md)), seeded only once the plugin file actually exists at the destination so a failed copy never leaves an entry pointing at a missing file. Earlier releases appended the entry to the project's tracked `.gitignore` instead, which dirtied the user's checkout; a line those releases appended is left in place (harmless - it ignores the same path).

## Session ID Capture

Not caller-owned (`supportsCallerSessionId = false`). Two capture pathways run concurrently and the first to succeed wins:

- **`sessionId.fromOutput`:** `SessionIdScanner` strips ANSI escapes from each PTY chunk and matches against `(?:session(?:[ _-]?id)?|sid)` and `--session` flag forms. Accepts both OpenCode's native `ses_<16-64 alphanumeric>` shape (verified empirically on v1.14.25, e.g. `ses_2349b5c91ffeKd6qajuUTR4clq`) and canonical UUID format.
- **`sessionId.fromFilesystem`:** Polls the OpenCode SQLite database at `~/.local/share/opencode/opencode.db` (read-only, WAL-friendly handle) for a `session` row whose `directory` equals the spawn cwd and whose `time_created` falls within `[spawnedAt - 5s, spawnedAt + 30s]`. Polls every 500 ms for up to ~10 s. Direct DB read avoids ~200-500 ms `opencode` CLI spin-up per poll, and avoids the Windows `child_process.execFile` rejection of `.cmd` shims.

## Remote Execution

OpenCode is the only adapter that declares `remoteExecution` (see `remoteExecution?` in [Optional properties](optional-properties.md) and [configuration.md - Remote Execution](../../configuration.md#remote-execution) for the config shape). When a project's mode for OpenCode is `remote`:

- **Command:** `command-builder.ts`'s `buildOpenCodeAttachCommand` emits `opencode attach <url> [--dir <serverPath>] [--username u] [--password p]` instead of the local TUI form. `--model` is never emitted - the server is the authority for providers and models. Resume uses `--session <id>` exactly as in local mode.
- **Auth:** `probeAuth()` (the local `auth.json` check) is bypassed. `remoteExecution.probeServer` (`remote-client.ts`'s `probeOpenCodeServer`) hits `GET <url>/global/health` instead, surfaced via the `agent:probeExecutionServer` IPC channel and the Agent settings tab's "Test connection" button.
- **Session ID capture:** `sessionId.fromFilesystem` (the local SQLite poll) is skipped for a remote-mode cwd - `sessionId.fromOutput` (the PTY scan) is the sole capture path. This also means the "concurrent same-cwd spawns cannot be disambiguated" caveat below does not apply to remote sessions.
- **Transcript:** `parseTranscript` fetches `GET <url>/session/:id/message` (`remote-client.ts`'s `fetchOpenCodeSessionMessages`) instead of reading the local SQLite database, mapped into the same `TranscriptEntry[]` shape by `mapOpenCodeRemoteEntries` (a distinct mapper from the local `mapOpenCodeRows` - the wire shape is `{info, parts}[]`, not SQLite rows).
- **Activity plugin:** not installed - the plugin file would need to land on the server's filesystem, which Kangentic has no access to. PTY-silence activity detection (already the fallback tier of `hooks_and_pty`) carries activity for remote sessions.
- **MCP:** not wired. `buildOpenCodeEnv` returns `null` whenever `options.executionTarget` is set (loopback or genuinely remote target - both). This is architectural, not a reachability problem: `opencode attach <url>` is a stateless HTTP client to a server that was started, and had its config fixed, independently and earlier - its CLI surface exposes no config-push flags (verified against `opencode attach --help`), so env vars Kangentic sets on the spawned attach process are never read by the already-running server. Kangentic's `mcpServer.bindAddress`/`callbackHost` settings (see [MCP Server > Network Access](../../mcp-server.md)) make the server itself LAN/VPN-reachable, but cannot make `attach` push config into a server it does not control the startup of.
- **Worktree:** `ensureTaskWorktree` (`src/main/ipc/helpers/task-git.ts`) skips creating a local git worktree for a task whose resolved agent is remote-mode; the configured server working directory travels via `executionTarget`, never through `task.worktree_path`.
- **Handoff:** `locateSessionHistoryFile` returns `null` for a remote-mode cwd - cross-agent handoff degrades to the PTY-scrollback cleanup fallback, since there is no local history file to reference.

The adapter tracks which cwd resolved to which remote target in an in-memory `Map` populated by `buildCommand` (alongside the plugin's `hookHolds`), since `parseTranscript` / `locateSessionHistoryFile` / `sessionId.fromFilesystem` have no other way to reach Kangentic's `AppConfig` (adapters hold no config reference by design). Known limitation: this map is empty after an app restart, so viewing an old remote session's transcript falls back to the (empty) local SQLite lookup until the task is resumed again.

## Limitations

- **Concurrent same-cwd spawns cannot be disambiguated (local mode only):** Two OpenCode tasks spawned within ~30 s against the same `cwd` cannot be reliably distinguished by `captureSessionIdFromFilesystem`. Both rows match the directory + time-window predicate, so the parser returns the most recently created row - which can attribute task A's session ID to task B, or vice versa. Kangentic's per-task worktrees (`git.worktreesEnabled`, default `true`) sidestep this by giving every task its own `cwd`. If you have disabled worktrees and need to run multiple OpenCode tasks against the same project root, either re-enable worktrees in Settings -> Git or stagger the spawns by more than 30 seconds. The Codex CLI parser carries the same caveat. Does not apply to remote-mode sessions (see above).
- **No status.json pipeline:** activity is `hooks_and_pty` - the activity plugin's events are authoritative when they fire, and PTY-silence detection (`PTY_SILENCE_THRESHOLD_MS`, same `PtyActivityTracker` shape as Codex) is the fallback tier for sessions without the plugin (remote mode, failed install). OpenCode has no statusline, so there is no `status.json` pipeline.
- **No trust dialog:** `ensureTrust` is a no-op. OpenCode does not prompt for directory trust on first run.
- **Remote mode is single-directory per project:** the server working directory is per-project, not per-task, so concurrent remote tasks in the same project share one directory. Per-task remote worktrees would require remote git operations (OpenCode's `POST /session/:id/shell` is the mechanism, if pursued later).
