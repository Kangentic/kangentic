---
type: Reference
title: Claude Code
description: Claude Code detection that skips dead npm shims, the merged --settings file with 18 event-bridge hooks and mcp__kangentic allow rules, how every CLI's hook command paths are quoted per shell, and the locked single write to ~/.claude.json for trust and diffSidebarOpen.
tags: [agents, adapter, claude]
sources:
  - resource: src/main/agent/adapters/claude/claude-adapter.ts
  - resource: src/main/agent/adapters/claude/detector.ts
  - resource: src/main/agent/adapters/claude/command-builder.ts
  - resource: src/main/agent/adapters/claude/hook-manager.ts
  - resource: src/main/agent/adapters/claude/trust-manager.ts
  - resource: src/main/agent/adapters/claude/claude-json-lock.ts
  - resource: src/main/agent/adapters/claude/diff-panel.ts
  - resource: src/main/agent/adapters/claude/model-picker-probe.ts
  - resource: src/main/agent/shared/hook-utils.ts
  - resource: src/main/agent/shared/npm-shim-target.ts
---
# Claude Code

## CLI Detection

`src/main/agent/adapters/claude/detector.ts`

On first use, `ClaudeDetector` locates the Claude CLI:

1. If `config.agent.cliPaths.claude` is set, probe that path and use it. A probe failure is
   reported as configured-but-broken rather than falling through, so an explicit override never
   silently resolves to a different binary
2. Otherwise, search `PATH` using the `which` package. Every match is walked in `which` order (on
   Windows the working directory first, then each `PATH` entry by `PATHEXT`), spending at most
   four version probes per name. An npm `.cmd` / `.bat` / `.ps1` shim whose target script is
   missing is skipped without a probe (`src/main/agent/shared/npm-shim-target.ts`) and does not
   spend the budget, so a stale shim in a project root cannot hide the real install
3. If no `PATH` match answered, probe the well-known fallback paths (`~/.claude/local/claude`,
   then the standard Unix install locations). This is the macOS Finder/Dock launch case, where
   Electron did not inherit the shell `PATH`
4. Cache the result for the app lifetime (`invalidateCache()` resets)

Every probe runs `claude --version` with a 5s timeout. A candidate whose output does not parse as
this agent's version format is passed over and the search continues, so another vendor's binary
publishing the same name cannot be reported as Claude.

Returns `{ found: boolean, path: string | null, version: string | null }`.

## Command Building

`src/main/agent/adapters/claude/command-builder.ts`

### New Session

```
claude --settings <mergedSettingsPath> --session-id <uuid> -- "prompt text"
```

- `--session-id <uuid>` creates a new conversation with a known ID (enables resume later)
- `--` separates options from the prompt (prevents prompt content like `--flag` from being parsed as CLI options)
- Prompt has double quotes replaced with single quotes to avoid PowerShell quoting issues

### Resumed Session

```
claude --settings <mergedSettingsPath> --resume <uuid>
```

- `--resume <uuid>` continues an existing conversation
- No prompt is injected - Claude resumes from its saved context

## Permission Modes

| Mode | CLI Flag |
|------|----------|
| `plan` | `--permission-mode plan` |
| `dontAsk` | `--permission-mode dontAsk` |
| `default` | (no mode flag) |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `auto` | `--permission-mode auto` |
| `bypassPermissions` | `--dangerously-skip-permissions` |

Every mode also passes `--settings <path>`, the merged settings file in the session directory, whenever the spawn has a status output path.

A `plan` spawn whose approved plan would continue in `bypassPermissions` (`planApprovalModeForSpawn`) also passes `--allow-dangerously-skip-permissions` (`CommandOptions.bypassAvailable`), so the approval can switch the session to bypass. The flag is a launch option, so bypass stays reachable from that session's own mode cycle for its whole life, even after its column is switched back to Manual. See [`plan-approval-bridge.js`](bridge-scripts.md#plan-approval-bridgejs).

### Permission Mode Resolution (Priority Order)

See [Permission Mode Resolution](../../settings/cascade.md#permission-mode-resolution-priority-order).

## Non-Interactive Mode

When `nonInteractive` is set, `--print` is added. The agent runs, prints output, and exits without waiting for user input.

## Settings Merge

For every session, a merged settings file is built at `.kangentic/sessions/<sessionId>/settings.json` (Kangentic's own session record id, not Claude's session id) and passed via `--settings`. Both project files are read from disk on every spawn, never cached, so a commit, a pull or an edit reaches the next session with no restart:

1. Read `.claude/settings.json` from project root (committed, shared)
2. Lay `.claude/settings.local.json` from project root (gitignored, personal) over it, the way Claude Code combines its own settings files ("lists merge instead of overriding" in Claude's settings docs)
   - Hooks: concatenated per event type (local hooks appended after project hooks)
   - A list key on both sides, at the top level (`enabledMcpjsonServers`) or under `permissions` (`allow`, `deny`, `ask`, `additionalDirectories`), keeps both lists' entries, deduplicated
   - Every other key takes the local value, and every `permissions` key is kept (`defaultMode` included). Nested objects such as `env` are replaced, not merged
3. For worktrees: merge permissions from the worktree's `.claude/settings.local.json`
   - Only permissions are merged (captures "always allow" grants from user)
   - Hooks from the worktree are skipped (may be stale leftovers)
4. Inject `statusLine` config pointing to the status bridge script
5. Inject event-bridge hooks into all registered hook points, plus the plan approval hook (and, when the session's allow rules name another server's MCP tool, its tool approval entry) and, for a task session whose MCP URL names it, the background shell hint hook (see [`plan-approval-bridge.js`](bridge-scripts.md#plan-approval-bridgejs) and [`background-shell-hint-bridge.js`](bridge-scripts.md#background-shell-hint-bridgejs))
6. When the MCP server is attached, append `mcp__kangentic` to `permissions.allow` (append-if-absent) so kangentic's own tools never prompt in default mode. `--permission-mode auto` runs a SEPARATE natural-language classifier that does not honor `permissions.allow`, so a plain-language allow rule (`KANGENTIC_AUTO_MODE_ALLOW_RULE`) is also appended to `autoMode.allow` (seeded with `$defaults` when the array is absent, preserving the classifier's built-in rules) so a board-driven auto-mode session does not soft-deny Kangentic's own board/session tools
7. Write merged file to session directory
8. Pass `--settings <mergedSettingsPath>` to the CLI

All Kangentic artifacts stay in `.kangentic/` - nothing is written to `.claude/settings.local.json`.

## Hook Injection

Kangentic subscribes to 18 Claude Code hook points via the event bridge:

| Hook Event | Event Type | Purpose |
|------------|-----------|---------|
| `PreToolUse` (blank) | `tool_start` | Agent began using a tool. `agent_id`, when the tool ran in an agent of its own, goes to `subagentId`; see [Activity predicate](../../architecture/activity/predicate.md#internal-cli-agents-tools) |
| `PostToolUse` (blank) | `tool_end` | Tool execution completed (remaps to `background_shell_start` when the `tool_response` carries an id-shaped detail: a backgrounded or auto-backgrounded Bash's shell id, or a `Monitor` wait's `taskId`). `agent_id` goes to `subagentId` as on `PreToolUse` |
| `PostToolUseFailure` (blank) | `tool_end` | Tool execution failed (remaps to `interrupted` when `is_interrupt` is true). `agent_id` goes to `subagentId` as on `PreToolUse` |
| `UserPromptSubmit` | `prompt` | User submitted a prompt. Carries `planMode`, whether the payload's `permission_mode` is `plan` (`extractPlanMode`), as `Stop` does; see [Activity Detection](../../architecture/activity/index.md). A Command Terminal's settings also copy the payload's `prompt` into `detail` (capped at the bridge's `FIELD_CAP`, 2000 characters, `capturePromptText`), which is what names the terminal; a task session's events carry no prompt text |
| `Stop` | `idle` | Agent stopped naturally. Carries `planMode`, as `UserPromptSubmit` does, except on a subagent's Stop, which arrives through the same hook with an `agent_id` (`unlessField`). The tool and subagent hooks carry none: a subagent can run in its own mode while the session plans |
| `StopFailure` | `turn_failed` or `turn_retrying` | Fires instead of `Stop` on a service/API error; carries the error type in `detail`. A TERMINAL error stays `turn_failed` (routed through the Interrupted bypass to reset stale counters and idle at once); a TRANSIENT, auto-retried error (overloaded/server_error/rate_limit/api_error) is reclassified to `turn_retrying`, which holds the session thinking through a live retry instead of force-idling it - see [Activity Detection](../../architecture/activity/index.md) |
| `PermissionRequest` | `idle` | Agent hit a permission wall. The payload's `tool_name` goes to `tool`, which is how the plan approval gate tells the plan prompt, and a tool the plan approval hook may answer, from every other one (see [Activity event types](../../architecture/activity/event-types.md#plan-approval-gate)) |
| `SessionStart` | `session_start` | Session began |
| `SessionEnd` | `session_end` | Session ended |
| `SubagentStart` | `subagent_start` | Main agent launched a subagent; `agent_type` goes to `detail` and `agent_id` to `subagentId`. A start for a `subagentId` that is still live takes no second slot - see [Activity Detection](../../architecture/activity/index.md) |
| `SubagentStop` | `subagent_stop` | Subagent finished; same fields. A second stop for a `subagentId` that already stopped is a duplicate the engine ignores - see [Activity Detection](../../architecture/activity/index.md) |
| `Notification` | `notification` | Informational notification |
| `PreCompact` | `compact` | Context compaction starting |
| `TeammateIdle` | `teammate_idle` | Teammate agent went idle |
| `TaskCompleted` | `task_completed` | Task marked complete |
| `ConfigChange` | `config_change` | Configuration changed |
| `WorktreeCreate` | `worktree_create` | Worktree created |
| `WorktreeRemove` | `worktree_remove` | Worktree removed |

All event-bridge hooks use blank matchers (fire for every invocation regardless of tool name). Three hooks carry a matcher: the plan approval hook, a second `PermissionRequest` entry, matcher exactly `ExitPlanMode`, registered on every spawn; the same bridge again on `PermissionRequest`, matcher `mcp__.*`, registered only when the session's allow rules name another server's MCP tool (see [`plan-approval-bridge.js`](bridge-scripts.md#plan-approval-bridgejs)); and the background shell hint, a second `PostToolUse` entry, matcher `Bash|PowerShell`, registered for a session whose MCP URL names it (see [`background-shell-hint-bridge.js`](bridge-scripts.md#background-shell-hint-bridgejs)). See [Activity Detection](../../architecture/activity/index.md) for the full event-to-state mapping and state derivation logic.

### Paths in hook commands

Every hook and status-line command Kangentic writes is `node <bridge> <path>...`, and the agent CLI
hands the whole string to a shell, except Antigravity, which tokenizes hook commands itself (see
[Antigravity](antigravity.md#antigravity)). A path the shell rewrites sends the bridge somewhere else: a
project under a folder named `$client` lost that segment, so the plan approval hook found no
decision file and every activity event went to the wrong file. Each adapter whose bridge command
goes through `quoteBridgePath` declares the shell its
CLI uses on Windows (`HookShell`, `src/main/agent/shared/hook-utils.ts`; Aider and Antigravity are
the exceptions, below), and `quoteBridgePath`
quotes each path for it, through `buildBridgeCommand`, `buildPlanApprovalCommand` and the Claude
and Copilot status-line builders. On macOS and Linux every CLI uses `sh -c` or `bash -c`.

| CLI (version) | Windows hooks | Windows status line | macOS and Linux | Replaces `$NAME` itself | How it was found |
|---|---|---|---|---|---|
| Claude Code 2.1.303 | Git Bash, `bash.exe -c`, when Claude finds Git Bash; otherwise PowerShell, `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` | The same as its hooks | `/bin/sh -c` | No | Git Bash probed; PowerShell from its hooks and status line docs and source |
| Copilot 1.0.98 | `pwsh.exe -nop -nol -c` (the `command` field is copied to `powershell`) | `cmd.exe /d /s /c "<command>"`, verbatim (Node's `shell: true`) | Hooks run the `bash` field; the status line runs `/bin/sh -c` | Not in hooks | Hooks probed; status line read from `cli-main.js` |
| Gemini 0.64.0 | `pwsh.exe -NoProfile -Command`, or powershell.exe with no pwsh | None | `bash -c` | Yes, every settings string (`resolveEnvVarsInString`) | Probed, and read from the bundle |
| grok 1.0.0 | `pwsh -NoProfile -NonInteractive -Command` | None | `sh -c` for a command with shell metacharacters | Yes | Windows probed; POSIX from its hooks guide |
| Qwen Code 0.21.7 | `%ComSpec% /d /s /c <command>`, with escaped arguments; Git Bash `-c` only when Qwen inherits an MSYS `MSYSTEM` | None written | `bash -c` | Yes | Probed on 0.21.7; the same spawn read in the 0.25.2 source |
| Codex 0.163.0 | A sh or PowerShell command line: quotes survive, `%NAME%` stays as written, `$HOME` is expanded | None | Not probed | No | Probed in `exec` and the TUI (task #859). The command is bare tokens anyway, because it sits in a TOML literal string passed through the user's shell |

The probe was a hook that recorded its parent process's command line and the argv it received for a
path holding `$OS`, `${OS}`, `%OS%`, a backtick, `&`, `'`, a space and curly double quotes, quoted
each candidate way, in one real session per CLI.

The adapters declare three shells:

- `sh-or-powershell` (Claude's hooks, plan approval hook and status line; Copilot's hooks; Gemini;
  grok; every CLI on macOS and Linux). Each path is double-quoted, with each run of `$`, backtick,
  `\`, `"` and curly double quote in single quotes between the double-quoted runs:
  `C:"/work/"'$'"client/x.js"`. Characters side by side share one pair (`'$$'`), because PowerShell
  reads `''` inside single quotes as a quote and would hand the bridge `$'$` for `'$''$'`. That one
  form reaches the bridge intact in sh, bash, Git Bash,
  Windows PowerShell 5.1 and pwsh, which is why Claude needs no guess at which of its two shells it
  will get. No `$` is ever followed by a name, so a CLI that replaces `$NAME` first finds nothing.
  The backslash escape this replaced did not survive that: Gemini, Qwen and grok turned `\$OS` into
  `\Windows_NT` on every platform. On Windows the drive, or a UNC path's `//`, stays bare in front,
  because PowerShell ends an argument that opens with a quote at its closing quote. A path with
  none of those characters stays `"path"`.
- `cmd` (Copilot's Windows status line). `%` becomes `"^%"`, as `quoteCmdExecutable` writes it, and
  `$` steps outside the quotes.
- `bare-tokens` (Qwen on Windows). Qwen spawns cmd without verbatim arguments, so each `"` reaches
  node as part of the path, and no quoted path survives, ordinary ones included. The command names
  a copy of the event bridge, `<cwd>/.kangentic/qwen-event-bridge.cjs`, by that relative path
  (Qwen runs hooks in the spawn cwd), and passes `env:KANGENTIC_EVENTS_PATH`, which the bridge
  resolves from the variable every session spawn sets. Bare tokens work in the Git Bash Qwen picks
  under MSYS as well. Before this, Qwen's Windows hooks only fired when Kangentic itself had
  inherited `MSYSTEM`, as it does when started from Git Bash.

Codex's hook commands do not go through `quoteBridgePath`. Each one sits inside a TOML literal
string in a `-c` value that reaches Codex through the user's shell, where `quoteArg` turns a content
`"` into `'` on Windows, so the command is bare tokens on every platform: the workspace copy
`.kangentic/codex-event-bridge.cjs`, `env:KANGENTIC_EVENTS_PATH`, the event type and the base64
directives (`codexHookCommand` refuses anything else).

Aider's notifications command quotes for its own shell (see [Aider](aider.md)), and Antigravity's
hook commands are unquoted by design, because its hook runner keeps quote characters literal.

`tests/unit/event-bridge.test.ts` runs each form through real shells: Git Bash, both PowerShells,
and cmd verbatim and with escaped arguments on Windows; `sh -c` and `bash -c` elsewhere. Each hook
manager's test runs its CLI's real commands, with the real bridges, through that CLI's shells and
checks the file the bridge wrote. Every built command is also checked against Gemini's `$NAME`
pattern (`CLI_ENVIRONMENT_REFERENCE`, `tests/unit/helpers/shell-argv-probe.ts`).
`.github/workflows/shell-quoting-windows.yml` runs the Windows half.

### Hook Identification

A command is a Kangentic hook (`isKangenticHookCommand`) when it names a known bridge (`activity-bridge`, `event-bridge`, `plan-approval-bridge` or `background-shell-hint-bridge`) AND carries one of these markers:
- `.kangentic` or `/kangentic/` in a path (a session directory, a workspace bridge copy, a source checkout, a Windows install)
- the events path named through `env:KANGENTIC_EVENTS_PATH`
- for a `background-shell-hint-bridge` command, a base64 spec that names `kangentic_mark_background_service`
- the exact path the running app ships that bridge at

The first three hold wherever the app is installed, so they also catch a hook an earlier install wrote from another path. Requiring a bridge name plus a marker prevents false positives on user-defined hooks with similar names. The `activity-bridge` check is for backwards compatibility with older session directories - the current bridge scripts are `event-bridge`, `plan-approval-bridge` and `background-shell-hint-bridge`.

### Hook Cleanup

`stripKangenticHooks()` in `hook-manager.ts` removes all Kangentic hooks from `.claude/settings.local.json` on project close or delete. This is a backward-compatibility function - the unified `--settings` approach means Kangentic no longer writes hooks to `settings.local.json`, but older worktrees may still have them.

Safety guarantees:
- Backs up the original file before modification
- Validates JSON integrity before writing
- Restores from backup on any error
- Deletes empty settings files and `.claude/` directories

## Global Config Writes (`~/.claude.json`)

`ClaudeAdapter.ensureTrust()` runs before every Claude spawn - both task chokepoints and the Command Terminal (`transient-sessions.ts`) - and makes one read-modify-write of the global `~/.claude.json` (see Trust Management below), serialized through one lock (`withClaudeJsonLock`, `src/main/agent/adapters/claude/claude-json-lock.ts`), which project relocation's key rewrite also takes. Two tests pin that, because one cannot cover both halves: `tests/unit/spawn-entry-point-parity.test.ts` scans every path that builds an agent command and proves the call appears first (line order, all paths), and `tests/unit/transient-session-spawn-ensure-trust.test.ts` drives the Command Terminal handler and proves the runtime contract there (awaited, called once, with the project root, resolving before `buildCommand`).

The lock has two layers. An in-process promise chain serializes Kangentic's own writers. Around it, every operation takes Claude's own `~/.claude.json.lock` (proper-lockfile semantics: a `mkdir` directory, stale after 10 s), because the CLI writes the same file from every running session and one of those writes withdraws the fullscreen boot canary (`fullscreenBootPending[pid]`) on a graceful exit; a Kangentic write that read before that withdrawal and wrote after it resurrects the record, and a dead pid found at the next launch is a strike against the fullscreen renderer. Each writer reads INSIDE the lock. A lock still held after the 12 s budget (which outlasts the stale window, so an abandoned lock is always broken first) makes the writer skip its write and warn, the CLI's own policy on a final `ELOCKED`. `tests/unit/claude-json-lock.test.ts` pins the acquire, the wait, the stale break, and the skip; the rule is `.claude/rules/pty-teardown-grace.md`.

The `/model` picker probe (`model-picker-probe.ts`) is the one other Claude process the adapter spawns. It runs on the classic renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`), which never arms that canary, and exits the CLI with `/exit`, waiting on the PTY's own exit before the fallback kill. A run that never got `/model` into the input box (a dialog showed, or it timed out) types nothing more, not even Esc, and is killed outright, and so is a run whose Enter opened a dialog instead of the picker; the classic renderer leaves no canary record to strand.

### Trust Management

`src/main/agent/adapters/claude/trust-manager.ts`

Before every spawn, `ClaudeAdapter.ensureTrust()` calls `ensureClaudeSpawnConfig()`, which makes ONE read-modify-write of `~/.claude.json` under the lock (it used to be three passes per spawn, each parsing and rewriting a file that runs to 1.5 MB):

1. Read `~/.claude.json` asynchronously (a missing file starts from an empty object; a file that exists but does not parse as a JSON object is left untouched, since it holds the user's auth and MCP state, and the session shows a trust prompt instead)
2. Trust the working directory: a `projects` entry with `hasTrustDialogAccepted: true`, copying `enabledMcpjsonServers` from the parent project entry for a worktree (MCP server inheritance)
3. Append `kangentic` to the entry's `enabledMcpjsonServers` (append-if-absent) so the Kangentic MCP server is enabled without a prompt
4. Set `diffSidebarOpen: false` (see Diff Panel below)
5. Write once, asynchronously and atomically (temp file + rename), only when something changed

A rename still refused after its retries (the file held open, usually on Windows) falls back to an in-place write. When that write fails too and leaves the file short, the temp file is the one complete copy, so it is kept and named in the thrown error; when the file still parses, nothing is kept. The first whole write of a run removes copies an earlier failed write kept, and so does the first whole write after a failed write keeps one.

`ensureWorktreeTrust()` and `ensureMcpServerTrust()` remain for callers that need one change alone (the model-picker probe trusts its scratch directory). They share the same reader and writer, so they also leave a file that does not parse untouched and write through a temp file.

### Diff Panel

`src/main/agent/adapters/claude/diff-panel.ts`

Claude Code 2.1.260 opens a diff panel beside the conversation in the fullscreen renderer whenever the terminal is wide enough: the gate is `columns >= 144` when the global `diffSidebarOpen` key is unset, `>= 110` when it is `true`, and never when it is `false`. The panel takes the right `min(floor(columns * 0.45), 90, columns - 70)` columns and shares physical rows with the transcript, so every line-oriented scrollback parse reads the two panes spliced together, and it duplicates the task window's Changes tab.

The key lives only in `~/.claude.json` (the same key list as `theme` and `diffTool`); it is not a settings.json key, so the per-session `--settings` file cannot carry it, and there is no CLI flag or env var. The spawn's one pass (`ensureClaudeSpawnConfig()`, applying `applyDiffPanelClosed()`) therefore writes `diffSidebarOpen: false` before every spawn:

- Idempotent: an already-`false` key costs one read and no write.
- Per spawn, not once: the key is remembered-last-state in one global slot, and any session that opens the panel (`/diff`) writes `true`, which would otherwise auto-open it in every later Kangentic session.
- Atomic (temp file + rename, no backup copy), and an unreadable file is left untouched rather than replaced, since the file holds the user's auth and MCP state.
- The CLI applies the value it read at startup: a session spawned with the key `false` stays closed even if another session flips the key to `true` later (verified with a completed turn at 210 columns), so the write covers the session's whole lifetime.
- `/diff` inside a session still opens the panel for that session (that path checks only the git cwd and `columns >= 110`), so it is the per-session opt-in. Turning fullscreen off (`tui: "default"`) would also remove the panel but reintroduces the scrollback duplication fullscreen exists to fix, so it is not used.
