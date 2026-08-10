# Agent Integration

Kangentic supports twelve AI coding agents: Claude Code, Codex CLI, Gemini CLI, Qwen Code, Cursor CLI, GitHub Copilot CLI, OpenCode, Aider, Oz CLI (Warp), Kimi Code, Droid, and Ollama. Each agent is wrapped behind a common `AgentAdapter` interface that handles CLI detection, command building, permission mapping, session lifecycle hooks, and cross-agent handoff. This doc covers the adapter system, agent-specific details, and shared infrastructure.

## Agent Adapter Interface

`src/main/agent/agent-adapter.ts`

Every agent implements the `AgentAdapter` interface. Each adapter lives in `src/main/agent/adapters/<name>/`. TUI agents also have a `transcript-cleanup.ts` file for handoff transcript processing (see [Handoff - Per-Agent Transcript Cleanup](handoff.md#per-agent-transcript-cleanup)).

| Method | Purpose |
|--------|---------|
| `detect(overridePath?)` | Locate the CLI binary and return path + version |
| `invalidateDetectionCache()` | Reset cached detection (e.g. after user changes CLI path) |
| `ensureTrust(workingDirectory)` | Pre-approve a directory so the agent doesn't prompt for trust |
| `probeAuth?()` | Optional. Check whether the agent is authenticated. Returns `true` (logged in), `false` (installed but not authenticated), or `null` (probe unavailable / I/O error). Only called by IPC after `detect()` reports `found: true`. Must never throw. Currently implemented only by Kimi (see [Kimi Code -> Authentication](#authentication)). |
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
| `name` | `string` | Unique identifier (`'claude'`, `'codex'`, `'gemini'`, `'qwen'`, `'cursor'`, `'copilot'`, `'opencode'`, `'aider'`, `'warp'`, `'kimi'`, `'droid'`, `'ollama'`) |
| `displayName` | `string` | Human-readable product name |
| `sessionType` | `SessionRecord['session_type']` | Value stored in the sessions DB table |
| `supportsCallerSessionId` | `boolean` | True when the CLI accepts a caller-supplied session ID via `--session-id` (Claude). When false, Kangentic captures the agent's own ID via `runtime.sessionId` for `--resume`. |
| `permissions` | `AgentPermissionEntry[]` | Supported permission modes with agent-specific labels |
| `defaultPermission` | `PermissionMode` | Recommended default permission mode |
| `runtime` | `AdapterRuntimeStrategy` | Activity detection + session ID capture (see below) |

### Optional Properties

| Property | Type | Purpose |
|----------|------|---------|
| `getSubmissionVerifier?(contextType)` | `(SubmissionContextType) => SubmissionVerifier \| null` | Returns a context-specific verification callback used in two flows: `'paste'` (post-`\r` confirmation in `TerminalSubmit.submitContent`) and `'command-injection'` (per-command confirmation in `TerminalSubmit.submitKeystrokes`, scheduled by `TerminalSubmitScheduler.scheduleKeystrokes`). The callback receives a `SubmissionContext` and returns `Promise<boolean>`. Adapters return `null` for contexts they cannot verify; every adapter returns `null` for `'paste'` today, falling back to the activity + data-floor backstops. Seven return a `'command-injection'` verifier: Claude (JSONL slash-invocation matching) and Codex, both VERIFIED and allowed to escalate; plus Copilot, OpenCode (via a read-only SQL query rather than a file read), Qwen, Kimi, and Aider, all CONFIRM-ONLY - they confirm and drive retry-on-Enter but are barred from escalation via `canEscalateOnVerificationFailure`. A verifier must only be added for an agent whose history is MEASURED to flush on submit; see [command-injection.md](command-injection.md) and [Embedded Browser - Paste Engine](embedded-browser.md#paste-engine). |
| `liveTelemetryUnsupported?` | `AgentLiveTelemetryUnsupported` | Set when the agent CLI has no per-session telemetry channel (no status file, session history, or stream output integration is possible). Carries the renderer-facing label and tooltip so all agent-specific copy lives with the adapter. Currently used by Droid. |
| `reportsRateLimits?` | `boolean` | Set by adapters whose CLI streams account-wide rate-limit windows (plan-usage quotas). The renderer ContextBar shows its rate-limit pill for any session of such an agent, sourced from a shared global snapshot that is merged monotonically per window across sessions (within a fixed window used-percentage only rises, so a session carrying a stale cached report never regresses the displayed values, and a genuine window rollover is taken wholesale). A freshly spawned terminal shows the same limits as its siblings before it has emitted its own status line. Omit (falsy) for adapters with no rate-limit telemetry. Currently set only by Claude. |
| `pastedImageReferenceTemplate?` | `string` | Set by adapters whose CLI does not reliably auto-attach an image from a bare file path (a typed/pasted path is read as inert text, not auto-recognized as an image). Kangentic saves a pasted-clipboard or dropped image to a temp PNG (reliable even where the CLI's own clipboard reader silently fails, e.g. Claude Code on Windows with Snipping Tool images - claude-code#26679) and injects this template instead of the bare path, so the agent reliably reads the file as an image. `{path}` is replaced with the shell-quoted absolute path; a template lacking `{path}` has the quoted path appended. Omit to inject the bare quoted path (legacy). Currently set only by Claude. |
| `buildEnv?(options)` | `(SpawnCommandOptions) => Record<string, string> \| null` | Adapter-specific environment variables to inject into the PTY spawn. Used by adapters whose CLI has no flag-based MCP wiring and must deliver the Kangentic MCP server config via env (e.g. OpenCode's `OPENCODE_CONFIG_CONTENT`). |
| `getExitSequence?()` | `() => string[]` | Sequence of strings to write to the PTY for a graceful exit. Default is `['\x03']` (Ctrl+C only). Claude overrides with `['\x03', '/exit\r']` to flush conversation state. |
| `attachSession?(context)` | `(SessionContext) => SessionAttachment \| void` | Per-session lifecycle hook for adapters that need work outside the declarative `runtime` strategy (out-of-band CLI queries, file watchers, etc.). The returned `dispose` is called on session end. |
| `summarize?(prompt, cliPath, cwd)` | `(string, string, string) => Promise<string>` | One-shot summarization for the auto-name-tasks-from-prompt feature. Spawns the CLI in non-interactive `--print` mode. Adapters without a clean headless mode (Aider, Warp) omit this, as does Ollama (its headless mode is not yet wired). |
| `parseTranscript?(agentSessionId, cwd)` | `(string, string) => Promise<ParsedTranscript>` | Parse the agent's native session history into agent-agnostic `TranscriptEntry[]` for the MCP `get_transcript` structured format. The adapter owns all format/location knowledge (JSONL file, chat JSONL, SQLite DB), so `handleGetTranscript` never branches on agent name. Must not throw; returns `{ entries: [], sourcePath }` on missing/corrupt history. Implemented by Claude, Droid, Codex, Gemini, Qwen, Kimi, and OpenCode; Aider/Warp/Cursor/Copilot/Ollama omit it (raw format only). See [MCP server - get_transcript](mcp-server.md#kangentic_get_transcript). |
| `onProjectRelocated?(oldPath, newPath)` | `(string, string) => Promise<void>` | Migrate per-cwd data the agent keeps OUTSIDE the working directory, keyed by the absolute path, when that path changes. Invoked for two relocations with the same (oldPath, newPath) contract: a whole-project move (the `project:relocate` IPC handler, reached via Locate Folder / Change or the one-step "Move..." flow), and a single worktree-cwd rename on the first resume after a task's worktree was recreated at a new path (`migrateResumeCwdIfRenamed` in `src/main/transition-engine/resume-cwd-migration.ts`, which passes one worktree's old/new path so only that cwd's data moves). Called best-effort after the stored paths are settled and the new location exists. Implemented by Claude, Codex, Gemini, Qwen, Copilot, OpenCode, Kimi, and Droid (per-agent details in [Project relocation](#project-relocation) below); the shared mechanics (path-pair collection, directory rename/merge, backup + atomic write, serial lock) live in `src/main/agent/shared/relocation-utils.ts`. Implementations must be non-destructive and never block the caller. Aider, Cursor, Warp, and Ollama omit this (their resumable state is in-project or absent). |
| `probeAuth?()` | `() => Promise<boolean \| null>` | See the methods table above. |
| `remoteExecution?` | `{ info: AgentRemoteExecutionInfo; probeServer(server): Promise<RemoteServerStatus> }` | Declared by adapters whose CLI can attach to an already-running server the user operates, instead of always spawning a local process (e.g. OpenCode's `opencode attach <url> --dir <serverPath>`). `info` (`urlPlaceholder`, `authKind`, `workingDirectoryScope`, `remoteModeCaveat?`) is surfaced to the renderer via `AgentDetectionInfo.remoteExecution` so the Agent settings tab renders remote-mode rows (right after the CLI Path row) only for capability-declaring agents - no agent-name branching, including for the adapter-authored caveat text. `probeServer` replaces `probeAuth` as the reachability check when a project's mode for this agent is `remote`: it must hit the server directly and never throw. Implemented today only by OpenCode. See [configuration.md - Remote Execution](configuration.md#remote-execution). |
| `launchOptions?` | `readonly AgentLaunchOptionInfo[]` | Declared by adapters whose CLI exposes optional boolean startup toggles (id, label, description, default). Surfaced to the renderer via `AgentDetectionInfo.launchOptions` so the Agent settings tab renders one toggle row per declared option, only for capability-declaring agents. Values are resolved by `resolveLaunchOptions` (`src/main/agent/shared/launch-options.ts`) from `agent.launchOptions[agentName]` (falling back to each option's `default`) and threaded through as `CommandOptions.launchOptions`; only the adapter's own command builder interprets an `id` into a concrete CLI flag - no agent-name branching outside the adapter. Implemented today only by Codex, which declares `disableApps` (maps to `--disable apps`, skipping the optional cloud ChatGPT Apps MCP connector that can hang startup at "Booting MCP server: codex_apps" - openai/codex#20167). See [configuration.md - agent.*](configuration.md#agent) for the config shape. |
| `discoverCapabilities?(cliPath, forceRefresh?)` | `(string, boolean?) => Promise<AgentCapabilities>` | Probe the live CLI for adapter-specific knobs (e.g. parsing `--help` for valid effort levels and the presence of a `--model` flag). Result is attached to `AgentDetectionInfo.capabilities` and read by the renderer to gate optional UI controls (Model and Effort dropdowns on `EditColumnDialog`). `forceRefresh` (set when a model dropdown opens) bypasses any adapter-internal capability caches - notably Claude's 12h `/model` picker probe - so a newly shipped model surfaces without a restart; adapters with no cache to bypass ignore it. Implementations must never throw - return an empty object on parse failure so the rest of detection still succeeds. |
| `getInjectionSequence?(spec)` | `(SettingsChangeSpec) => string[]` | Translate a column-level settings change (model / effort) into the writes the `TerminalSubmitScheduler` should push onto the live PTY. Sibling of `getExitSequence` - both return `string[]` of writes. Claude returns `['/model X', '/effort Y']` for changed fields. Adapters with no live-swap slash return `[]` and the caller falls back to suspend+respawn. |
| `canVerifySlashSubmission?()` | `() => boolean` | Whether a SLASH-prefixed `auto_command` can be verified in this agent's history. Omitted or `true` means yes. Declaring `false` makes `prepareInjectionPlan` tag that command `verify: 'none'`, so it is neither retried nor escalated and the outcome stays `unconfirmed`. Exists because absence from the history file is AMBIGUOUS for agents that handle slash input in the TUI - it cannot distinguish "the CLI rejected it" from "the CLI ran it client-side" - and treating the second as a failure escalates a command that actually worked into a session restart. Declared `false` by Codex, which prints "Unrecognized command" and writes no record. See [command-injection.md](command-injection.md). |
| `canEscalateOnVerificationFailure?()` | `() => boolean` | Whether a verification FAILURE may escalate to a restart-with-prompt. Omitted or `true` means yes. Declaring `false` marks the verifier CONFIRM-ONLY: it still confirms and still drives retry-on-Enter (rung 2, where nearly all the delivery win lives), but is barred from rung 3, because a false negative from an unproven verifier is a guess and escalation acts on that guess by destroying live work. Escalation takes TWO proofs: flush latency measured live (`scripts/measure-injection-flush.mjs`), AND the adapter's own verifier watched confirming a real submission inside a running app. The second is separate because the harness reads the history with its OWN file reader, so it cannot catch a resolver pointing at the wrong path, an uncaptured session id, or a CLI that wraps the stored text - each a PERMANENT false negative that would escalate every delivery. Declared `false` today by Copilot, OpenCode, Qwen, Kimi, and Aider; only Claude and Codex escalate. Graduation recipe: [command-injection.md](command-injection.md). |
| `requiresAgentSessionIdForVerification?()` | `() => boolean` | Whether this adapter's verifier needs a captured `agent_session_id` to locate its history. Omitted or `true` means it does, which is the norm. Declared `false` by Aider and Copilot, for different reasons. Aider has NO session id at all (no `sessionIdCapture` in its `runtime`) because it keeps one `.aider.chat.history.md` per project directory, so `cwd` alone identifies its history. Copilot HAS a session id, but its prompt history is a single GLOBAL `~/.copilot/command-history-state.json` shared across every session and project, so neither the id nor `cwd` plays any part in locating it. Without the opt-out `buildCommandInjectionVerifier` short-circuits on the missing id and the verifier can never confirm - worse than having none, since the burst still retries and then reports `failed` instead of staying silently `unconfirmed`. |
| `transcriptUsage?(input)` | `({ transcriptPath?, agentSessionId?, cwd? }) => Promise<TranscriptUsage \| null>` | Parse CUMULATIVE lifetime token usage for a session from the agent's own transcript - the authoritative source for the per-task lifetime-stats rollup, since the live statusLine token counts are a current-context snapshot (Claude Code 2.1.132+). Prefers the explicit `transcriptPath`, else derives it from `agentSessionId` + `cwd`. Must not throw; returns `null` when the transcript is missing/unparseable so the caller falls back to the snapshot. Implemented today only by the Claude adapter. |
| `transcriptToolCounts?(input)` | `({ transcriptPath?, agentSessionId?, cwd? }) => Promise<TranscriptToolCounts \| null>` | Sibling of `transcriptUsage`: parse a cumulative tool-call count + callCount-only per-tool breakdown from the agent's own transcript. Backfills the live `UsageAccumulator` count for sessions whose ToolStart/ToolEnd hook events never reached it (e.g. a parked/suspended session that reports 0 despite real cost/tokens). Counts DISTINCT `tool_use` ids (parallel tool calls in one message count separately; a streamed re-emission of the same message does not double-count). Same location contract as `transcriptUsage`; must not throw, returns `null` on a missing/tool-less transcript so the caller keeps the live count. Implemented today only by the Claude adapter. |
| `configuredModelFromCommand?(command)` | `(string) => { id: string; displayName: string } \| null` | Extract the configured model from a spawned command so the board card can show a friendly model name IMMEDIATELY, before the agent reports its own via status.json / stream telemetry. Returns `{ id, displayName }` (e.g. `claude-opus-4-8` -> "Opus 4.8"), or `null` when the command encodes no explicit model. The seeded value is a placeholder: the agent's own live telemetry overrides it once reported (full usage replace), so a later in-session `/model` change stays accurate. Each adapter owns its own command syntax and model-naming scheme. Implemented today only by the Claude adapter (`adapters/claude/model-display-name.ts`). |

### `AgentCapabilities`

`src/shared/types.ts`

Adapter-discovered capabilities surfaced to the renderer (returned by `discoverCapabilities`). All fields are optional - adapters that cannot discover a capability leave it undefined and the corresponding UI control is not rendered. Nothing is hardcoded in Kangentic; values come from the live CLI.

| Field | Type | Purpose |
|-------|------|---------|
| `effortLevels?` | `string[]` | Effort/reasoning levels accepted by the CLI's `--effort` (or equivalent) flag. Claude parses these from the `--help` output. Drives the Effort dropdown on `EditColumnDialog`. |
| `supportsModelOverride?` | `boolean` | True when the CLI accepts a model override flag (e.g. Claude `--model <alias>`). When true and `models` has entries, the renderer shows a dropdown; when true and `models` is empty/undefined, the renderer falls back to a free-form text input. |
| `models?` | `string[]` | Model identifiers the user can pick from. Discovered from agent-specific sources: Claude scans `~/.claude/projects/<slug>/<sessionId>.jsonl` for assistant `message.model` values, and merges ids harvested from the CLI's own `/model` picker driven through a hidden short-lived PTY (`model-picker-probe.ts`). The picker probe runs in the background and its result is read from a cache, so discovery never blocks on it; a newly shipped model surfaces on the next discovery after the probe settles, with silent fallback to the transcript scan on any failure. Absent when no curated list is available - the renderer falls back to a free-form text input. |
| `modelDisplayNames?` | `Record<string, string>` | Friendly display name per entry in `models` (e.g. `claude-opus-4-8` -> "Opus 4.8"), computed by the adapter (Claude via `humanizeClaudeModelId`) so no agent-naming knowledge lives in shared or renderer code. Drives the humanized rows in the Model dropdown (`ModelCombobox`) and the ContextBar model popover; an id absent from the map falls back to showing its raw id. |

`AgentDetectionInfo.capabilities?: AgentCapabilities` - populated at detection time; absent for adapters that do not implement `discoverCapabilities`.

### Per-Adapter Capability Discovery

Beyond Claude (detailed above) and Ollama (which lists installed models via `ollama list`, see [Ollama](#ollama)), eight adapters each ship their own `src/main/agent/adapters/<name>/capability-discovery.ts`. The seven that probe the CLI share a common shape built on the bounded session-history scan helpers in `src/main/agent/shared/history-scan.ts` (`listMostRecentDirs` / `listMostRecentFiles` / `readHeadBytes` / `readTailBytes` / `parseJsonlRecords`, all capped so discovery stays fast on a heavily-used install):

1. **Model-override flag** - run `<cli> --help` and regex for a `--model` / `-m` flag to set `supportsModelOverride`.
2. **Model list** - when that flag is present, scan the agent's own on-disk session history for the distinct model ids the user has actually used, sorted ascending so families cluster. An empty result leaves `models` undefined and the renderer falls back to a free-form text input.
3. **Effort levels** - only Copilot parses these from `--help`; every other non-Claude adapter reports `effortLevels: []` (no CLI effort concept).

All implementations are best-effort and never throw: a help-read or history-scan failure yields conservative defaults so the rest of detection still succeeds. Droid is the one exception to the probe shape - it discovers nothing and hardcodes `supportsModelOverride: false` by design.

| Adapter | `--model`? | Effort levels | Model list source | Notes |
|---------|-----------|---------------|-------------------|-------|
| Qwen Code | `--help` (`--model` / `-m`) | None | `~/.qwen/projects/<hash>/chats/*.jsonl` - assistant `model` + `ui_telemetry` `systemPayload.uiEvent.model` | Probes both shapes for schema-drift resilience. |
| Gemini | `--help` (`--model` / `-m`) | None | `~/.gemini/tmp/<basename(cwd)>/chats/session-*.{json,jsonl}` - top-level `model` + each `messages[].model` | Reads single-document `.json` in full; head-scans `.jsonl`. |
| Codex | `--help` (`--model` / `-m`) | None | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` - `turn_context` events' `payload.model` | Codex effort is `config.toml` `model_reasoning_effort` only (no CLI flag), so effort stays empty. |
| GitHub Copilot | `--help` (`--model <...>`) | `--help` `--reasoning-effort` / `--effort` line (commander.js `choices:` format, quotes stripped) | `~/.copilot/session-state/<id>/events.jsonl` (tail) - `session.shutdown` `data.currentModel` / `data.model` / `modelMetrics` keys | The only non-Claude adapter that discovers effort levels; scans the file tail because the model-bearing shutdown event lands last. |
| Kimi | `--help` (`--model` / `-m`) | None | `~/.kimi/sessions/<md5(workdir)>/<uuid>/wire.jsonl` - top-level `model` + `message.payload.model` | Best-effort; upstream CLI research was quota-limited, so the payload probe is deliberately broad. |
| Cursor | `--help` (`--model` only, no `-m`) | None | `~/.cursor/sessions/<dated>/*.jsonl` NDJSON `system` / `init` events' `model`, merged with a hardcoded `CURSOR_COMMON_MODELS` fallback | Model entries are display names (e.g. "Claude 4.1 Sonnet"), not ids; the fallback list runs unconditionally so `models` is always populated. Reasoning is encoded in model names, not a separate flag. |
| OpenCode | `--help` best-effort, defaults false | None | (no history scan) | Model selection is intentionally left to the TUI / `opencode.json` per `cli-features-over-custom-layers.md`; no curated model list. |
| Droid | No (hardcoded false, no probe) | None | (no history scan) | Intentional: `discoverDroidCapabilities` ignores `cliPath` and returns `supportsModelOverride: false` so the Model / Effort dropdowns stay hidden. TUI-first per `cli-features-over-custom-layers.md`. |

### `CommandOptions` - new spawn knobs

`src/main/agent/agent-adapter.ts`

Four recently-added optional fields drive per-spawn overrides. Adapters consume them in `buildCommand` to emit the appropriate CLI flag (or branch) when the value is present:

| Field | Type | Purpose |
|-------|------|---------|
| `model?` | `string` | Adapter-specific model identifier (e.g. Claude `--model opus`). Empty/undefined leaves the agent default in place. Sourced from `swimlane.model_override` at spawn time by `prepare-spawn.ts`. |
| `effort?` | `string` | Adapter-specific effort/reasoning level (e.g. Claude `--effort xhigh`). Empty/undefined leaves the agent default in place. Sourced from `swimlane.effort_override` at spawn time by `prepare-spawn.ts`. |
| `executionTarget?` | `ResolvedExecutionTarget` | Present only when this project's execution mode for the agent is `remote` (see [Remote Execution](#remote-execution) below and [configuration.md - Remote Execution](configuration.md#remote-execution)). Adapters that declare `remoteExecution` read this instead of spawning the CLI locally; `undefined` unambiguously means local. Resolved by `resolveExecutionTarget()` and populated at both spawn chokepoints (`transition-engine.ts`, `session-startup/prepare-spawn.ts`). |
| `launchOptions?` | `Record<string, boolean>` | Fully-defaulted boolean launch-option values for this agent, keyed by `AgentLaunchOptionInfo.id` (e.g. Codex's `disableApps` -> `--disable apps`). `undefined` for adapters that declare no launch options. Resolved by `resolveLaunchOptions()` and populated at both spawn chokepoints (`transition-engine.ts`, `session-startup/prepare-spawn.ts`). |

For mid-session overrides (changing model/effort on a live session without respawn), see `getInjectionSequence` and `getSubmissionVerifier` in the Optional Properties table above. The adapter declares the slash-command writes; `TerminalSubmitScheduler.scheduleKeystrokes` delivers them via `TerminalSubmit.submitKeystrokes` with verification via `getSubmissionVerifier('command-injection')`.

### `AdapterRuntimeStrategy`

`src/shared/types.ts`

One scannable block per adapter for activity-state derivation and session ID capture:

| Field | Type | Purpose |
|-------|------|---------|
| `activity` | `ActivityDetectionStrategy` | How thinking-vs-idle is detected. See [Activity Detection](activity-detection.md) for the discriminated union variants and the `ActivityDetection.hooks() / pty() / hooksAndPty()` factories. |
| `sessionId.fromHook?(hookContext)` | `(string) => string \| null` | Parse the agent's CLI session ID from hook stdin JSON. Fires once on `session_start`. Used by Gemini (`session_id` field) and Codex (`thread_id` from the full SessionStart hookContext that event-bridge captures from the hook stdin). |
| `sessionId.fromOutput?(data)` | `(string) => string \| null` | Parse the agent's CLI session ID from raw PTY output. Scanned on every data chunk by `SessionIdScanner` (chunk-boundary-safe rolling buffer with ANSI stripping), plus a final scrollback scan in `suspend()`. Used for Codex's startup header and Gemini's shutdown summary. |
| `sessionId.fromFilesystem?(options)` | `({ spawnedAt, cwd }) => Promise<string \| null>` | Locate the agent's session ID by scanning the filesystem for a freshly-created session file. Polls the expected directory for files created after `spawnedAt` with a matching `cwd` in the session metadata. Primary capture path for Codex 0.118+ (neither PTY output nor hooks deliver the ID; the UUID is in the rollout filename at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`). |
| `sessionHistory?.locate({agentSessionId, cwd})` | `(options) => Promise<string \| null>` | Locate the agent's native session history file on disk for a captured session UUID. Used by `SessionHistoryReader` (`src/main/pty/readers/session-history-reader.ts`) to start tailing. See [Adapter Session History](adapter-session-history.md) for the full pipeline. |
| `sessionHistory?.parse(content, mode)` | `(string, 'full' \| 'append') => SessionHistoryParseResult` | Parse newly-appended bytes (Codex JSONL, Claude transcript JSONL) or full file content (Gemini JSON) into a `SessionHistoryParseResult` containing `usage`, `events[]`, and an optional `activity` hint. For Claude this is a background-session fallback to the `statusFile` pipeline - see [Adapter Session History](adapter-session-history.md#claude). |
| `sessionHistory?.isFullRewrite` | `boolean` | `true` for whole-file-rewrite agents (Gemini), `false` for append-only JSONL (Codex, Claude). Tells the watcher whether to track a byte cursor. |
| `statusFile?.parseStatus(raw)` | `(string) => SessionUsage \| null` | Decode the rewritten contents of a per-session `status.json` (written by Kangentic's status-bridge hook) into a `SessionUsage` snapshot. Used by Claude Code and Copilot. Adapters that report plan-usage quotas populate `SessionUsage.rateLimits?: RateLimitWindow[]` - each window self-describes via `id`, `label`, `iconKind: 'session' \| 'period'` (renderer maps to a Lucide icon), `usedPercentage` (0-100, clamp at the adapter), `resetsAt` (Unix epoch seconds), and optionally `windowDurationSeconds` (fixed window length; with `resetsAt` it yields the window start for the renderer's elapsed-time marker line, omitted when a provider's window has no fixed duration, in which case that window simply shows no time marker). The renderer iterates the array; no per-agent branching. Today only Claude populates this field. |
| `statusFile?.parseEvent(line)` | `(string) => SessionEvent \| null` | Decode one appended line from the per-session `events.jsonl` (written by the event-bridge hook) into a `SessionEvent`. |
| `statusFile?.isFullRewrite` | `boolean` | `true` when `status.json` is fully rewritten on every update. The events file is always append-only regardless of this flag. |
| `streamOutput?.createParser()` | `() => StreamOutputParser` | Build a per-session parser that consumes raw PTY stdout for telemetry. Used by agents that emit machine-readable NDJSON to the terminal (Cursor's `--output-format stream-json` init event carries `model` + `session_id`). The returned object exposes `parseTelemetry(data)` returning `{ usage?, events? } \| null`; `SessionManager` invokes it on every PTY chunk. Each spawn gets a fresh parser so per-session rolling buffers can survive across chunk boundaries. |
| `backgroundShells?.resolveOutputFile({cwd, shellId})` | `(options) => string \| null` | Locate the agent's on-disk output file for a NAMED background shell, or `null` when it has none. The bg-shell process-tree watcher stats this file each poll cycle; file growth is ground-truth liveness that keeps a genuinely-running shell from being reclaimed at the 5-min named cap when no OS PID could be captured (see [Activity Detection](activity-detection.md), Output-file liveness). Today only Claude implements this (its temp `tasks/<shellId>.output` files). |
| `backgroundShells?.reportTerminatedShells?({cwd, agentSessionId, shellIds})` | `(options) => string[]` | Report which of `shellIds` have a TERMINAL notification in the agent's durable session transcript - definitive proof of completion (task #386), independent of process-tree/output state. Reads only new transcript bytes since the previous call. Today only Claude implements this (its native transcript carries the holder's terminal `<task-notification>`; when the CLI is mid-turn it delivers that notification as a `queued_command` attachment which fires no hook, and mid-turn is exactly when a drain matters - see [Activity Detection](activity-detection.md), Transcript drain). Covers both backgrounded Bash shells and `Monitor` waits, which share the same id space, output store, and notification wrapper. |

Omit `sessionId` entirely for agents that use caller-owned IDs (Claude via `--session-id`) or that have no resume mechanism (Aider). Omit `sessionHistory` for agents without a native session log file. Omit `statusFile` for agents that don't emit hook-driven `status.json` / `events.jsonl` (only Claude and Copilot use this pipeline today). Omit `streamOutput` for agents that don't emit machine-readable NDJSON to PTY stdout (everyone except Cursor today). Omit `backgroundShells` for agents that don't write a per-shell output file or expose a transcript-based termination signal (everyone except Claude today).

### `SpawnSessionInput` extras

| Field | Type | Purpose |
|-------|------|---------|
| `agentName?` | `string` | Human-readable agent name (`'claude'`, `'gemini'`, etc.) captured at spawn time. Used in diagnostic logs - survives production minification unlike `agentParser.constructor.name`. |
| `agentSessionId?` | `string \| null` | Caller-owned agent session UUID. Set when the adapter declares `supportsCallerSessionId = true` and the spawn pipeline pre-generates a UUID before invoking the CLI (Claude `--session-id`, Qwen `--session-id`, Kimi `--session`). Lets `session-spawn-flow.ts` call `sessionHistoryReader.attach()` immediately at spawn time without waiting for capture pathways to round-trip, and skips the 30s "session ID not captured" diagnostic timer. Null/undefined for adapters that auto-generate IDs (Codex, Gemini, Droid). |

## Supported Agents

| Agent | Adapter | CLI Binary | Session Resume | Status/Events | Settings Merge | Trust |
|-------|---------|-----------|----------------|---------------|----------------|-------|
| Claude Code | `claude-adapter.ts` | `claude` | `--resume <id>` | Yes (status.json + events.jsonl; transcript fallback for background sessions, see [Adapter Session History](adapter-session-history.md#claude)) | Yes (`--settings`) | Yes (`~/.claude.json`) |
| Codex CLI | `codex-adapter.ts` | `codex` | `resume <id>` | Partial (events.jsonl only) | No | No |
| Gemini CLI | `gemini-adapter.ts` | `gemini` | `--resume <id>` | Yes (status.json + events.jsonl) | Yes (`.gemini/settings.json`) | No |
| Qwen Code | `qwen-adapter.ts` | `qwen` | `--session-id <uuid>` (caller-owned) / `--resume <id>` | Yes (events.jsonl) | Yes (`.qwen/settings.json`) | No |
| Cursor CLI | `cursor-adapter.ts` | `cursor-agent` (alias `agent`) | `--resume="<id>"` | No | No | No |
| GitHub Copilot CLI | `copilot-adapter.ts` | `copilot` | `--resume <uuid>` (caller-owned) | Partial (events.jsonl + status parser) | Per-session `--config-dir` | Runtime `--add-dir` |
| Aider | `aider-adapter.ts` | `aider` | No | No | No | No |
| Oz CLI (Warp) | `warp-adapter.ts` | `oz` | No | No | No | No |
| Kimi Code | `kimi-adapter.ts` | `kimi` | `--session <uuid>` (caller-owned) | Yes (`wire.jsonl`) | No | No |
| Droid | `droid-adapter.ts` | `droid` | `--resume <uuid>` | No (PTY-only) | No (use Droid's TUI: `/model` + Ctrl+D, shift+tab; MCP via manual `droid mcp add`) | No |
| OpenCode | `opencode-adapter.ts` | `opencode` | Plugin/PTY-captured `ses_<id>` (auto-generated) | Yes (plugin JSONL via `tool.execute.before/after` + `event` `session.*`) | No (`opencode.json` + `OPENCODE_CONFIG_CONTENT` env) | No (auth via `opencode auth login` -> `~/.local/share/opencode/auth.json`) |
| Ollama | `ollama-adapter.ts` | `ollama` | No | No | No | No |

## Agent Resolution

`src/main/transition-engine/agent-resolver.ts`

When a task moves to a column, `resolveTargetAgent()` determines which agent to spawn:

1. **Task agent_override** (`task.agent_override`, set at task creation via the New Task dialog's Advanced section) - highest priority. When set, the agent is locked for the task's entire lifetime; column moves cannot change it.
2. **Column agent_override** (per-column setting)
3. **Project default_agent** (per-project setting)
4. **Global fallback** (`DEFAULT_AGENT` constant, currently `'claude'`)

`task.agent` is intentionally NOT in the resolution chain. It records which agent last ran on the task (for resume and handoff detection), but column and project settings are the authority for which agent should run. Including `task.agent` caused bugs where tasks that previously ran Claude would always resolve to Claude even when moved to a Codex column.

**Handoff detection:** When `task.agent` is set and differs from the resolved agent, a cross-agent handoff is triggered. See [Handoff](handoff.md) for the full context transfer flow.

## First-Output Detection

Each adapter implements `detectFirstOutput(data)` to signal when the agent's TUI is ready. This controls when the shimmer overlay lifts in the terminal UI.

| Agent | Detection Strategy | Rationale |
|-------|-------------------|-----------|
| Claude Code | `\x1b[?25l` (cursor hide) | TUI hides cursor when it takes over the terminal |
| Codex CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Gemini CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Qwen Code | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude (inherited from gemini-cli fork) |
| GitHub Copilot CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Cursor CLI | `data.length > 0` | Streams output immediately (no alternate screen buffer) |
| Aider | `data.length > 0` | Aider writes output immediately (no TUI alternate screen) |
| Oz CLI (Warp) | `data.length > 0` | `oz agent run` streams output, no alternate screen |
| Kimi Code | `\x1b[?25l` (cursor hide) | TUI hides cursor when its alternate-screen buffer takes over (verified empirically with kimi v1.37.0) |
| Droid | `\x1b[?25l` (cursor hide) | Ink-based TUI, same pattern as Claude (verified empirically) |
| OpenCode | `\x1b[?25l` (cursor hide) | Full-screen TUI initializes alternate screen buffer with cursor hide on first frame |
| Ollama | `data.length > 0` | Ollama streams output immediately (no alternate screen buffer) |

The `\x1b[?25l` (ANSI cursor hide) sequence fires after the shell prompt noise but before the TUI draws its startup banner. This keeps the shell command hidden behind the shimmer overlay.

## Exit Sequences

Graceful exit sequences written to the PTY during `SessionManager.suspend()`:

| Agent | Sequence | Notes |
|-------|----------|-------|
| Claude Code | `Ctrl+C`, `/exit` | Flushes conversation state to JSONL transcript |
| Codex CLI | `Ctrl+C` | API-backed sessions, no local state to flush |
| Gemini CLI | `Ctrl+C`, `/quit` | Triggers clean shutdown |
| Qwen Code | `Ctrl+C`, `/quit` | Same TUI shutdown as Gemini (fork) |
| Cursor CLI | `Ctrl+C` | No graceful exit needed |
| GitHub Copilot CLI | `Ctrl+C`, `/exit` | Same TUI exit pattern as Claude |
| Aider | `Ctrl+C`, `/exit` | `/exit` lets Aider flush `.aider.chat.history.md` before termination |
| Oz CLI (Warp) | `Ctrl+C` | No session resume mechanism |
| Kimi Code | `Ctrl+C`, `/exit` | Conventional TUI quit; flushes context.jsonl / wire.jsonl |
| Droid | `Ctrl+C`, `/quit` | Triggers clean shutdown of the Ink TUI |
| OpenCode | `Ctrl+C` | Verified 2026-04-28: PTY exits in ~1s. `/exit` and `/quit` are not recognized slash commands. |
| Ollama | `Ctrl+C`, `/bye` | `/bye` exits the interactive REPL; harmless after a one-shot run has already exited |

## Session History File Location

During cross-agent handoff, each adapter's `locateSessionHistoryFile()` finds the source agent's native session file:

| Agent | File Pattern | Method |
|-------|-------------|--------|
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | Direct path computation |
| Codex CLI | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` | Directory scan with polling |
| Gemini CLI | `~/.gemini/tmp/<projectDir>/chats/session-<id>.json` **or** `.jsonl` | Directory scan with polling. Both extensions are live (Gemini cut over on 2026-04-28); an anchored `\.json$` matches nothing on a current install |
| Qwen Code | `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl` | Direct path construction (the session id is caller-owned via `--session-id`). Despite being a gemini-cli fork, Qwen does NOT inherit Gemini's `tmp/<basename>/chats/session-<timestamp><shortId>.json` scheme |
| Cursor CLI | N/A | Returns null - the location IS known (`~/.cursor/projects/<cwd-slug>/agent-transcripts/<id>/<id>.jsonl`, see [Command Injection](command-injection.md#cursor-located-not-yet-verified)) but is not wired in: the records carry no timestamp and the stored text is wrapped |
| GitHub Copilot CLI | N/A | Returns null (not yet empirically verified; activity flows through hooks JSONL) |
| Aider | N/A | Returns null (no native session files) |
| Oz CLI (Warp) | N/A | Returns null (no CLI-accessible session history) |
| Kimi Code | `~/.kimi/sessions/<work_dir_hash>/<sessionId>/wire.jsonl` | Glob across all hash dirs (work_dir hash is opaque) and match on session UUID |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite `session` table) | Read-only WAL handle; match `directory == cwd` and `time_created` within spawn window |
| Droid | N/A | Returns null (no native session history file; activity flows through PTY-only detection) |
| Ollama | N/A | Returns null (no CLI-accessible session history) |

## Auto-Name (Summarize)

Always-on feature that suggests a task title from the task description, via each adapter's optional `summarize?(prompt, cliPath, cwd)` method. Adapters that omit `summarize` are gated out automatically (Aider and Warp lack a clean plain-text headless mode; Ollama's is not yet wired): the renderer hides the button and never schedules the rename toast.

### Surfaces

- **`<NameFromPromptButton>`** (`src/renderer/components/NameFromPromptButton.tsx`) is a square Sparkles icon button placed alongside the title input (not inside it). It exposes a `useNameFromPromptAvailable(description)` hook and is used by `NewTaskDialog` and `TaskDetailEditForm`. The button shows only when the project's default agent declares `supportsSummarize`, the agent CLI is detected, and the description is non-empty.
- **30-second rename toast** (wired in `App.tsx`) fires once per task per app run for placeholder-titled tasks (`fix`, `wip`, etc., or empty). The "don't re-ask" set is persisted in `AppConfig.autoNameAskedTaskIds` (drained on task delete) so a dismissed suggestion does not reappear after restart.

### Implementation

Implementations live next to each adapter and call the shared `runCliPrintSummarize` helper in `src/main/agent/shared/auto-name.ts`. Each adapter picks the right `args`, `promptVia`, and (if needed) `extractRaw`:

| Agent | Invocation | Prompt delivery |
|-------|-----------|-----------------|
| Claude | `claude --print --permission-mode plan` | stdin |
| Codex | `codex exec --skip-git-repo-check` | stdin |
| Gemini | `gemini --output-format text` | stdin (non-TTY headless) |
| Qwen Code | `qwen --output-format text` | stdin (non-TTY headless) |
| OpenCode | `opencode run -q` | stdin |
| Kimi | `kimi --print --quiet` | stdin |
| Cursor | `agent --output-format text -p "<prompt>"` | positional arg |
| Droid | `droid exec -o text "<prompt>"` | positional arg |
| Copilot | `copilot --silent -p "<prompt>"` | positional arg |
| Aider, Warp | (no clean plain-text headless mode yet) | n/a |
| Ollama | (summarize not yet wired) | n/a |

### Configuration knobs

- `AppConfig.autoNameAskedTaskIds: string[]` - persisted "don't re-ask" set, drained when a task is deleted (single and bulk delete in `task-crud.ts`).
- `AppConfig.autoNameRateLimitPerHour: number` (default 60, 0 disables) - sliding-window cap on summarize CLI calls per hour, enforced in the IPC handler.

### Verification

`node scripts/probe-summarize.js` runs each detected adapter's `summarize()` against a sample description and reports success / timeout / format issues. Run it after installing or upgrading an agent CLI to confirm Kangentic's invocation still produces a sane title.

### Adding summarize to a new adapter

Import `runCliPrintSummarize` and `buildSummarizePrompt` from `../../shared/auto-name`, then add a `summarize()` method choosing the right `args`, `promptVia`, and (if needed) `extractRaw`. Mirror the pattern in `tests/unit/agent-summarize-shape.test.ts`, and set `supportsSummarize: true` on the agent's entry in `tests/ui/mock-electron-api.js`.

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

See [Permission Mode Resolution](configuration.md#permission-mode-resolution-priority-order) in configuration.md.

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
6. When the MCP server is attached, append `mcp__kangentic` to `permissions.allow` (append-if-absent) so kangentic's own tools never prompt in default mode. `--permission-mode auto` runs a SEPARATE natural-language classifier that does not honor `permissions.allow`, so a plain-language allow rule (`KANGENTIC_AUTO_MODE_ALLOW_RULE`) is also appended to `autoMode.allow` (seeded with `$defaults` when the array is absent, preserving the classifier's built-in rules) so a board-driven auto-mode session does not soft-deny Kangentic's own board/session tools
7. Write merged file to session directory
8. Pass `--settings <mergedSettingsPath>` to the CLI

All Kangentic artifacts stay in `.kangentic/` - nothing is written to `.claude/settings.local.json`.

### Hook Injection

Kangentic subscribes to 18 Claude Code hook points via the event bridge:

| Hook Event | Event Type | Purpose |
|------------|-----------|---------|
| `PreToolUse` (blank) | `tool_start` | Agent began using a tool |
| `PostToolUse` (blank) | `tool_end` | Tool execution completed (remaps to `background_shell_start` when the `tool_response` carries an id-shaped detail: a backgrounded or auto-backgrounded Bash's shell id, or a `Monitor` wait's `taskId`) |
| `PostToolUseFailure` (blank) | `tool_end` | Tool execution failed (remaps to `interrupted` when `is_interrupt` is true) |
| `UserPromptSubmit` | `prompt` | User submitted a prompt |
| `Stop` | `idle` | Agent stopped naturally |
| `StopFailure` | `turn_failed` or `turn_retrying` | Fires instead of `Stop` on a service/API error; carries the error type in `detail`. A TERMINAL error stays `turn_failed` (routed through the Interrupted bypass to reset stale counters and idle at once); a TRANSIENT, auto-retried error (overloaded/server_error/rate_limit/api_error) is reclassified to `turn_retrying`, which holds the session thinking through a live retry instead of force-idling it - see [Activity Detection](activity-detection.md) |
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

### Launch Options

Codex declares one `AgentLaunchOptionInfo` (see [Agent Adapter Interface - Optional Properties](#optional-properties)): `disableApps`, off by default. When enabled, `--disable apps` is appended to both the new-session and `resume` command forms, skipping Codex's optional cloud ChatGPT Apps MCP connector (`apps` feature, stable and on by default per `codex features list`), which can hang the whole session at `Booting MCP server: codex_apps` (openai/codex#20167, #19284, #16550). The flag is per-invocation only - it never touches the user's `~/.codex/config.toml`. Configured via the Agent settings tab's Launch Options row, stored at `agent.launchOptions.codex.disableApps`.

### Permission Modes

| Mode | Flags | Codex Preset |
|------|-------|--------------|
| `plan` | `--sandbox read-only --ask-for-approval on-request` | Safe Read-Only Browsing |
| `dontAsk` | `--sandbox read-only --ask-for-approval never` | Read-Only Non-Interactive (CI) |
| `default` | `--sandbox workspace-write --ask-for-approval untrusted` | Automatically Edit, Ask for Untrusted |
| `acceptEdits` | `--sandbox workspace-write --ask-for-approval never` | Workspace Write, No Approval |
| `auto` | `--sandbox workspace-write --ask-for-approval on-request` | Workspace Write, Model-Decided |
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

## Qwen Code

Qwen Code (https://github.com/QwenLM/qwen-code) is a soft fork of Google's gemini-cli published by the Alibaba Qwen team. The Kangentic adapter mirrors the Gemini adapter: same hook event schema, same session JSON layout, same TUI behavior. Three deltas matter for users.

### CLI Detection

`src/main/agent/adapters/qwen-code/detector.ts`

Detection follows the standard pattern: check `config.agent.cliPaths.qwen`, fall back to `PATH` via `which`, run `qwen --version`. Version output is the raw version string with no product-name prefix or suffix (inherited from gemini-cli), so `parseVersion` is identity.

### Command Building

`src/main/agent/adapters/qwen-code/command-builder.ts`

#### New Session

```
qwen --approval-mode <mode> --session-id <uuid> "prompt text"
```

Kangentic generates a UUID up front and passes it via `--session-id`, mirroring Claude. Qwen 0.15.3+ honors caller-owned UUIDs and writes its session JSONL at exactly `<our-uuid>.jsonl`.

#### Resumed Session

```
qwen --resume <sessionId>
```

`--session-id` and `--resume` are mutually exclusive (yargs enforces). The command builder picks the correct flag based on the `resume` option.

### Permission Modes

| Mode | Flag | Qwen Mode |
|------|------|-----------|
| `plan` / `dontAsk` | `--approval-mode plan` | Plan (Read-Only Research) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` / `auto` | `--approval-mode auto-edit` | Auto Edit (Auto-Approve Edits) |
| `bypassPermissions` | `--approval-mode yolo` | YOLO (Auto-Approve All) |

The fork swapped Gemini's `auto_edit` (underscore) flag value for `auto-edit` (hyphen). The unit tests guard against the underscore form regressing.

### Settings Merge

Qwen Code reads settings from `.qwen/settings.json` in the project directory. Like Gemini it has no `--settings` flag, so Kangentic writes merged settings (with event-bridge hooks) directly to `.qwen/settings.json` in the CWD. Concurrent sessions in the same project are serialized by a per-task reference counter in `QwenAdapter.hookHolders`, identical to the Gemini implementation.

### Session History

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

Context window sizes are stored in a model-name lookup table covering Qwen3-Coder (256K), Qwen3 general (128K), Qwen-Max (32K), Qwen-Plus (128K), Qwen-Turbo (1M long-context tier), and the Qwen2.5 family. Unknown model names fall through to a `null` sentinel - the renderer hides the progress bar and shows only the model name (graceful degradation).

### Session ID Capture

Caller-owned via `--session-id <uuid>`, mirroring Claude. `supportsCallerSessionId` is `true`. Empirically verified against Qwen 0.15.3: real qwen accepts a UUID and writes its JSONL at exactly `~/.qwen/projects/<sanitized-cwd>/chats/<our-uuid>.jsonl`. `--session-id` and `--resume` are mutex (yargs enforces). The runtime keeps `fromHook` and `fromOutput` capture paths as belt-and-suspenders for forks that pre-empt the caller's UUID.

### Limitations / Out of Scope

- **No statusLine telemetry:** Qwen Code (like Gemini) has no `status.json` token-streaming feature, so context window % is sourced from the session history file rather than a real-time hook.
- **OpenAI gpt-5 family unsupported (upstream bug):** Qwen Code 0.15.3's bundled `cli.js` sends `max_tokens` in OpenAI requests and never `max_completion_tokens`. OpenAI's gpt-5 family (e.g. gpt-5, gpt-5-mini, gpt-5-nano, gpt-5.1, and any gpt-5.x / gpt-5.x-codex variant) requires `max_completion_tokens` and rejects `max_tokens` with HTTP 400. Picking any gpt-5 variant via `/model` in the Qwen TUI surfaces `[API Error: 400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.]`. Workarounds until upstream patches: stay on the gpt-4.1 family for OpenAI, or use the Anthropic provider (Opus 4.7, Sonnet 4.6, Haiku 4.5) which is fully supported. Kangentic cannot work around this - the adapter is a pure CLI wrapper with no request-parameter interception. Tracked upstream at https://github.com/QwenLM/qwen-code (search issues for `max_completion_tokens`).

## OpenCode

### CLI Detection

`config.agent.cliPaths.opencode` override, then `PATH` lookup for `opencode` (with the `.cmd` shim on Windows for `npm i -g opencode-ai` installs), then the standard Unix fallback paths. Distributed via Homebrew, Scoop, Chocolatey, Pacman, the curl|sh installer, and `npm i -g opencode-ai` - all install methods publish the same `opencode` binary name. The version probe runs `opencode --version` and strips an optional `opencode ` product prefix from the output.

### Command Building

`src/main/agent/adapters/opencode/command-builder.ts`

```
opencode [--session <id>] [--prompt <text>]
```

Important shape constraints (verified against /anomalyco/opencode docs):

- The TUI's positional argument is a **project directory**, not a prompt. Initial prompts must go through `--prompt <text>` or OpenCode tries to chdir into the prompt text. The PTY layer already sets the shell cwd, so Kangentic never emits a positional or `--dir` value.
- Resume uses `--session <id>` (alias `-s`) on the TUI command - not the `run` subcommand. The prompt is omitted on resume so the user continues the prior conversation (mirrors Claude's `--resume` convention).
- Windows shells get embedded `"` characters in the prompt rewritten to `'` to keep the cmd.exe / PowerShell quoting parser happy.

### Permission Modes

The `permissions` list exposes two entries in OpenCode's own vocabulary: `plan` (label "Plan", OpenCode's built-in read-only agent) and `acceptEdits` (label "Build", full tool access). The stored `PermissionMode` enum values are reused for compatibility, so a swimlane set to `acceptEdits` under Claude continues to mean "Build" under OpenCode. Both entries are **informational** today - they produce the same CLI invocation. There is no `--dangerously-skip-permissions` flag in TUI mode (it exists only on the non-interactive `opencode run` subcommand), and no per-mode flag set. Historical values outside this list (`default`, `bypassPermissions`, `dontAsk`, `auto`) are still accepted by `mapPermissionModeToAgent` for backward compatibility with mixed-agent projects. Users who want auto-approval must enable it in `opencode.json`. The default mode is `acceptEdits`.

### Settings Merge

None. OpenCode reads MCP and provider configuration from `opencode.json` (project) or `~/.config/opencode/opencode.json` (global). `removeHooks` is a no-op and `clearSettingsCache` has nothing to clear. The Kangentic MCP server IS wired in for a local-mode spawn - `buildOpenCodeEnv` (`command-builder.ts`) emits an inline `mcp.kangentic` entry via the `OPENCODE_CONFIG_CONTENT` env var per PTY spawn, deep-merged over the user's own config so their `mcp.*` entries are preserved (see [MCP Server](mcp-server.md)). It is NOT wired in for a remote-mode spawn (`opencode attach <url>`) - see the Remote Execution subsection below.

### Session ID Capture

Not caller-owned (`supportsCallerSessionId = false`). Two capture pathways run concurrently and the first to succeed wins:

- **`sessionId.fromOutput`:** `SessionIdScanner` strips ANSI escapes from each PTY chunk and matches against `(?:session(?:[ _-]?id)?|sid)` and `--session` flag forms. Accepts both OpenCode's native `ses_<16-64 alphanumeric>` shape (verified empirically on v1.14.25, e.g. `ses_2349b5c91ffeKd6qajuUTR4clq`) and canonical UUID format.
- **`sessionId.fromFilesystem`:** Polls the OpenCode SQLite database at `~/.local/share/opencode/opencode.db` (read-only, WAL-friendly handle) for a `session` row whose `directory` equals the spawn cwd and whose `time_created` falls within `[spawnedAt - 5s, spawnedAt + 30s]`. Polls every 500 ms for up to ~10 s. Direct DB read avoids ~200-500 ms `opencode` CLI spin-up per poll, and avoids the Windows `child_process.execFile` rejection of `.cmd` shims.

### Remote Execution

OpenCode is the only adapter that declares `remoteExecution` (see [Agent Adapter Interface](#agent-adapter-interface) above and [configuration.md - Remote Execution](configuration.md#remote-execution) for the config shape). When a project's mode for OpenCode is `remote`:

- **Command:** `command-builder.ts`'s `buildOpenCodeAttachCommand` emits `opencode attach <url> [--dir <serverPath>] [--username u] [--password p]` instead of the local TUI form. `--model` is never emitted - the server is the authority for providers and models. Resume uses `--session <id>` exactly as in local mode.
- **Auth:** `probeAuth()` (the local `auth.json` check) is bypassed. `remoteExecution.probeServer` (`remote-client.ts`'s `probeOpenCodeServer`) hits `GET <url>/global/health` instead, surfaced via the `agent:probeExecutionServer` IPC channel and the Agent settings tab's "Test connection" button.
- **Session ID capture:** `sessionId.fromFilesystem` (the local SQLite poll) is skipped for a remote-mode cwd - `sessionId.fromOutput` (the PTY scan) is the sole capture path. This also means the "concurrent same-cwd spawns cannot be disambiguated" caveat below does not apply to remote sessions.
- **Transcript:** `parseTranscript` fetches `GET <url>/session/:id/message` (`remote-client.ts`'s `fetchOpenCodeSessionMessages`) instead of reading the local SQLite database, mapped into the same `TranscriptEntry[]` shape by `mapOpenCodeRemoteEntries` (a distinct mapper from the local `mapOpenCodeRows` - the wire shape is `{info, parts}[]`, not SQLite rows).
- **Activity plugin:** not installed - the plugin file would need to land on the server's filesystem, which Kangentic has no access to. PTY-silence activity detection (already the fallback tier of `hooks_and_pty`) carries activity for remote sessions.
- **MCP:** not wired. `buildOpenCodeEnv` returns `null` whenever `options.executionTarget` is set (loopback or genuinely remote target - both). This is architectural, not a reachability problem: `opencode attach <url>` is a stateless HTTP client to a server that was started, and had its config fixed, independently and earlier - its CLI surface exposes no config-push flags (verified against `opencode attach --help`), so env vars Kangentic sets on the spawned attach process are never read by the already-running server. Kangentic's `mcpServer.bindAddress`/`callbackHost` settings (see [MCP Server > Network Access](mcp-server.md)) make the server itself LAN/VPN-reachable, but cannot make `attach` push config into a server it does not control the startup of.
- **Worktree:** `ensureTaskWorktree` (`src/main/ipc/helpers/task-git.ts`) skips creating a local git worktree for a task whose resolved agent is remote-mode; the configured server working directory travels via `executionTarget`, never through `task.worktree_path`.
- **Handoff:** `locateSessionHistoryFile` returns `null` for a remote-mode cwd - cross-agent handoff degrades to the PTY-scrollback cleanup fallback, since there is no local history file to reference.

The adapter tracks which cwd resolved to which remote target in an in-memory `Map` populated by `buildCommand` (mirrors the existing `hookHolders` pattern), since `parseTranscript` / `locateSessionHistoryFile` / `sessionId.fromFilesystem` have no other way to reach Kangentic's `AppConfig` (adapters hold no config reference by design). Known limitation: this map is empty after an app restart, so viewing an old remote session's transcript falls back to the (empty) local SQLite lookup until the task is resumed again.

### Limitations

- **Concurrent same-cwd spawns cannot be disambiguated (local mode only):** Two OpenCode tasks spawned within ~30 s against the same `cwd` cannot be reliably distinguished by `captureSessionIdFromFilesystem`. Both rows match the directory + time-window predicate, so the parser returns the most recently created row - which can attribute task A's session ID to task B, or vice versa. Kangentic's per-task worktrees (`git.worktreesEnabled`, default `true`) sidestep this by giving every task its own `cwd`. If you have disabled worktrees and need to run multiple OpenCode tasks against the same project root, either re-enable worktrees in Settings -> Git or stagger the spawns by more than 30 seconds. The Codex CLI parser carries the same caveat. Does not apply to remote-mode sessions (see above).
- **No status / events telemetry:** OpenCode has no documented hook system, so activity detection is PTY-silence-only (`PTY_SILENCE_THRESHOLD_MS`, same `PtyActivityTracker` shape as Codex) and there is no `status.json` / `events.jsonl` pipeline.
- **No trust dialog:** `ensureTrust` is a no-op. OpenCode does not prompt for directory trust on first run.
- **Remote mode is single-directory per project:** the server working directory is per-project, not per-task, so concurrent remote tasks in the same project share one directory. Per-task remote worktrees would require remote git operations (OpenCode's `POST /session/:id/shell` is the mechanism, if pursued later).

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

Detection uses the shared `AgentDetector` with binary name `cursor-agent` and `binaryAliases: ['agent']`.

Cursor installs BOTH shims, and the short one is not its alone: xAI's Grok CLI also installs `agent`, and on Windows its `agent.exe` beats Cursor's `agent.cmd` in PATHEXT order. Detecting on `agent` therefore made Cursor **undetectable** on any machine that also had Grok - the probe resolved, ran Grok's binary, and Cursor was reported missing. Probing the unambiguous name first is the fix; the alias keeps working where only `agent` exists.

Two supporting details make the fallback safe. `parseVersion` accepts `1.0.0`, `agent 1.0.0`, or `Cursor Agent 1.0.0` and rejects anything else, so Grok's own version banner fails the probe rather than passing as Cursor. And the PATH loop CONTINUES to the next candidate when a name resolves but fails its version probe, instead of aborting - without that, finding Grok's `agent` would still end the search. Pinned by `tests/unit/cursor-grok-binary-collision.test.ts`.

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
- `locateSessionHistoryFile` returns null. The location is no longer unknown - Cursor writes
  `~/.cursor/projects/<cwd-slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl` plus a per-session
  `store.db` - but two things block wiring it in: the records carry NO timestamp, and the stored
  text is WRAPPED (`<user_query>...</user_query>`) rather than the raw submitted text. See
  [Command Injection - Cursor](command-injection.md#cursor-located-not-yet-verified). Cursor was
  also measured as turn-end flushed, so it gets no `command-injection` verifier either.

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

## Kimi Code

### CLI Detection

`src/main/agent/adapters/kimi/kimi-adapter.ts`

Kimi is a Python tool installed via `uv tool install kimi-cli` (the upstream installer at `code.kimi.com/install.sh`). Both `kimi` and `kimi-cli` PATH entries map to the same `src/kimi_cli:__main__` entry point. Detection uses `AgentDetector` with a `kimi --version` probe (output format: `kimi, version 1.37.0`). Fallback paths cover the uv-tool prefix on macOS/Linux (`~/.local/share/uv/tools/kimi-cli/bin/kimi`) and Windows (`%APPDATA%\uv\tools\kimi-cli\Scripts\kimi.exe` and `%LOCALAPPDATA%` equivalent).

### Command Building

`src/main/agent/adapters/kimi/command-builder.ts`

```
kimi -w <cwd> [--session <uuid> | --continue] [--plan|--yolo] [--print --output-format stream-json] [--mcp-config '<json>'] [--prompt "<text>"]
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
- `--prompt <text>` is the canonical non-interactive prompt entry. Quoting follows the same shell-safe rules as the other adapters.
- `--mcp-config <JSON>` is synthesized when `mcpServerEnabled` is true; the payload is a minimal fastmcp-compatible config naming Kangentic's HTTP MCP server with the `X-Kangentic-Token` header.

### Session ID Capture

Two PTY regex anchors plus a filesystem fallback:

1. **Welcome banner**: `Session: <uuid>` printed in the cyan startup box (interactive and `--print`).
2. **Print-mode exit**: `To resume this session: kimi -r <uuid>` written to stderr at session end.
3. **Filesystem fallback**: `runtime.sessionId.fromFilesystem` scans this spawn's own work_dir directory - `~/.kimi/sessions/<md5(cwd)>/` (and its `<kaos>_<md5(cwd)>` variant) - for UUID directories whose mtime is within ±30s of the spawn time, returning the newest. Scoping to the spawn's own work_dir hash (rather than globbing every hash dir) keeps a concurrent Kimi session in another work_dir, or a `-w`-less probe's stray session, from winning the recency race and poisoning the captured id.

### Session History

`src/main/agent/adapters/kimi/session-history-parser.ts` + `wire-parser.ts`

Kimi writes `wire.jsonl` to `~/.kimi/sessions/<work_dir_hash>/<sessionId>/` on every spawn (interactive or `--print`). The work_dir hash is `md5(absolute work_dir)`. The history locator (`locate()`, given a known session UUID) globs across all hash dirs and matches on the UUID, so it is robust to the same directory opened under different paths. This differs from the capture fallback above, which has no known UUID and so is scoped to the spawn's own work_dir hash to avoid mis-attributing another work_dir's session.

The file is append-only (resume via `-r <uuid>` appends new `TurnBegin` / `TurnEnd` lines). Format:

```jsonl
{"type": "metadata", "protocol_version": "1.9"}
{"timestamp": <unix_seconds>, "message": {"type": "<EventName>", "payload": {...}}}
```

Every documented wire-protocol message type (19 Events + 4 Requests, wire protocol v1.9) is parsed:

**Events**

| Wire event | Activity | SessionEvent |
|------------|----------|--------------|
| `TurnBegin` | → Thinking | `Prompt` (detail = extracted user_input text) |
| `TurnEnd` | → Idle | (none) |
| `StepBegin` | → Thinking | (none) |
| `StepInterrupted` | → Idle | `Interrupted` |
| `CompactionBegin` | → Thinking | `Compact` |
| `CompactionEnd` | (preserve) | (none) |
| `StatusUpdate` | (preserve) | (none; updates SessionUsage) |
| `ContentPart` | (preserve) | (none; streaming text fragment) |
| `ToolCall` | (preserve) | `ToolStart` (detail = tool name) |
| `ToolCallPart` | (preserve) | (none; argument-streaming fragment) |
| `ToolResult` | (preserve) | `ToolEnd` (detail = `ok` or `error`) |
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
| `ApprovalRequest` | → Idle | `Idle` (detail = `IdleReason.Permission`) |
| `ToolCallRequest` | (preserve) | `ToolStart` (detail = `name`) |
| `QuestionRequest` | → Idle | `Idle` (detail = `IdleReason.Permission`) |
| `HookRequest` | (preserve) | `Notification` (detail = `<event>:<target>[: <summary>]`, summary derived from `input_data` and capped at 200 chars) |

The parser uses an exhaustive `switch` over a `KIMI_DISPATCH_TYPES` literal union, so a future protocol bump that adds a new type produces a TS exhaustiveness error at compile time. `user_input` (TurnBegin / SteerInput) accepts both `string` and `ContentPart[]`; the parser extracts `TextPart.text` from arrays and ignores think/media parts.

### Permission Modes

Kimi exposes only two permission flags. The adapter surfaces three modes:

| Mode | Kimi behavior |
|------|---------------|
| `plan` | Read-only (`--plan`) |
| `default` | Interactive confirmation per action (no flag) |
| `bypassPermissions` | Auto-approve all (`--yolo`) |

### Authentication

`KimiAdapter.probeAuth()` checks for `~/.kimi/credentials/` (the OAuth state directory written by `kimi login`). The probe is invoked by the `IPC.AGENT_LIST` handler after `detect()` reports `found: true` and surfaces a tristate field `authenticated: true | false | null` on `AgentDetectionInfo`:

- `true` - credentials directory exists and is non-empty
- `false` - directory missing or empty (user has not run `kimi login`)
- `null` - I/O error or probe not implemented

The renderer surfaces the `false` state two ways: an amber `DetectionCard` variant on the welcome-screen agent grid (with a "Copy `kimi login`" clipboard button), and an amber pill plus inline hint in Settings -> Agent. Refreshing the agent list (welcome-screen Refresh, Settings re-detect button, or reopening the settings panel) re-runs the probe and clears the warning once the user has logged in.

Filesystem check chosen over a `kimi info` subprocess: the probe runs on every `AGENT_LIST` call alongside the existing `--version` probes, and a single sub-millisecond `fs.readdirSync` (with ENOENT mapped to `false`) keeps the refresh latency unchanged. An expired-token false-positive (credentials present but not valid) still falls through to today's behavior - the spawned session prints "LLM not set" and exits.

`probeAuth?()` is an optional method on the `AgentAdapter` interface; only Kimi implements it today. Other adapters return `undefined` for the `authenticated` field, which the renderer treats as "not applicable".

### Limitations

- No hook injection (Kimi reads `~/.kimi/config.toml` `hooks = []` but has no per-project settings file equivalent we can write to)
- No trust dialog (`ensureTrust` is a no-op)
- We do not initiate the OAuth flow on the user's behalf - see Authentication above for how the unauthenticated state is detected and surfaced

## Droid

### CLI Detection

`src/main/agent/adapters/droid/detector.ts`

Droid is Factory's coding agent CLI (the `droid` binary). Detection follows the standard `AgentDetector` flow with a `droid --version` probe. Output is either `droid <semver>` or bare `<semver>`; `parseVersion` strips the optional `droid` product prefix and returns the trimmed version string. Standard Unix fallback paths are wired via `standardUnixFallbackPaths('droid')` for cases where the binary is not on `PATH`. Refer to Factory's documentation for the current install command.

### Command Building

`src/main/agent/adapters/droid/command-builder.ts`

```
droid --cwd <cwd> [--resume <uuid>] "<prompt>"
```

Empirically validated against Droid 0.109.1 (see `scripts/probe-droid.js`). The adapter is intentionally minimal - the bare command with cwd + optional resume + prompt is the production path. Other CLI behavior (model picker, autonomy mode, BYOK) is configured in Droid's TUI and persisted in `~/.factory/settings.json`. Trying to shadow these with Kangentic-managed `--settings` overrides was rejected by user feedback as unnecessary custom layering.

### Session ID Capture

`src/main/agent/adapters/droid/session-id-capture.ts`

`captureSessionIdFromFilesystem` polls `~/.factory/sessions/<cwd-slug>/` (up to 20 attempts at 500ms) for `<uuid>.jsonl` files whose mtime is at or above `spawnedAt - 30s`, and returns the UUID with the newest qualifying mtime. The cwd slug normalizes path separators and the drive-letter colon to `-` (e.g. `C:\Users\dev\project` -> `-C-Users-dev-project`). Concurrent Droid spawns in the same cwd within the 30s floor can collide; per-task worktrees are the recommended mitigation.

### Permission Modes

Droid does not accept a CLI flag for autonomy mode. The adapter surfaces a single `default` mode and the user cycles autonomy in the TUI directly (shift+tab toggles low/medium/high). Kangentic does not translate `permissionMode` into a flag override.

### MCP Setup (Manual)

Droid CLI has no per-spawn `--mcp-config` flag, and Kangentic intentionally does not write to `~/.factory/mcp.json` or `<projectRoot>/.factory/mcp.json`. To expose Kangentic's project MCP server (board/task tools) to a Droid session, run once per machine after enabling MCP in project settings:

```
droid mcp add kangentic <kangenticMcpUrl> --type http --header "Authorization: Bearer <token>"
```

The URL and token are visible in **Settings -> MCP**. Droid persists the entry in `~/.factory/mcp.json`; subsequent spawns pick it up automatically. Codex and Gemini behave the same way - Kangentic only auto-wires MCP for Kimi (inline `--mcp-config`) and Claude (`--settings` merge).

### Limitations

#### No live telemetry (model, cost, tokens, context window)

Droid 0.109.x has no per-session telemetry channel that Kangentic can subscribe to. The three documented surfaces all sit outside the live-streaming contract that `ContextBar` requires:

- **`/cost` and `/context` slash commands** - post-hoc and user-initiated inside the TUI, not a stream Kangentic can read.
- **`OTEL_TELEMETRY_ENDPOINT`** - out-of-band OpenTelemetry export to a collector. Not a per-session signal we can subscribe to from the main process.
- **`~/.factory/sessions/<cwd-slug>/<uuid>.settings.json`** - written post-hoc, schema undocumented and unstable. Empirical parsing was evaluated and rejected (see "Out of scope" below).

As a result, `SessionUsage` is never populated for Droid sessions. The Droid adapter declares `liveTelemetryUnsupported` (carrying a label and tooltip) on `AgentAdapter`, the field flows to the renderer through `AgentDetectionInfo`, and `ContextBar` reads the generic capability and renders a "Telemetry: TUI only" pill (with the adapter-supplied tooltip) in place of the loading spinner. The renderer never branches on agent name. Users get live telemetry by running `/cost` or `/context` directly inside the Droid TUI.

Tracked upstream at [Factory-AI/factory#TBD](https://github.com/Factory-AI/factory/issues) - once a per-session streaming channel ships (status file, named pipe, or `stream-json` on interactive `droid`), wire a `runtime.sessionHistory` (or `runtime.statusFile` / `runtime.streamOutput`) parser in `src/main/agent/adapters/droid/` and remove `liveTelemetryUnsupported` from the Droid adapter. The renderer falls back to the standard model / cost / token pills automatically.

#### Other gaps

- No status events or activity log integration; the terminal panel is the only signal of agent state.
- No trust dialog (`ensureTrust` is a no-op; Droid does not prompt for directory approval).
- No cross-agent handoff source: `locateSessionHistoryFile` returns null because Droid's JSONL transcript format has not yet been wired into the handoff pipeline.

#### Out of scope: post-hoc JSONL replay

Reading `<uuid>.settings.json` after session exit was considered as a "good enough" fallback for cost/token totals. Rejected because (a) the file schema is undocumented and observed to differ across Droid 0.10x point releases, (b) post-hoc data does not solve the live-spinner UX, only the final-row UX, and (c) Factory has signaled willingness to add a streaming channel - see upstream FR.

## Ollama

Ollama drives a local LLM via the `ollama` CLI (https://ollama.com). It is a local-inference tool, not an agentic coder: `ollama run` opens a chat with a local model and cannot edit files or call tools on its own. It is modeled on the Warp adapter (a one-shot run that streams output then exits): `ollama run <model> "<prompt>"` prints the answer and the process exits, so each spawn is a single turn. Free-form multi-turn chat is available by running `ollama run <model>` directly in a Command Terminal.

### CLI Detection

Detection uses the shared `AgentDetector` (via composition, like Aider) with binary name `ollama` and `standardUnixFallbackPaths('ollama')`. `ollama --version` prints `ollama version is X.Y.Z`; `parseVersion` strips the `ollama version is ` prefix.

### Command Building

`src/main/agent/adapters/ollama/ollama-adapter.ts`

```
ollama run <model> [-- "<prompt>"]
```

- `ollama run` **requires** a model argument (it has no built-in default and no interactive picker), so the adapter always supplies one: the per-column / per-task model override when set, else `DEFAULT_OLLAMA_MODEL` (`llama3.2`). Ollama auto-pulls a missing model on first run, so the fallback is always runnable. The model picker is populated from `ollama list` (see `capability-discovery.ts`); on discovery failure the renderer falls back to a free-form text input.
- The mandatory model argument is a documented exception to `cli-features-over-custom-layers.md` - it is the one Kangentic-managed knob, because `ollama run` cannot run without it.
- The initial prompt is delivered as a single positional argument. The `--` end-of-options guard is pushed first (like Warp) so a prompt starting with `-` (a markdown bullet, a dashed list item) is taken as the positional argument rather than parsed as a flag. On Windows / non-unix shells, embedded double quotes in the prompt are rewritten to single quotes.
- A no-prompt spawn (`ollama run <model>` with no prompt) drops into an interactive REPL the user types into.

### Permission Modes

Ollama has no autonomy / permission concept - it is a plain chat REPL. Per `cli-features-over-custom-layers.md`, the adapter exposes a single informational entry and injects no permission flags in `buildCommand()`.

| Mode | Ollama Behavior |
|------|-----------------|
| `default` | Chat |

`defaultPermission` is `default`.

### Activity Detection

Runtime activity is PTY-only. A one-shot `ollama run` streams output then exits, so the PTY silence timer drives the idle transition. The `detectIdle` callback additionally matches the interactive REPL prompt (`>>> `) for an instant idle when a no-prompt spawn drops into the REPL. `detectFirstOutput` returns true on any non-empty data (no alternate screen buffer).

### Limitations

- No session resume (Ollama has no CLI-level session IDs)
- No hooks, no settings merge, no trust mechanism, no MCP wiring
- No structured status or event output - PTY silence timer (plus the REPL-prompt regex) is the sole idle detection
- No `transcript-cleanup.ts` (streams plain text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null - `ollama run` has no native session history files

## Project relocation

A Kangentic project relocates in one of two ways, both handled by the `project:relocate` IPC
handler (`src/main/ipc/handlers/project-relocate.ts`): the user moves the folder outside
Kangentic and points us at the new location (`repoint` mode, reached from Project Settings or the
Locate Folder dialog), or Kangentic moves the folder itself in one step (`move` mode, reached
from the Project Settings "Move..." button). In both modes the handler suspends the project's own
live sessions, then rewrites the stored DB paths, then calls the optional
`onProjectRelocated(oldPath, newPath)` hook on every registered adapter (best-effort, per-adapter
try/catch). By the time the hook fires the folder is already at `newPath`. Each adapter migrates
the per-project data its CLI keys to the absolute path OUTSIDE the project folder, so sessions
stay resumable. The shared mechanics (path-pair collection across the project root plus on-disk
worktrees, directory rename/merge, backup + atomic write, serial lock) live in
`src/main/agent/shared/relocation-utils.ts`; per-adapter logic lives in each adapter's
`project-relocation.ts`.

Suspending the project's own sessions fully terminates their PTYs before the folder moves (the
quiesce that lets the move succeed on Windows, where a directory cannot be renamed while a
process holds a handle inside it). It does NOT cover an unrelated agent session running in a
DIFFERENT project or an external terminal: such a session can still hold a shared global config
(e.g. `~/.claude.json`) in memory and overwrite the migrated keys on its next save. Kangentic
only manages its own sessions and does not detect or kill those, so that residue is accepted (the
same caveat the Claude adapter documents).

| Agent | What migrates | Documented residue / notes |
|-------|---------------|----------------------------|
| Claude | `~/.claude/projects/<slug>/` transcript dirs and `~/.claude.json` `projects` keys (backup `~/.claude.json.kangentic-backup`). | - |
| Qwen Code | `~/.qwen/projects/<slug>/` chats, `~/.qwen/tmp/<sha256>/` history, and `~/.qwen/trustedFolders.json` keys. | - |
| Droid | `~/.factory/sessions/<cwd-slug>/` session dirs. | Best-effort: Droid is closed source, so resume resolution around the slug dir is not authoritatively documented. |
| OpenCode | `session.directory`/`session.path`, `project.worktree`, `project_directory.directory` columns in `~/.local/share/opencode/opencode.db` (one transaction). | No file backup (live WAL DB; rollback = status quo). `project.sandboxes` left untouched. Project id is git-derived, so sessions are never orphaned, only re-scoped. |
| Gemini | `~/.gemini/projects.json` key, `.project_root` markers under `tmp/`+`history/<slug>/`, and `~/.gemini/trustedFolders.json` keys; slug dirs renamed opportunistically on a basename change. | When the new-basename slug is already taken, the old slug is kept (Gemini still resolves via the registry, but Kangentic's basename-keyed chat locator cannot find the old chats - a pre-existing Gemini basename-collision limitation). |
| Codex | `[projects.'<path>']` trust headers in `~/.codex/config.toml` (line-based, preserving quote / `\\?\` prefix / separator style). | Rollout JSONLs under `~/.codex/sessions/` are intentionally NOT touched: `codex resume <id>` resolves by session id, so resume already survives a move. Only the cwd-filtered resume picker shows residue (it has an `--all` escape hatch). |
| Kimi | `~/.kimi/sessions/<md5(work_dir)>/` dirs (and `<kaos>_<md5>` variants) and `~/.kimi/kimi.json` `work_dirs[].path`. | md5 is computed over the resolved native-separator path (Kangentic spawns Kimi with a forward-slashed `-w`, but Kimi normalizes to native before hashing). |
| Copilot | `cwd` / `git_root` lines in `~/.copilot/session-state/<uuid>/workspace.yaml`. | Best-effort and version-fragile (v1.0.52+ resumes in the saved cwd). The `~/.copilot/session-store.db` cache is left untouched, so picker/search residue is accepted. |
| Aider | None. | History (`.aider.chat.history.md`) lives inside the project folder and moves with it. |
| Cursor | None. | No cwd-keyed external session store Kangentic depends on. |
| Oz (Warp) | None. | No resumable on-disk session state. |
| Ollama | None. | No resumable external session state; `onProjectRelocated` omitted. |

## Prompt Templates

Actions of type `spawn_agent` can define a `promptTemplate` with `{{placeholder}}` variables. The full variable set (`task_xml`, `title`, `description`, `taskId`, `worktreePath`, `branchName`, `baseBranch`, `prUrl`, `prNumber`, `attachments`) is documented once, in the transition engine's [Template Variables](transition-engine.md#template-variables) section. The two families worth calling out for prompt authoring:

- `{{task_xml}}` is the preferred default: a `<task><title>...</title><description>...</description></task>` envelope (escaped).
- `{{title}}` / `{{description}}` remain for backward compatibility with custom prose templates.

Default template: `{{task_xml}}{{attachments}}`

The `<task>` envelope follows Anthropic + OpenAI guidance: wrap user-authored input in XML tags so the model has a clear data/instruction boundary. Non-XML-aware agents (Aider, Codex) treat the markup as harmless prose. Attachment `@-mention` paths stay outside the envelope so Claude Code / Gemini bare-token parsers reliably auto-inject them.

A typical prompt:

```
<task>
  <title>Fix auth bug</title>
  <description>Users can't login after password reset</description>
</task>
/path/to/screenshot.png
```

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
- **Supported by:** Claude Code (18 hook points), Codex CLI (via config.toml hooks), Gemini CLI (via .gemini/settings.json hooks)

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
