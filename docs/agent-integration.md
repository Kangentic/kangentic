# Agent Integration

Kangentic supports seven AI coding agents: Claude Code, Codex CLI, Gemini CLI, Cursor CLI, GitHub Copilot CLI, Aider, and Oz CLI (Warp). Each agent is wrapped behind a common `AgentAdapter` interface that handles CLI detection, command building, permission mapping, session lifecycle hooks, and cross-agent handoff. This doc covers the adapter system, agent-specific details, and shared infrastructure.

## Agent Adapter Interface

`src/main/agent/agent-adapter.ts`

Every agent implements the `AgentAdapter` interface. Each adapter lives in `src/main/agent/adapters/<name>/`. TUI agents also have a `transcript-cleanup.ts` file for handoff transcript processing (see [Handoff - Per-Agent Transcript Cleanup](handoff.md#per-agent-transcript-cleanup)).

| Method | Purpose |
|--------|---------|
| `detect(overridePath?)` | Locate the CLI binary and return path + version |
| `invalidateDetectionCache()` | Reset cached detection (e.g. after user changes CLI path) |
| `ensureTrust(workingDirectory)` | Pre-approve a directory so the agent doesn't prompt for trust |
| `buildCommand(options)` | Build the shell command string to spawn the agent |
| `interpolateTemplate(template, variables)` | Replace `{{key}}` placeholders in prompt templates |
| `runtime` | `AdapterRuntimeStrategy` declaring activity detection + session ID capture (see below) |
| `removeHooks(directory, taskId?)` | Remove monitoring hooks on cleanup. `taskId` lets shared-file adapters (Codex, Gemini) reference-count so concurrent sessions do not clobber each other's hooks. |
| `clearSettingsCache()` | Clear cached merged settings |
| `detectFirstOutput(data)` | Detect when the agent TUI is ready (lifts shimmer overlay) |
| `getExitSequence()` | Return PTY write sequence for graceful exit |
| `locateSessionHistoryFile(agentSessionId, cwd)` | Locate the agent's native session history file on disk |

### Required Properties

| Property | Type | Purpose |
|----------|------|---------|
| `name` | `string` | Unique identifier (`'claude'`, `'codex'`, `'gemini'`, `'cursor'`, `'copilot'`, `'aider'`, `'warp'`) |
| `displayName` | `string` | Human-readable product name |
| `sessionType` | `SessionRecord['session_type']` | Value stored in the sessions DB table |
| `supportsCallerSessionId` | `boolean` | True when the CLI accepts a caller-supplied session ID via `--session-id` (Claude). When false, Kangentic captures the agent's own ID via `runtime.sessionId` for `--resume`. |
| `permissions` | `AgentPermissionEntry[]` | Supported permission modes with agent-specific labels |
| `defaultPermission` | `PermissionMode` | Recommended default permission mode |
| `runtime` | `AdapterRuntimeStrategy` | Activity detection + session ID capture (see below) |

### `AdapterRuntimeStrategy`

`src/shared/types.ts`

One scannable block per adapter for activity-state derivation and session ID capture:

| Field | Type | Purpose |
|-------|------|---------|
| `activity` | `ActivityDetectionStrategy` | How thinking-vs-idle is detected. See [Activity Detection](activity-detection.md) for the discriminated union variants and the `ActivityDetection.hooks() / pty() / hooksAndPty()` factories. |
| `sessionId.fromHook?(hookContext)` | `(string) => string \| null` | Parse the agent's CLI session ID from hook stdin JSON. Fires once on `session_start`. Used by Gemini (`session_id` field) and Codex (`thread_id` via the `CODEX_THREAD_ID` env var captured by event-bridge). |
| `sessionId.fromOutput?(data)` | `(string) => string \| null` | Parse the agent's CLI session ID from raw PTY output. Scanned on every data chunk by `SessionIdScanner` (chunk-boundary-safe rolling buffer with ANSI stripping), plus a final scrollback scan in `suspend()`. Used for Codex's startup header and Gemini's shutdown summary. |
| `sessionId.fromFilesystem?(options)` | `({ spawnedAt, cwd }) => Promise<string \| null>` | Locate the agent's session ID by scanning the filesystem for a freshly-created session file. Polls the expected directory for files created after `spawnedAt` with a matching `cwd` in the session metadata. Primary capture path for Codex 0.118+ (neither PTY output nor hooks deliver the ID; the UUID is in the rollout filename at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`). |
| `sessionHistory?.locate({agentSessionId, cwd})` | `(options) => Promise<string \| null>` | Locate the agent's native session history file on disk for a captured session UUID. Used by `SessionHistoryReader` (`src/main/pty/session-history-reader.ts`) to start tailing. See [Adapter Session History](adapter-session-history.md) for the full pipeline. |
| `sessionHistory?.parse(content, mode)` | `(string, 'full' \| 'append') => SessionHistoryParseResult` | Parse newly-appended bytes (Codex JSONL) or full file content (Gemini JSON) into a `SessionHistoryParseResult` containing `usage`, `events[]`, and an optional `activity` hint. |
| `sessionHistory?.isFullRewrite` | `boolean` | `true` for whole-file-rewrite agents (Gemini), `false` for append-only JSONL (Codex). Tells the watcher whether to track a byte cursor. |
| `statusFile?.parseStatus(raw)` | `(string) => SessionUsage \| null` | Decode the rewritten contents of a per-session `status.json` (written by Kangentic's status-bridge hook) into a `SessionUsage` snapshot. Used by Claude Code and Copilot. |
| `statusFile?.parseEvent(line)` | `(string) => SessionEvent \| null` | Decode one appended line from the per-session `events.jsonl` (written by the event-bridge hook) into a `SessionEvent`. |
| `statusFile?.isFullRewrite` | `boolean` | `true` when `status.json` is fully rewritten on every update. The events file is always append-only regardless of this flag. |
| `streamOutput?.createParser()` | `() => StreamOutputParser` | Build a per-session parser that consumes raw PTY stdout for telemetry. Used by agents that emit machine-readable NDJSON to the terminal (Cursor's `--output-format stream-json` init event carries `model` + `session_id`). The returned object exposes `parseTelemetry(data)` returning `{ usage?, events? } \| null`; `SessionManager` invokes it on every PTY chunk. Each spawn gets a fresh parser so per-session rolling buffers can survive across chunk boundaries. |

Omit `sessionId` entirely for agents that use caller-owned IDs (Claude via `--session-id`) or that have no resume mechanism (Aider). Omit `sessionHistory` for agents without a native session log file. Omit `statusFile` for agents that don't emit hook-driven `status.json` / `events.jsonl` (only Claude and Copilot use this pipeline today). Omit `streamOutput` for agents that don't emit machine-readable NDJSON to PTY stdout (everyone except Cursor today).

### `SpawnSessionInput` extras

| Field | Type | Purpose |
|-------|------|---------|
| `agentName?` | `string` | Human-readable agent name (`'claude'`, `'gemini'`, etc.) captured at spawn time. Used in diagnostic logs - survives production minification unlike `agentParser.constructor.name`. |

## Supported Agents

| Agent | Adapter | CLI Binary | Session Resume | Status/Events | Settings Merge | Trust |
|-------|---------|-----------|----------------|---------------|----------------|-------|
| Claude Code | `claude-adapter.ts` | `claude` | `--resume <id>` | Yes (status.json + events.jsonl) | Yes (`--settings`) | Yes (`~/.claude.json`) |
| Codex CLI | `codex-adapter.ts` | `codex` | `resume <id>` | Partial (events.jsonl only) | No | No |
| Gemini CLI | `gemini-adapter.ts` | `gemini` | `--resume <id>` | Yes (status.json + events.jsonl) | Yes (`.gemini/settings.json`) | No |
| Cursor CLI | `cursor-adapter.ts` | `agent` | `--resume="<id>"` | No | No | No |
| GitHub Copilot CLI | `copilot-adapter.ts` | `copilot` | `--resume <uuid>` (caller-owned) | Partial (events.jsonl + status parser) | Per-session `--config-dir` | Runtime `--add-dir` |
| Aider | `aider-adapter.ts` | `aider` | No | No | No | No |
| Oz CLI (Warp) | `warp-adapter.ts` | `oz` | No | No | No | No |

## Agent Resolution

`src/main/engine/agent-resolver.ts`

When a task moves to a column, `resolveTargetAgent()` determines which agent to spawn:

1. **Column agent_override** (per-column setting) - highest priority
2. **Project default_agent** (per-project setting)
3. **Global fallback** (`DEFAULT_AGENT` constant, currently `'claude'`)

`task.agent` is intentionally NOT in the resolution chain. It records which agent last ran on the task (for resume and handoff detection), but column and project settings are the authority for which agent should run. Including `task.agent` caused bugs where tasks that previously ran Claude would always resolve to Claude even when moved to a Codex column.

**Handoff detection:** When `task.agent` is set and differs from the resolved agent, a cross-agent handoff is triggered. See [Handoff](handoff.md) for the full context transfer flow.

## First-Output Detection

Each adapter implements `detectFirstOutput(data)` to signal when the agent's TUI is ready. This controls when the shimmer overlay lifts in the terminal UI.

| Agent | Detection Strategy | Rationale |
|-------|-------------------|-----------|
| Claude Code | `\x1b[?25l` (cursor hide) | TUI hides cursor when it takes over the terminal |
| Codex CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Gemini CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| GitHub Copilot CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Cursor CLI | `data.length > 0` | Streams output immediately (no alternate screen buffer) |
| Aider | `data.length > 0` | Aider writes output immediately (no TUI alternate screen) |
| Oz CLI (Warp) | `data.length > 0` | `oz agent run` streams output, no alternate screen |

The `\x1b[?25l` (ANSI cursor hide) sequence fires after the shell prompt noise but before the TUI draws its startup banner. This keeps the shell command hidden behind the shimmer overlay.

## Exit Sequences

Graceful exit sequences written to the PTY during `SessionManager.suspend()`:

| Agent | Sequence | Notes |
|-------|----------|-------|
| Claude Code | `Ctrl+C`, `/exit` | Flushes conversation state to JSONL transcript |
| Codex CLI | `Ctrl+C` | API-backed sessions, no local state to flush |
| Gemini CLI | `Ctrl+C`, `/quit` | Triggers clean shutdown |
| Cursor CLI | `Ctrl+C` | No graceful exit needed |
| GitHub Copilot CLI | `Ctrl+C`, `/exit` | Same TUI exit pattern as Claude |
| Aider | `Ctrl+C` | No session resume, clean exit sufficient |
| Oz CLI (Warp) | `Ctrl+C` | No session resume mechanism |

## Session History File Location

During cross-agent handoff, each adapter's `locateSessionHistoryFile()` finds the source agent's native session file:

| Agent | File Pattern | Method |
|-------|-------------|--------|
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | Direct path computation |
| Codex CLI | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` | Directory scan with polling |
| Gemini CLI | `~/.gemini/tmp/<projectDir>/chats/session-<id>.json` | Directory scan with polling |
| Cursor CLI | N/A | Returns null (location not yet known) |
| GitHub Copilot CLI | N/A | Returns null (not yet empirically verified; activity flows through hooks JSONL) |
| Aider | N/A | Returns null (no native session files) |
| Oz CLI (Warp) | N/A | Returns null (no CLI-accessible session history) |

## Claude Code

### CLI Detection

`src/main/agent/adapters/claude/detector.ts`

On first use, `ClaudeDetector` locates the Claude CLI:

1. If `config.agent.cliPaths.claude` is set, use that path directly
2. Otherwise, search `PATH` using the `which` package
3. Run `claude --version` (5s timeout) to capture the version string
4. Cache the result for the app lifetime (`invalidateCache()` resets)

Returns `{ found: boolean, path: string | null, version: string | null }`.

### Command Building

`src/main/agent/adapters/claude/command-builder.ts`

#### New Session

```
claude --settings <mergedSettingsPath> --session-id <uuid> -- "prompt text"
```

- `--session-id <uuid>` creates a new conversation with a known ID (enables resume later)
- `--` separates options from the prompt (prevents prompt content like `--flag` from being parsed as CLI options)
- Prompt has double quotes replaced with single quotes to avoid PowerShell quoting issues

#### Resumed Session

```
claude --settings <mergedSettingsPath> --resume <uuid>
```

- `--resume <uuid>` continues an existing conversation
- No prompt is injected - Claude resumes from its saved context

### Permission Modes

| Mode | CLI Flag |
|------|----------|
| `plan` | `--permission-mode plan` |
| `dontAsk` | `--permission-mode dontAsk` |
| `default` | `--settings <path>` (uses project-settings) |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `auto` | `--permission-mode auto` |
| `bypassPermissions` | `--dangerously-skip-permissions` |

#### Permission Mode Resolution (Priority Order)

1. Swimlane's `permission_mode` (if set)
2. Global `config.agent.permissionMode`

### Non-Interactive Mode

When `nonInteractive` is set, `--print` is added. The agent runs, prints output, and exits without waiting for user input.

### Settings Merge

For every session, a merged settings file is built at `.kangentic/sessions/<claudeSessionId>/settings.json` and passed via `--settings`:

1. Read `.claude/settings.json` from project root (committed, shared)
2. Deep-merge `.claude/settings.local.json` from project root (gitignored, personal)
   - Hooks: concatenated per event type (local hooks appended after project hooks)
   - Permissions: deduplicated union of allow/deny arrays
3. For worktrees: merge permissions from the worktree's `.claude/settings.local.json`
   - Only permissions are merged (captures "always allow" grants from user)
   - Hooks from the worktree are skipped (may be stale leftovers)
4. Inject `statusLine` config pointing to the status bridge script
5. Inject event-bridge hooks into all registered hook points
6. Write merged file to session directory
7. Pass `--settings <mergedSettingsPath>` to the CLI

All Kangentic artifacts stay in `.kangentic/` - nothing is written to `.claude/settings.local.json`.

### Hook Injection

Kangentic subscribes to 17 Claude Code hook points via the event bridge:

| Hook Event | Event Type | Purpose |
|------------|-----------|---------|
| `PreToolUse` (blank) | `tool_start` | Agent began using a tool |
| `PostToolUse` (blank) | `tool_end` | Tool execution completed |
| `PostToolUseFailure` (blank) | `tool_failure` | Tool execution failed |
| `UserPromptSubmit` | `prompt` | User submitted a prompt |
| `Stop` | `idle` | Agent stopped naturally |
| `PermissionRequest` | `idle` | Agent hit a permission wall |
| `SessionStart` | `session_start` | Session began |
| `SessionEnd` | `session_end` | Session ended |
| `SubagentStart` | `subagent_start` | Main agent launched a subagent |
| `SubagentStop` | `subagent_stop` | Subagent finished |
| `Notification` | `notification` | Informational notification |
| `PreCompact` | `compact` | Context compaction starting |
| `TeammateIdle` | `teammate_idle` | Teammate agent went idle |
| `TaskCompleted` | `task_completed` | Task marked complete |
| `ConfigChange` | `config_change` | Configuration changed |
| `WorktreeCreate` | `worktree_create` | Worktree created |
| `WorktreeRemove` | `worktree_remove` | Worktree removed |

All hooks use blank matchers (fire for every invocation regardless of tool name). See [Activity Detection](activity-detection.md) for the full event-to-state mapping and state derivation logic.

#### Hook Identification

Kangentic hooks are identified by two markers in the command string:
- Contains `.kangentic` (path component)
- Contains a known bridge name (`activity-bridge` or `event-bridge`)

Both must match. This two-marker pattern prevents false positives on user-defined hooks with similar names. The `activity-bridge` check is for backwards compatibility with older session directories - the current bridge script is `event-bridge`.

#### Hook Cleanup

`stripKangenticHooks()` in `hook-manager.ts` removes all Kangentic hooks from `.claude/settings.local.json` on project close or delete. This is a backward-compatibility function - the unified `--settings` approach means Kangentic no longer writes hooks to `settings.local.json`, but older worktrees may still have them.

Safety guarantees:
- Backs up the original file before modification
- Validates JSON integrity before writing
- Restores from backup on any error
- Deletes empty settings files and `.claude/` directories

### Trust Management

`src/main/agent/adapters/claude/trust-manager.ts`

When spawning an agent in a worktree (CWD differs from project root), `ensureWorktreeTrust()` pre-populates `~/.claude.json` so Claude Code doesn't prompt for trust:

1. Read `~/.claude.json` (or start from empty object if missing/malformed)
2. Find the parent project's trust entry in `projects`
3. Create a new entry for the worktree path with `hasTrustDialogAccepted: true`
4. Copy `enabledMcpjsonServers` from the parent entry (MCP server inheritance)
5. Write back to `~/.claude.json`

Idempotent - skips write if the worktree is already trusted.

## Codex CLI

### CLI Detection

`src/main/agent/adapters/codex/detector.ts`

Detection follows the same pattern as Claude: check `config.agent.cliPaths.codex`, fall back to `PATH` search via `which`, run `codex --version`.

### Command Building

`src/main/agent/adapters/codex/command-builder.ts`

#### New Session

```
codex -C <cwd> --sandbox <level> --ask-for-approval <level> "prompt text"
```

#### Resumed Session

```
codex resume <sessionId> -C <cwd>
```

Resume is a subcommand in Codex (not a flag like Claude).

### Permission Modes

| Mode | Flags | Codex Preset |
|------|-------|--------------|
| `plan` | `--sandbox read-only --ask-for-approval on-request` | Safe Read-Only Browsing |
| `dontAsk` | `--sandbox read-only --ask-for-approval never` | Read-Only Non-Interactive (CI) |
| `default` | `--sandbox workspace-write --ask-for-approval untrusted` | Automatically Edit, Ask for Untrusted |
| `acceptEdits` / `auto` | `--full-auto` | Auto (Preset) |
| `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | Dangerous Full Access |

### Hook Integration

Codex hooks are written to `config.toml` in the project root via `writeCodexHooks()`. Unlike Claude's per-session `--settings` approach, Codex reads hooks from the project directory directly.

### Limitations

- No real-time token usage or cost data (no statusLine equivalent)
- No merged settings file mechanism
- No trust/directory-approval system

## Gemini CLI

### CLI Detection

`src/main/agent/adapters/gemini/detector.ts`

Detection follows the same pattern: check `config.agent.cliPaths.gemini`, fall back to `PATH` via `which`, run `gemini --version`.

### Command Building

`src/main/agent/adapters/gemini/command-builder.ts`

#### New Session

```
gemini --approval-mode <mode> "prompt text"
```

Gemini creates sessions implicitly (no `--session-id` equivalent).

#### Resumed Session

```
gemini --resume <sessionId>
```

### Permission Modes

| Mode | Flag | Gemini Mode |
|------|------|-------------|
| `plan` / `dontAsk` | `--approval-mode plan` | Plan (Read-Only Research) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` / `auto` | `--approval-mode auto_edit` | Auto Edit (Auto-Approve Edits) |
| `bypassPermissions` | `--approval-mode yolo` | YOLO (Auto-Approve All) |

### Settings Merge

Gemini reads settings from `.gemini/settings.json` in the project directory. Unlike Claude's `--settings` flag, Gemini has no way to point to a per-session settings file. Kangentic writes merged settings (with event-bridge hooks) directly to `.gemini/settings.json` in the CWD.

Because the file is shared, concurrent Gemini sessions in the same project are serialized by a per-task reference counter in `GeminiAdapter.hookHolders`: each `buildCommand` retains a reference keyed by `taskId`, and `removeHooks(directory, taskId)` only strips the file when the last task in that directory releases. Double-calls for the same `taskId` (session-manager invokes `removeHooks` both explicitly in `suspend()` and again from the PTY `onExit` handler) are idempotent. On crash or force-quit, `buildHooks` strips any stale Kangentic entries from the settings file on the next spawn. The same pattern lives in `CodexAdapter.hookHolders` for `.codex/hooks.json`.

## Aider

### CLI Detection

Detection is inlined in the adapter (no separate detector class): check `config.agent.cliPaths.aider`, fall back to `PATH` via `which`, run `aider --version`. The version output (`aider 86.2`) is parsed to strip the product name prefix.

### Command Building

`src/main/agent/adapters/aider/aider-adapter.ts`

```
aider --message "prompt text" --chat-mode <mode> --no-auto-commits
```

- `--message` delivers the prompt (shell-safe quoting applied)
- `--no-auto-commits` prevents Aider from auto-committing (Kangentic manages git)

### Permission Modes

| Mode | Flags | Aider Mode |
|------|-------|------------|
| `plan` / `dontAsk` | `--chat-mode ask` | Ask (Read-Only Questions) |
| `default` | (no flags) | Code (Confirm Changes) |
| `acceptEdits` / `auto` | `--architect` | Architect (Two-Model Design) |
| `bypassPermissions` | `--yes` | Auto Yes (Skip Confirmations) |

### Limitations

- No session resume (no `--resume` equivalent)
- No structured status or event output
- No hooks, settings merge, or trust mechanism
- No TUI alternate screen - uses streaming text output

## Cursor CLI

### CLI Detection

Detection uses the shared `AgentDetector` with binary name `agent`. Because `agent` is a generic name that may collide with other tools, `parseVersion` accepts patterns like `1.0.0`, `agent 1.0.0`, or `Cursor Agent 1.0.0` and rejects non-version output.

### Command Building

`src/main/agent/adapters/cursor/cursor-adapter.ts`

#### New Session (Interactive)

```
agent "prompt text"
```

User confirms changes in the PTY. Default mode.

#### New Session (Non-Interactive)

```
agent -p "prompt text" --output-format stream-json
```

Selected when `permissionMode === 'bypassPermissions'` or `nonInteractive` is set. Has full write access. The NDJSON `init` event carries `session_id`, which `runtime.sessionId.fromOutput` captures for resume.

#### Resumed Session

```
agent --resume="<chat-id>"
```

The `=` sits outside the quote boundary (`--resume='id'` on unix, `--resume="id"` on Windows).

### Permission Modes

| Mode | Behavior | Cursor Mode |
|------|----------|-------------|
| `default` | (no special flag) | Interactive (Confirm Changes) |
| `bypassPermissions` | `-p ... --output-format stream-json` | Non-Interactive (Full Access) |

### Limitations

- No hooks, no structured status pipeline (PTY silence timer only)
- No settings merge, no trust mechanism
- No `transcript-cleanup.ts` (uses streaming text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null - session history file location is not yet known

## GitHub Copilot CLI

### CLI Detection

`src/main/agent/adapters/copilot/detector.ts`

Detection follows the standard pattern: check `config.agent.cliPaths.copilot`, fall back to `PATH` via `which`, run `copilot --version`.

### Command Building

`src/main/agent/adapters/copilot/command-builder.ts`

Copilot CLI v1.0+ supports caller-owned session IDs via `--resume <uuid>` (same semantics as Claude's `--session-id`): passing a new UUID starts a fresh session with that ID, passing an existing UUID resumes it.

Per-session config is written to `<eventsOutputPath dir>/copilot-config/`, enabling inline hooks (`preToolUse`, `postToolUse`, `agentStop`, `preCompact`) and `statusLine`. The adapter tracks these directories keyed by project root and `taskId` so `removeHooks(directory, taskId?)` can clean up the right one.

### Permission Modes

| Mode | Flag | Copilot Mode |
|------|------|--------------|
| `plan` | `--plan` | Plan (Read-Only) |
| `dontAsk` | `--plan` (non-interactive) | Plan Non-Interactive (CI) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` | (configured tool allowlist) | Allow All Tools |
| `auto` | (configured tool allowlist) | Autopilot (Allow All Tools) |
| `bypassPermissions` | `--yolo` | YOLO (Full Access) |

`defaultPermission` is `acceptEdits`.

### Status & Events

The `CopilotStatusParser` reads a `status.json` written by Copilot's `statusLine` config (full-rewrite). Activity uses `hooksAndPty` - hooks primary, PTY silence timer as fallback.

### Limitations

- No `transcript-cleanup.ts` despite being a TUI agent (`\x1b[?25l` cursor hide). Handoff transcripts may contain rendering artifacts.
- `locateSessionHistoryFile` returns null - file location is not yet empirically verified.
- Trust is handled at runtime via `--add-dir`, not pre-approved.

## Oz CLI (Warp)

### CLI Detection

`src/main/agent/adapters/warp/version-detector.ts`

Detection is custom because `oz` does not support `--version` - it uses `dump-debug-info` instead. The detector inlines the same caching and inflight-deduplication pattern as `AgentDetector` but with the alternate version command. Override path is checked first, then `which('oz')` falls back to PATH.

### Command Building

`src/main/agent/adapters/warp/warp-adapter.ts`

```
oz agent run -C <cwd> --name <taskId> -- --prompt "prompt text"
```

- `oz agent run` is a one-shot cloud agent runner - it streams output then exits
- `-C <cwd>` sets the working directory
- `--name <taskId>` provides traceability/grouping
- `--` end-of-options guard prevents prompt content starting with `-` from being parsed as a flag

### Permission Modes

Warp manages permissions via agent profiles (`--profile <ID>`), not individual CLI flags. The labels below are informational only - no permission-mode-to-flag mapping exists in `buildCommand()`.

| Mode | Oz Mode |
|------|---------|
| `plan` | Plan Only (Read-Only) |
| `default` | Default |
| `bypassPermissions` | Auto (Skip Confirmations) |

### Limitations

- No session resume (`oz agent run` is one-shot)
- No hooks, no settings merge, no trust mechanism
- No structured status or event output - PTY silence timer is the sole idle detection
- No `transcript-cleanup.ts` (streams text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null - no CLI-accessible session history

## Prompt Templates

Actions of type `spawn_agent` can define a `promptTemplate` with placeholders:

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty, empty string otherwise |
| `{{taskId}}` | Task UUID |
| `{{worktreePath}}` | Worktree directory path (empty if no worktree) |
| `{{branchName}}` | Git branch name (empty if no worktree) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when attachments exist, empty otherwise |

Default template: `{{title}}{{description}}{{attachments}}`

This produces prompts like:
- `Fix auth bug: Users can't login after password reset` followed by `/path/to/screenshot.png` on the next line
- `Add dark mode` (no description, no attachments)

Shortcut commands use a separate set of template variables. See [Configuration](configuration.md#shortcuts) for the full list.

## Bridge Scripts

Two standalone Node.js scripts in `src/main/agent/`:

### `status-bridge.js`

- **Hook point:** `statusLine` (not a hook - uses Claude Code's status line feature)
- **Output:** `status.json` (overwritten on each invocation)
- **Data:** Token usage, cost, model, context window percentage
- **Watched by:** SessionManager with 100ms debounce
- **Supported by:** Claude Code, Gemini CLI (via status parser)

### `event-bridge.js`

- **Hook point:** All registered hooks
- **Output:** `events.jsonl` (append-only, one JSON line per event)
- **Data:** Timestamps, event types, tool names, file paths
- **Watched by:** SessionManager with 50ms debounce, incremental byte-offset reads
- **Supported by:** Claude Code (17 hook points), Codex CLI (via config.toml hooks), Gemini CLI (via .gemini/settings.json hooks)

Both scripts are stateless (no persistent process), read JSON from stdin, write to their output file, and exit. All writes are try/catch wrapped for non-fatal failures.

## CWD Strategy

All agent CLIs are invoked with `cwd` set to:
- **Worktree path** if the task has a worktree
- **Project directory** otherwise

This ensures agents load project-level configuration (`.claude/`, `.gemini/`, `CLAUDE.md`, etc.) from the correct location.

## See Also

- [Handoff](handoff.md) - Cross-agent context transfer: extraction, packaging, delivery
- [Activity Detection](activity-detection.md) - Event processing, state derivation, subagent-aware transitions
- [Session Lifecycle](session-lifecycle.md) - Spawn flow, resume, crash recovery
- [Worktree Strategy](worktree-strategy.md) - Worktree creation, sparse-checkout, hook delivery
- [Configuration](configuration.md) - Permission modes
