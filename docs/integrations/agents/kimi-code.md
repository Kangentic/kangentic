---
type: Reference
title: Kimi Code
description: Kimi Code, installed with uv, with caller-owned --session and --continue, session ids from the welcome banner or a scan of the md5-of-cwd folder, wire.jsonl session history under ~/.kimi/sessions parsed into activity events, --plan and --yolo modes, and an auth probe of ~/.kimi/credentials.
tags: [agents, adapter, kimi]
sources:
  - resource: src/main/agent/adapters/kimi/kimi-adapter.ts
  - resource: src/main/agent/adapters/kimi/command-builder.ts
  - resource: src/main/agent/adapters/kimi/session-history-parser.ts
  - resource: src/main/agent/adapters/kimi/wire-parser.ts
  - resource: src/main/agent/adapters/kimi/work-dir-hash.ts
---
# Kimi Code

## CLI Detection

`src/main/agent/adapters/kimi/kimi-adapter.ts`

Kimi is a Python tool installed via `uv tool install kimi-cli` (the upstream installer at `code.kimi.com/install.sh`). Both `kimi` and `kimi-cli` PATH entries map to the same `src/kimi_cli:__main__` entry point. Detection uses `AgentDetector` with a `kimi --version` probe (output format: `kimi, version 1.37.0`). Fallback paths cover the uv-tool prefix on macOS/Linux (`~/.local/share/uv/tools/kimi-cli/bin/kimi`) and Windows (`%APPDATA%\uv\tools\kimi-cli\Scripts\kimi.exe` and `%LOCALAPPDATA%` equivalent).

## Command Building

`src/main/agent/adapters/kimi/command-builder.ts`

```
kimi -w <cwd> [--session <uuid> | --continue] [--plan|--yolo] [--print --output-format stream-json] [--mcp-config-file <sessionDir>/mcp.json] [--prompt "<text>"]
```

Flag mapping (verified empirically with kimi v1.37.0):

| PermissionMode | Kimi flag |
|----------------|-----------|
| `plan` | `--plan` |
| `bypassPermissions` | `--yolo` |
| `default` / `acceptEdits` / `dontAsk` / `auto` | (no flag - interactive confirms) |

- `-w <cwd>` always passed; the path is forward-slashed so PowerShell and bash both parse it correctly.
- `--session <uuid>` is used for both *create* (caller-owned UUID) and *resume*. Kimi's `Session.create(work_dir, session_id="...")` SDK API maps to the same flag, so we set `supportsCallerSessionId = true` and own the ID end-to-end.
- `--continue` is emitted when the builder's `useContinueFallback` option is set and no `sessionId` is supplied. It tells Kimi to resume the most recent session for `cwd`, covering three cases: recovering after a lost DB record, attaching to a session started by a manual `kimi` invocation in the same `work_dir`, or driving a "Resume last session" UI affordance from the command-terminal overlay. Precedence: when both `sessionId` and `useContinueFallback` are provided, the explicit `--session <uuid>` always wins.
- `--prompt <text>` carries the prompt on a new session and on a resume (`--session <uuid> --prompt "..."`, `resumePromptDelivery: 'command-line'`). `kimi --help` calls it "User prompt to the agent", and only `--print` is non-interactive, so the session stays interactive. Quoting follows the same shell-safe rules as the other adapters.
- `--mcp-config-file <sessionDir>/mcp.json` is passed when `mcpServerEnabled` is true; the file is a minimal fastmcp-compatible config naming Kangentic's HTTP MCP server with the `X-Kangentic-Token` header. With no token the wiring is skipped (the server refuses every request without it), as Codex does.

## Session ID Capture

Two PTY regex anchors plus a filesystem fallback:

1. **Welcome banner**: `Session: <uuid>` printed in the cyan startup box (interactive and `--print`).
2. **Print-mode exit**: `To resume this session: kimi -r <uuid>` written to stderr at session end.
3. **Filesystem fallback**: `runtime.sessionId.fromFilesystem` scans this spawn's own work_dir directory - `~/.kimi/sessions/<md5(cwd)>/` (and its `<kaos>_<md5(cwd)>` variant) - for UUID directories whose mtime is within ±30s of the spawn time, returning the newest. Scoping to the spawn's own work_dir hash (rather than globbing every hash dir) keeps a concurrent Kimi session in another work_dir, or a `-w`-less probe's stray session, from winning the recency race and poisoning the captured id.

## Session History

`src/main/agent/adapters/kimi/session-history-parser.ts` + `wire-parser.ts`

Kimi writes `wire.jsonl` to `~/.kimi/sessions/<work_dir_hash>/<sessionId>/` on every spawn (interactive or `--print`). The work_dir hash is `md5(absolute work_dir)`. The history locator (`locate()`, given a known session UUID) globs across all hash dirs and matches on the UUID, so it is robust to the same directory opened under different paths. This differs from the capture fallback above, which has no known UUID and so is scoped to the spawn's own work_dir hash to avoid mis-attributing another work_dir's session.

The file is append-only (resume via `-r <uuid>` appends new `TurnBegin` / `TurnEnd` lines). Format:

```jsonl
{"type": "metadata", "protocol_version": "1.9"}
{"timestamp": <unix_seconds>, "message": {"type": "<EventName>", "payload": {...}}}
```

Kimi's activity is `hooks_and_pty` with wire.jsonl as the structured source: the first wire read turns the PTY tracker off, and the PTY silence timer and prompt regex cover only the gap before it. Measured in the interactive TUI on 1.37.0, every record reached the file 13 to 40 ms after its own timestamp. A turn end, an interrupt and a permission wait are events, not forced activity ("released" below): a forced idle runs the engine's `forceIdle`, which ends no turn for On agent turn end automations and clears every background task the session holds.

Every documented wire-protocol message type (19 Events + 4 Requests, wire protocol v1.9) is parsed, plus `Notification` for background tasks:

**Events**

| Wire event | Activity | SessionEvent |
|------------|----------|--------------|
| `TurnBegin` | → Thinking | `Prompt` (detail = extracted user_input text) |
| `TurnEnd` | (released) | `Idle` |
| `StepBegin` | → Thinking | (none) |
| `StepInterrupted` | (released) | `Interrupted` |
| `CompactionBegin` | → Thinking | `Compact` |
| `CompactionEnd` | (preserve) | (none) |
| `StatusUpdate` | (preserve) | (none; updates SessionUsage) |
| `ContentPart` | (preserve) | (none; streaming text fragment) |
| `ToolCall` | (preserve) | `ToolStart` (`toolId` = the call id; detail = the command for `Shell`, else the tool name) |
| `ToolCallPart` | (preserve) | (none; argument-streaming fragment) |
| `ToolResult` | (preserve) | `ToolEnd` (`toolId`; detail = `ok` or `error`). A `Shell` background launch (message "Background task started." with a `background_task` display block) is a `BackgroundShellStart` with the task id instead, which closes its pending tool by `toolId`; a `TaskStop` result ("Task stop requested.") adds a `BackgroundShellEnd` |
| `Notification` | (preserve) | `BackgroundShellEnd` for a `task.*` notification whose `source_kind` is `background_task` (detail = `source_id`); others emit nothing |
| `ApprovalResponse` | → Thinking | `Notification` (detail = response) |
| `SubagentEvent` | (preserve) | `SubagentStart` (inner `TurnBegin`) / `SubagentStop` (inner `TurnEnd`) / `Notification` (other inner types). detail = `subagent_type` \|\| `agent_id` \|\| `subagent` |
| `BtwBegin` | (preserve) | `SubagentStart` (detail = `btw`) |
| `BtwEnd` | (preserve) | `SubagentStop` (detail = `btw`) |
| `SteerInput` | → Thinking | `Prompt` (detail = extracted user_input text) |
| `PlanDisplay` | (preserve) | `Notification` (detail = file_path) |
| `HookTriggered` | (preserve) | `Notification` (detail = `<event>:<target>`) |
| `HookResolved` | (preserve) | `Notification` (detail = `<event>:<action> (<reason>)`) |

**Requests** (Wire protocol uses JSON-RPC 2.0; the parser is a passive observer that surfaces requests as activity-state telemetry):

| Wire request | Activity | SessionEvent |
|--------------|----------|--------------|
| `ApprovalRequest` | (released) | `Idle` (detail = `IdleReason.Permission`) |
| `ToolCallRequest` | (preserve) | `ToolStart` (detail = `name`) |
| `QuestionRequest` | (released) | `Idle` (detail = `IdleReason.Permission`) |
| `HookRequest` | (preserve) | `Notification` (detail = `<event>:<target>[: <summary>]`, summary derived from `input_data` and capped at 200 chars) |

The parser uses an exhaustive `switch` over a `KIMI_DISPATCH_TYPES` literal union, so a future protocol bump that adds a new type produces a TS exhaustiveness error at compile time. `user_input` (TurnBegin / SteerInput) accepts both `string` and `ContentPart[]`; the parser extracts `TextPart.text` from arrays and ignores think/media parts.

## Permission Modes

Kimi exposes only two permission flags. The adapter surfaces three modes:

| Mode | Kimi behavior |
|------|---------------|
| `plan` | Read-only (`--plan`) |
| `default` | Interactive confirmation per action (no flag) |
| `bypassPermissions` | Auto-approve all (`--yolo`) |

## Authentication

`KimiAdapter.probeAuth(cliPath)` ignores the detected path and checks for `~/.kimi/credentials/` (the OAuth state directory written by `kimi login`). The probe is invoked by the `IPC.AGENT_LIST` handler after `detect()` reports `found: true` and surfaces a tristate field `authenticated: true | false | null` on `AgentDetectionInfo`:

- `true` - credentials directory exists and is non-empty
- `false` - directory missing or empty (user has not run `kimi login`)
- `null` - I/O error or probe not implemented

The renderer surfaces the `false` state two ways: an amber `DetectionCard` variant on the welcome-screen agent grid (with a "Copy `kimi login`" clipboard button), and an amber pill plus inline hint in Settings -> Agent. Refreshing the agent list (welcome-screen Refresh, Settings re-detect button, or reopening the settings panel) re-runs the probe and clears the warning once the user has logged in.

Filesystem check chosen over a `kimi info` subprocess: the probe runs on every `AGENT_LIST` call alongside the existing `--version` probes, and a single sub-millisecond `fs.readdirSync` (with ENOENT mapped to `false`) keeps the refresh latency unchanged. An expired-token false-positive (credentials present but not valid) still falls through to today's behavior - the spawned session prints "LLM not set" and exits.

`probeAuth?()` is an optional method on the `AgentAdapter` interface; Kimi and Grok implement it today (Grok via `grok models` output, see [Grok Build](grok-build.md#grok-build)). Other adapters return `undefined` for the `authenticated` field, which the renderer treats as "not applicable".

## Limitations

- No hook injection (Kimi reads `~/.kimi/config.toml` `hooks = []` but has no per-project settings file equivalent we can write to)
- No trust dialog (`ensureTrust` is a no-op)
- We do not initiate the OAuth flow on the user's behalf - see Authentication above for how the unauthenticated state is detected and surfaced
- No WSL support. A Kimi path into a WSL distro shows "No WSL support" (#286). This adapter is built and measured on the `kimi-cli` 1.x layout above (`~/.kimi`). Kimi Code CLI, its successor, also installs as `kimi` but is a different CLI: its data root is `$KIMI_CODE_HOME` or `~/.kimi-code`, with sessions under `wd_<slug>_<sha256 prefix>` folders and `agents/main/wire.jsonl`. It has no `-w` flag and no `--mcp-config-file` (MCP comes only from `mcp.json` files). Its `--prompt` runs one prompt without the TUI, and `--session <id>` only resumes, so a caller cannot choose a new session's id. Support for a distro install waits on an adapter for that CLI, and a Kimi Code install on this machine does not work with this adapter either.
