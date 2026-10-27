---
type: Reference
title: Qwen Code
description: Qwen Code, a gemini-cli fork with Claude-style hook names, and why Kangentic's MCP server goes in through --mcp-config to avoid the Untrusted MCP server dialog, bare-token Windows hooks, caller-owned --session-id, trust writes gated on folderTrust and the ~/.qwen/projects chat history.
tags: [agents, adapter, qwen-code]
sources:
  - resource: src/main/agent/adapters/qwen-code/qwen-adapter.ts
  - resource: src/main/agent/adapters/qwen-code/detector.ts
  - resource: src/main/agent/adapters/qwen-code/command-builder.ts
  - resource: src/main/agent/adapters/qwen-code/hook-manager.ts
  - resource: src/main/agent/adapters/qwen-code/trust-manager.ts
  - resource: src/main/agent/adapters/qwen-code/qwen-home.ts
  - resource: src/main/agent/adapters/qwen-code/session-history-parser.ts
---
# Qwen Code

Qwen Code (https://github.com/QwenLM/qwen-code) is a soft fork of Google's gemini-cli published by the Alibaba Qwen team. The Kangentic adapter mirrors the Gemini adapter in shape (a shared `.qwen/settings.json`, the same TUI behavior), but Qwen replaced Gemini's hook system with Claude Code's event names and payloads, and moved its session files.

## CLI Detection

`src/main/agent/adapters/qwen-code/detector.ts`

Detection follows the standard pattern: check `config.agent.cliPaths.qwen`, fall back to `PATH` via `which`, run `qwen --version`. Version output is the raw version string with no product-name prefix or suffix (inherited from gemini-cli), so `parseVersion` is identity.

## Command Building

`src/main/agent/adapters/qwen-code/command-builder.ts`

### New Session

```
qwen --approval-mode <mode> --session-id <uuid> "prompt text"
```

Kangentic generates a UUID up front and passes it via `--session-id`, mirroring Claude. Qwen 0.15.3+ honors caller-owned UUIDs and writes its session JSONL at exactly `<our-uuid>.jsonl`.

### Resumed Session

```
qwen --resume <sessionId>
```

`--session-id` and `--resume` are mutually exclusive (yargs enforces). The command builder picks the correct flag based on the `resume` option.

## Permission Modes

| Mode | Flag | Qwen Mode |
|------|------|-----------|
| `plan` / `dontAsk` | `--approval-mode plan` | Plan (Read-Only Research) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` / `auto` | `--approval-mode auto-edit` | Auto Edit (Auto-Approve Edits) |
| `bypassPermissions` | `--approval-mode yolo` | YOLO (Auto-Approve All) |

The fork swapped Gemini's `auto_edit` (underscore) flag value for `auto-edit` (hyphen). The unit tests guard against the underscore form regressing.

## Hooks

`src/main/agent/adapters/qwen-code/hook-manager.ts`

Qwen's `HookEventName` uses Claude Code's names (read from the 0.21.7 and 0.24.0 bundles, and the
same in upstream v0.12.0 and v0.15.3), and Qwen skips any other key with an "Invalid hook event
name" warning. The adapter wrote Gemini's names before plan approval shipped, so on those versions only
SessionStart, SessionEnd and Notification ever fired. Each event now maps as Claude's does:

| Qwen event | Kangentic event |
|------------|-----------------|
| `PreToolUse` | `tool_start` (tool, `tool_use_id`, file path or command) |
| `PostToolUse` | `tool_end` (fires only for a result with no error) |
| `PostToolUseFailure` | `tool_end`, or `interrupted` when `is_interrupt` is true |
| `UserPromptSubmit` / `Stop` | `prompt` / `idle`, both with the session's plan mode |
| `StopFailure` | `turn_failed` (an API error or loop detection ended the turn) |
| `PermissionRequest` | `idle` with detail `permission`, naming the tool |
| `SubagentStart` / `SubagentStop` | `subagent_start` / `subagent_stop`, with `agent_type` in `detail` and `agent_id` as the subagent id |
| `PreCompact` | `compact` |
| `Notification`, `SessionStart`, `SessionEnd` | the same-named events |

A live 0.25.2 session fires `PreToolUse` and then `PermissionRequest`, the same order as Claude. A
subagent fires no `UserPromptSubmit` or `Stop`, in the foreground or the background. It fires
`SubagentStart`, `SubagentStop` and its own tool events, which carry `agent_id`. A background
subagent keeps working after the main agent's `Stop`, so the engine needs the subagent count: before
the two were wired, that `Stop` reported a turn end and ran the column's On agent turn end
automations while the subagent still worked. The captured payloads are in
`tests/fixtures/qwen-hooks/`, and `activity-engine-turn-ended.test.ts` replays the whole session
through the real wiring. Gemini's `BeforeModel`, `AfterModel` and `BeforeToolSelection` have no
Qwen equivalent and are not wired. `buildHooks` and `removeHooks` strip Kangentic entries from
every key, so a settings file an older build left with Gemini-named entries is cleaned on the next
spawn or session exit.

## Plan exit

A plan column's task moves to its After Plan Mode target when Qwen's plan is approved, as a Claude
task does. `exit_plan_mode` also fires `PostToolUse` with no error for a plan it did not act on
("Plan execution was not approved. Remaining in plan mode." or a stale approval), so the
`PostToolUse` hook carries a `setToolWhen` directive that reports it as `ExitPlanMode` only when
`tool_response.llmContent` starts with "User approved." Qwen's own approved-prefix list also holds
"Leader approved.", which is left out on purpose: only a plan-required teammate's plan, approved
by the session's agent, produces it, and the session is still planning. A rejection in the dialog
never runs the tool, so it fires no `PostToolUse`.

Qwen does not declare `supportsPlanAutoApproval`. Its scheduler ignores a hook's allow for a tool
that requires user interaction, which the plan prompt does, so no hook can answer it.

## Settings Merge

Qwen Code reads settings from `.qwen/settings.json` in the project directory. Like Gemini it has no `--settings` flag, so Kangentic writes merged settings (with event-bridge hooks) directly to `.qwen/settings.json` in the CWD. Concurrent sessions in the same folder are serialized by per-session holds in `QwenAdapter.hookHolds`, identical to the Gemini implementation. As with Gemini, the project root's file is read on every spawn with Kangentic's own hooks and `mcpServers.kangentic` entry stripped (`stripKangenticEntries`), so an edit reaches the next session and the previous spawn's entries never become the baseline. When Kangentic creates the file the builder seeds `.qwen/settings.json` and `.kangentic/` into `.git/info/exclude` (created-by-us carve-out: a pre-existing user file keeps its git visibility).

On Windows the hook commands carry bare tokens only: `node .kangentic/qwen-event-bridge.cjs env:KANGENTIC_EVENTS_PATH <type> ...`. Qwen's Windows hook runner hands cmd an escaped command line that no quoted path survives, and a bare token also survives the Git Bash it uses under MSYS. The builder checks the bridge copy in `<cwd>/.kangentic/` on every spawn and rewrites it only when its bytes differ from the app's bridge (after an app update, for example). A spawn that finds an identical copy leaves it alone, a hook already running keeps the copy it loaded, and the events path comes from each session's own environment, so concurrent sessions in one folder each write to their own file. See [Paths in hook commands](claude-code.md#paths-in-hook-commands).

## Kangentic MCP server and the approval gate

Qwen 0.20 and later hold MCP servers from two sources behind an "Untrusted MCP server" dialog: the
folder's `.qwen/settings.json` (Qwen tags them scope `workspace`) and `.mcp.json` (scope
`project`). An approval is recorded in `~/.qwen/mcpApprovals.json` under the folder, the server
name, and a hash of the server's exact config, so a change to the config asks again. Read from the
0.24.0 and 0.25.2 bundles: `useMcpApproval` filters on `isGatedMcpScope`, `--approval-mode yolo`
skips the gate, and user-level and system settings are not gated.

Kangentic's entry changes its URL and token every spawn, so an approval never matched and every
board-driven session stopped on the dialog. The builder now writes the entry (`httpUrl` plus the
`X-Kangentic-Token` header) to `<sessionDir>/mcp.json` and passes `--mcp-config <path>`. Servers
from that flag carry no scope, so the gate never sees them, and Qwen merges them last, so they also
replace a same-named entry in any settings file. The path goes on the command line, never inline
JSON, so the token stays out of argv. `.qwen/settings.json` no longer carries a `kangentic` entry,
and the builder drops a stale one an older build or a crash left in the baseline. Your own servers
in `.mcp.json` or `.qwen/settings.json` still ask for approval, which is Qwen's decision to put to
you, not Kangentic's.

`--mcp-config` arrived in Qwen 0.16.0, and Qwen rejects unknown flags, so a detected version before
0.16 falls back to the old `mcpServers.kangentic` entry in `.qwen/settings.json` (those versions
have no gate). That copy holds the token in plaintext in a file users may commit; `removeHooks`
strips it when the folder's last session ends. An undetected version takes the flag.

## Trust

`src/main/agent/adapters/qwen-code/trust-manager.ts`

Qwen inherits Gemini's folder-trust store: `~/.qwen/trustedFolders.json` maps absolute forward-slashed paths to `TRUST_FOLDER`, `TRUST_PARENT`, or `DO_NOT_TRUST`. Kangentic only ever writes `TRUST_FOLDER`; the other two are user decisions it detects and leaves alone.

Every `~/.qwen` path on this page is Qwen's global directory, `$QWEN_HOME` when set (`qwenHomeDir`, `qwen-home.ts`), the variable Qwen's settings docs name for moving it. The trust write and removal, the chats, the model scan and the relocation pass all use it, so Kangentic writes trust where Qwen reads it. A leading `~` is expanded. A relative value is left out: Qwen resolves one against its own working directory, which a global reader does not have.

Two things differ from the Gemini implementation:

- The write is gated on `security.folderTrust.enabled` in `~/.qwen/settings.json`. With that flag unset (the upstream default) Qwen implicitly trusts every folder, so `ensureTrust` writes nothing rather than cluttering the user's home directory. Gemini has no such gate, because 0.54.4 enforces trust with the flag unset.
- There is no ancestor check. Gemini skips the write when an already-trusted ancestor covers the path; Qwen records one key for every worktree it spawns into. Those keys are redundant, not load-bearing: `LoadedTrustedFolders.isPathTrusted` in qwen-code 0.21.7 matches a `TRUST_FOLDER` rule with a containment test (`isWithinRoot`), so a trusted project root already trusts every worktree beneath it. Porting Gemini's `hasTrustedAncestor` skip would remove the accumulation at its source rather than reaping it afterwards.

Qwen's `DO_NOT_TRUST` is the mirror image and is worth knowing before copying more of Gemini's logic here: the same function matches a deny with raw string equality, so it applies to the exact path only and never cascades. The trusted loop also runs first and returns early, so a covering `TRUST_FOLDER` beats an exact-path deny. Kangentic's write honors a `DO_NOT_TRUST` recorded at the worktree path itself, which is the only place the CLI would have honored one either. Both are exact string lookups against the canonical forward-slash key, so a deny stored under a different separator style is invisible to Kangentic's write and to the CLI alike. Removal is deliberately the asymmetric one: it matches on the resolved location, so it reaps a `TRUST_FOLDER` key whatever separators it was stored with.

The second difference is what makes cleanup load-bearing here. `QwenAdapter.onWorktreeRemoved` calls `removeWorktreeTrust` when Kangentic deletes a worktree, or the file grows by one dead path per task forever (the accumulation that reached 473 entries in Codex's `config.toml`). Removal diverges from the write in two deliberate ways. It is NOT gated on `security.folderTrust.enabled`: that flag lives in a separate file the user and the CLI both edit, so gating on it would leak every entry a user wrote before turning folder trust back off. And it never throws, because by the time it runs the worktree is gone and a failed write only leaves a stale entry, so it goes through `atomicWriteFileWithBackup` (temp file plus rename, `.kangentic-backup`) which logs and returns false instead. Matching is on the resolved location rather than the raw key, since the relocation pass and Qwen's own CLI both write keys and the file ends up holding mixed separator styles. Only a `TRUST_FOLDER` entry is taken, so a `TRUST_PARENT` or `DO_NOT_TRUST` at that path survives the directory and a later worktree there still honors it.

## Session History

Native chat session JSONL file:

```
~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
```

`<sanitized-cwd>` is the cwd lowercased (on Windows) with every non-alphanumeric character replaced
by `-`, so `C:\Users\dev\proj` becomes `c--users-dev-proj`. The filename is exactly the session UUID
with no prefix or timestamp, and since Kangentic supplies that UUID via `--session-id`, `locate()`
is direct path construction rather than a directory scan.

Verified against Qwen Code 0.15.3 on disk. Qwen is a gemini-cli fork but moved chat persistence
entirely: it does NOT use Gemini's `~/.gemini/tmp/<basename>/chats/session-<timestamp><shortId>.json`
layout. See the note at the top of `qwen-code/session-history-parser.ts`.

The parser walks the `messages[]` array backwards to find the most recent assistant message and reads its `model` + `tokens` fields. Both `type: 'qwen'` (rebranded build) and `type: 'gemini'` (some forks retain the upstream literal) are accepted.

Context window size is read straight off the event: Qwen records a real `contextWindowSize` on every assistant event, so there is no lookup table to maintain. A missing field (older builds) falls through to the `0` sentinel, and the renderer hides the progress bar and shows only the model name.

## WSL

A Qwen installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Qwen's Linux path in a `wsl -d <distro>` shell. Its `.qwen/settings.json` hooks call the WSL hook transport's script (`wsl-hook.sh event <type> <directives>`) in place of the node bridge, with the same events and directives, since a distro may have no node, and the background shell hint goes through the transport's `reply`. The file is shared by every session in the folder, so the commands name the folder's copy of the script, `<cwd>/.kangentic/qwen-wsl-hook.sh`, which finds the session's own folder through `KANGENTIC_WSL_HOOK_DIR`. Naming one session's script would break every other session's hooks once that session's folder was removed. Qwen passes each hook its payload on stdin and closes it, which the script's `event` mode reads, so these commands keep stdin (unlike Aider's notification command). `--mcp-config` names the session's `mcp.json` in the distro's form. On mirrored networking the distro reaches this machine's loopback and the entry is the `httpUrl` one. On NAT networking it is the transport's stdio bridge, `{"command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": <token>}}`, in the same session file. Trust, the chats and the model scan read the distro's Qwen directory (its own `QWEN_HOME`, else `~/.qwen`), keyed by the `/mnt` cwd with Linux case, so the slug keeps capitals. A removed worktree's trust entry goes from the distro's file while the distro runs. `--help`, a title summary and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Qwen installed in a distro: the `qwen` on this machine's Ubuntu is the Windows one through interop.

## Session ID Capture

Caller-owned via `--session-id <uuid>`, mirroring Claude. `supportsCallerSessionId` is `true`. Empirically verified against Qwen 0.15.3: real qwen accepts a UUID and writes its JSONL at exactly `~/.qwen/projects/<sanitized-cwd>/chats/<our-uuid>.jsonl`. `--session-id` and `--resume` are mutex (yargs enforces). The runtime keeps `fromHook` and `fromOutput` capture paths as belt-and-suspenders for forks that pre-empt the caller's UUID.

## Limitations / Out of Scope

- **No statusLine telemetry:** Qwen Code (like Gemini) has no `status.json` token-streaming feature, so context window % is sourced from the session history file rather than a real-time hook.
- **OpenAI gpt-5 family unsupported (upstream bug):** Qwen Code 0.15.3's bundled `cli.js` sends `max_tokens` in OpenAI requests and never `max_completion_tokens`. OpenAI's gpt-5 family (e.g. gpt-5, gpt-5-mini, gpt-5-nano, gpt-5.1, and any gpt-5.x / gpt-5.x-codex variant) requires `max_completion_tokens` and rejects `max_tokens` with HTTP 400. Picking any gpt-5 variant via `/model` in the Qwen TUI surfaces `[API Error: 400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.]`. Workarounds until upstream patches: stay on the gpt-4.1 family for OpenAI, or use the Anthropic provider (Opus 4.7, Sonnet 4.6, Haiku 4.5) which is fully supported. Kangentic cannot work around this - the adapter is a pure CLI wrapper with no request-parameter interception. Tracked upstream at https://github.com/QwenLM/qwen-code (search issues for `max_completion_tokens`).
