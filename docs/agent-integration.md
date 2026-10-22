# Agent Integration

Kangentic supports fifteen AI coding agents: Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Qwen Code, Cursor CLI, GitHub Copilot CLI, OpenCode, Aider, Oz CLI (Warp), Kimi Code, Droid, Ollama, Grok Build, and Goose CLI. Each agent is wrapped behind a common `AgentAdapter` interface that handles CLI detection, command building, permission mapping, session lifecycle hooks, and cross-agent handoff. This doc covers the adapter system, agent-specific details, and shared infrastructure.

## Agent Adapter Interface

`src/main/agent/agent-adapter.ts`

Every agent implements the `AgentAdapter` interface. Each adapter lives in `src/main/agent/adapters/<name>/`. TUI agents also have a `transcript-cleanup.ts` file for handoff transcript processing (see [Handoff - Per-Agent Transcript Cleanup](handoff.md#per-agent-transcript-cleanup)).

| Method | Purpose |
|--------|---------|
| `detect(overridePath?)` | Locate the CLI binary and return path + version |
| `invalidateDetectionCache()` | Reset cached detection (e.g. after user changes CLI path) |
| `ensureTrust(workingDirectory)` | Pre-approve a directory so the agent doesn't prompt for trust, plus any other pre-spawn global-config state the adapter needs (see [Global Config Writes](#global-config-writes-claudejson)) |
| `probeAuth?()` | Optional. Check whether the agent is authenticated. Returns `true` (logged in), `false` (installed but not authenticated), or `null` (probe unavailable / I/O error). Only called by IPC after `detect()` reports `found: true`. Must never throw. Currently implemented by Kimi (see [Kimi Code -> Authentication](#authentication)) and Grok (`grok models`, whose output says "not authenticated" from local state). |
| `buildCommand(options)` | Build the shell command string to spawn the agent. `options.agentPath` is what `detect()` returned, except that on Windows a `.cmd` / `.bat` head is swapped by the spawn chokepoint for the sibling shim the PTY shell can run before the builder sees it (`resolveShimLaunch`, see [cross-platform.md](cross-platform.md#npm-cmd-shims-under-powershell-and-git-bash)); builders never inspect the extension |
| `interpolateTemplate(template, variables)` | Replace `{{key}}` placeholders in prompt templates |
| `runtime` | `AdapterRuntimeStrategy` declaring activity detection + session ID capture (see below) |
| `removeHooks(directory, sessionId?)` | Remove the per-directory config an adapter injected, on cleanup. `directory` is the cwd the session's command was built for (`ManagedSession.commandCwd`), not the PTY's start dir. `sessionId` is the session releasing its hold: adapters that write a file every session in a folder shares (Gemini, Qwen, Cursor, Droid, Antigravity, Grok, OpenCode, Codex) hold it per session in a `SharedFolderHolds` (`src/main/agent/shared/shared-folder-holds.ts`) and strip it when the folder's last session releases, from the folder the hold was taken in. Keyed by session, never by task: a task's sessions overlap while a killed young session's PTY exits. No `sessionId` (project delete's sweep) strips the folder whoever holds it. The payload is not only hooks: Gemini also strips its `mcpServers.kangentic` entry (which carries the per-launch token), and Droid's hold guards `<cwd>/.factory/mcp.json` rather than a hooks file. |
| `detectFirstOutput(data)` | Detect the adapter's readiness escape, which times the boot geometry re-assert. A heuristic, not proof the agent is up, so it does not lift the launch overlay - see First-Output Detection below |
| `locateSessionHistoryFile(agentSessionId, cwd)` | Locate the agent's native session history file on disk |

### Required Properties

| Property | Type | Purpose |
|----------|------|---------|
| `name` | `string` | Unique identifier (`'claude'`, `'codex'`, `'gemini'`, `'qwen'`, `'cursor'`, `'copilot'`, `'opencode'`, `'aider'`, `'warp'`, `'kimi'`, `'droid'`, `'ollama'`, `'grok'`, `'antigravity'`, `'goose'`) |
| `displayName` | `string` | Human-readable product name |
| `sessionType` | `SessionRecord['session_type']` | Value stored in the sessions DB table |
| `supportsCallerSessionId` | `boolean` | True when the CLI accepts a caller-supplied session ID via `--session-id` (Claude). When false, Kangentic captures the agent's own ID via `runtime.sessionId` for `--resume`. |
| `permissions` | `AgentPermissionEntry[]` | Supported permission modes with agent-specific labels |
| `defaultPermission` | `PermissionMode` | Recommended default permission mode |
| `runtime` | `AdapterRuntimeStrategy` | Activity detection + session ID capture (see below) |

### Optional Properties

| Property | Type | Purpose |
|----------|------|---------|
| `getSubmissionVerifier?(contextType)` | `(SubmissionContextType) => SubmissionVerifier \| null` | Returns a context-specific verification callback used in two flows: `'paste'` (post-`\r` confirmation in `TerminalSubmit.submitContent`) and `'command-injection'` (per-command confirmation in `TerminalSubmit.submitKeystrokes`, scheduled by `TerminalSubmitScheduler.scheduleKeystrokes`). The callback receives a `SubmissionContext` and returns `Promise<boolean>`. Adapters return `null` for contexts they cannot verify; every adapter returns `null` for `'paste'` today, falling back to the activity + data-floor backstops. Nine return a `'command-injection'` verifier: Claude (JSONL slash-invocation matching) and Codex, both VERIFIED and allowed to escalate; plus Copilot, OpenCode (via a read-only SQL query rather than a file read), Qwen, Kimi, Aider, Grok, and Antigravity (brain-dir transcript USER_INPUT matching), all CONFIRM-ONLY - they confirm and drive retry-on-Enter but are barred from escalation via `canEscalateOnVerificationFailure`. A verifier must only be added for an agent whose history is MEASURED to flush on submit; see [command-injection.md](command-injection.md) and [Embedded Browser - Paste Engine](embedded-browser.md#paste-engine). |
| `liveTelemetryUnsupported?` | `AgentLiveTelemetryUnsupported` | Set when the agent CLI has no per-session telemetry channel (no status file, session history, or stream output integration is possible). Carries the renderer-facing label and tooltip so all agent-specific copy lives with the adapter. The task detail's context bar, the board card's footer and the Agent Monitor card's footer show it in place of a "Starting agent..." spinner that would never end. Currently used by Droid and Antigravity. |
| `reportsRateLimits?` | `boolean` | Set by adapters whose CLI streams account-wide rate-limit windows (plan-usage quotas). The renderer ContextBar shows its rate-limit pill for any session of such an agent, sourced from a shared global snapshot merged per window across sessions. Main's `RateLimitLedger` (`src/main/activity-engine/rate-limit-ledger.ts`) stamps every reported window with a reset `generation`, and the merge compares it between two reports of the same window, before their values. A fresh report that falls more than 5 points inside the same window is a free usage reset, and opens the next generation. A session still behind the current generation that falls the same amount catches up without opening another. A reset is either a session's own drop, or a new session's first report below the highest value the current generation has seen in that window, which the ledger keeps after the session that reported it is removed. The reset opens the next generation and replaces the held value, even though `resetsAt` did not move. A session that has reported nothing new since then keeps the older generation, so its stale pre-reset number is ignored until its next fresh report catches it up. Main also brings every such session's cached window up to the reset's value and re-sends it, so a renderer reload, or a board whose projects did not see the reset, shows it even after the session that saw it is gone. Within one generation, used-percentage only rises, so a sibling's stale cached report never regresses the displayed values, and a genuine window rollover is taken wholesale. A freshly spawned terminal shows the same limits as its siblings before it has emitted its own status line. Omit (falsy) for adapters with no rate-limit telemetry. Currently set only by Claude. |
| `scopesTranscriptReadsByTime?` | `boolean` | Set when `transcriptToolCounts` and `transcriptToolResultTokens` honor `sinceMs` and `untilMs`, so a read holds exactly one run's calls even though the CLI writes every resume of a conversation to one transcript (Claude). Without it, the run-end count backfill skips a resumed conversation's later runs (a whole-transcript count would add the earlier runs' calls to this run's record), and the earlier-run Tokens fill does not read the agent's transcripts. |
| `pastedImageNativeExtensions?` | `readonly string[]` | Image extensions (lowercase, no dot) the CLI attaches natively when the file's path arrives as a bracketed paste. Kangentic saves a pasted-clipboard or dropped image to a file (reliable even where the CLI's own clipboard reader silently fails, e.g. Claude Code on Windows with Snipping Tool images - claude-code#26679) and delivers the shell-quoted path through xterm's `terminal.paste()`, the way a native terminal delivers a drop; a CLI that scans a paste packet for image paths then attaches the file inline in the user turn with no `Read` tool call. A plain string array, never a RegExp: the value crosses IPC in `AgentDetectionInfo`. Omit when the CLI attaches nothing from a pasted path. An image outside the set is re-encoded as PNG by the renderer and saved through `clipboard:saveImage` when the set includes `png`, so the set only needs to name what was verified to attach. Set by Claude (`png`, `jpg`, `jpeg`, `gif`, `webp`, its own `/\.(png\|jpe?g\|gif\|webp)$/i`, verified on 2.1.276), Gemini (`png`, `jpg`, `jpeg`, `gif`, verified on 0.60.0; a path with a space becomes an `@"..."` file reference instead of a chip), and OpenCode (`png`, `jpg`, `jpeg`, `gif`, verified on 1.18.30). Neither of those two was probed with webp, so a webp drop under them takes the PNG normalization, which attaches all the same. Probed negative on 2026-09-18, both quoted and bare, so left unset: Cursor 2026.09.10, Grok 1.0.0, Antigravity 1.1.13 (each inserts the path as text; Grok and Antigravity then open it with their own Read tool at submit). Not probed, since they could not reach a prompt on the probe machine: Codex (not signed in), Copilot 1.0.83 (the spawn fails with "No session, task, or name matched" for the session id the adapter passes), Qwen (not authenticated), Kimi (not logged in), Droid (not logged in), plus the uninstalled Aider, Oz, Ollama and Goose. The probe: spawn a session in a `/preview`, then `kangentic_devtools_pty_input` with `bytes` = base64 of `\x1b[200~"<absolute png path>"\x1b[201~`, and look for the chip; no submit is needed. |
| `pastedImageReferenceTemplate?` | `string` | Fallback text pasted for an image outside `pastedImageNativeExtensions` that could not be re-encoded as PNG (the bytes did not decode, or the set has no `png`), or for every image when that set is not declared (a typed path is inert text to most CLIs), so the agent reads an explicit instruction instead of a bare path. `{path}` is replaced with the shell-quoted absolute path; a template lacking `{path}` has the quoted path appended. Omit to paste the bare quoted path. Currently set only by Claude (`Read this image: {path} `, which now covers svg and any file whose bytes Chromium cannot decode). |
| `buildEnv?(options)` | `(SpawnCommandOptions) => Record<string, string> \| null` | Adapter-specific environment variables to inject into the PTY spawn. Three uses. Most implementers deliver MCP config an adapter cannot pass on the command line: either because the CLI has no MCP flag at all (OpenCode's `OPENCODE_CONFIG_CONTENT`, carrying the whole config), or because the value is a secret that must not land in argv or in a repo file (Codex and Droid both pass only `KANGENTIC_MCP_TOKEN`, referenced by name from their config). Grok extends the pattern furthest: its env carries the MCP URL and token (`KANGENTIC_MCP_URL` / `KANGENTIC_MCP_TOKEN`, dereferenced by grok's `${VAR}` expansion so its `.grok/config.toml` block stays fully static) plus `KANGENTIC_EVENTS_PATH` for the hook bridge's `env:` sentinel. Goose's native permission/autonomy control is an env var (`GOOSE_MODE`) rather than a flag, so its permission mode is delivered here. Claude's renderer variable, `CLAUDE_CODE_NO_FLICKER=1` (`rendererEnvironment`), is the third use. Implemented by Claude, Cursor, OpenCode, Codex, Droid, Grok, and Goose. |
| `getExitSequence?()` | `() => ExitSequenceStep[]` | Keys (and `{ delayMs }` pauses) to write to the PTY to ask the agent to exit. Default is `['\x03']` (Ctrl+C only). Claude overrides with Esc, a 400 ms pause, Ctrl+C and `/exit`. |
| `consoleCloseIsGraceful?(platform)` | `(platform: NodeJS.Platform) => boolean` | Whether closing the agent's console is itself its graceful exit there, as measured. True means kill, suspend and quit close it at once and type nothing. Claude: Windows and Linux, not macOS. Default false. |
| `mayApprovePlanTool?(toolName)` | `(toolName: string) => boolean` | Whether the adapter's plan tool approval hook may answer a permission prompt for this tool (see [`plan-approval-bridge.js`](#plan-approval-bridgejs)). The plan approval gate holds such a prompt's permission idle for the hook's marker; every other prompt passes at once. It names candidates only; the hook decides from the session's own rules. Claude: any MCP tool but Kangentic's own. Default false. |
| `backgroundCommands?` | `{ source: 'hooks' \| 'session-history'; launchHint: boolean }` | The agent reports the background commands it starts, so a launch holds the session `thinking` until the command exits or the agent marks it a service, and its task sessions are offered `kangentic_mark_background_service`. `source` says where the starts come from (its hooks, or a history file its parser tails); `launchHint` says whether a launch also tells the agent how to mark a service. Read at spawn onto the session row (`ManagedSession.reportsBackgroundCommands`). Declared by Claude, Qwen, Gemini, Copilot, Grok, Kimi and Codex; the per-agent decisions are in [Background commands](#background-commands). |
| `attachSession?(context)` | `(SessionContext) => SessionAttachment \| void` | Per-session lifecycle hook for adapters that need work outside the declarative `runtime` strategy (out-of-band CLI queries, file watchers, etc.). The returned `dispose` is called on session end. |
| `summarize?(prompt, cliPath, cwd, options?)` | `(string, string, string, SummarizeOptions?) => Promise<string>` | One-shot summarization for the auto-name-tasks-from-prompt feature. Runs the title prompt on the Automation agent's model and effort in the shared answer home: through the adapter's own answer run where it was measured to title cleanly (Gemini, Copilot, OpenCode), and otherwise a headless print run (Claude's runs on its answer arguments with `--output-format json`). `SummarizeOptions` carries `model`, `effort`, `runDirectory` and `onUsage`, the sink that receives the run's `AgentCallUsage` for the `background_calls` ledger. Antigravity is the one PTY exception: `agy -p` hangs when stdio is not a TTY (upstream google-antigravity/antigravity-cli#318), so its summarize runs the print mode through a hidden PTY in a pre-trusted scratch cwd. Warp has no headless run and omits it. Aider, Ollama and Goose omit it too: each has a headless answer run (`answerFromContext`) but no summarize, and Aider's answer run is built from its published options without a run against an installed Aider. |
| `answerFromContext?(prompt, cliPath, cwd, model?, options?)` | `(string, string, string, string \| null?, AnswerFromContextOptions?) => Promise<string>` | One-shot, read-only answer for the Knowledge Graph. The prompt arrives fully built; the adapter chooses only its CLI flags and how to read the answer out of stdout. The prompt stays OFF the command line: an answer prompt runs to about 50k characters, past the Windows command-line limit, so it goes on stdin, or through `promptVia: 'file'` for a CLI that reads a file (Grok `--prompt-file`, Aider `--message-file`). `cwd` is the answer home, `<tmpdir>/kangentic-ask-home` (`kangentic-ask-home-<uid>` on POSIX, where the temp folder can be shared): one stable directory for every answer run, never the project. On POSIX it is created private to the user (0700), and an existing one is used only when it is a real directory the user owns and no one else can write to; otherwise a fresh private folder takes its place for the rest of the launch. The home and each run directory are handed over as their real paths: macOS keeps its temp folder behind a link (`/var` is `/private/var`), and a CLI that resolves its working directory keys trust and saved chats by the real one. Every agent CLI keys its own state by working directory (sessions, trust entries, project registries), so a fresh directory per question left one entry per question in each CLI's store. Per-run files (an MCP config carrying the token, a prompt file, a chat history) go in `options.runDirectory`, a fresh `kangentic-answer-*` directory removed after the run. `AnswerFromContextOptions.onUsage` receives the run's `AgentCallUsage` when the CLI reports one (Claude and Antigravity today), before an error result throws, since a failed run was still paid for. Each adapter also keeps its run out of the CLI's saved sessions: Claude passes `--no-session-persistence`, Codex `--ephemeral`, Qwen `--chat-recording=false`; Copilot, Cursor, Grok, Gemini and Antigravity remove their session by id afterwards, and OpenCode runs `session delete`. Every adapter except Warp implements it, since Warp has no documented read-only headless run. |
| `answerCapabilities?` | `AnswerCapabilities` | Declared beside `answerFromContext`: `streaming` (text reaches `onEvent` as it is written), `search` (the run honours `options.retrieval`, reaching `kangentic_search` through an MCP URL whose `answer-` caller segment makes the server expose that one tool and nothing else), `model` (the run takes a model id, which makes the agent's Model row in the Knowledge Graph card (Settings > Knowledge Graph) required), `effort` (the run passes `options.effort` as the CLI's own effort flag; the Knowledge Graph card shows its optional Effort row only when this is true and the CLI reports effort levels), and `defaultEffort` (the level an unset row runs at, shown as its placeholder). The handler passes the user's level, else `defaultEffort`, and either only if the CLI still reports it. Claude, Grok, Copilot and Antigravity declare `effort` with a `low` default; Claude's `low` also keeps extended thinking off, and a higher level lets the level decide. Claude, Grok, Copilot, Cursor and OpenCode declare `streaming` and `search`; Antigravity and Gemini declare `streaming` only. Antigravity's headless run denies any tool that needs approval, our search included. In the runs tried, Gemini's headless run never registered our MCP tool: in plan mode with the folder trusted in `~/.gemini/trustedFolders.json` (which a project's MCP servers need; `--skip-trust` does not do it) and the server marked `trust: true`, the server connected and the tool was "not registered"; default mode was tried only with the built-in tools narrowed to `read_file` (`tools.core`, which may itself filter MCP tools), with the same result. Asked to search, the model also handed the question to its own `codebase_investigator` subagent. Qwen, Codex, Kimi and Droid declare neither until a probe on a signed-in account passes: in 2026-09 Codex, Kimi and Droid were not signed in, and Qwen's configured provider rejected every request. Aider, Goose and Ollama were added as base runs (prompt in, reply out) and declare neither; Ollama's plain model run has no tools to search with. A search-capable run may call `kangentic_search` at most `ANSWER_SEARCH_BUDGET` (4) times per question; the server answers a further call with an instruction to answer from what it has, which is what stopped a Grok run making about 50 searches. Read generically by the answer handler and the Knowledge Graph settings tab, never by agent name. |
| `openAnswerSession?(input)` | `(AnswerSessionInput) => AnswerSession` | A warm answering process for one Knowledge Graph chat: started when the graph opens (an idle one makes no model call), asked turn by turn, and disposed when the chat ends, the graph closes, after 10 idle minutes, or on quit (`answer-session-pool.ts`, one live session at a time). Its presence is the capability. It keeps the same read-only flags as `answerFromContext`. The shared transport is `shared/answer-session/stdin-json-session.ts` (one JSON line per user turn, a turn ending on the CLI's result line); the adapter supplies the flags, the turn line, the reducer and the answer extractor. Measured on a 143k-character prompt at Sonnet: first text 2.2 s cold, 1.3 s warm, 0.8 s for a follow-up that sends only the new question. Claude implements it (`--input-format stream-json`). Claude's answer runs also pass `--no-session-persistence` and `autoMemoryEnabled: false`, without which every run left a project folder under `~/.claude/projects`. |
| `parseTranscript?(agentSessionId, cwd)` | `(string, string) => Promise<ParsedTranscript>` | Parse the agent's native session history into agent-agnostic `TranscriptEntry[]` for the MCP `get_transcript` structured format. The adapter owns all format/location knowledge (JSONL file, chat JSONL, SQLite DB), so `handleGetTranscript` never branches on agent name. Reads at most the most recent `MAX_PARSE_SOURCE_BYTES` (16MB) of the source, prepending a `truncated` system entry when it omits anything (see `parseTranscriptWindow` below for the unbounded walk). Must not throw; returns `{ entries: [], sourcePath }` on missing/corrupt history. Implemented by Claude, Droid, Codex, Gemini, Qwen, Kimi, OpenCode, Grok, and Antigravity; Aider/Warp/Cursor/Copilot/Ollama/Goose omit it (raw format only). See [MCP server - get_transcript](mcp-server.md#kangentic_get_transcript). |
| `parseTranscriptWindow?(agentSessionId, cwd, startByte, maxBytes, attributedMessageIds?)` | `(string, string, number, number, Set<string>?) => Promise<ParsedTranscriptWindow>` | Parse ONE bounded byte window of the native transcript, retaining nothing between calls. `parseTranscript` returns only the most recent `MAX_PARSE_SOURCE_BYTES` of a large transcript (a whole-file read is what OOM'd the main process), which is right for a reader but would silently shrink the conversation INDEX to recent history only. The conversation indexer therefore walks with this instead: window by window from offset 0, chunking each window and dropping its entries, so the whole file is indexed while only one window is resident. Pass `nextByteOffset` back verbatim as the next `startByte`; the walk ends when it stops advancing or reaches `totalBytes`. `attributedMessageIds` is the walker's bounded usage-attribution carry, threaded through every window of one file: an agent that reports one API message's tokens on several transcript lines attributes them to the first line it emits, and a per-window dedupe attributes them AGAIN past a seam - invisible to chunking, but a double-counted turn in `conversation_turn_usage`, which keys a row per line uuid. Seed the dedupe from it, add what you attribute, prune it to a small bound before returning, and never reset it per window (a window can legitimately attribute nothing and still sit mid-message). Adapters whose usage is already one-per-line can ignore it. Implementations must NOT cache per-file state (a sweep touches every session, and retaining would evict the live viewer's hot parse state); the carry does not bend that, since it is the caller's and is not retained between calls. Implemented by Claude; adapters without it fall back to `parseTranscript` and index recent history only. It is also the only read that gives a turn end's reply its anchor (see [Transition Engine](transition-engine.md#on-agent-turn-end)); without it, `transcript.finalReply` reads the newest reply in the transcript tail. |
| `readTranscriptPage?(agentSessionId, cwd, request)` | `(string, string, TranscriptPageReadRequest) => Promise<TranscriptPageReadResult>` | One page of the conversation's history for the Conversation viewer, which shows the tail `parseTranscript` reads and loads the rest as the reader scrolls. `request` reads before a cursor, after one, or around a position, at most `maxBytes` of source, never past `untilPosition` (the tail's start). Cursors are the adapter's own opaque strings; the tail's `truncated` notice carries the first one in `earlierHistory`, and every entry a pageable parser produces carries `origin` (its conversation and the position it starts at) so the viewer can place it on a scrollbar spanning the whole conversation. A page must mint exactly the entries a whole-file parse mints for its lines, the same uuids included: JSONL adapters share `readJsonlHistoryPage` (`agent/shared/jsonl-history-page.ts`) with their tail's line parser, and an adapter whose uuids number lines carries a line count in the cursor. A `probe` request (the timeline's) reads only times and positions, so a JSONL adapter skips that line count for it. Answers `reset` when the source was rewritten. Retains nothing between calls. Implemented by Claude, Qwen, Droid, Codex, Kimi, Gemini (JSONL only), Grok, Antigravity and OpenCode (local database only; its unit is the characters of stored data). An adapter without it is read as the tail alone, as before. |
| `transcriptHasTimestamps?` | `boolean` | False for an agent whose transcript records no timestamps: the viewer orders its entries by position, asks for no timeline, and shows no date while dragging the scrollbar. Declared by Grok. |
| `statSubagentTranscripts?(agentSessionId, cwd)` | `(string, string) => SubagentTranscriptSignature \| null` | Cheap staleness signature (`fileCount`, `totalSize`, `maxMtimeMs`) for a session's subagent transcripts, computed without parsing them. Separate from the main transcript's signature on purpose: a subagent writes to its OWN file, so the main transcript's mtime and size never move while a fan-out runs, and an indexer watching only the main signature would never see the subagent turns. Returns `null` when the agent keeps no subagent transcripts for the session (pruned, or it never fanned out). Implemented by Claude (`~/.claude/projects/<slug>/<agentSessionId>/subagents/`); paired with `parseSubagentUsage` below. |
| `parseSubagentUsage?(agentSessionId, cwd)` | `(string, string) => Promise<ParsedSubagentUsage>` | Parse a session's Task-tool subagent turns into agent-agnostic `SubagentUsageTurn[]` for the durable turn-usage ledger (`conversation_turn_usage`). The adapter owns all format and location knowledge, including how one API message's repeated records fold into a single turn. That fold is NOT shareable with the main-transcript parser: Claude's subagent files re-emit a message mid-stream, so the main path's first-record-wins rule undercounts subagent output by 30% while staying exactly right for the main thread, which is why this folds field-wise max per `message.id` instead. `directoryPresent: false` records a coverage gap (no subagent transcripts for this session) rather than a quiet period; `complete: false` marks a partial read, so the caller retries later instead of marking the session indexed. Also returns `spawnLinks`: the spawning calls made BY these subagents, which is what lets a nested subagent resolve to the subagent that spawned it rather than only to a depth number. Those links are collected independently of the usage fold, because a message the ledger skips (no `usage`, or all-zero counts) can still carry the `Task` call that created a child, and a link dropped there is dropped identically on every re-walk. Must not throw. Implemented by Claude (`src/main/agent/adapters/claude/subagent-usage-parser.ts`); adapters with no subagent concept omit it and the ledger carries main-thread rows only, as it always has. |
| `proveConversationGone?(params)` | `({ agentSessionId, reportedPaths, cwd }) => Promise<boolean>` | Prove that a conversation's history file is gone, so a resume of it starts a new conversation from a recap instead of failing with "No conversation found". Returns `true` only on proof; anything else returns `false`, and an omitted method means the check never reports a conversation gone. `reportedPaths` are paths the agent itself reported, never ones Kangentic derived. Implemented by Claude (`adapters/claude/conversation-gone.ts`). See [Session Lifecycle](session-lifecycle.md#a-resume-the-cli-cannot-serve-starts-fresh-instead). |
| `fileChangeTools?` | `ReadonlyArray<{ tool: string; pathField: string }>` | The agent's file-changing tools and the input field naming the file (Claude: `Edit`, `Write` and `MultiEdit` by `file_path`, `NotebookEdit` by `notebook_path`). Read by the memory index's `change` corpus from the conversation chunks' text, where the chunker writes each tool call as `Tool: <name> <json input>` cut at 200 characters, so the changes of a session whose transcript is gone are still found. Measured on 998 real conversations: 90.7% of 47,318 edit calls kept their whole path. Declared here so no tool name reaches `src/main/retrieval/`. An adapter that omits it indexes no changes. |
| `subagentSpawnToolName?` | `string` | The name this agent's subagent-spawning tool carries in a transcript's `tool_use` blocks (Claude: `Task`). Read by the conversation indexer to record `turn_spawn_links` rows, which are the other half of `parent_tool_use_id`: that column names a tool call, and nothing otherwise recorded which turn emitted it. Declared here rather than matched inside `src/main/retrieval/` because the tool name is agent knowledge (see [[agent-adapters-boundary]]); a generic reader hardcoding `Task` would need surgery to admit the next agent, whereas this needs only the string. Filtering on it is also what keeps the link table small - a session emits thousands of tool-use ids and only the spawning ones are ever referenced. An adapter that omits it records no links, which costs nothing and is correct for an agent with no subagent concept. |
| `onProjectRelocated?(oldPath, newPath)` | `(string, string) => Promise<void>` | Migrate per-cwd data the agent keeps OUTSIDE the working directory, keyed by the absolute path, when that path changes. Invoked for two relocations with the same (oldPath, newPath) contract: a whole-project move (the `project:relocate` IPC handler, reached via Locate Folder / Change or the one-step "Move..." flow), and a single worktree-cwd rename on the first resume after a task's worktree was recreated at a new path (`migrateResumeCwdIfRenamed` in `src/main/transition-engine/resume-cwd-migration.ts`, which passes one worktree's old/new path so only that cwd's data moves). Called best-effort after the stored paths are settled and the new location exists. Implemented by Claude, Codex, Gemini, Qwen, Copilot, OpenCode, Kimi, Droid, Grok, and Antigravity (per-agent details in [Project relocation](#project-relocation) below); the shared mechanics (path-pair collection, directory rename/merge, backup + atomic write, serial lock) live in `src/main/agent/shared/relocation-utils.ts`. Implementations must be non-destructive and never block the caller. Aider, Cursor, Warp, and Ollama omit this (their resumable state is in-project or absent). Goose omits it for a different reason: its resumable state is real and global, keyed by the caller-supplied `--name` rather than by path, so a relocation leaves nothing to migrate (see [Project relocation](#project-relocation)). |
| `onWorktreeRemoved?(worktreePath)` | `(string) => Promise<void>` | Drop per-directory state the adapter recorded in a GLOBAL config file for a worktree Kangentic has just deleted. Kangentic creates a worktree per task, so an adapter keyed by absolute path accumulates one dead entry per task forever with nothing to clean it up (one machine reached 473). Dispatched from the single chokepoint inside `WorktreeManager.removeWorktree`, via a listener the main process registers at startup (`setWorktreeRemovedListener` -> `notifyAdaptersWorktreeRemoved`), so the git module never imports the agent registry and no removal path can run un-notified. Generic over `agentRegistry.list()` - no agent-name branching. Best-effort and never fatal: the worktree is already gone. Implemented by Codex (`~/.codex/config.toml` directory trust), Gemini (`~/.gemini/trustedFolders.json`), Qwen (`~/.qwen/trustedFolders.json`), Grok (`~/.grok/trusted_folders.toml`), and Antigravity (`trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`), the five adapters that REAP trust keyed by absolute path in a global file. Claude keys trust that way too (`~/.claude.json` `projects.<path>.hasTrustDialogAccepted`) but does not implement the hook, so its entries accumulate. All remove only an entry they could have written themselves, never a user decision. Grok is the one loose match: it reaps a table carrying nothing but `trusted` and `decided_at`, which is also the shape grok's own prompt writes, so a decline the user recorded by running grok by hand inside a Kangentic worktree goes with it. The hook is used for TRUST only. Several agents also keep cwd-keyed session or history state outside the worktree (the stores [Project relocation](#project-relocation) enumerates, such as Claude's `~/.claude.json` `projects` key and `~/.claude/projects/<slug>/`, Kimi's `~/.kimi/kimi.json` `work_dirs[]`, and Droid's `~/.factory/sessions/<cwd-slug>/`), and none of it is reaped on removal. That is a deliberate gap rather than an oversight: dropping a trust entry for a directory that no longer exists is unambiguously right, whereas deleting a user's conversation history because a worktree was cleaned up is not. |
| `probeAuth?()` | `() => Promise<boolean \| null>` | See the methods table above. |
| `remoteExecution?` | `{ info: AgentRemoteExecutionInfo; probeServer(server): Promise<RemoteServerStatus>; knownTargets?(); adoptTargets?(targets) }` | Declared by adapters whose CLI can attach to an already-running server the user operates, instead of always spawning a local process (e.g. OpenCode's `opencode attach <url> --dir <serverPath>`). `info` (`urlPlaceholder`, `authKind`, `workingDirectoryScope`, `remoteModeCaveat?`) is surfaced to the renderer via `AgentDetectionInfo.remoteExecution` so the Agent settings tab renders remote-mode rows (right after the CLI Path row) only for capability-declaring agents - no agent-name branching, including for the adapter-authored caveat text. `probeServer` replaces `probeAuth` as the reachability check when a project's mode for this agent is `remote`: it must hit the server directly and never throw. `knownTargets` and `adoptTargets` carry the servers main's copy of the adapter learned at spawn (by cwd) to the retrieval worker's own copy, which is handed them with each index job so it reads a remote session's transcript from the same server. Implemented today only by OpenCode. See [configuration.md - Remote Execution](configuration.md#remote-execution). |
| `launchOptions?` | `readonly AgentLaunchOptionInfo[]` | Declared by adapters whose CLI exposes optional boolean startup toggles (id, label, description, default). Surfaced to the renderer via `AgentDetectionInfo.launchOptions` so the Agent settings tab renders one toggle row per declared option, only for capability-declaring agents. Values are resolved by `resolveLaunchOptions` (`src/main/agent/shared/launch-options.ts`) from `agent.launchOptions[agentName]` (falling back to each option's `default`) and threaded through as `CommandOptions.launchOptions`; only the adapter's own command builder interprets an `id` into a concrete CLI flag - no agent-name branching outside the adapter. Implemented today only by Codex, which declares `disableApps` (maps to `--disable apps`, skipping the optional cloud ChatGPT Apps MCP connector that can hang startup at "Booting MCP server: codex_apps" - openai/codex#20167). See [configuration.md - agent.*](configuration.md#agent) for the config shape. |
| `discoverCapabilities?(cliPath, forceRefresh?)` | `(string, boolean?) => Promise<AgentCapabilities>` | Probe the live CLI for adapter-specific knobs (e.g. parsing `--help` for valid effort levels and the presence of a `--model` flag). Result is attached to `AgentDetectionInfo.capabilities` and read by the renderer to gate optional UI controls (Model and Effort dropdowns on `EditColumnDialog`). `forceRefresh` (set when a model dropdown opens) bypasses any adapter-internal capability caches - notably Claude's 12h `/model` picker probe - so a newly shipped model surfaces without a restart; adapters with no cache to bypass ignore it. Implementations must never throw - return an empty object on parse failure so the rest of detection still succeeds. |
| `getInjectionSequence?(spec)` | `(SettingsChangeSpec) => string[]` | Translate a model / effort change into the writes the `TerminalSubmitScheduler` should push onto a live PTY. Used only by the Command Terminal's live swap (`session:injectSettings`); a task session restarts with launch flags instead and never consults it. Sibling of `getExitSequence` - both return `string[]` of writes. Claude returns `['/model X', '/effort Y']` for changed fields. Adapters with no live-swap slash return `[]`, and the Command Terminal then leaves the session as is. |
| `canVerifySlashSubmission?()` | `() => boolean` | Whether a SLASH-prefixed `auto_command` can be verified in this agent's history. Omitted or `true` means yes. Declaring `false` makes `prepareInjectionPlan` tag that command `verify: 'none'`, so it is neither retried nor escalated and the outcome stays `unconfirmed`. Exists because absence from the history file is AMBIGUOUS for agents that handle slash input in the TUI - it cannot distinguish "the CLI rejected it" from "the CLI ran it client-side" - and treating the second as a failure escalates a command that actually worked into a session restart. Declared `false` by Codex, which prints "Unrecognized command" and writes no record; by OpenCode, which declines slash commands the same way; by Grok, whose slash input runs in the TUI palette and never becomes a chat_history turn; and by Antigravity, which rejects an unregistered `/command` client-side ("Unknown command") without recording it. See [command-injection.md](command-injection.md). |
| `canEscalateOnVerificationFailure?()` | `() => boolean` | Whether a verification FAILURE may escalate to a restart-with-prompt. Omitted or `true` means yes. Declaring `false` marks the verifier CONFIRM-ONLY: it still confirms and still drives retry-on-Enter (rung 2, where nearly all the delivery win lives), but is barred from rung 3, because a false negative from an unproven verifier is a guess and escalation acts on that guess by destroying live work. Escalation takes TWO proofs: flush latency measured live (`scripts/measure-injection-flush.mjs`), AND the adapter's own verifier watched confirming a real submission inside a running app. The second is separate because the harness reads the history with its OWN file reader, so it cannot catch a resolver pointing at the wrong path, an uncaptured session id, or a CLI that wraps the stored text - each a PERMANENT false negative that would escalate every delivery. Declared `false` today by Copilot, OpenCode, Qwen, Kimi, Aider, Grok, and Antigravity; only Claude and Codex escalate. Graduation recipe: [command-injection.md](command-injection.md). |
| `describeStartupFailure?(finalOutput, exitCode)` | `(string, number) => string \| null` | Read a STARTUP failure out of the CLI's own final output. Called by the PTY exit listener when a task session ends on its own (never for a kill or a suspend, never for a Command Terminal), with the raw ring and the exit code. A sentence is surfaced through the same "Agent did not start" notice a failed worktree or checkout raises; `null` for a normal end or a crash the adapter cannot name. Claude implements it for `--resume <id>` of a conversation the CLI reports it cannot find ("No conversation found with session ID"); the other startup shapes probed on 2.1.276 either keep the TUI up (bad API key, invalid settings JSON, unknown model) or are not something Kangentic can produce, see the header of `tests/unit/claude-startup-failure.test.ts`. Add a recognizer only for wording seen on a real card. A notice after the fact, deliberately not a pre-spawn guard that downgrades the resume: that was built and reverted in #255 because a path Kangentic computes can be wrong while the conversation is fine. |
| `requiresAgentSessionIdForVerification?()` | `() => boolean` | Whether this adapter's verifier needs a captured `agent_session_id` to locate its history. Omitted or `true` means it does, which is the norm. Declared `false` by Aider and Copilot, for different reasons. Aider has NO session id at all (no `sessionIdCapture` in its `runtime`) because it keeps one `.aider.chat.history.md` per project directory, so `cwd` alone identifies its history. Copilot HAS a session id, but its prompt history is a single GLOBAL `~/.copilot/command-history-state.json` shared across every session and project, so neither the id nor `cwd` plays any part in locating it. Without the opt-out `buildCommandInjectionVerifier` short-circuits on the missing id and the verifier can never confirm - worse than having none, since the burst still retries and then reports `failed` instead of staying silently `unconfirmed`. |
| `transcriptUsage?(input)` | `({ transcriptPath?, agentSessionId?, cwd? }) => Promise<TranscriptUsage \| null>` | Parse CUMULATIVE lifetime token usage for a session from the agent's own transcript - the authoritative source for the per-task lifetime-stats rollup, since the live statusLine token counts are a current-context snapshot (Claude Code 2.1.132+). Prefers the explicit `transcriptPath`, else derives it from `agentSessionId` + `cwd`. Must not throw; returns `null` when the transcript is missing/unparseable so the caller falls back to the snapshot. Implemented by Claude and Grok (Grok reads the last cumulative `turn_completed.usage` from `updates.jsonl`). |
| `transcriptToolCounts?(input)` | `({ transcriptPath?, agentSessionId?, cwd?, sinceMs?, untilMs? }) => Promise<TranscriptToolCounts \| null>` | Sibling of `transcriptUsage`: parse a cumulative tool-call count + per-tool breakdown from the agent's own transcript. Backfills the live `UsageAccumulator` count for sessions whose ToolStart/ToolEnd hook events never reached it (e.g. a parked/suspended session that reports 0 despite real cost/tokens). Counts DISTINCT `tool_use` ids (parallel tool calls in one message count separately; a streamed re-emission of the same message does not double-count). Rows may carry an optional `resultTokens` estimate, which the run-end backfill merges onto a healthy live breakdown. `sinceMs` (the run's start) scopes the answer to one run, since Claude appends every `--resume` to the same transcript, and `untilMs` closes the window (the run-end backfill passes the moment the run ended); an adapter that cannot scope ignores both. A call with no timestamp counts in an open window and is left out of a closed one. Same location contract as `transcriptUsage`; must not throw, returns `null` on a missing/tool-less transcript so the caller keeps the live count. Implemented by Claude, Grok (counting distinct `tool_call` ids in `updates.jsonl`), and Antigravity; only Claude fills `resultTokens` and honors `sinceMs` and `untilMs`. |
| `transcriptToolResultTokens?(input)` | `({ transcriptPath?, agentSessionId?, cwd?, sinceMs?, untilMs? }) => Promise<Record<string, number> \| null>` | Estimated result tokens per tool name for the calls made at or after `sinceMs` and before `untilMs`, behind `session:getToolResultTokens` and the tool-call popover's Tokens column. The live run reads an open window from its start. An earlier run whose record has no estimates (one that ended at app quit) reads a closed window, from its own start to the next run's, and the estimates are written onto its record; that fill reads only from an adapter that declares `scopesTranscriptReadsByTime`. Return null only when the transcript cannot be read: a null makes the fill try the next recorded cwd of the conversation, while an object (even an empty one) is an answer the record keeps. The popover refetches on every tool call, so an implementation must be cheap to repeat: Claude sizes each `tool_result` matched by id (text at chars/4, images by their header dimensions) from a resumable per-path cursor that reads only appended bytes. An adapter without it is never asked, so its transcript is not read for the popover. Implemented by Claude. |
| `supportsReadOnlyLaunch?` | `boolean` | True when `buildCommand` honours `CommandOptions.readOnly`: the agent reads files and calls Kangentic's MCP tools, and has no tool that edits a file or runs a shell command. A workflow's own agent gets it where it is declared; an agent without it can still be one, launched in its default mode and asked by the first message to leave files alone. Declared only once the CLI's flags were measured to hold, since a CLI can let a user's own approval settings outrank them. Set only by Claude. |
| `supportsPlanAutoApproval?` | `boolean` | True when every command `buildCommand` makes registers Kangentic's plan approval hook (`plan-approval-bridge.js`, see [Bridge Scripts](#bridge-scripts)) on the CLI's plan approval prompt, so a plan column or workflow set to Automatic approves its plans. The adapter may also register it on prompts for tools the project allows (`mayApprovePlanTool`), never on any other prompt. A question the agent asks the user always waits. Mirrored as `AgentDetectionInfo.supportsPlanAutoApproval`; without it the Column Manager disables Automatic for the agent and main never approves its plans. Declare it only when the hook was measured against the real CLI to answer only the prompts it is registered on (the plan prompt, and an allowed tool's if `mayApprovePlanTool` is set), with the plan exit's `tool_end` reported only for an approved plan. Set only by Claude. |
| `kangenticMcp?` | `'per-session' \| 'shared-folder'` | How the adapter connects the agent to Kangentic's MCP server when `mcpServerEnabled` is on. `'per-session'`: each session gets its own URL (a flag, an env var, or a file in its session directory). `'shared-folder'`: the URL is written literally into a config file in the working directory, which every session in that folder shares, so the last to start decides the URL the others read. Absent: not wired. Read by `canBeWorkflowAgent` (only `'per-session'` can carry the workflow agent's caller scope) and by handoff prompts. Pinned against the real builders by `tests/unit/kangentic-mcp-delivery.test.ts`. |
| `kangenticMcpBlockedReason?(workingDirectory)` | `string \| null` | Why a session started in that folder would not reach Kangentic's MCP server although the adapter wires it, in the agent's own words, or null. For a CLI that loads the wiring only under a condition Kangentic never decides for the user. A workflow's agent refuses to start with this reason instead of starting without the tools it saves its plan with. Grok: its project MCP loads only in a folder the user trusted in Grok (`isFolderTrusted`, `adapters/grok/trust-manager.ts`, which reads the decision on the folder's real path first). Cursor: the folder's `.cursor/mcp.json` is one Kangentic cannot merge its entry into (`cursorProjectMcpConfigProblem`). |
| `capturesInteractiveSessionId?` | `boolean` | True when an interactive session's own id is captured after launch (its hook, its output, or a folder scan in `runtime.sessionId`), for an adapter whose `supportsCallerSessionId` is false. Declared, not inferred: Cursor's only capture is headless stream-json. With any kind of id (chosen, created or captured) a workflow's agent can resume its conversation. |
| `createSessionId?(cliPath, workingDirectory)` | `Promise<string \| null>` | Create an empty conversation before launch and return its id, for a CLI that takes no id of Kangentic's and prints none in a terminal. The launch then opens that conversation (`sessionId` with `resume` false), so the id is known from the start. Null when the CLI could not create one; never throws. Called only by a workflow's agent on a fresh start, after `supportsCallerSessionId`. Implemented by Cursor (`create-chat`, run in the working directory). |
| `supportsReadableDirectories?` | `boolean` | True when `buildCommand` honours `CommandOptions.readableDirectories`, so a read-only agent can read other projects' checkouts without a permission prompt. A workflow agent without it reads only its own project. Set only by Claude. |
| `configuredModelFromCommand?(command)` | `(string) => { id: string; displayName: string } \| null` | Extract the configured model from a spawned command so the board card can show a friendly model name IMMEDIATELY, before the agent reports its own via status.json / stream telemetry. Returns `{ id, displayName }` (e.g. `claude-opus-4-8` -> "Opus 4.8"), or `null` when the command encodes no explicit model. The seeded value is a placeholder: the agent's own live telemetry overrides it once reported (full usage replace), so a later in-session `/model` change stays accurate. Each adapter owns its own command syntax and model-naming scheme. Implemented by Claude (`adapters/claude/model-display-name.ts`), Grok (`--model` extraction with display names from `~/.grok/models_cache.json`), and Antigravity (`antigravityModelDisplayName`), where the seeded value matters most because Antigravity has no live telemetry to override it. |
| `modelDisplayName?(modelId)` | `(string) => string \| null` | Label a model id the adapter's own discovery did not list: one the app learned from live telemetry (`config.discoveredModelsByAgent`). The pickers union those ids into every list, and without a label they render raw. The `agent:list` handler adds these labels to `capabilities.modelDisplayNames` per call, on top of the cached inventory (`nameLearnedModels`, `src/main/agent/agent-list.ts`), so a newly learned id is named on the next request without a rebuild, and the renderer makes that request as soon as it persists one (`updateConfig` reloads the list on a `discoveredModelsByAgent` write); a name discovery already gave wins, and an entry with no `capabilities` is left alone. Null leaves the raw id. Implemented by Claude, with the same `humanizeClaudeModelId` its discovery uses. |

### `AgentCapabilities`

`src/shared/types.ts`

Adapter-discovered capabilities surfaced to the renderer (returned by `discoverCapabilities`). All fields are optional - adapters that cannot discover a capability leave it undefined and the corresponding UI control is not rendered. Nothing is hardcoded in Kangentic; values come from the live CLI.

| Field | Type | Purpose |
|-------|------|---------|
| `effortLevels?` | `string[]` | Effort/reasoning levels accepted by the CLI's `--effort` (or equivalent) flag. Claude parses these from the `--help` output. Drives the Effort dropdown on `EditColumnDialog`. |
| `supportsModelOverride?` | `boolean` | True when the CLI accepts a model override flag (e.g. Claude `--model <alias>`). When true and `models` has entries, the renderer shows a dropdown; when true and `models` is empty/undefined, the renderer falls back to a free-form text input. |
| `models?` | `string[]` | Model identifiers the user can pick from. Discovered from agent-specific sources: Claude scans `~/.claude/projects/<slug>/<sessionId>.jsonl` for assistant `message.model` values, and merges ids harvested from the CLI's own `/model` picker driven through a hidden short-lived PTY (`model-picker-probe.ts`). The picker probe runs in the background and its result is read from a cache, so discovery never blocks on it; a newly shipped model surfaces on the next discovery after the probe settles, with silent fallback to the transcript scan on any failure. The user sees nothing, but the log does. Each failed or partial run writes one `[model-picker-probe]` warning to the local log (`<project>/.kangentic/logs/<date>.log`, or `<configDir>/logs/` with no project open) naming the stage it stopped at (`scratch-setup`, `spawn`, `trust-dialog`, `select-dialog`, `no-prompt`, `input-not-echoed`, `picker-not-rendered`, `frame-not-settled`, `no-rows`, `error`, or `scroll-incomplete` for a partial scan) and, when the CLI got as far as drawing, the last six non-blank lines of its screen, with absolute paths, email addresses, a welcome greeting's name and API keys redacted (the "use this API key?" dialog prints the key's last 20 characters; the 2.1.290 header names no one, and a cwd it prints as a `~` path is left as drawn). The tag is not in Sentry's console allowlist, so that screen text never reaches Sentry. The probe sets `TERM=xterm-256color` whatever the app's own environment says, because Claude Code draws its prompt as `❯` only when its Unicode check passes ([Environment Stripping and Defaults](cross-platform.md#environment-stripping-and-defaults) says why a packaged Windows launch fails that check). Before `/model` is submitted it types into no dialog. The input box is recognized by its shape (a full-width `─` rule, then `❯` in column 0, measured on 2.1.290), and a `❯` on screen with no input box is a select dialog: no key is sent while one shows. That covers the "use this API key?" dialog, whose options carry no number. Enter goes only to an input box whose own line shows the typed `/model`; the suggestion list under the box repeats `❯ /model` indented and does not count. Once the picker opens, only Arrow Down and Esc reach it. The picker shows ten rows at a time ("… +2 models"), so the probe walks the highlight down with Arrow Down (never Enter, which would change the user's default) until the last row is on screen, and parses every row it saw. A scroll that stops with rows still below is used only until the short failure backoff, and never replaces or overwrites a complete scan. The last good result is kept in `model-picker-last-scan.json` in the app's config directory (per user, never the shared temp directory), so the first discovery after a restart already has the aliases and ids instead of waiting for the background probe; a scan taken with a different CLI path, or an unreadable file, is ignored. Absent when no curated list is available - the renderer falls back to a free-form text input. |
| `modelDisplayNames?` | `Record<string, string>` | Friendly display name per entry in `models` and per `modelAliases` id (e.g. `claude-opus-4-8` -> "Opus 4.8", `opus` -> "Opus"), computed by the adapter (Claude via `buildModelCapabilityFields`, which humanizes with `humanizeClaudeModelId`) so no agent-naming knowledge lives in shared or renderer code. Drives the humanized rows in the Model dropdown (`ModelCombobox`), the ContextBar model popover, and the Model cell of the Column Manager's All columns table, which reads the map of the column's own agent so the row and the column's form print the same label; an id absent from the map falls back to showing its raw id. The `agent:list` handler also adds a label for each telemetry-learned id the adapter can name (`modelDisplayName?`, above), so a learned-only row such as an old dated pin does not render raw. |
| `modelAliases?` | `ModelAliasOption[]` | Floating selectors that follow the latest release of a model family, each `{ id, resolvesTo? }` (e.g. `{ id: 'opus', resolvesTo: 'claude-opus-5-5' }`), in the CLI's own order. The model pickers list them in a "Latest" group, with `resolvesTo` as a muted second column, above one collapsed "Specific versions" section that holds every entry in `models` (`planModelPickerRows`, `src/shared/model-id.ts`). A stored alias displays as its bare family name; the field's hover names the version it runs. Claude derives them in `parseModelPickerScreen`: one alias per model family whose own name labels a `/model` picker row, spelled as the lowercased family word (the CLI's documented "alias for the latest model"), resolving to that family's highest listed version. The picker never prints an alias spelling, so no list of family names exists anywhere. The same scan decides the spawn spelling: `toClaudeModelArgument` turns a stored single word (`"Opus"`) into `opus` only when it is one of these aliases (`peekModelPickerAliasIds`, which reads the cache and never starts a probe), and passes any other word through as written. An alias's other forms (`sonnet[1m]`) stay listed under "Specific versions"; only the exact alias id folds into its Latest row. Absent when the picker has not been read yet or lists no family rows; the pickers then show exactly the `models` list. |

`AgentDetectionInfo.capabilities?: AgentCapabilities` - populated at detection time; absent for adapters that do not implement `discoverCapabilities`.

### Per-Adapter Capability Discovery

Beyond Claude (detailed above) and Ollama (which lists installed models via `ollama list`, see [Ollama](#ollama)), ten adapters each ship their own `src/main/agent/adapters/<name>/capability-discovery.ts`. Most of those that probe the CLI share a common shape built on the bounded session-history scan helpers in `src/main/agent/shared/history-scan.ts` (`listMostRecentDirs` / `listMostRecentFiles` / `readHeadBytes` / `readTailBytes` / `parseJsonlRecords`, all capped so discovery stays fast on a heavily-used install):

1. **Model-override flag** - run `<cli> --help` and regex for a `--model` / `-m` flag to set `supportsModelOverride`.
2. **Model list** - when that flag is present, scan the agent's own on-disk session history for the distinct model ids the user has actually used, sorted ascending so families cluster. An empty result leaves `models` undefined and the renderer falls back to a free-form text input.
3. **Effort levels** - Copilot and Antigravity parse these from `--help`, and Grok reads a real ladder (`low`..`xhigh`) from its models cache; every other non-Claude adapter reports `effortLevels: []` (no CLI effort concept).

All implementations are best-effort and never throw: a help-read or history-scan failure yields conservative defaults so the rest of detection still succeeds. **No adapter keeps a list of model names or ids.** Per `.claude/rules/cli-features-over-custom-layers.md`, a model list is either discovered (from the CLI or from the CLI's own cache) or derived from the id, and a discovery failure reports no list rather than a guess - the renderer then shows a free-form model input. Four adapters deviate from the history-scan probe shape: Droid discovers nothing and hardcodes `supportsModelOverride: false` by design; Grok discovers everything (models, display names, effort ladders) from `~/.grok/models_cache.json`, the CLI's own maintained cache, with a `--help` parse as its fresh-install fallback; Antigravity parses `--help` for flags and effort levels and fetches its model list from the CLI's own `agy models` listing; and Cursor does the same through `cursor-agent --list-models`.

| Adapter | `--model`? | Effort levels | Model list source | Notes |
|---------|-----------|---------------|-------------------|-------|
| Qwen Code | `--help` (`--model` / `-m`) | None | `~/.qwen/projects/<hash>/chats/*.jsonl` - assistant `model` + `ui_telemetry` `systemPayload.uiEvent.model` | Probes both shapes for schema-drift resilience. |
| Gemini | `--help` (`--model` / `-m`) | None | `~/.gemini/tmp/<project-dir>/chats/session-*.{json,jsonl}` across the 50 project dirs whose `chats/` changed most recently (3 newest files each), not only the current cwd's - top-level `model` + each `messages[].model` | Reads single-document `.json` in full; head-scans `.jsonl`. |
| Codex | `--help` (`--model` / `-m`) | None | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` - `turn_context` events' `payload.model` | Codex effort is `config.toml` `model_reasoning_effort` only (no CLI flag), so effort stays empty. |
| GitHub Copilot | `--help` (`--model <...>`) | `--help` `--reasoning-effort` / `--effort` line (commander.js `choices:` format, quotes stripped) | `~/.copilot/session-state/<id>/events.jsonl` (tail) - `session.shutdown` `data.currentModel` / `data.model` / `modelMetrics` keys | The only non-Claude adapter that discovers effort levels; scans the file tail because the model-bearing shutdown event lands last. |
| Kimi | `--help` (`--model` / `-m`) | None | `~/.kimi/sessions/<md5(workdir)>/<uuid>/wire.jsonl` - top-level `model` + `message.payload.model` | Best-effort; upstream CLI research was quota-limited, so the payload probe is deliberately broad. |
| Cursor | `--help` (`--model` only, no `-m`) | None | `cursor-agent --list-models` - `<id> - <Display Name>` lines (skipping the `Available models` header and the `Tip:` footer) | Ids, so a `--model` override round-trips; display names feed `modelDisplayNames`. The `(default)` / `(current)` state markers are stripped, `(NO ZDR)` is kept. The listing is a network fetch, so the result is cached per cliPath and `forceRefresh` bypasses it. Reasoning is encoded in the model id, not a separate flag. |
| OpenCode | `--help` best-effort, defaults false | None | (no history scan) | Model selection is intentionally left to the TUI / `opencode.json` per `cli-features-over-custom-layers.md`; no curated model list. |
| Antigravity | `--help` (`--model`) | `--help` `--effort` line (`low`/`medium`/`high`) | `agy models` subcommand - `slug<TAB>Display Name` lines (skipping the fetch banner) | The one adapter whose model list comes from a CLI subcommand rather than a history scan; `agy models` is a network fetch, so the result is cached per cliPath and `forceRefresh` bypasses it. Display names feed `modelDisplayNames` directly. |
| Droid | No (hardcoded false, no probe) | None | (no history scan) | Intentional: `discoverDroidCapabilities` ignores `cliPath` and returns `supportsModelOverride: false` so the Model / Effort dropdowns stay hidden. TUI-first per `cli-features-over-custom-layers.md`. |
| Grok Build | `~/.grok/models_cache.json` (fallback: `--help` `-m, --model`) | `models_cache.json` `reasoning_efforts[].id` per model (`low`..`xhigh`) | `~/.grok/models_cache.json` `models.<id>.info` (the CLI's own `/model` picker source; `hidden: true` entries skipped) | The cache carries ids, display names (`info.name`), context windows, AND effort ladders in one file grok itself maintains, so nothing is scraped from sessions. The discovery result is memoized per cliPath (mirroring Antigravity), so repointing `agent.cliPaths.grok` re-discovers instead of returning the previous binary's capabilities. |

### `CommandOptions` - new spawn knobs

`src/main/agent/agent-adapter.ts`

Ten recently-added optional fields drive per-spawn overrides. Adapters consume them in `buildCommand` to emit the appropriate CLI flag (or branch) when the value is present:

| Field | Type | Purpose |
|-------|------|---------|
| `model?` | `string` | Adapter-specific model identifier (e.g. Claude `--model opus`). Empty/undefined leaves the agent default in place. Sourced from `swimlane.model_override` at spawn time by `prepare-spawn.ts`. |
| `effort?` | `string` | Adapter-specific effort/reasoning level (e.g. Claude `--effort xhigh`). Empty/undefined leaves the agent default in place. Sourced from `swimlane.effort_override` at spawn time by `prepare-spawn.ts`. |
| `executionTarget?` | `ResolvedExecutionTarget` | Present only when this project's execution mode for the agent is `remote` (see [Remote Execution](#remote-execution) below and [configuration.md - Remote Execution](configuration.md#remote-execution)). Adapters that declare `remoteExecution` read this instead of spawning the CLI locally; `undefined` unambiguously means local. Resolved by `resolveExecutionTarget()` and populated at both spawn chokepoints (`transition-engine.ts`, `session-startup/prepare-spawn.ts`). |
| `launchOptions?` | `Record<string, boolean>` | Fully-defaulted boolean launch-option values for this agent, keyed by `AgentLaunchOptionInfo.id` (e.g. Codex's `disableApps` -> `--disable apps`). `undefined` for adapters that declare no launch options. Resolved by `resolveLaunchOptions()` and populated at both spawn chokepoints (`transition-engine.ts`, `session-startup/prepare-spawn.ts`). |
| `taskProcessTag?` | `string` | The task's `KANGENTIC_TASK_ID` value, the tag a terminal transition reaps by (see [worktree-strategy.md](worktree-strategy.md#reaping-processes-that-pin-a-worktree)). The PTY env already carries it; an adapter whose CLI can strip inherited variables from its tool shells re-injects it (Codex: `-c shell_environment_policy.set.KANGENTIC_TASK_ID=<id>`). Populated at both task spawn chokepoints, and by a Command Terminal's start with the terminal's own made-up task id. |
| `ptySessionId?` | `string` | Kangentic's id for the session this command is built for: the `id` the build site then hands `sessionManager.spawn` (not the agent's own `sessionId`). An adapter that writes a file every session in a folder shares holds it under this id, and the session layer releases it with `removeHooks(directory, ptySessionId)`. Set by all four build sites (`transition-engine.ts`, `session-startup/prepare-spawn.ts`, a Command Terminal's start, a workflow's agent); `spawn-entry-point-parity.test.ts` fails a build site without it. A built command that never becomes a session releases its hold through `releaseCommandHold`. |
| `bypassAvailable?` | `boolean` | Launch with the bypass permission mode available but not on, so a plan Kangentic approves can continue in it. Set only for a plan-mode spawn whose approved plan would continue in `bypassPermissions` (`planApprovalModeForSpawn`), at both task spawn chokepoints, and only for an adapter that declares `supportsPlanAutoApproval`. Claude maps it to `--allow-dangerously-skip-permissions`: measured on 2.1.302, the approval's mode switch reaches bypass only in a session launched with it. Adapters without such a launch option ignore it. |
| `capturePromptText?` | `boolean` | Carry the submitted prompt's text in the Prompt event's `detail`. Set only by a Command Terminal's start, whose namer (`command-terminal-namer.ts`) names the terminal from its first prompt; a task spawn never sets it, so task sessions' events keep no prompt text. An adapter whose prompt hook carries no text ignores it. |
| `readOnly?` | `boolean` | Launch with no tool that edits a file or runs a shell command, and with Kangentic's MCP server as the only one. Set only for a workflow's own agent, and only on an adapter that declares `supportsReadOnlyLaunch`. Claude maps it to `--tools Read,Grep,Glob,ToolSearch`, `--strict-mcp-config` and `--no-chrome` (`READ_ONLY_TOOLS` in `adapters/claude/command-builder.ts`). |
| `readableDirectories?` | `readonly string[]` | More directories the agent may read beyond its `cwd`: other projects' checkouts, for a workflow agent planning tasks on their boards. Set only on an adapter that declares `supportsReadableDirectories`. Claude emits one `--add-dir` per directory. |

A task session never switches model or effort live: any change to a concrete value restarts it with the new launch flags (see [Command Injection](command-injection.md)). Only the Command Terminal, which has no session to `--resume`, switches live, through `getInjectionSequence` in the Optional Properties table above. The adapter declares the slash-command writes and `TerminalSubmitScheduler.scheduleKeystrokes` delivers them via `TerminalSubmit.submitKeystrokes`, unverified (a transient session has no task row for the verifier to resolve). `getSubmissionVerifier('command-injection')` confirms a task's column message instead.

### `AdapterRuntimeStrategy`

`src/shared/types.ts`

One scannable block per adapter for activity-state derivation and session ID capture:

| Field | Type | Purpose |
|-------|------|---------|
| `activity` | `ActivityDetectionStrategy` | How thinking-vs-idle is detected. See [Activity Detection](activity-detection.md) for the discriminated union variants and the `ActivityDetection.hooks() / pty() / hooksAndPty()` factories. |
| `reportsTurnEnd` | `boolean` | Required. Whether the agent says when its turn ended, through a hook or its wire protocol, so the activity engine gets a real `Idle` event and the session manager emits `'turn-ended'`. That event is what runs a column's On agent turn end automations. False where the only idle signal is terminal silence or a prompt pattern, because a quiet compile looks the same; such a column offers no On agent turn end group. True for Claude Code, Codex CLI (its Stop hook, task #859), Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Grok Build, Antigravity CLI and Kimi Code (its wire `TurnEnd`, an Idle event since task #859); false for Aider, Droid, Goose CLI, Cursor CLI, Ollama and Oz CLI (Warp). Surfaced to the renderer as `AgentDetectionInfo.reportsTurnEnd` on `agent:list`. |
| `sessionId.fromHook?(hookContext)` | `(string) => string \| null` | Parse the agent's CLI session ID from hook stdin JSON. Fires once on `session_start`. Used by Gemini (`session_id` field) and Codex (`session_id`, or `thread_id` on older payloads, from the full SessionStart hookContext that event-bridge captures from the hook stdin). |
| `sessionId.fromOutput?(data)` | `(string) => string \| null` | Parse the agent's CLI session ID from raw PTY output. Scanned on every data chunk by `SessionIdScanner` (chunk-boundary-safe rolling buffer with ANSI stripping), plus a final scrollback scan in `suspend()`. Used for Codex's startup header and Gemini's shutdown summary. |
| `sessionId.fromFilesystem?(options)` | `({ spawnedAt, cwd }) => Promise<string \| null>` | Locate the agent's session ID by scanning the filesystem for a freshly-created session file. Polls the expected directory for files created after `spawnedAt` with a matching `cwd` in the session metadata. Primary capture path for Codex 0.118+ (neither PTY output nor hooks deliver the ID; the UUID is in the rollout filename at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`). |
| `sessionHistory?.locate({agentSessionId, cwd})` | `(options) => Promise<string \| null>` | Locate the agent's native session history file on disk for a captured session UUID. Used by `SessionHistoryReader` (`src/main/pty/readers/session-history-reader.ts`) to start tailing. See [Adapter Session History](adapter-session-history.md) for the full pipeline. |
| `sessionHistory?.parse(content, mode)` | `(string, 'full' \| 'append') => SessionHistoryParseResult` | Parse newly-appended bytes (Codex JSONL, Claude transcript JSONL) or full file content (Gemini JSON) into a `SessionHistoryParseResult` containing `usage`, `events[]`, and an optional `activity` hint. For Claude this is a background-session fallback to the `statusFile` pipeline - see [Adapter Session History](adapter-session-history.md#claude). |
| `sessionHistory?.isFullRewrite` | `boolean` | `true` for whole-file-rewrite agents (Gemini), `false` for append-only JSONL (Codex, Claude). Tells the watcher whether to track a byte cursor. |
| `sessionHistory?.suppressesPtyFallback` | `boolean` | Whether the history file may turn the PTY tracker off for a `hooks_and_pty` agent, on its first read and on a turn-initiating event it reports. Default true, which suits a file that carries the agent's turns (Kimi's wire.jsonl). False for Codex, whose rollout reports only background commands, interrupts and failed turns beside its hooks, so a session whose hooks Codex did not confirm keeps the tracker (task #859). |
| `statusFile?.parseStatus(raw)` | `(string) => SessionUsage \| null` | Decode the rewritten contents of a per-session `status.json` (written by Kangentic's status-bridge hook) into a `SessionUsage` snapshot. Used by Claude Code and Copilot. Adapters that report plan-usage quotas populate `SessionUsage.rateLimits?: RateLimitWindow[]` - each window self-describes via `id`, `label`, `iconKind: 'session' \| 'period'` (renderer maps to a Lucide icon), `usedPercentage` (0-100, clamp at the adapter), `resetsAt` (Unix epoch seconds), and optionally `windowDurationSeconds` (fixed window length; with `resetsAt` it yields the window start for the renderer's elapsed-time marker line, omitted when a provider's window has no fixed duration, in which case that window simply shows no time marker). A window also has `generation`, which the adapter never sets: main's `RateLimitLedger` stamps it on every report before caching it (see `reportsRateLimits` above). The renderer iterates the array; no per-agent branching. Today only Claude populates this field. |
| `statusFile?.parseEvent(line)` | `(string) => SessionEvent \| null` | Decode one appended line from the per-session `events.jsonl` (written by the event-bridge hook) into a `SessionEvent`. |
| `statusFile?.isFullRewrite` | `boolean` | `true` when `status.json` is fully rewritten on every update. The events file is always append-only regardless of this flag. |
| `streamOutput?.createParser()` | `() => StreamOutputParser` | Build a per-session parser that consumes raw PTY stdout for telemetry. Used by agents that emit machine-readable NDJSON to the terminal (Cursor's `--output-format stream-json` init event carries `model` + `session_id`). The returned object exposes `parseTelemetry(data)` returning `{ usage?, events? } \| null`; `SessionManager` invokes it on every PTY chunk. Each spawn gets a fresh parser so per-session rolling buffers can survive across chunk boundaries. |
| `backgroundShells?.resolveOutputFile({cwd, shellId})` | `(options) => string \| null` | Locate the agent's on-disk output file for a NAMED background shell, or `null` when it has none. The bg-shell process-tree watcher stats this file each poll cycle; file growth is ground-truth liveness that keeps a genuinely-running shell from being reclaimed at the 5-min named cap when no OS PID could be captured (see [Activity Detection](activity-detection.md), Output-file liveness). Today only Claude implements this (its temp `tasks/<shellId>.output` files). |
| `backgroundShells?.reportTerminatedShells?({cwd, agentSessionId, shellIds})` | `(options) => string[]` | Report which of `shellIds` have a TERMINAL notification in the agent's durable session transcript - definitive proof of completion (task #386), independent of process-tree/output state. Reads only new transcript bytes since the previous call. Today only Claude implements this (its native transcript carries the holder's terminal `<task-notification>`; when the CLI is mid-turn it delivers that notification as a `queued_command` attachment which fires no hook, and mid-turn is exactly when a drain matters - see [Activity Detection](activity-detection.md), Transcript drain). Covers both backgrounded Bash shells and `Monitor` waits, which share the same id space, output store, and notification wrapper. |
| `permissionPrompts?.reportRejectedPromptTools?({cwd, agentSessionId, toolIds, sinceMs})` | `(options) => string[]` | Report which of `toolIds` were manually REJECTED, per a terminal marker in the agent's durable session transcript at or after `sinceMs` - the only signal for a denial no hook can report (task #640). `SessionTelemetry` polls this every 2s while any session is `permissionPending`. Today only Claude implements this (a denied tool never runs, so `PostToolUse` never fires, and the turn aborts rather than ending, so `Stop` never fires either; the durable transcript still records the denial as a `tool_result` - see [Activity Detection](activity-detection.md), Permission flag). |

Omit `sessionId` entirely for agents that use caller-owned IDs (Claude and Grok via `--session-id`) or that have no resume mechanism (Aider). Omit `sessionHistory` for agents without a native session log file. Omit `statusFile` for agents that don't emit hook-driven `status.json` / `events.jsonl` (Claude, Copilot, and Grok use this pipeline today; Grok's `parseStatus` is null because it has no statusline, but its hook-driven `parseEvent` is live). Omit `streamOutput` for agents that don't emit machine-readable NDJSON to PTY stdout (everyone except Cursor today). Omit `backgroundShells` for agents that don't write a per-shell output file or expose a transcript-based termination signal (everyone except Claude today). Omit `permissionPrompts` for agents whose hook protocol already reports a denial directly, or whose transcript carries no such signal (everyone except Claude today).

### `SpawnSessionInput` extras

| Field | Type | Purpose |
|-------|------|---------|
| `agentName?` | `string` | Human-readable agent name (`'claude'`, `'gemini'`, etc.) captured at spawn time. Used in diagnostic logs - survives production minification unlike `agentParser.constructor.name`. |
| `agentSessionId?` | `string \| null` | Caller-owned agent session UUID. Set when the adapter declares `supportsCallerSessionId = true` and the spawn pipeline pre-generates a UUID before invoking the CLI (Claude `--session-id`, Qwen `--session-id`, Kimi `--session`, Grok `-s`). Lets `session-spawn-flow.ts` call `sessionHistoryReader.attach()` immediately at spawn time without waiting for capture pathways to round-trip, and skips the 30s "session ID not captured" diagnostic timer. Null/undefined for adapters that auto-generate IDs (Codex, Gemini, Droid). |
| `permissionMode?` | `PermissionMode \| null` | The resolved permission mode the session spawns under, the same value its record's `permission_mode` gets. Kept on the registry row (`SessionManager.getSessionPermissionMode`) because the `session_spawn` analytics event fires inside `spawn()`, before the caller inserts that record. Passed by all three task spawn sites; a Command Terminal passes none. |

## Supported Agents

| Agent | Adapter | CLI Binary | Session Resume | Status/Events | Settings Merge | Kangentic MCP | Trust |
|-------|---------|-----------|----------------|---------------|----------------|---------------|-------|
| Claude Code | `claude-adapter.ts` | `claude` | `--resume <id>` | Yes (status.json + events.jsonl; transcript fallback for background sessions, see [Adapter Session History](adapter-session-history.md#claude)) | Yes (`--settings`) | `--mcp-config <sessionDir>/mcp.json` | Yes (`~/.claude.json`) |
| Codex CLI | `codex-adapter.ts` | `codex` | `resume <id>` | Yes (events.jsonl via `-c hooks.*` overrides, rollout for usage and background commands) | No | `-c mcp_servers.*` overrides + `buildEnv` token | Yes (`~/.codex/config.toml` `[projects]`) |
| Gemini CLI | `gemini-adapter.ts` | `gemini` | `--resume <id>` | Yes (status.json + events.jsonl) | Yes (`.gemini/settings.json`) | `mcpServers` in `.gemini/settings.json` (`httpUrl`) with `${VAR}` env refs + `buildEnv` URL/token | Yes (`~/.gemini/trustedFolders.json`) |
| Qwen Code | `qwen-adapter.ts` | `qwen` | `--session-id <uuid>` (caller-owned) / `--resume <id>` | Yes (events.jsonl) | Yes (`.qwen/settings.json`) | `--mcp-config <sessionDir>/mcp.json` (`httpUrl`; `.qwen/settings.json` before 0.16) | Yes (`~/.qwen/trustedFolders.json`) |
| Cursor CLI | `cursor-adapter.ts` | `cursor-agent` (alias `agent`) | `--resume="<id>"` | No | No | `<cwd>/.cursor/mcp.json` with `${env:...}` url/token + `buildEnv` + `--approve-mcps` | No |
| GitHub Copilot CLI | `copilot-adapter.ts` | `copilot` | `--session-id <uuid>` (caller-owned) | Partial (events.jsonl + status parser) | Per-session `--config-dir` | `--additional-mcp-config @<path>` | Runtime `--add-dir` |
| Aider | `aider-adapter.ts` | `aider` | No | No | No | Not possible (CLI has no MCP client) | No |
| Oz CLI (Warp) | `warp-adapter.ts` | `oz` | No | No | No | Not wired | No |
| Kimi Code | `kimi-adapter.ts` | `kimi` | `--session <uuid>` (caller-owned) | Yes (`wire.jsonl`) | No | `--mcp-config-file <sessionDir>/mcp.json` | No |
| Droid | `droid-adapter.ts` | `droid` | `--resume <uuid>` | No (PTY-only) | No (use Droid's TUI: `/model` + Ctrl+D, shift+tab) | `<cwd>/.factory/mcp.json` + `buildEnv` token | No |
| OpenCode | `opencode-adapter.ts` | `opencode` | Plugin/PTY-captured `ses_<id>` (auto-generated) | Yes (plugin JSONL via `tool.execute.before/after` + `event` `session.*`) | No (`opencode.json` + `OPENCODE_CONFIG_CONTENT` env) | `OPENCODE_CONFIG_CONTENT` (local spawns only) | No (auth via `opencode auth login` -> `~/.local/share/opencode/auth.json`) |
| Ollama | `ollama-adapter.ts` | `ollama` | No | No | No | Not possible (CLI has no MCP client) | No |
| Grok Build | `grok-adapter.ts` | `grok` | `--session-id <uuid>` (caller-owned) / `--resume <id>` | Yes (events.jsonl via Claude-compatible hooks; usage from `updates.jsonl` tail) | No (wholly-owned `.grok/hooks/kangentic.json` + `.grok/config.toml` sentinel block) | `[mcp_servers.kangentic]` block in `<cwd>/.grok/config.toml` with `${VAR}` env refs + `buildEnv` URL/token | Yes (`~/.grok/trusted_folders.toml`, cascades from project root) |
| Antigravity CLI | `antigravity-adapter.ts` | `agy` | `--conversation <id>` | Yes (events.jsonl via `.agents/hooks.json`) | Yes (`.agents/hooks.json`, named-hook merge) | Workspace plugin `.agents/plugins/kangentic/` (`serverUrl` + token header) | Yes (`trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`) |
| Goose CLI | `goose-adapter.ts` | `goose` | `-r -n <name>` (caller-owned name) | No (PTY-only) | No | Not wired | No |

The Kangentic MCP column, by `kangenticMcp`: Claude, Codex, Copilot, Kimi, OpenCode, Grok, Cursor,
Qwen and Gemini are `'per-session'`; Droid and Antigravity are `'shared-folder'`, because each
writes the session's literal URL into a file in the working directory. Gemini moved to a fixed
`settings.json` entry whose URL and token are `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}`
(Grok's and Cursor's pattern) in task #859, measured on 0.64.0: an MCP request arrived on the path
the session environment named, and the token is no longer written to disk. Its hook commands carry
the events path the same way (`env:KANGENTIC_EVENTS_PATH`). The same move is undocumented for
Droid's `url` and for Antigravity, and each waits on a live run before it changes, since it alters
every session on that agent. Qwen moved to `--mcp-config` because its workspace MCP approval gate stopped every session
on a dialog (see [Qwen's MCP approval gate](#kangentic-mcp-server-and-the-approval-gate)); that move also made it eligible as a Workflow
agent, which has not been run live. Cursor's interactive and print sessions use the same static
`${env:...}` entry its answer path measured; the interactive path has not been run live yet.
Goose's `streamable_http` extensions take `headers` with `${VAR}` (its source), but its CLI flag
takes only a URL, and a config-file entry has not been run live, so it stays unwired.
Grok reads its project block only in a folder the user trusted in Grok, which Kangentic never
decides for them.

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

Each adapter implements `detectFirstOutput(data)` to spot its first output. A match times the
boot geometry re-assert (see [session-lifecycle.md](session-lifecycle.md)'s "Post-boot geometry
re-assert"). It does not lift the launch overlay for an agent session; see "The launch overlay"
below for what does.

| Agent | Detection Strategy | Rationale |
|-------|-------------------|-----------|
| Claude Code | `\x1b[?25l` (cursor hide) | The pwsh and Windows PowerShell startup frames carry the same escape, so it times the geometry re-assert only, not agent liveness (see The launch overlay) |
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
| Grok Build | `\x1b[?25l` (cursor hide) | Rust alt-screen TUI; the cursor-hide arrives in the very first output chunk, before the alt-screen switch (verified via node-pty against grok 1.0.0) |
| Antigravity CLI | `data.length > 0` | First paint (logo + welcome banner) arrives as one plain-text burst well under a second after spawn (verified against agy 1.1.13) |
| Goose CLI | `data.length > 0` | Streams output immediately (no alternate screen buffer) |

**A detector match is never proof the agent is running.** A shell can emit the same escape
during its own startup: the startup frame of pwsh 7.6 and of Windows PowerShell carries
`\x1b[?25l`, so on PowerShell the latch trips on SHELL bytes tens of ms after spawn, seconds
before the agent process exists, and a `data.length > 0` detector trips on the first byte of
any shell. Anything needing "the agent is demonstrably driving the terminal" must key on the
stream's first alt-screen entry (`PtyBufferManager`'s `onAltScreenEnter`) or on the evidence
below. Misreading this latch as agent liveness is what made the task #573 spawn-race fix miss
its target on PowerShell, and what showed the PowerShell prompt for about three seconds before
Claude's TUI in a Command Terminal.

### The launch overlay

A terminal's launch overlay lifts when `SessionManager.markAgentReady` says the session's agent
is on screen. That is the `session:firstOutput` push and the renderer's `sessionFirstOutput`
map. It fires once, on the first of:

- **The agent's first text after the shell ran the spawn command.** Every agent spawn types the
  shell's own clear in front of the agent command (`buildSpawnClearPrelude`). Under Windows
  PowerShell 5.1, pwsh 7.6 and cmd, ConPTY renders that clear as line erases plus `\x1b[3J`,
  with no `\x1b[2J`. Git Bash, WSL and Linux's ncurses `clear` send `\x1b[H\x1b[2J\x1b[3J`, and a
  terminfo without the E3 capability sends the `\x1b[2J` alone. ConPTY's own startup clear is a
  `\x1b[2J` with nothing printable ahead of it. So the first visible text after either clear,
  when printable text came before that clear, is the agent's, or the shell's error when the
  agent could not start. `AgentOutputTracker` in the pty host reports it as `agentOutput`. It
  needs nothing from the adapter, which is why it covers inline agents (Aider, Cursor, Ollama,
  Goose, Warp, Antigravity) as well as TUIs.
- **The first alt-screen entry.** No shell enters the alt buffer. A fullscreen Claude Code
  enters it before it prints anything, so this is usually what fires for Claude.
- **The agent's SessionStart hook.** For an agent with hooks, measured about 0.4 s after
  Claude's alt-screen entry.
- **A 15 s ceiling** (`AGENT_READY_CEILING_MS`), the backstop for a stream none of the above
  fits. One known case: a terminfo whose clear is `\x1b[H\x1b[J` (TERM=screen, so a dev build
  launched from GNU screen) sends neither erase the handoff test matches. That pair is left out on
  purpose: it is plain cursor-home plus erase-below, and no shell's redraws before the typed
  command runs were measured free of it. The pty host stops scanning a session's output at the
  same 15 s mark.

A session with no agent keeps its raw first output: its shell is the output. Usage is not
evidence either way. The spawn seeds it with the model name from `--model`
(`configuredModelFromCommand`), seconds before the agent draws.

The terminal under the overlay mounts at once and drops PTY output until the lift, then replays
the scrollback. Mounting early is what sizes the PTY: a cold spawn starts at 120x30, and the
mount's fit resizes it to the window before the agent's first frame. Measured in a /preview, a
Command Terminal went from spawn to Claude's TUI in 3.0 to 3.1 s under Windows PowerShell with
the terminal hidden, the same as with it showing the prompt, so no boot query waits on a reply
from the hidden terminal.

## Exit Sequences

Graceful exit sequences written to the PTY before a force-kill, for every agent that is typed into. `SessionManager.suspend()` writes one for each such session; `kill()` writes one for a young one (inside the agent's boot window, see the `kill()` grace in [session-lifecycle.md](session-lifecycle.md)); the quit path's `killAll()` writes one best-effort for each such session; the pty host writes one to an agent whose shell died on its own. An agent whose console close is its graceful exit (see below) gets no sequence on kill, suspend or quit. A step may be a pause (`{ delayMs }`), so keys the TUI must read apart never share a burst.

An adapter whose `consoleCloseIsGraceful(platform)` answers true is never typed into on that platform: kill, suspend and quit close its console at once, and its sequence serves only the dead-shell ask. Claude Code answers true on Windows, measured on 2.1.302 in every state a session can be in, and on Linux, where the close is node-pty's hangup, measured on 2.1.304 in the same states ([session-lifecycle.md](session-lifecycle.md), the 2.1.302 table and the Linux table after it).

| Agent | Sequence | Notes |
|-------|----------|-------|
| Claude Code | `Esc`, 400 ms, `Ctrl+C`, `/exit` | Windows and Linux: console close or hangup instead, except for a dead Windows shell. Typed on macOS. Esc stops a running turn or declines a permission prompt, so Ctrl+C clears the input rather than interrupting a turn, which would put the prompt back with `/exit` appended and send it as a new turn |
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
| Grok Build | `Ctrl+C`, `/quit` | `/quit` exits cleanly (probe-verified exit 0) and prints the conversation dump that transcript cleanup anchors on |
| Antigravity CLI | `Ctrl+C`, `Ctrl+C` | First Ctrl+C prints "press ctrl+c again to exit" (or cancels a running turn); the second exits gracefully, printing the `agy --conversation=<uuid>` resume summary (the fromOutput capture source) and flushing `cache/last_conversations.json`. No `/quit` slash command exists |
| Goose CLI | `Ctrl+C`, `/exit` | Goose's Ctrl+C is contextual: it clears the line if text is entered, interrupts the request if one is processing, and exits only when the line is already empty. A kill usually lands mid-turn, where Ctrl+C alone only interrupts, so the explicit `/exit` is what ends the session before the teardown grace expires |

A sequence that ends in Enter can answer an open permission prompt: Claude's old `\x03` + `/exit\r` approved the pending tool, because the Enter landed on the highlighted Yes. `scripts/probe-agent-dialog-exit.js` checks the other agents for that, by typing each one's sequence into its own shell-command prompt. Measured 2026-10-19 on Windows:

- Gemini CLI 0.64.0 and Copilot CLI 1.0.98 are safe. Ctrl+C cancelled the request and the tool never ran. The slash command that followed did not take, so the CLI kept running until the force-kill.
- Qwen Code, Kimi Code and Droid were not measured (not logged in on the probing machine), nor Grok 1.0.0 (the service refused the outdated version) or Aider, Goose and Ollama (not installed). Rerun the probe for one of them before changing its sequence.
- Codex, Cursor, OpenCode, Oz (Warp) and Antigravity send Ctrl+C only, with no Enter that could answer a prompt.

## Background commands

A background command the agent starts (a build, a test run, a dev server) holds its task `thinking` until the command exits, so a task never reads idle while its work runs. A command that is meant to stay up, a server or a watcher, is released by the agent with `kangentic_mark_background_service`, or kept out of the hold from the start by `--kangentic-no-activity-hold` in its command. Both end the hold without stopping the process. The engine side is in [Activity Detection](activity-detection.md), "Opting a background shell out of the hold".

An agent takes part only when it declares `backgroundCommands`. A declaration is a measured claim with four conditions. `tests/unit/background-commands-declaration.test.ts` pins the list and checks the first two; the other two were measured against the real CLI:

- Activity is driven by hooks or a history file (`hooks_and_pty`), so the PTY tracker is off once that source flows and PTY silence stops ending turns. While a session still runs its PTY tracker (a Codex session whose hooks never flowed), PTY silence keeps every tracked shell: `handlePtyIdle` ends the turn through `forceIdle` with `keepBackgroundShells`, so the hold lasts until the command exits.
- `kangenticMcp` is `'per-session'`. A folder-shared URL can name another session, so a mark could land on the wrong one.
- The launch, foreground, stop and flagged payloads were captured from the real CLI and are pinned as fixtures (`tests/fixtures/<agent>-hooks/`, `tests/fixtures/kimi/wire-background-tasks.jsonl`).
- The process runs inside the PTY root's process tree, where the background-shell watcher can see it end. A process started outside it is never adopted, and the hold would be reclaimed after about 30 quiet cycles, which brings back "reads idle while a build runs".

An agent that does not declare emits no background start or end, gets no hint, and is not offered the MCP tool (`resolveBackgroundShells` in `mcp-http-server.ts` checks `SessionManager.reportsBackgroundCommands`). It never gains a hold it cannot release.

| Agent | Starts and ends reported by | Launch hint | Decision |
|-------|-----------------------------|-------------|----------|
| Claude Code | PreToolUse and PostToolUse remaps of `Bash` and `PowerShell` with `run_in_background`, the shell id in `tool_response.backgroundTaskId`; `KillShell` ends one | Yes | Declared. Payloads pinned by the replay fixtures |
| Qwen Code 0.25.3 | PostToolUse: `run_shell_command` with `tool_input.is_background`, id read from the text after `\nid: ` in `tool_response.llmContent` (observed as `bg_<hex>`); `task_stop` ends one (`tool_input.task_id`) | Yes, `hookSpecificOutput.additionalContext` | Declared. Hooks of one event run in parallel |
| Gemini CLI 0.64.0 | AfterTool: `run_shell_command` with `is_background`, the PID read from "Command moved to background (PID: N)". No stop tool, so the end is the process's exit | Yes, AfterTool `additionalContext` | Declared. Became per-session: the MCP URL and token are `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}` references Gemini expands from the session environment, so `.gemini/settings.json` holds neither, and Gemini can now be a workflow's agent |
| GitHub Copilot CLI 1.0.100 | postToolUse: `powershell` and `bash` started async, the `shellId` read from the result text (agent-chosen or assigned); `stop_powershell` and `stop_bash` end one when `resultType` is `success` | Yes, top-level `additionalContext` (`hookSpecificOutput` is ignored) | Declared. A `detach: true` launch is excluded: the agent declared that process independent of the session |
| Grok Build 1.0.0 | PostToolUse: `run_terminal_command` whose `toolResult.type` is `BackgroundTaskStarted`, id `toolResult.task_id`; `kill_command_or_subagent` whose result is `KillTask` ends one | No, its PostToolUse output never reaches the model | Declared. The agent learns of the tool from its description |
| Kimi Code 1.37.0 | wire.jsonl: a `Shell` ToolResult with message "Background task started." and a `background_task` display block naming the task id; `TaskStop`'s result and the task's `task.*` Notification end one | No, its PostToolUse hook reads only a block or deny decision | Declared. Activity moved to `hooks_and_pty`: the first wire read turns the PTY tracker off, and `TurnEnd` is now an Idle event, so On agent turn end automations run for Kimi. Measured in the interactive TUI, every record reaches wire.jsonl 13 to 40 ms after its own timestamp |
| Codex CLI 0.154.0 and 0.163.0 (fixtures captured on 0.154.0, the TUI and the trust read run on 0.163.0) | The rollout: a command still running at its yield (`Process running with session ID N`) starts one, keyed by the call id its PreToolUse carried; a `write_stdin` poll that finds it exited ends one. No hook fires at the yield, and `write_stdin` fires none | No, no hook fires at the launch | Declared. Codex runs Kangentic's hooks once its trust read confirms them (see [Codex Hook Integration](#hook-integration)): activity is `hooks_and_pty`, and the Stop hook's Idle makes On agent turn end automations run for Codex. Only the exec status block before `Output:` is read, so a command that prints the phrase is never a launch |
| Droid 0.218.0 | Not reported | No | Not declared. `Execute` with `fireAndForget` starts the command through `Start-Process`, whose parent exits at once, so the process is outside the PTY root's tree and the watcher cannot see it end. Detached by design, like Copilot's `detach: true`. The `droid exec` payloads this was decided from are in `tests/fixtures/droid-hooks/`. Its activity stays on the PTY tracker: a hook pipeline through `--settings` was measured in `droid exec` (the file merges with the user's `~/.factory/settings.json`; SessionStart, PreToolUse, PostToolUse and Stop fire; UserPromptSubmit did not), but the TUI asks for a Factory sign-in even with a BYOK model, so its prompt, permission and interrupt events were never seen and the pipeline is not built |
| Cursor CLI | Not reported | No | Not probed: the CLI needs a signed-in account to run, so neither its background `shell_id` nor its hooks were seen against the real CLI. Its activity stays as it was |
| Antigravity CLI 1.3.4 | Not reported | No | Not declared. `run_command` backgrounds after `WaitMsBeforeAsync`, but the PostToolUse payload carries no tool output, so there is no id to key on, and the hook's reply must be `{}` |
| OpenCode 1.18.31 | Not reported | No | Its `bash` tool cannot run a command in the background |
| Goose CLI 1.55.0 | Not reported | No | No background commands: its `shell` tool takes only `command` and `timeout_secs`, returns when the command ends and kills it at the timeout (probed headless against a local stand-in for the model API). Not wired, and Goose has no Kangentic MCP |
| Aider, Oz CLI (Warp), Ollama | Not reported | No | No background commands |

### How a hook-driven declaration is wired

Each declaring adapter keeps one `BackgroundCommandSpec` (`src/shared/background-command-spec.ts`) in its adapter folder: which tool calls are a launch (tool names, `when` and `unless` conditions on the payload, where the id sits, and the literal text that frames an id inside result text), which are a stop, and the hint's reply envelope. Shared builders in `src/main/agent/shared/background-command-hooks.ts` turn it into directives and the hint command, so the hold and the hint answer the same calls.

- The launch and the stop ride the adapter's existing post-tool `tool_end` entry as two more directives, `appendBackgroundLaunch` and `appendBackgroundStop`. The event bridge writes their `background_shell_start` and `background_shell_end` lines beside the tool's own event, in one append. A separate entry would cost a second hook process per tool call, and Copilot and Grok run one event's hooks one after another, measured at 0.6 to 0.9 s each.
- The start carries no `toolId`. A start with one closes that pending tool, and the tool's own `tool_end` would then decrement the count a second time. With no tool id for the memo, a launch whose command carries `--kangentic-no-activity-hold` reports it on the start itself (`noActivityHold`).
- A stop is read on the stop tool's post-tool success payload, never pre-tool, so a denied or failed stop never drains a live command.
- The hint is its own entry, matcher-scoped to the launch tools, running `background-shell-hint-bridge.js` with a v2 spec (`{ launch, reply }`) built from the same launch match. It is added only when the session's MCP URL names it as the caller (`offersMarkBackgroundService`).
- A CLI whose hooks take bare tokens (Qwen on Windows) runs a workspace copy of the hint bridge, `<cwd>/.kangentic/qwen-background-shell-hint-bridge.cjs`. `copyBridgeInto` refuses a copy name that does not contain the script's name, which is what lets `isKangenticHookCommand` recognize the copy during cleanup.
- The matching code is in both bridges between `// BEGIN background-call-match` and `// END background-call-match`, since a workspace copy is one file and cannot `require` a shared module. `tests/unit/background-call-match-parity.test.ts` keeps the two blocks byte-identical and pins the block's `SHELL_ID_PATTERN` literal to `SHELL_ID_PATTERN_SOURCE`, since a workspace copy cannot import the shared constant. The block finds an id in result text by plain string search, so it compiles no regex from its argv.

A history parser that reports a turn end as a forced idle (Grok's `updates.jsonl`) would clear every tracked shell through `forceIdle`. `SessionTelemetry.forceActivity` turns that hint into the plain Idle event a Stop hook sends while any shell is tracked, which ends the turn and keeps the shells. PTY silence is handled the same way for the same reason (`handlePtyIdle`, above).

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
| Aider | `<cwd>/.aider.chat.history.md` | Direct path in the working directory, returned only when the file exists. One history file per project directory, with no session id in its name |
| Oz CLI (Warp) | N/A | Returns null (no CLI-accessible session history) |
| Kimi Code | `~/.kimi/sessions/<work_dir_hash>/<sessionId>/wire.jsonl` | Glob across all hash dirs (work_dir hash is opaque) and match on session UUID |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite `session` table) | Read-only WAL handle; match `directory == cwd` and `time_created` within spawn window |
| Droid | `~/.factory/sessions/<cwd-slug>/<sessionId>.jsonl` | Direct path construction, polled up to 10 times at 500 ms because Droid creates the file after the spawn returns |
| Ollama | N/A | Returns null (no CLI-accessible session history) |
| Grok Build | `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl` | Deterministic path construction (session id is caller-owned via `-s`) plus a strict existence check, scoped to the given cwd (the `resume-cwd-migration` reachability gate depends on a cross-cwd match NOT counting). The attach-time `runtime.sessionHistory.locate` additionally polls ~60s and falls back to a sessions-root scan for encoding mismatches |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` | Direct path computation from the conversation id, with a short existence poll (the transcript appears when the first turn starts) |
| Goose CLI | N/A | Returns null (no transcript parsing; resume rides on the caller-supplied `--name`) |

## Auto-Name (Summarize)

Suggests a task title from the task description, and names a Command Terminal from its first prompt, via each adapter's optional `summarize?(prompt, cliPath, cwd, options)` method. Both run on the **Automation agent** (Settings > Workflows, `AppConfig.automation`), at its model and effort, never on the project's default agent: the project default was Opus at xhigh, the top tier for four to eight words. With no Automation agent, or one whose adapter has no `summarize` (Warp has no headless run; Aider, Ollama and Goose have headless answer runs but no summarize yet), naming is off: the renderer hides the button and never schedules the automatic rename, a Command Terminal keeps "Command Terminal N", and main's handler refuses the call. Renderer and main read the same predicate, `namingAgentReady` (`src/shared/answer-agent.ts`), and main resolves the agent through the resolver Condition checks use (`src/main/automations/automation-agent.ts`), so the detection cache and the effort rule exist once.

### Surfaces

- **`<NameFromPromptButton>`** (`src/renderer/components/NameFromPromptButton.tsx`) is a square Sparkles icon button placed alongside the title input (not inside it). It exposes a `useNameFromPromptAvailable(description)` hook and is used by `NewTaskDialog` and `TaskDetailEditForm`. The button shows only when the Automation agent can name tasks (`namingAgentReady`) and the description is non-empty.
- **Automatic rename** (`src/renderer/lib/auto-name-scheduler.ts`, scheduled from `App.tsx`) runs once per placeholder-titled task (`fix`, `wip`, etc., or empty), 30 seconds after its agent starts, in any project. It generates a title and applies it at the agent's next idle moment, never mid-turn, because the save also renames the task's branch and a branch cannot move under a running agent. It skips the save if the user renamed the task meanwhile. A timed "Task renamed" toast follows, only for the open project, and a click on it opens the task. The "already named" set is persisted in `AppConfig.autoNameAskedTaskIds` (drained on task delete), written only once a task proves nameable, so a restart never renames a task twice. The request carries the task's project and task ids, read when it was scheduled.

### Implementation

Implementations live next to each adapter. The run's `cwd` is the shared answer home (`ensureAnswerHomeDirectory`), never the project: a title needs nothing from the repository, and a project root loads the agent's instructions into every call. Two shapes:

- **On the answer run.** Gemini, Copilot and OpenCode call their own `answerFromContext` with `buildSummarizePrompt` and clean the reply with `titleFromAnswer` (`src/main/agent/shared/auto-name.ts`). That run already carries the agent's read-only flags and removes the session it leaves, so naming gets both from one place. Each was measured turning the title prompt into a clean title there (2026-10-13: Gemini 3.6 s, OpenCode 7.1 s, Copilot 8.0 s). It runs under the answer run's 120 s bound rather than the title runner's 15 s.
- **On the title runner.** The rest call `runCliPrintSummarize`, the title shape of the headless runner (`runCliPrint`, `src/main/agent/shared/cli-print.ts`). Each takes the model (and effort, where its answer run has one) and trust flags its own `answerFromContext` uses, plus those of that run's read-only and no-session flags that leave its mode alone. A mode change waits for a title measured in that mode: Antigravity's plan-mode answer run, given the title prompt, searched the web twice, tried a shell command and came back empty after 41 s and 36k tokens. Codex, Cursor, Grok, Qwen and Kimi could not be measured on the machine that tried (logged out, an outdated CLI, a provider error, no model set), so Cursor still runs with write tools and keeps its chat, Kimi still runs without plan mode, and Grok keeps its session file.

| Agent | Invocation | Prompt delivery |
|-------|-----------|-----------------|
| Claude | `claude --print --no-session-persistence --permission-prompts none --tools '' --strict-mcp-config --settings <file> --output-format json [--model] [--effort]`, the answer run's flags (`answerArgs`), with no plan mode, which rerouted a Haiku request to Sonnet | stdin |
| Codex | `codex exec --skip-git-repo-check --sandbox read-only --ephemeral [--model]` | stdin |
| Gemini | Its answer run: `gemini --skip-trust --output-format stream-json --approval-mode plan --session-id <uuid> [--model]`, the chat removed after | stdin (non-TTY headless) |
| Qwen Code | `qwen --output-format text --chat-recording=false [--model]` | stdin (non-TTY headless) |
| OpenCode | Its answer run: `opencode run --agent plan --format json --pure [--model]`, the session deleted after | stdin |
| Kimi | `kimi --print --quiet [--model]` | stdin |
| Cursor | `agent --trust --output-format text [--model] -p "<prompt>"` | positional arg |
| Droid | `droid exec -o text [--model] "<prompt>"` | positional arg |
| Copilot | Its answer run: `copilot --silent --output-format json --stream off --session-id <uuid> --no-ask-user [--model] [--reasoning-effort]`, the session folder removed after | stdin |
| Grok Build | `grok --output-format plain --deny Write --deny Edit --deny Bash --no-subagents --disable-web-search --no-memory [--model] [--reasoning-effort] -p "<prompt>"` | positional arg |
| Antigravity | `agy -p "<prompt>" --output-format json [--model] [--effort]` through a hidden PTY (`agy -p` hangs without a TTY, upstream #318); runs in a pre-trusted scratch cwd so it never touches the project workspace's `agy -c` mapping. It removes the conversation the run made and reports the result's `usage` | flag arg |
| Warp | (no headless run) | n/a |
| Aider | (headless answer run only; summarize not wired) | n/a |
| Ollama | (headless answer run only; summarize not wired) | n/a |
| Goose CLI | (headless answer run only; summarize not wired) | n/a |

### Configuration knobs

- `AppConfig.autoNameAskedTaskIds: string[]` - persisted "don't re-ask" set, drained when a task is deleted (single and bulk delete in `task-crud.ts`).
- `AppConfig.autoNameRateLimitPerHour: number` (default 60, 0 disables) - sliding-window cap on summarize CLI calls per hour. One window is shared by task titles (`agent:summarize`) and Command Terminal names (`src/main/agent/shared/summarize-rate-limit.ts`).

### Verification

`node scripts/probe-summarize.js` runs each detected adapter's `summarize()` against a sample description and reports success / timeout / format issues. Run it after installing or upgrading an agent CLI to confirm Kangentic's invocation still produces a sane title.

### Adding summarize to a new adapter

First run the title prompt through the adapter's own `answerFromContext` against the real CLI, in an empty folder. If it comes back as a clean title, `summarize()` is `titleFromAnswer(await this.answerFromContext(buildSummarizePrompt(prompt), cliPath, cwd, options?.model, { effort, runDirectory, onUsage }))`, and the answer run's read-only flags and cleanup come with it. If it explores, comes back empty or runs long, import `runCliPrintSummarize` and `buildSummarizePrompt` from `../../shared/auto-name` instead and choose the right `args`, `promptVia`, and (if needed) `extractRaw`. Mirror the pattern in `tests/unit/agent-summarize-shape.test.ts`, and set `supportsSummarize: true` on the agent's entry in `tests/ui/mock-electron-api.js`.

## Claude Code

### CLI Detection

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
| `default` | (no mode flag) |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `auto` | `--permission-mode auto` |
| `bypassPermissions` | `--dangerously-skip-permissions` |

Every mode also passes `--settings <path>`, the merged settings file in the session directory, whenever the spawn has a status output path.

A `plan` spawn whose approved plan would continue in `bypassPermissions` (`planApprovalModeForSpawn`) also passes `--allow-dangerously-skip-permissions` (`CommandOptions.bypassAvailable`), so the approval can switch the session to bypass. The flag is a launch option, so bypass stays reachable from that session's own mode cycle for its whole life, even after its column is switched back to Manual. See [`plan-approval-bridge.js`](#plan-approval-bridgejs).

#### Permission Mode Resolution (Priority Order)

See [Permission Mode Resolution](configuration.md#permission-mode-resolution-priority-order) in configuration.md.

### Non-Interactive Mode

When `nonInteractive` is set, `--print` is added. The agent runs, prints output, and exits without waiting for user input.

### Settings Merge

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
5. Inject event-bridge hooks into all registered hook points, plus the plan approval hook (and, when the session's allow rules name another server's MCP tool, its tool approval entry) and, for a task session whose MCP URL names it, the background shell hint hook (see [`plan-approval-bridge.js`](#plan-approval-bridgejs) and [`background-shell-hint-bridge.js`](#background-shell-hint-bridgejs))
6. When the MCP server is attached, append `mcp__kangentic` to `permissions.allow` (append-if-absent) so kangentic's own tools never prompt in default mode. `--permission-mode auto` runs a SEPARATE natural-language classifier that does not honor `permissions.allow`, so a plain-language allow rule (`KANGENTIC_AUTO_MODE_ALLOW_RULE`) is also appended to `autoMode.allow` (seeded with `$defaults` when the array is absent, preserving the classifier's built-in rules) so a board-driven auto-mode session does not soft-deny Kangentic's own board/session tools
7. Write merged file to session directory
8. Pass `--settings <mergedSettingsPath>` to the CLI

All Kangentic artifacts stay in `.kangentic/` - nothing is written to `.claude/settings.local.json`.

### Hook Injection

Kangentic subscribes to 18 Claude Code hook points via the event bridge:

| Hook Event | Event Type | Purpose |
|------------|-----------|---------|
| `PreToolUse` (blank) | `tool_start` | Agent began using a tool. `agent_id`, when the tool ran in an agent of its own, goes to `subagentId`; see [Activity Detection](activity-detection.md#internal-cli-agents-tools) |
| `PostToolUse` (blank) | `tool_end` | Tool execution completed (remaps to `background_shell_start` when the `tool_response` carries an id-shaped detail: a backgrounded or auto-backgrounded Bash's shell id, or a `Monitor` wait's `taskId`). `agent_id` goes to `subagentId` as on `PreToolUse` |
| `PostToolUseFailure` (blank) | `tool_end` | Tool execution failed (remaps to `interrupted` when `is_interrupt` is true). `agent_id` goes to `subagentId` as on `PreToolUse` |
| `UserPromptSubmit` | `prompt` | User submitted a prompt. Carries `planMode`, whether the payload's `permission_mode` is `plan` (`extractPlanMode`), as `Stop` does; see [Activity Detection](activity-detection.md). A Command Terminal's settings also copy the payload's `prompt` into `detail` (capped at the bridge's `FIELD_CAP`, 2000 characters, `capturePromptText`), which is what names the terminal; a task session's events carry no prompt text |
| `Stop` | `idle` | Agent stopped naturally. Carries `planMode`, as `UserPromptSubmit` does, except on a subagent's Stop, which arrives through the same hook with an `agent_id` (`unlessField`). The tool and subagent hooks carry none: a subagent can run in its own mode while the session plans |
| `StopFailure` | `turn_failed` or `turn_retrying` | Fires instead of `Stop` on a service/API error; carries the error type in `detail`. A TERMINAL error stays `turn_failed` (routed through the Interrupted bypass to reset stale counters and idle at once); a TRANSIENT, auto-retried error (overloaded/server_error/rate_limit/api_error) is reclassified to `turn_retrying`, which holds the session thinking through a live retry instead of force-idling it - see [Activity Detection](activity-detection.md) |
| `PermissionRequest` | `idle` | Agent hit a permission wall. The payload's `tool_name` goes to `tool`, which is how the plan approval gate tells the plan prompt, and a tool the plan approval hook may answer, from every other one (see [Activity Detection](activity-detection.md#plan-approval-gate)) |
| `SessionStart` | `session_start` | Session began |
| `SessionEnd` | `session_end` | Session ended |
| `SubagentStart` | `subagent_start` | Main agent launched a subagent; `agent_type` goes to `detail` and `agent_id` to `subagentId`. A start for a `subagentId` that is still live takes no second slot - see [Activity Detection](activity-detection.md) |
| `SubagentStop` | `subagent_stop` | Subagent finished; same fields. A second stop for a `subagentId` that already stopped is a duplicate the engine ignores - see [Activity Detection](activity-detection.md) |
| `Notification` | `notification` | Informational notification |
| `PreCompact` | `compact` | Context compaction starting |
| `TeammateIdle` | `teammate_idle` | Teammate agent went idle |
| `TaskCompleted` | `task_completed` | Task marked complete |
| `ConfigChange` | `config_change` | Configuration changed |
| `WorktreeCreate` | `worktree_create` | Worktree created |
| `WorktreeRemove` | `worktree_remove` | Worktree removed |

All event-bridge hooks use blank matchers (fire for every invocation regardless of tool name). Three hooks carry a matcher: the plan approval hook, a second `PermissionRequest` entry, matcher exactly `ExitPlanMode`, registered on every spawn; the same bridge again on `PermissionRequest`, matcher `mcp__.*`, registered only when the session's allow rules name another server's MCP tool (see [`plan-approval-bridge.js`](#plan-approval-bridgejs)); and the background shell hint, a second `PostToolUse` entry, matcher `Bash|PowerShell`, registered for a session whose MCP URL names it (see [`background-shell-hint-bridge.js`](#background-shell-hint-bridgejs)). See [Activity Detection](activity-detection.md) for the full event-to-state mapping and state derivation logic.

#### Paths in hook commands

Every hook and status-line command Kangentic writes is `node <bridge> <path>...`, and the agent CLI
hands the whole string to a shell, except Antigravity, which tokenizes hook commands itself (see
[Antigravity](#antigravity)). A path the shell rewrites sends the bridge somewhere else: a
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

Aider's notifications command quotes for its own shell (see the Aider section), and Antigravity's
hook commands are unquoted by design, because its hook runner keeps quote characters literal.

`tests/unit/event-bridge.test.ts` runs each form through real shells: Git Bash, both PowerShells,
and cmd verbatim and with escaped arguments on Windows; `sh -c` and `bash -c` elsewhere. Each hook
manager's test runs its CLI's real commands, with the real bridges, through that CLI's shells and
checks the file the bridge wrote. Every built command is also checked against Gemini's `$NAME`
pattern (`CLI_ENVIRONMENT_REFERENCE`, `tests/unit/helpers/shell-argv-probe.ts`).
`.github/workflows/shell-quoting-windows.yml` runs the Windows half.

#### Hook Identification

A command is a Kangentic hook (`isKangenticHookCommand`) when it names a known bridge (`activity-bridge`, `event-bridge`, `plan-approval-bridge` or `background-shell-hint-bridge`) AND carries one of these markers:
- `.kangentic` or `/kangentic/` in a path (a session directory, a workspace bridge copy, a source checkout, a Windows install)
- the events path named through `env:KANGENTIC_EVENTS_PATH`
- for a `background-shell-hint-bridge` command, a base64 spec that names `kangentic_mark_background_service`
- the exact path the running app ships that bridge at

The first three hold wherever the app is installed, so they also catch a hook an earlier install wrote from another path. Requiring a bridge name plus a marker prevents false positives on user-defined hooks with similar names. The `activity-bridge` check is for backwards compatibility with older session directories - the current bridge scripts are `event-bridge`, `plan-approval-bridge` and `background-shell-hint-bridge`.

#### Hook Cleanup

`stripKangenticHooks()` in `hook-manager.ts` removes all Kangentic hooks from `.claude/settings.local.json` on project close or delete. This is a backward-compatibility function - the unified `--settings` approach means Kangentic no longer writes hooks to `settings.local.json`, but older worktrees may still have them.

Safety guarantees:
- Backs up the original file before modification
- Validates JSON integrity before writing
- Restores from backup on any error
- Deletes empty settings files and `.claude/` directories

### Global Config Writes (`~/.claude.json`)

`ClaudeAdapter.ensureTrust()` runs before every Claude spawn - both task chokepoints and the Command Terminal (`transient-sessions.ts`) - and makes one read-modify-write of the global `~/.claude.json` (see Trust Management below), serialized through one lock (`withClaudeJsonLock`, `src/main/agent/adapters/claude/claude-json-lock.ts`), which project relocation's key rewrite also takes. Two tests pin that, because one cannot cover both halves: `tests/unit/spawn-entry-point-parity.test.ts` scans every path that builds an agent command and proves the call appears first (line order, all paths), and `tests/unit/transient-session-spawn-ensure-trust.test.ts` drives the Command Terminal handler and proves the runtime contract there (awaited, called once, with the project root, resolving before `buildCommand`).

The lock has two layers. An in-process promise chain serializes Kangentic's own writers. Around it, every operation takes Claude's own `~/.claude.json.lock` (proper-lockfile semantics: a `mkdir` directory, stale after 10 s), because the CLI writes the same file from every running session and one of those writes withdraws the fullscreen boot canary (`fullscreenBootPending[pid]`) on a graceful exit; a Kangentic write that read before that withdrawal and wrote after it resurrects the record, and a dead pid found at the next launch is a strike against the fullscreen renderer. Each writer reads INSIDE the lock. A lock still held after the 12 s budget (which outlasts the stale window, so an abandoned lock is always broken first) makes the writer skip its write and warn, the CLI's own policy on a final `ELOCKED`. `tests/unit/claude-json-lock.test.ts` pins the acquire, the wait, the stale break, and the skip; the rule is `.claude/rules/pty-teardown-grace.md`.

The `/model` picker probe (`model-picker-probe.ts`) is the one other Claude process the adapter spawns. It runs on the classic renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`), which never arms that canary, and exits the CLI with `/exit`, waiting on the PTY's own exit before the fallback kill. A run that never got `/model` into the input box (a dialog showed, or it timed out) types nothing more, not even Esc, and is killed outright, and so is a run whose Enter opened a dialog instead of the picker; the classic renderer leaves no canary record to strand.

#### Trust Management

`src/main/agent/adapters/claude/trust-manager.ts`

Before every spawn, `ClaudeAdapter.ensureTrust()` calls `ensureClaudeSpawnConfig()`, which makes ONE read-modify-write of `~/.claude.json` under the lock (it used to be three passes per spawn, each parsing and rewriting a file that runs to 1.5 MB):

1. Read `~/.claude.json` asynchronously (a missing file starts from an empty object; a file that exists but does not parse as a JSON object is left untouched, since it holds the user's auth and MCP state, and the session shows a trust prompt instead)
2. Trust the working directory: a `projects` entry with `hasTrustDialogAccepted: true`, copying `enabledMcpjsonServers` from the parent project entry for a worktree (MCP server inheritance)
3. Append `kangentic` to the entry's `enabledMcpjsonServers` (append-if-absent) so the Kangentic MCP server is enabled without a prompt
4. Set `diffSidebarOpen: false` (see Diff Panel below)
5. Write once, asynchronously and atomically (temp file + rename), only when something changed

A rename still refused after its retries (the file held open, usually on Windows) falls back to an in-place write. When that write fails too and leaves the file short, the temp file is the one complete copy, so it is kept and named in the thrown error; when the file still parses, nothing is kept. The first whole write of a run removes copies an earlier failed write kept, and so does the first whole write after a failed write keeps one.

`ensureWorktreeTrust()` and `ensureMcpServerTrust()` remain for callers that need one change alone (the model-picker probe trusts its scratch directory). They share the same reader and writer, so they also leave a file that does not parse untouched and write through a temp file.

#### Diff Panel

`src/main/agent/adapters/claude/diff-panel.ts`

Claude Code 2.1.260 opens a diff panel beside the conversation in the fullscreen renderer whenever the terminal is wide enough: the gate is `columns >= 144` when the global `diffSidebarOpen` key is unset, `>= 110` when it is `true`, and never when it is `false`. The panel takes the right `min(floor(columns * 0.45), 90, columns - 70)` columns and shares physical rows with the transcript, so every line-oriented scrollback parse reads the two panes spliced together, and it duplicates the task window's Changes tab.

The key lives only in `~/.claude.json` (the same key list as `theme` and `diffTool`); it is not a settings.json key, so the per-session `--settings` file cannot carry it, and there is no CLI flag or env var. The spawn's one pass (`ensureClaudeSpawnConfig()`, applying `applyDiffPanelClosed()`) therefore writes `diffSidebarOpen: false` before every spawn:

- Idempotent: an already-`false` key costs one read and no write.
- Per spawn, not once: the key is remembered-last-state in one global slot, and any session that opens the panel (`/diff`) writes `true`, which would otherwise auto-open it in every later Kangentic session.
- Atomic (temp file + rename, no backup copy), and an unreadable file is left untouched rather than replaced, since the file holds the user's auth and MCP state.
- The CLI applies the value it read at startup: a session spawned with the key `false` stays closed even if another session flips the key to `true` later (verified with a completed turn at 210 columns), so the write covers the session's whole lifetime.
- `/diff` inside a session still opens the panel for that session (that path checks only the git cwd and `columns >= 110`), so it is the per-session opt-in. Turning fullscreen off (`tui: "default"`) would also remove the panel but reintroduces the scrollback duplication fullscreen exists to fix, so it is not used.

## Codex CLI

### CLI Detection

`src/main/agent/adapters/codex/detector.ts`

Detection follows the same pattern as Claude: check `config.agent.cliPaths.codex`, fall back to `PATH` search via `which`, run `codex --version`.

### Command Building

`src/main/agent/adapters/codex/command-builder.ts`

#### New Session

```
codex -C <cwd> --sandbox <level> --ask-for-approval <level> [--model <m>] \
  -c mcp_servers.kangentic.url=<url> \
  -c mcp_servers.kangentic.env_http_headers.X-Kangentic-Token=KANGENTIC_MCP_TOKEN \
  [-c shell_environment_policy.set.KANGENTIC_TASK_ID=<taskId>] \
  -c check_for_update_on_startup=false \
  [-c hooks.<Event>=[...] for seven events, -c hooks.state={...}] \
  "prompt text"
```

#### Resumed Session

```
codex resume <sessionId> -C <cwd> --sandbox <level> --ask-for-approval <level> [--model <m>] \
  -c <the same two MCP overrides> \
  [-c <the same task tag override>] \
  -c check_for_update_on_startup=false \
  [-c <the same hook and trust overrides>]
```

The hook overrides appear only when Codex confirmed their trust for this binary (see [Hook Integration](#hook-integration)).

`check_for_update_on_startup=false` keeps Codex's "Update available" prompt out of a Kangentic session. It is a modal at TUI startup whose first option is "Update now", so an `auto_command` typed into a session showing it, or any Enter meant for the agent, updates Codex and ends the session (a probe's Enter did exactly that, 0.154.0 to 0.163.0, in task #859). The key is Codex's own (`config_toml.rs`), it applies to that process only, and the user's own terminal still offers updates.

The task tag override is added for every session, a Command Terminal included (it carries its own made-up task id, so its leftovers are reaped when it ends). Codex passes its environment to tool shells through `shell_environment_policy`, which a user can narrow (`inherit = "core"`), and that strips `KANGENTIC_TASK_ID`, the tag a terminal transition finds a task's leftover processes by (see [worktree-strategy.md](worktree-strategy.md#reaping-processes-that-pin-a-worktree)). A `set` entry always wins over the inherit and filter steps, and it adds to the user's own `set` table rather than replacing it (measured on codex-cli 0.154.0).

Resume is a subcommand in Codex (not a flag like Claude). Both forms emit the same flags: `codex resume` accepts `-c`, `-s/--sandbox`, `-a/--ask-for-approval`, `-m/--model`, `-C/--cd`, and `--disable`. The resume branch used to return early after `-C`, so a resumed session silently lost its permission mode, model override, and MCP wiring.

### MCP Wiring

Codex reads MCP servers from the `mcp_servers.<name>` table in `~/.codex/config.toml`. Kangentic applies the same keys with `-c` for that invocation only, so the user's config file is never written. `env_http_headers` maps a header name to the NAME of an environment variable that Codex resolves at MCP-connect time, so the token travels via `CodexAdapter.buildEnv` as `KANGENTIC_MCP_TOKEN` and never appears in argv (argv is echoed into terminal scrollback the user can read).

**The `-c` payloads deliberately contain no quotes, braces, or whitespace.** `quoteArg` cannot deliver an embedded double quote on Windows: it writes one as `'` (see `escapeForDoubleQuotedShell` in [cross-platform.md](cross-platform.md)), so the natural TOML inline-table form cannot arrive as written. A `\"` escape breaks it under PowerShell with `error: unexpected argument 'http://...\' found`. Two properties make the quote-free form work: a bare URL fails TOML parsing and is taken as a literal string, and TOML bare keys permit `-`, so the header name works as a dotted key segment. Verified against codex-cli 0.141.0 on PowerShell, cmd, and Git Bash. Do not "tidy" these into quoted TOML.

### Directory Trust

Codex prompts "Do you trust the contents of this directory?" before it will load project-local config, hooks, or exec policies. Kangentic pre-approves the spawn directory in `~/.codex/config.toml` (`src/main/agent/adapters/codex/trust-manager.ts`):

```toml
[projects.'C:\Users\dev\proj\.kangentic\worktrees\7']
trust_level = "trusted"
```

Measured against codex-cli 0.141.0, this cannot be left to the user answering once. Trust is keyed on the **git repo root** and is **not inherited** by nested repositories, and every Kangentic task gets its own worktree, which is its own repo root. Accepting the prompt therefore records only that one worktree and the next task prompts again: there is no answer the user can give that carries forward. The per-invocation `-c` override does not help either, because trust is resolved before config overrides are applied.

The pre-approval never overrules the user. An explicit `trust_level` already recorded for the directory is left as-is (so a deliberate `"untrusted"` survives), and a project root marked `"untrusted"` suppresses approval for the worktrees beneath it.

Path comparison is shared with the relocation migration (`config-toml.ts`), because Codex stores these keys in several interchangeable spellings (single vs double quotes, forward vs back slashes, and an optional `\\?\` long-path prefix) and a missed match would append a duplicate table, which makes `config.toml` unparsable for Codex itself.

The entry is also **removed** when Kangentic deletes the worktree, via the adapter contract's `onWorktreeRemoved` hook (`removeWorktreeTrust`). Without that, a per-directory key that can never be inherited accumulates one dead table per task forever: one developer machine had reached 473 entries before this landed. Only a table whose sole key is `trust_level` is dropped, so anything the user or a future Codex added to it survives. `$CODEX_HOME` is honored on both the write and the removal, so Kangentic always targets the file Codex will actually read.

### Launch Options

Codex declares one `AgentLaunchOptionInfo` (see [Agent Adapter Interface - Optional Properties](#optional-properties)): `disableApps`, off by default. When enabled, `--disable apps` is appended to both the new-session and `resume` command forms, skipping Codex's optional cloud ChatGPT Apps MCP connector (`apps` feature, stable and on by default per `codex features list`), which can hang the whole session at `Booting MCP server: codex_apps` (openai/codex#20167, #19284, #16550). The flag is per-invocation only - it never touches the user's `~/.codex/config.toml`. Configured via the Agent settings tab's Launch Options row, stored at `agent.launchOptions.codex.disableApps`.

### Permission Modes

| Mode | Flags | Codex Preset |
|------|-------|--------------|
| `plan` | `--sandbox read-only --ask-for-approval on-request` | Safe Read-Only Browsing |
| `dontAsk` | `--sandbox read-only --ask-for-approval never` | Read-Only Non-Interactive (CI) |
| `default` | `--sandbox workspace-write --ask-for-approval on-request` | Automatically Edit, Ask When Needed |
| `acceptEdits` | `--sandbox workspace-write --ask-for-approval never` | Auto (Preset) |
| `auto` | `--sandbox workspace-write --ask-for-approval on-request` | Not exposed in the settings dropdown |
| `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | Dangerous Full Access |

`default` and `auto` launch alike: Codex 0.154.0 accepts only `on-request` and `never` for
`--ask-for-approval` and exits on `untrusted`, which `default` passed before.

The Codex Preset column is the adapter's `AgentPermissionEntry.label`, which is what the Agent
settings dropdown shows. Codex declares five entries, so `auto` has no preset of its own. It still
maps to flags, because a column or agent override can set the mode without going through that
dropdown.

### Hook Integration

Kangentic registers its hooks as `-c hooks.<Event>=[...]` overrides in Codex's session-flags layer (task #859, measured on codex-cli 0.154.0 and 0.163.0). Nothing is written to `~/.codex` or the repo beyond the bridge's workspace copy, and the user's own hooks load beside these. Seven events: SessionStart (`session_id` for `fromHook`), UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest (a permission idle; its payload has no `tool_use_id`, so the engine awaits the tool PreToolUse opened), Stop and PreCompact. Each command is `node .kangentic/codex-event-bridge.cjs env:KANGENTIC_EVENTS_PATH <type> <directives>`, bare tokens inside a TOML literal string: the hook runs in the session's working directory and inherits `KANGENTIC_EVENTS_PATH`, and the relative copy is the one path that never needs quotes. The overrides hold no `"` at all, the same quoting contract as the MCP overrides above, and `codex-hook-overrides.test.ts` types them at PowerShell 5.1 and 7, cmd and Git Bash and reads back what arrived.

**Trust comes from Codex itself.** Codex runs a session-flags hook only when `hooks.state` holds the hash it computes for it, and its TUI opens a blocking "Hooks need review" dialog for any hook without one (exec mode skips the hook silently). Kangentic does not compute that hash. `CodexHookTrustCheck` (`codex/hook-trust.ts`) runs the binary's own `codex app-server` once, with a scratch `CODEX_HOME`, asks `hooks/list` for the key and `currentHash` of the exact overrides, and passes them as one `-c hooks.state={...}` override, which Codex merges with the user's own `[hooks.state]` (their trusted hooks stay trusted, measured). The read starts in `detect`, `ensureTrust` waits for it for up to 8 s, and the answer is cached per binary file (path, size and modification time), so an in-place update reads again. A read that fails, times out, reports an error or warning, or leaves a hook out wires no hooks: the session runs on the PTY tracker as before. One read covers every session, because the overrides do not vary by session. An npm `.cmd` shim is the gap: an update replaces the package behind it, not the shim, so the cache key does not change.

What no hook reports comes from the rollout (`codex/session-history-parser.ts`): a command still running at its yield (`Process running with session ID N`, which fires PreToolUse but no PostToolUse) is a background start keyed by its call id, a `write_stdin` poll that finds it exited ends it, `turn_aborted` (an Esc interrupt, no hook) is an Interrupted event, and a `task_complete` that carries an `error` (a failed model request, no Stop) is a TurnFailed event. The rollout no longer forces activity or reports tool starts, and `sessionHistory.suppressesPtyFallback: false` keeps its reads from turning the PTY tracker off, so a session whose hooks Codex did not confirm keeps that tracker.

The legacy project-local `.codex/hooks.json` from builds before Codex 0.128 is still swept of Kangentic-owned entries by `buildHooks`.

Codex's rollout, transcript and model-history readers resolve Codex's home through `codexHomeDir` (`config-toml.ts`), so `$CODEX_HOME` is honored there too; with `~/.codex` hard-coded, a user with `CODEX_HOME` set got no rollout telemetry at all.

### Limitations

- No real-time token usage or cost data (no statusLine equivalent)
- No merged settings file mechanism
- No live `/model` or `/reasoning-effort` injection: changing either requires a respawn (`getInjectionSequence` returns `[]`), and effort is `config.toml`-only with no CLI flag

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

### Plan exit

A plan column's task moves to its After Plan Mode target when Gemini's plan is approved, as a
Claude task does. Gemini's `exit_plan_mode` fires `AfterTool` for an approved plan and a rejected
one alike, so the `AfterTool` hook carries a `setToolWhen` directive that reports it as
`ExitPlanMode` only when `tool_response.llmContent` starts with "Plan approved." (measured on
Gemini CLI 0.63.0: a rejection reads "Plan rejected. User feedback: ...").

### Confirmation prompts

Gemini has no permission hook. It reports each tool confirmation dialog, the plan prompt included,
as a `Notification` whose `notification_type` is `ToolPermission`. A second `Notification` entry
turns that one into the permission `idle` (`extractDetail(['notification_type'])`, then
`emitOnlyWhenDetailMatches('^ToolPermission$')`, then `setDetail('permission')`), so the card
shows the task needs you. The `AfterTool` that follows your answer clears it. Any other
notification writes no idle.

Gemini does not declare `supportsPlanAutoApproval`, so its plans always wait for you. Three things
stand in the way:

- Its approval always continues in Auto Edit or Default, never in the destination column's mode.
- An approval would have to be armed at spawn, so a column switched to Manual mid-plan could not
  stop it.
- Nothing would write the marker the [plan approval gate](activity-detection.md#plan-approval-gate)
  pairs with the plan exit.

### Settings Merge

Gemini reads settings from `.gemini/settings.json` in the project directory. Unlike Claude's `--settings` flag, Gemini has no way to point to a per-session settings file. Kangentic writes merged settings (event-bridge hooks and / or the Kangentic MCP server entry) directly to `.gemini/settings.json` in the CWD.

The project root's file is read on every spawn, never cached, so an edit or a pull reaches the next session with no restart. In the main repo that read finds the file the previous spawn wrote, so it strips Kangentic's own hooks and `mcpServers.kangentic` entry first (`stripKangenticEntries`, the same strip `removeHooks` runs) and the user's content is the baseline. A hook counts as Kangentic's when its command runs one of the bridges (`isKangenticHookCommand`). Gemini's commands name no `.kangentic` path, so they are recognized by the events argument `env:KANGENTIC_EVENTS_PATH` and by the hint spec naming `kangentic_mark_background_service`. Neither depends on the install path, so hooks an earlier install wrote from another path (an AppImage remount, a moved app) are stripped too.

Because the file is shared, concurrent Gemini sessions in the same folder are serialized by per-session holds in `GeminiAdapter.hookHolds` (a `SharedFolderHolds`): every `buildCommand` that writes the file (an events pipeline or MCP wiring) holds it under `CommandOptions.ptySessionId`, the id the session spawns under, and `removeHooks(directory, sessionId)` only strips the file when the last session in that folder releases. The key is the session, not the task: a young session's kill leaves its PTY exiting for up to the grace while the task's next session starts, and a task-keyed release let that late exit strip the running session's hooks. A second release of one session (session-manager invokes `removeHooks` both in `suspend()` and from the PTY `onExit` handler) is a no-op. A built command that never becomes a session (an abort, a skipped startup spawn, a failed spawn) releases its hold through `releaseCommandHold` (`src/main/pty/lifecycle/adapter-lifecycle.ts`). On crash or force-quit, the next spawn's read strips any stale Kangentic entries (`stripKangenticEntries`) and `buildHooks` filters them again. `removeHooks` strips the `mcpServers.kangentic` entry alongside the hooks, so the entry and its environment references do not outlive the session. Qwen, Cursor, Droid, Antigravity, Grok, OpenCode and Codex (its legacy `.codex/hooks.json` sweep) hold their shared files the same way.

### MCP Wiring

The merged settings carry an `mcpServers.kangentic` entry using the Gemini-family `httpUrl` key (not the Anthropic/fastmcp `url` used by Claude and Kimi), with `httpUrl` `${KANGENTIC_MCP_URL}` and `headers` `X-Kangentic-Token: ${KANGENTIC_MCP_TOKEN}`. Both values come from the session environment through `buildEnv` (task #859; Gemini expands `$NAME` and `${NAME}` in every settings string), so the file holds no URL and no token, and the entry is per-session. This is the same shape the Qwen fork writes. User-defined `mcpServers` are preserved, and `removeHooks` strips only our entry.

The settings write is gated on hooks **or** MCP, so an MCP-only spawn (no events pipeline) still produces the file.

Two things make this work that are easy to miss:

- **Folder trust is load-bearing.** Gemini disables every configured MCP server in an untrusted folder (`gemini mcp list` reports "MCP servers are configured but disabled because this folder is untrusted", and user-level servers are suppressed too), so the entry would be silently inert. `GeminiAdapter.ensureTrust` pre-populates `~/.gemini/trustedFolders.json` via `trust-manager.ts`. Unlike the Qwen equivalent it does **not** gate on `security.folderTrust.enabled`, because Gemini 0.54.4 enforces trust with that flag unset. It never overrides a user's `TRUST_PARENT` or `DO_NOT_TRUST`, at the path itself or on any ancestor, so a `DO_NOT_TRUST` on the repo suppresses approval for every worktree Kangentic creates beneath it (the same deny rule Codex applies to its project root). It also skips the write when an ancestor is already trusted, so a worktree under an already-trusted repo adds no key at all. When no ancestor is trusted, though, it does record one `TRUST_FOLDER` per task worktree, exactly like Codex - which is why `GeminiAdapter.onWorktreeRemoved` drops that entry again when Kangentic deletes the worktree (`removeWorktreeTrust`). Without it the file grows by a dead entry per task forever, the accumulation that reached 473 entries in Codex's `config.toml`. Removal only ever takes an entry Kangentic could have written itself: a `TRUST_PARENT` or `DO_NOT_TRUST` at that path is a user decision and survives, so a later worktree at the same path still honors it. Ancestor matching folds case only on Windows, since POSIX paths are case-sensitive.
- **No token is on disk.** The file holds only the `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}` references (the values travel in the session environment), but its hook entries still land in `.gemini/settings.json`, which is project-shared and may be intentionally committed, so it cannot be blanket-gitignored like `.kangentic/`. `removeHooks` strips the entry when the folder's last session ends. For the untracked case this is now self-enforcing: when Kangentic creates the file (it did not exist before the spawn), the builder seeds `.gemini/settings.json` and `.kangentic/` into `.git/info/exclude` via the shared `git-exclude.ts` mechanism (see the Antigravity section), so the file never shows as untracked and cannot ride a `git add -A` into history. A pre-existing file keeps its normal git visibility (the created-by-us carve-out), and ignore rules never affect tracked files - so the rule stands: do not commit `.gemini/settings.json` while a Kangentic-spawned Gemini session is running.

## Qwen Code

Qwen Code (https://github.com/QwenLM/qwen-code) is a soft fork of Google's gemini-cli published by the Alibaba Qwen team. The Kangentic adapter mirrors the Gemini adapter in shape (a shared `.qwen/settings.json`, the same TUI behavior), but Qwen replaced Gemini's hook system with Claude Code's event names and payloads, and moved its session files.

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

### Hooks

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

### Plan exit

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

### Settings Merge

Qwen Code reads settings from `.qwen/settings.json` in the project directory. Like Gemini it has no `--settings` flag, so Kangentic writes merged settings (with event-bridge hooks) directly to `.qwen/settings.json` in the CWD. Concurrent sessions in the same folder are serialized by per-session holds in `QwenAdapter.hookHolds`, identical to the Gemini implementation. As with Gemini, the project root's file is read on every spawn with Kangentic's own hooks and `mcpServers.kangentic` entry stripped (`stripKangenticEntries`), so an edit reaches the next session and the previous spawn's entries never become the baseline. When Kangentic creates the file the builder seeds `.qwen/settings.json` and `.kangentic/` into `.git/info/exclude` (created-by-us carve-out: a pre-existing user file keeps its git visibility).

On Windows the hook commands carry bare tokens only: `node .kangentic/qwen-event-bridge.cjs env:KANGENTIC_EVENTS_PATH <type> ...`. Qwen's Windows hook runner hands cmd an escaped command line that no quoted path survives, and a bare token also survives the Git Bash it uses under MSYS. The builder checks the bridge copy in `<cwd>/.kangentic/` on every spawn and rewrites it only when its bytes differ from the app's bridge (after an app update, for example). A spawn that finds an identical copy leaves it alone, a hook already running keeps the copy it loaded, and the events path comes from each session's own environment, so concurrent sessions in one folder each write to their own file. See [Paths in hook commands](#paths-in-hook-commands).

### Kangentic MCP server and the approval gate

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

### Trust

`src/main/agent/adapters/qwen-code/trust-manager.ts`

Qwen inherits Gemini's folder-trust store: `~/.qwen/trustedFolders.json` maps absolute forward-slashed paths to `TRUST_FOLDER`, `TRUST_PARENT`, or `DO_NOT_TRUST`. Kangentic only ever writes `TRUST_FOLDER`; the other two are user decisions it detects and leaves alone.

Two things differ from the Gemini implementation:

- The write is gated on `security.folderTrust.enabled` in `~/.qwen/settings.json`. With that flag unset (the upstream default) Qwen implicitly trusts every folder, so `ensureTrust` writes nothing rather than cluttering the user's home directory. Gemini has no such gate, because 0.54.4 enforces trust with the flag unset.
- There is no ancestor check. Gemini skips the write when an already-trusted ancestor covers the path; Qwen records one key for every worktree it spawns into. Those keys are redundant, not load-bearing: `LoadedTrustedFolders.isPathTrusted` in qwen-code 0.21.7 matches a `TRUST_FOLDER` rule with a containment test (`isWithinRoot`), so a trusted project root already trusts every worktree beneath it. Porting Gemini's `hasTrustedAncestor` skip would remove the accumulation at its source rather than reaping it afterwards.

Qwen's `DO_NOT_TRUST` is the mirror image and is worth knowing before copying more of Gemini's logic here: the same function matches a deny with raw string equality, so it applies to the exact path only and never cascades. The trusted loop also runs first and returns early, so a covering `TRUST_FOLDER` beats an exact-path deny. Kangentic's write honors a `DO_NOT_TRUST` recorded at the worktree path itself, which is the only place the CLI would have honored one either. Both are exact string lookups against the canonical forward-slash key, so a deny stored under a different separator style is invisible to Kangentic's write and to the CLI alike. Removal is deliberately the asymmetric one: it matches on the resolved location, so it reaps a `TRUST_FOLDER` key whatever separators it was stored with.

The second difference is what makes cleanup load-bearing here. `QwenAdapter.onWorktreeRemoved` calls `removeWorktreeTrust` when Kangentic deletes a worktree, or the file grows by one dead path per task forever (the accumulation that reached 473 entries in Codex's `config.toml`). Removal diverges from the write in two deliberate ways. It is NOT gated on `security.folderTrust.enabled`: that flag lives in a separate file the user and the CLI both edit, so gating on it would leak every entry a user wrote before turning folder trust back off. And it never throws, because by the time it runs the worktree is gone and a failed write only leaves a stale entry, so it goes through `atomicWriteFileWithBackup` (temp file plus rename, `.kangentic-backup`) which logs and returns false instead. Matching is on the resolved location rather than the raw key, since the relocation pass and Qwen's own CLI both write keys and the file ends up holding mixed separator styles. Only a `TRUST_FOLDER` entry is taken, so a `TRUST_PARENT` or `DO_NOT_TRUST` at that path survives the directory and a later worktree there still honors it.

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

Context window size is read straight off the event: Qwen records a real `contextWindowSize` on every assistant event, so there is no lookup table to maintain. A missing field (older builds) falls through to the `0` sentinel, and the renderer hides the progress bar and shows only the model name.

### Session ID Capture

Caller-owned via `--session-id <uuid>`, mirroring Claude. `supportsCallerSessionId` is `true`. Empirically verified against Qwen 0.15.3: real qwen accepts a UUID and writes its JSONL at exactly `~/.qwen/projects/<sanitized-cwd>/chats/<our-uuid>.jsonl`. `--session-id` and `--resume` are mutex (yargs enforces). The runtime keeps `fromHook` and `fromOutput` capture paths as belt-and-suspenders for forks that pre-empt the caller's UUID.

### Limitations / Out of Scope

- **No statusLine telemetry:** Qwen Code (like Gemini) has no `status.json` token-streaming feature, so context window % is sourced from the session history file rather than a real-time hook.
- **OpenAI gpt-5 family unsupported (upstream bug):** Qwen Code 0.15.3's bundled `cli.js` sends `max_tokens` in OpenAI requests and never `max_completion_tokens`. OpenAI's gpt-5 family (e.g. gpt-5, gpt-5-mini, gpt-5-nano, gpt-5.1, and any gpt-5.x / gpt-5.x-codex variant) requires `max_completion_tokens` and rejects `max_tokens` with HTTP 400. Picking any gpt-5 variant via `/model` in the Qwen TUI surfaces `[API Error: 400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.]`. Workarounds until upstream patches: stay on the gpt-4.1 family for OpenAI, or use the Anthropic provider (Opus 4.7, Sonnet 4.6, Haiku 4.5) which is fully supported. Kangentic cannot work around this - the adapter is a pure CLI wrapper with no request-parameter interception. Tracked upstream at https://github.com/QwenLM/qwen-code (search issues for `max_completion_tokens`).

## OpenCode

### CLI Detection

`config.agent.cliPaths.opencode` override, then `PATH` lookup for `opencode` (with the `.cmd` shim on Windows for `npm i -g opencode-ai` installs; under a PowerShell or Git Bash host the spawn chokepoint launches the sibling `.ps1` or sh shim instead, see [cross-platform.md](cross-platform.md#npm-cmd-shims-under-powershell-and-git-bash)), then the standard Unix fallback paths. Distributed via Homebrew, Scoop, Chocolatey, Pacman, the curl|sh installer, and `npm i -g opencode-ai` - all install methods publish the same `opencode` binary name. The version probe runs `opencode --version` and strips an optional `opencode ` product prefix from the output.

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

The `permissions` list exposes two entries in OpenCode's own vocabulary: `plan` (label "Plan", OpenCode's built-in read-only agent) and `acceptEdits` (label "Build", full tool access). The stored `PermissionMode` enum values are reused for compatibility, so a swimlane set to `acceptEdits` under Claude continues to mean "Build" under OpenCode. On a fresh spawn the mode sets OpenCode's `--agent`: `plan` gives `--agent plan`, `acceptEdits` and `bypassPermissions` give `--agent build`, and `default`, `dontAsk` and `auto` give no flag, deferring to the user's `default_agent`. A resume passes only `--session <id>`, because the saved session already has an agent and the user may have switched it with Tab. There is no `--dangerously-skip-permissions` flag in TUI mode (it exists only on the non-interactive `opencode run` subcommand). `bypassPermissions`, `default`, `dontAsk` and `auto` sit outside the `permissions` list and are still accepted by `mapPermissionModeToAgent` for mixed-agent projects. Users who want auto-approval must enable it in `opencode.json`. The default mode is `acceptEdits`.

### Settings Merge

None. OpenCode reads MCP and provider configuration from `opencode.json` (project) or `~/.config/opencode/opencode.json` (global). `removeHooks` only removes the activity plugin (next subsection). The Kangentic MCP server IS wired in for a local-mode spawn - `buildOpenCodeEnv` (`command-builder.ts`) emits an inline `mcp.kangentic` entry via the `OPENCODE_CONFIG_CONTENT` env var per PTY spawn, deep-merged over the user's own config so their `mcp.*` entries are preserved (see [MCP Server](mcp-server.md)). It is NOT wired in for a remote-mode spawn (`opencode attach <url>`) - see the Remote Execution subsection below.

### Activity Plugin

Local-mode spawns install the Kangentic activity plugin by copying `kangentic-activity.mjs` into `<projectRoot>/.opencode/plugins/`, where OpenCode auto-discovers plugins at TUI startup. The copy is byte-compare idempotent, and removal verifies a sentinel comment on line 1 so a user-authored plugin at the same path is never touched. The plugin runs inline in the OpenCode process and writes activity events straight to the session's `events.jsonl`, reading its output path from the `KANGENTIC_EVENTS_PATH` env var exported by the PTY spawn flow. Note the install lands at the PROJECT ROOT, not the task worktree. Concurrent sessions in one project hold the plugin per session (`OpenCodeAdapter.hookHolds`), and the hold records the project root, so a worktree session's release (which names the worktree) removes the plugin once the root's last session ends.

The plugin file is hidden from git via the shared `.git/info/exclude` mechanism (`src/main/agent/shared/git-exclude.ts`, see the Antigravity section), seeded only once the plugin file actually exists at the destination so a failed copy never leaves an entry pointing at a missing file. Earlier releases appended the entry to the project's tracked `.gitignore` instead, which dirtied the user's checkout; a line those releases appended is left in place (harmless - it ignores the same path).

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

The adapter tracks which cwd resolved to which remote target in an in-memory `Map` populated by `buildCommand` (alongside the plugin's `hookHolds`), since `parseTranscript` / `locateSessionHistoryFile` / `sessionId.fromFilesystem` have no other way to reach Kangentic's `AppConfig` (adapters hold no config reference by design). Known limitation: this map is empty after an app restart, so viewing an old remote session's transcript falls back to the (empty) local SQLite lookup until the task is resumed again.

### Limitations

- **Concurrent same-cwd spawns cannot be disambiguated (local mode only):** Two OpenCode tasks spawned within ~30 s against the same `cwd` cannot be reliably distinguished by `captureSessionIdFromFilesystem`. Both rows match the directory + time-window predicate, so the parser returns the most recently created row - which can attribute task A's session ID to task B, or vice versa. Kangentic's per-task worktrees (`git.worktreesEnabled`, default `true`) sidestep this by giving every task its own `cwd`. If you have disabled worktrees and need to run multiple OpenCode tasks against the same project root, either re-enable worktrees in Settings -> Git or stagger the spawns by more than 30 seconds. The Codex CLI parser carries the same caveat. Does not apply to remote-mode sessions (see above).
- **No status.json pipeline:** activity is `hooks_and_pty` - the activity plugin's events are authoritative when they fire, and PTY-silence detection (`PTY_SILENCE_THRESHOLD_MS`, same `PtyActivityTracker` shape as Codex) is the fallback tier for sessions without the plugin (remote mode, failed install). OpenCode has no statusline, so there is no `status.json` pipeline.
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
- `--notifications --notifications-command` runs `node <event-bridge> <events file> idle` when Aider waits for input. Aider runs it through its own shell, so the paths are written bare when they allow it. A path that cannot be carried through the outer shell drops the pair, and the prompt regex stays the idle signal (see `isBareShellToken` in [cross-platform.md](cross-platform.md))

### Permission Modes

| Mode | Flags | Aider Mode |
|------|-------|------------|
| `plan` / `dontAsk` | `--chat-mode ask` | Ask (Read-Only Questions) |
| `default` | (no flags) | Code (Confirm Changes) |
| `acceptEdits` / `auto` | `--architect` | Architect (Two-Model Design) |
| `bypassPermissions` | `--yes` | Auto Yes (Skip Confirmations) |

### Limitations

- No session resume (no `--resume` equivalent)
- No structured status output; idle comes from the notifications command above or the prompt regex
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
- Kangentic's MCP server reaches every session through the project's `.cursor/mcp.json` (a static
  `${env:...}` entry beside the user's servers, `project-mcp-config.ts`) and `--approve-mcps`, which
  also approves the user's own project servers for that run. The entry is removed when the last
  session in the folder exits. A `.cursor/mcp.json` Kangentic cannot parse as a JSON object (one
  with comments, say) is left untouched, and that start gets neither the entry nor
  `--approve-mcps`; a workflow's agent refuses to start there and says why.
- Interactive mode prints no session id. A workflow's agent on Cursor gets one before launch
  instead: `createSessionId` runs `cursor-agent create-chat` in the project folder (measured: it
  prints the bare UUID and writes nothing under `~/.cursor`), and the start opens that chat with
  `--resume=<id>` plus the first message. Whether `--resume` opens a chat made this way in an
  interactive session, and keeps it across a Pause, has not been run live yet. A task or Command
  Terminal in interactive mode still starts without an id, so it cannot be resumed.
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

Copilot CLI 1.0.51+ supports caller-owned session IDs via `--session-id <uuid>` (same semantics as Claude's `--session-id`): passing a new UUID starts a fresh session with that ID, passing an existing UUID resumes it. The builder used `--resume <uuid>`, which 1.0.97 refuses for an id it has not seen ("No session, task, or name matched"), so no new Copilot task started.

Per-session config is written to `<eventsOutputPath dir>/copilot-config/` and passed with `--config-dir`, which Copilot 1.0.97 still honors by setting `COPILOT_HOME` (it prints a deprecation line). Three files go there:

- `hooks/kangentic.json` holds the hooks (`preToolUse`, `postToolUse`, `agentStop`, `preCompact`) as `{ "version": 1, "hooks": ... }`. Copilot reads every `*.json` in `<COPILOT_HOME>/hooks/` as user hooks, and has since 0.0.422, so one file covers every version.
- `settings.json` is a copy of the user's `~/.copilot/settings.json` plus the `statusLine` bridge and `banner: never`. Copilot 1.0.93 reads user settings only from this file.
- `config.json` is a copy of the user's (signed-in account, trusted folders) with the same two settings for older versions. It never carries hooks: 1.0.8 through 1.0.92 read config.json hooks as well as the hooks folder, so hooks in both would fire twice. Earlier Kangentic versions wrote their hooks there, which 1.0.93 ignores.

The adapter tracks these directories keyed by the session's own id (`CommandOptions.ptySessionId`), so `removeHooks(directory, sessionId?)` cleans that session's directory and never the one of the task's next session. It deletes Kangentic's files one by one and never recursively, because Copilot keeps the session's `session-state/` in the same config home and the next resume by `--session-id` needs it. The project-delete sweep (no `sessionId`) cleans every directory recorded for its folder.

### Permission Modes

| Mode | Flag | Copilot Mode |
|------|------|--------------|
| `plan` | `--plan` | Plan (Read-Only) |
| `dontAsk` | `--plan --no-ask-user` | Plan Non-Interactive (CI) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` | `--allow-all-tools` | Allow All Tools |
| `auto` | `--allow-all-tools` | Autopilot (Allow All Tools) |
| `bypassPermissions` | `--yolo` | YOLO (Full Access) |

`defaultPermission` is `acceptEdits`.

### Status & Events

The `CopilotStatusParser` reads a `status.json` written by Copilot's `statusLine` config (full-rewrite). Activity uses `hooksAndPty` - hooks primary, PTY silence timer as fallback.

### Limitations

- No `transcript-cleanup.ts` despite being a TUI agent (`\x1b[?25l` cursor hide). Handoff transcripts may contain rendering artifacts.
- `locateSessionHistoryFile` returns null - file location is not yet empirically verified.
- Trust is handled at runtime via `--add-dir`, not pre-approved.
- Plan exit detection was read from the 1.0.97 bundle and confirmed on a live 1.0.98 session (`tests/fixtures/plan-exit/copilot-1.0.98-post-tool-use-*.json`). Copilot's plan exit tool is `exit_plan_mode`, and its `postToolUse` result at `toolResult.textResultForLlm` starts "Plan approved! Exited plan mode." for an approved plan and "Plan not approved." otherwise. A rejection does reach `postToolUse`, as a `success` result with the "Plan not approved." text. The `postToolUse` entry carries `setToolWhen({ whenTool: 'exit_plan_mode', toolField: 'toolName', nested: ['toolResult', 'textResultForLlm'], startsWith: 'Plan approved', to: 'ExitPlanMode' })`, so only an approved plan moves the card to the After Plan Mode target.

## Oz CLI (Warp)

### CLI Detection

`src/main/agent/adapters/warp/warp-adapter.ts` (the detection walk),
`src/main/agent/adapters/warp/version-detector.ts` (the version command and its parser)

Detection is custom because `oz` does not support `--version` - it uses `dump-debug-info` instead. The detector inlines the same caching and inflight-deduplication pattern as `AgentDetector` but with the alternate version command. Override path is checked first, then `which('oz')` falls back to PATH. Because it does not use the shared `AgentDetector`, `oz` resolves only `which`'s first match and gets neither the multi-match walk nor the dead-shim skip described under Claude.

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
- `--prompt <text>` is the canonical non-interactive prompt entry. Quoting follows the same shell-safe rules as the other adapters.
- `--mcp-config-file <sessionDir>/mcp.json` is passed when `mcpServerEnabled` is true; the file is a minimal fastmcp-compatible config naming Kangentic's HTTP MCP server with the `X-Kangentic-Token` header. With no token the wiring is skipped (the server refuses every request without it), as Codex does.

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

`probeAuth?()` is an optional method on the `AgentAdapter` interface; Kimi and Grok implement it today (Grok via `grok models` output, see [Grok Build](#grok-build)). Other adapters return `undefined` for the `authenticated` field, which the renderer treats as "not applicable".

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

### MCP Setup

Droid CLI has no per-spawn `--mcp-config` flag, but it does expand `${NAME}` references against the process environment inside `headers` values at connect time, and never rewrites the file with the expanded value. Kangentic uses that: on spawn it writes a project-scoped `<cwd>/.factory/mcp.json` holding only the environment variable NAME, and supplies the value through the adapter's `buildEnv`. `~/.factory/mcp.json` is never touched, and the token never reaches disk even though the file lives inside the user's repo.

```json
{
  "mcpServers": {
    "kangentic": {
      "type": "http",
      "url": "<kangenticMcpUrl>",
      "headers": { "X-Kangentic-Token": "${KANGENTIC_MCP_TOKEN}" }
    }
  }
}
```

User-defined servers in that file are preserved, and `removeHooks` strips only the `kangentic` entry once the folder's last session ends (deleting the file when nothing else remains). Verified against droid 0.189.0: `droid mcp list` reports `kangentic  http  connected  [project]`.

Cleanup runs from the PTY exit and suspend paths, so a hard kill (Task Manager, crash, OS reboot) leaves the entry behind pointing at a dead loopback port until the next spawn rewrites it. It holds no secret, but it is a file Kangentic wrote inside the user's tree, so when Kangentic creates it the builder seeds `.factory/mcp.json` and `.kangentic/` into `.git/info/exclude` via the shared `git-exclude.ts` mechanism (see the Antigravity section) - the file never shows as untracked and cannot ride a `git add -A`. A pre-existing user `mcp.json` keeps its normal git visibility (the created-by-us carve-out). A Droid session on a project with worktrees disabled writes it into the project root rather than a worktree, which is what makes that entry matter.

### Limitations

#### No live telemetry (model, cost, tokens, context window)

Droid 0.109.x has no per-session telemetry channel that Kangentic can subscribe to. The three documented surfaces all sit outside the live-streaming contract that `ContextBar` requires:

- **`/cost` and `/context` slash commands** - post-hoc and user-initiated inside the TUI, not a stream Kangentic can read.
- **`OTEL_TELEMETRY_ENDPOINT`** - out-of-band OpenTelemetry export to a collector. Not a per-session signal we can subscribe to from the main process.
- **`~/.factory/sessions/<cwd-slug>/<uuid>.settings.json`** - written post-hoc, schema undocumented and unstable. Empirical parsing was evaluated and rejected (see "Out of scope" below).

As a result, `SessionUsage` is never populated for Droid sessions. The Droid adapter declares `liveTelemetryUnsupported` (carrying a label and tooltip) on `AgentAdapter`, the field flows to the renderer through `AgentDetectionInfo`, and `ContextBar` reads the generic capability and renders a "Telemetry: TUI only" pill (with the adapter-supplied tooltip) in place of the loading spinner. The board card and the Agent Monitor card show the same label in their footer, in place of "Starting agent..." (`TelemetryUnavailableFooter`, `task-card-view.tsx`). The renderer never branches on agent name. Users get live telemetry by running `/cost` or `/context` directly inside the Droid TUI.

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

## Grok Build

`src/main/agent/adapters/grok/`

xAI's terminal coding agent (repo: `xai-org/grok-build`, binary `grok`, a Rust alt-screen
TUI). Grok deliberately clones Claude Code's surface - Claude-compatible hooks, the same
`--session-id` / `--resume` split, the same `--permission-mode` vocabulary - which is what
makes this the second full-harness adapter after Claude. Every empirical claim below was
verified against grok 1.0.0 (3cd0d0cbce) on Windows and is re-checkable with
`node scripts/probe-grok.js` (headless checks spend a few tiny free-tier turns; add
`--skip-pty` to skip the interactive leg).

**Sessions (caller-owned ids).** `-s/--session-id <uuid>` names a NEW session only (reusing
an existing uuid errors with "Session ID ... is already in use"); `--resume <uuid>` resumes.
The store lives at `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/` (the raw
absolute cwd, backslashes intact on Windows, URL-encoded byte-for-byte) with
`updates.jsonl` (append-only ACP `session/update` JSON-RPC log, the authoritative record),
`chat_history.jsonl` (raw model messages), and `summary.json` (metadata). `GROK_HOME`
overrides `~/.grok`. Because the id is caller-owned, `locate` is a deterministic path build
plus an existence poll, with a sessions-root scan fallback keyed on the uuid for encoding
mismatches. The command builder deliberately emits NO `--cwd`: grok keys the store by
process cwd, and a normalized `--cwd` value could key it under a different encoding than
`session-paths.ts` computes.

**Hooks (the activity pipeline).** Grok fires the full Claude-compatible hook set -
including in headless mode - with camelCase payloads (`toolName`, `toolUseId`, `toolInput`,
`toolResult`, `reason`, `stopHookActive`). `Stop` fires only for the main agent (subagents
fire `SubagentStop` in the subagent), so Claude's subagent-depth gating is unnecessary.
Grok has no per-session settings flag, so the hook file is per-cwd:
`<cwd>/.grok/hooks/kangentic.json`, a wholly-Kangentic-owned file (grok merges every
`*.json` in that directory, so user hook files are never read, merged, or swept). The
per-session events path rides the spawn environment instead of the file: hook commands name
`env:KANGENTIC_EVENTS_PATH`, which `event-bridge.js` resolves from its own process env at
run time - hook processes inherit the grok process env (probe-verified). One static file is
therefore correct for concurrent sessions in one cwd, and a session without the variable
(the user's own manual `grok` run there) makes the bridge a silent no-op. Hooks load from
the project root grok discovers by walking up to the first `.git`; every Kangentic spawn cwd
is a git root, so writing at cwd is writing at the root. On Windows grok runs each hook with
`pwsh -NoProfile -NonInteractive -Command`, and it replaces `$NAME` in the command first, so the
bridge path is quoted for that (see [Paths in hook commands](#paths-in-hook-commands)). Runtime is
`ActivityDetection.hooksAndPty()`: untrusted folders skip project hooks silently
(fail-open), and the PTY silence timer carries activity until trust lands. No `detectIdle`
regex - grok's `❯` prompt stays visible during active work, the same always-visible-prompt
trap as Codex's `›`.

**Telemetry (`updates.jsonl` tail, no statusline).** Grok has no statusline, so
`parseStatus` is null and usage comes from `runtime.sessionHistory` tailing `updates.jsonl`.
Three measured semantics are load-bearing: `params._meta.totalTokens` on streaming/tool
updates is the RUNNING context total (the ContextBar occupancy number);
`turn_completed.usage` is CUMULATIVE across the session (observed `numTurns: 8`,
`inputTokens: 541k` - using it for occupancy is the Codex `total_token_usage` trap; it feeds
`transcriptUsage` instead); and `costUsdTicks` is 1e-10 USD (pinned by a headless json run
reporting `total_cost_usd` and `total_cost_usd_ticks` side by side, re-checked by the
probe). Context window sizes and model display names come from `~/.grok/models_cache.json`.
The parser emits NO tool events - hooks own those, and a second emitter would double-count
ToolStart/ToolEnd pairs - only usage plus idempotent activity hints (`turn_completed` ->
Idle, chunks -> Thinking, non-terminal `retry_state` -> Thinking) as a hook backstop.

**Kangentic MCP.** Project-scoped `<cwd>/.grok/config.toml` carries a sentinel-delimited
`[mcp_servers.kangentic]` block whose every value is an env reference
(`url = "${KANGENTIC_MCP_URL}"`, token header `${KANGENTIC_MCP_TOKEN}`); grok's documented
`${VAR}` expansion resolves them at load time. The block is fully static - the per-session
URL (which carries the caller-session id) and per-launch token ride `buildEnv` - so
concurrent sessions in one cwd each expand their own environment, no secret ever reaches
disk or argv, and removal (held per session, shared with the hooks file) is a surgical strip of
the sentinel block that never reserializes the user's TOML. The builder also passes
`--allow "MCPTool(kangentic__*)"` (grok's native permission-rules mechanism,
session-scoped, deny still wins) so a board-driven session never stalls on the interactive
approval prompt for Kangentic's own tools - verified live without it,
`kangentic__kangentic_get_current_task` sat on the approval dialog with nobody there to
answer. This is Claude's `mcp__kangentic` allow-rule injection, in grok's dialect.

Both runtime files are hidden from git for the untracked case: the builder seeds
`.grok/hooks/kangentic.json` (unconditionally - the filename is wholly Kangentic-owned),
`.grok/config.toml` (only when Kangentic creates the file; a pre-existing user config keeps
its git visibility), and `.kangentic/` into `.git/info/exclude` via the shared
`git-exclude.ts` mechanism (see the Antigravity section). Neither file carries a secret, so
this is purely untracked-noise control for the Changes pane and `git add -A`.

**Trust.** Folder trust (`~/.grok/trusted_folders.toml`, entries
`[folders.'<path>'] / trusted = true / decided_at = <unix>`) gates project hooks and
project MCP together, and CASCADES to subdirectories - verified live: a Kangentic worktree
under a trusted project root reports `projectTrusted: true` with only the root in the store.
`ensureTrust` therefore pre-approves ONLY a Kangentic worktree with no covering decision
(one entry per task, dropped by `onWorktreeRemoved` - the Codex dead-entries lesson), never
overrules an explicit ancestor deny, and never auto-trusts a plain project root: an
undecided root runs untrusted (PTY fallback carries activity) until the user's own first
interactive grok session decides it once, which then cascades to every future worktree.

**Verification tier: confirm-only.** `chat_history.jsonl` flushes the typed user turn on
SUBMIT (measured 313ms and 32ms across two runs, against a ~2s turn), so a
`command-injection` verifier is wired against it (genuine turns have no `synthetic_reason`
and wrap the text in `<user_query>` tags, which the extractor strips). But records carry no
timestamps to bound the match window and the resolver has never been proven in-app, so
`canEscalateOnVerificationFailure` is false. `canVerifySlashSubmission` is false (slash
input runs in the TUI palette and never becomes a chat_history turn - the Codex verdict),
which is also why `getInjectionSequence` returns `[]` despite grok having native `/model`
and `/effort` commands: an unconfirmable injection could land as literal prompt text, while
a task session's restart applies `--model` / `--reasoning-effort` deterministically.

**Other capabilities.** `parseTranscript` reads `chat_history.jsonl`
(`system`/`user`/`assistant`/`reasoning`/`tool_result` records; assistant tool calls in
`tool_calls[]` with JSON-string `arguments`; no timestamps, so entries get a parse-time
stamp and synthesized uuids). `transcriptUsage`/`transcriptToolCounts` read `updates.jsonl`
(Claude-parity lifetime rollup). `summarize` runs the plain-output print mode
(`--output-format plain -p`) with the answer run's deny rules (see the Auto-Name table); its session
stays in `~/.grok/sessions` until a title is measured on the answer run. `probeAuth` runs `grok models` and checks for "not
authenticated" - note grok currently serves a free tier without login, so false means "not
signed in", not "unusable"; a subscription-less account that hits a limit gets an explicit
403 rendered as a failed turn in the TUI, not a hang. Auth is browser OAuth through the PTY
(`grok login`, device-code fallback `--device-auth`, `XAI_API_KEY` env for CI).

**Detector.** `binaryName: 'grok'` with NO `agent` alias - grok's installer also publishes
a generic `agent` shim that collides with Cursor's (see the collision guard below), and
`parseVersion` requires the `grok ` banner prefix so a foreign binary answering on a shared
name is rejected. `tests/unit/cursor-grok-binary-collision.test.ts` pins both directions.

### Command Building

`src/main/agent/adapters/grok/command-builder.ts`

```
grok [-s <uuid> | --resume <uuid>] --permission-mode <mode> [--allow "MCPTool(kangentic__*)"]
     [--model <slug>] [--reasoning-effort <effort>]
     [-- "<prompt>" | -p "<prompt>" --output-format plain]
```

- `-s <uuid>` names a NEW session and `--resume <uuid>` resumes an existing one; the builder emits exactly one of the two, never both.
- `--permission-mode` is always emitted (see below).
- `--allow "MCPTool(kangentic__*)"` rides along only when the Kangentic MCP server is attached, so a board-driven session never stalls on grok's interactive approval prompt for Kangentic's own tools. An explicit user deny still wins.
- Model and effort overrides pass straight through as `--model <slug>` and `--reasoning-effort <effort>` when set.
- The interactive prompt is delivered after `--` (end-of-options), so prompt text starting with a dash can never be parsed as a CLI option regardless of shell quoting. Non-interactive spawns (`nonInteractive` transition actions) use `-p "<prompt>" --output-format plain` instead, which prints one turn and exits. A resume passes no prompt at all.

### Permission Modes

`--permission-mode` accepts Kangentic's `PermissionMode` names verbatim (verified in
`grok --help`), so all six pass through 1:1. Internally grok normalizes `acceptEdits` and
`dontAsk` onto its own ladder (`default | auto | plan | bypassPermissions`), with `auto` as the
nearest neighbor, so the behavior these names select is grok's, not Claude's.

| Mode | CLI Flag |
|------|----------|
| `plan` | `--permission-mode plan` |
| `default` | `--permission-mode default` |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `auto` | `--permission-mode auto` |
| `dontAsk` | `--permission-mode dontAsk` |
| `bypassPermissions` | `--permission-mode bypassPermissions` |

`defaultPermission` is `acceptEdits`.

## Antigravity

Antigravity CLI (`agy`, https://antigravity.google/docs/cli/getting-started) is Google's terminal TUI coding agent, Gemini-family models by default with optional Claude and open-source backends. It shares the `~/.gemini` home directory with the Gemini CLI but keeps everything of its own under the `~/.gemini/antigravity-cli/` subtree, with its own trust store, hook schema, and MCP config format - hence a sibling adapter rather than a Gemini variant. Every behavior below was verified against a real agy 1.1.13 install (2026-08-16).

### CLI Detection

Detection uses the shared `AgentDetector` (via composition) with binary name `agy`. The official installer places the binary at `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows (a fallback path derived from the `LOCALAPPDATA` env var) and `~/.local/bin/agy` on macOS/Linux (covered by `standardUnixFallbackPaths`). `agy --version` prints a bare version number; `parseVersion` requires a leading digit so a foreign tool answering on the same name is rejected.

### Command Building

`src/main/agent/adapters/antigravity/command-builder.ts`

```
agy [--mode plan|accept-edits] [--dangerously-skip-permissions] [--conversation <id>] [--model <slug>] [--effort <level>] [-i|-p "<prompt>"]
```

- The interactive prompt is delivered via `-i` (`--prompt-interactive`), which runs the prompt and keeps the TUI session; agy has no bare positional prompt form. Non-interactive spawns (`nonInteractive` transition actions) use `-p` instead.
- Resume passes `--conversation <id>` with the captured conversation UUID; it works cross-directory, so a relocated worktree still reaches its conversation. Fresh spawns pass nothing - agy allocates the conversation id lazily at the first turn (`supportsCallerSessionId` is false).
- Model (`--model <slug>`) and effort (`--effort low|medium|high`) overrides pass straight through when set.
- As spawn side effects the builder merges the Kangentic named hook into `<cwd>/.agents/hooks.json` and writes the MCP workspace plugin (below).

### Permission Modes

Mapped onto agy's native autonomy flags; the unflagged default is agy's own "request-review" mode.

| Mode | agy flag |
|------|----------|
| `plan` | `--mode plan` |
| `default` | (none - request-review) |
| `acceptEdits` / `auto` | `--mode accept-edits` |
| `bypassPermissions` / `dontAsk` | `--dangerously-skip-permissions` |

`defaultPermission` is `acceptEdits`.

### Hooks and Activity Detection

agy has a lifecycle hook system (`hooks.json` in a customization root; the adapter writes `<cwd>/.agents/hooks.json` with one named hook, `kangentic-events`). Three events feed the event-bridge pipeline: `PreInvocation` -> `prompt` (the turn-initiating signal, also carrying a `captureHookContext` directive so the session id can be read from the payload), `PostToolUse` -> `tool_end` (tool name at `toolCall.name`, primary argument from `toolCall.args`, via the path-addressed `extractToolPath` / `extractDetailPath` directives), and `Stop` -> `idle` (agy's payload carries `fullyIdle`). `PreToolUse` is deliberately NEVER hooked: agy treats a handler response without a `decision` field as a DENY (observed: a `{}` response put the model in a tool-denied retry loop), and answering `allow` would bypass the CLI's own permission system.

Two agy quirks shape the wiring. First, agy tokenizes hook commands on whitespace with quote characters kept literal, so no command token may be quoted or contain a space: every path is emitted `.agents`-relative (hooks run with cwd = the directory containing hooks.json) and the event-bridge is copied to `<cwd>/.kangentic/agy-event-bridge.cjs` on each spawn whose copy differs from the app's bridge (`.cjs` so a `"type": "module"` in the user's package.json cannot make node parse the CommonJS bridge as ESM). Second, hooks do NOT fire in `-p` print mode, so activity is `hooks_and_pty`: hook events are primary, and the PTY silence timer plus a `detectIdle` match on the idle footer (`? for shortcuts`; the running footer shows `esc to cancel` instead) cover print-mode spawns and any workspace where hook wiring was skipped.

Session ids are captured two ways: `fromHook` reads `conversationId` (present in every hook payload, camelCase protojson), and `fromOutput` matches the graceful-shutdown summary (`agy --conversation=<uuid>`) plus print-mode JSON (`"conversation_id"`). There is no `fromFilesystem` capture: `cache/last_conversations.json` is written only at CLI exit, after the spawn-time polling window has closed.

### MCP

The Kangentic MCP server is registered as a WORKSPACE PLUGIN at `<cwd>/.agents/plugins/kangentic/` (`plugin.json` marker + `mcp_config.json` with `serverUrl` and a `headers['X-Kangentic-Token']` entry). agy dials `serverUrl` with streamable HTTP (`POST /mcp`) and forwards the headers map, connecting lazily at the first agent turn. A bare workspace `mcp_config.json` (no plugin wrapper) does not load (upstream google-antigravity/antigravity-cli#60). Same plaintext-token trade-off as Gemini: the per-launch token sits on disk during the active session; tokens rotate per app launch and `removeHooks()` deletes the plugin dir once the folder's last session exits or suspends. A spawn with MCP wiring holds the folder even without an events pipeline, so a neighbour's exit never deletes the plugin under it.

The runtime files are also hidden from git for the session's lifetime: the command builder seeds `.git/info/exclude` (the local, never-committed ignore file, resolved through the worktree's `commondir` so one seeding covers every worktree of the repo) with `.agents/plugins/kangentic/`, `.kangentic/`, and - only when Kangentic created the file itself - `.agents/hooks.json`. Ignore rules affect untracked files only, so a user's own tracked `.agents` customizations keep normal git visibility, while the token-bearing plugin can never ride into a commit on a `git add -A`. The marker comment in the exclude file says the lines are safe to remove. This mechanism originated here and now lives in `src/main/agent/shared/git-exclude.ts` (generic `# kangentic:` marker; the legacy antigravity-branded marker is recognized by prefix so already-seeded repos never gain a second marker block), shared by the Gemini, Qwen, Droid, and Grok builders and OpenCode's plugin install - each with its own pattern list and created-by-us carve-outs.

### Trust

agy stores workspace trust as `trustedWorkspaces: string[]` (exact absolute paths) in `~/.gemini/antigravity-cli/settings.json` - NOT Gemini's `trustedFolders.json`, and with no per-entry trust level. Trust is exact-path, not inherited: agy prompts for a task worktree even when the repository root above it is already trusted (observed live), so `ensureTrust` writes one entry per spawn cwd rather than relying on ancestor coverage, and the TUI's workspace trust confirmation never blocks an automated spawn. `onWorktreeRemoved` drops the exact-path entry so the list does not grow one dead entry per task, and `onProjectRelocated` re-keys both the trust entry and the `last_conversations.json` mapping.

### Session History and Transcript

Each conversation writes a parseable JSONL transcript at `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (steps: `USER_INPUT` with the prompt wrapped in `<USER_REQUEST>`, `PLANNER_RESPONSE` with `thinking` / `content` / `tool_calls`, `ERROR_MESSAGE`, `CHECKPOINT`). `parseTranscript` maps it into `TranscriptEntry[]` and `transcriptToolCounts` counts its tool calls. The conversation store itself (`conversations/<uuid>.db`) is SQLite with opaque protobuf step payloads and is not read.

The transcript flushes ON SUBMIT (measured: 84ms worst append latency across short and long turns), which is what qualifies the command-injection verifier - see [command-injection.md](command-injection.md).

### Limitations

- No token/context/cost telemetry: neither the interactive transcript nor the hook payloads carry usage, so the adapter declares `liveTelemetryUnsupported` ("Telemetry: TUI only" - the agy footer shows the active model and effort). The board model pill is seeded from a `--model` override via `configuredModelFromCommand`.
- No live model/effort injection: `/model` exists in the TUI but model changes restart by design, and no `/effort` slash command exists, so `getInjectionSequence` is omitted.
- No `probeAuth` / `loginCommand`: sign-in is keyring + Google Sign-In completed inside the TUI (works through the PTY); there is no login subcommand and no reliable non-quota probe.
- Slash auto_commands are `verify: 'none'`: the TUI rejects an unregistered `/command` client-side ("Unknown command") and records nothing (`canVerifySlashSubmission` is false).
- Handoff transcript cleanup captures the last turn only (no response marker glyph; same limitation as Gemini).

## Goose CLI

Goose is Block's open-source agent CLI (`goose`, https://github.com/aaif-goose/goose). It is a thin first-pass integration, close to the Warp/Ollama adapters: no hooks wired, no structured status/event output, no trust mechanism, and no settings merging. It differs from those two by supporting session resume and by delivering its approval mode through an env var.

"No hooks wired" rather than "no hooks", and the distinction is load-bearing because it is what justifies the PTY-only activity detection below. Goose ships a hook system: plugin-scoped `hooks/hooks.json` discovered from `<project>/.agents/plugins/<name>/` or `~/.agents/plugins/<name>/`, firing `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `PreToolUseResult`, `PostToolUse`, `PostToolUseFailure`, `BeforeReadFile`, `AfterFileEdit`, `BeforeShellExecution`, and `AfterShellExecution`, each handed a JSON payload on stdin carrying `event` and `session_id`. That is the same `.agents/` workspace shape the Antigravity adapter already writes to and a payload close to what `event-bridge.js` consumes, so wiring hooks (and with them structured activity, a session-id capture, and eventually a submission verifier) is a follow-up rather than a blocked path. Until then activity rides the PTY silence timer, with the false-idle exposure that implies.

### CLI Detection

Detection uses the shared `AgentDetector` (via composition) with binary name `goose` and `standardUnixFallbackPaths('goose')`. The official installer puts the binary in `~/.local/bin` on macOS/Linux (covered by those fallbacks) and in `%USERPROFILE%\.local\bin` on Windows, where it is added to PATH and found by `which`.

`parseVersion` REQUIRES a digit immediately after the product name (`goose` or `goose-cli`, optional `v`, case-insensitive). This is a collision defense, not cosmetic: two other tools install a binary called `goose` - pressly/goose, a widely used Go database-migration tool (banner `goose version: v3.24.1`), and the awesome-goose scaffolding framework (banner `goose version 0.0.0`). A scan-anywhere `MAJOR.MINOR.PATCH` match accepts both and reports them as Block's agent CLI, after which Kangentic spawns `goose run -t "<prompt>" -s` against a tool that has no such command. Both impostors put the literal word `version` where Block's clap-generated banner puts the digits, which is the discriminator. `AgentDetector` walks every `which` match in order, so rejecting a foreign banner means detection skips that binary and keeps looking rather than stopping on the wrong one. Same anchoring as `GrokDetector`, for the same reason.

The accept side is deliberately wider than one pinned string, because Goose's published docs show the `--version` command everywhere and its stdout nowhere. A false negative surfaces as a diagnosable "not found" with the raw line logged by `AgentDetector`; a false positive spawns the wrong binary.

### Command Building

`src/main/agent/adapters/goose/goose-adapter.ts`

```
goose run [-r] [-n <sessionId>] -t "<prompt>" -s    # with a prompt
goose run [-r] [-n <sessionId>] -t "<prompt>"       # nonInteractive spawn_agent action
goose session [-r] [-n <sessionId>]                 # promptless / resume
```

- Goose runs in the process cwd (there is no start-in-dir flag), so the PTY's cwd set by the spawn chokepoint is authoritative and no directory flag is passed.
- A prompt uses `goose run -t "<prompt>" -s`: process the prompt, then stay interactive (`-s` / `--interactive`) so the user can continue the session. A promptless spawn opens a bare interactive `goose session`.
- A `nonInteractive` spawn_agent action drops `-s`, which is already Goose's headless one-shot form: run the prompt and exit. Leaving `-s` on would park a fire-and-forget automation in a session that never exits.
- `-n <sessionId>` names the session with the engine-generated id when one is present; `-r` is added to resume that named session. On Windows / non-unix shells, embedded double quotes in the prompt are rewritten to single quotes.

### Session Resume

`supportsCallerSessionId` is `true`. Goose accepts a caller-supplied session name (`--name`), so the engine hands it the id it generated on the fresh spawn and resumes with `-r -n <id>`. No transcript parsing is needed to capture an id after the fact, so `locateSessionHistoryFile` returns null.

### Permission Modes

Goose sets its approval mode through the `GOOSE_MODE` env var, not a spawn flag, so the permission dropdown is delivered via `buildEnv`. The mapping lives in `GOOSE_MODE_BY_PERMISSION`, a `Record` over the full `PermissionMode` union (so a new mode is a compile error rather than a silent wrong-mode spawn), and it maps all six modes below. The dropdown exposes three, one per distinct Goose mode Kangentic can reach; `dontAsk`, `acceptEdits`, and `auto` are not offered there but are still mapped, so a column/lane override or the global default that forces one of them resolves to a valid `GOOSE_MODE`.

Goose has four modes. `approve` (every action needs approval) is stricter than `smart_approve`, so it sits below `default` on the permissiveness ladder the dropdown is ordered by and nothing maps to it.

| Mode | GOOSE_MODE | Goose Behavior |
|------|-----------|----------------|
| `plan` | `chat` | No tools at all. Not merely read-only: the agent cannot read files either, so a plan-mode Goose session reasons without repo access |
| `dontAsk` | `chat` | No tools (not in the dropdown). Goose has no allowlist, so "deny unless allowed" degrades to "deny" |
| `default` | `smart_approve` | File modifications need approval, reads do not |
| `acceptEdits` | `smart_approve` | Not in the dropdown. See below |
| `auto` | `auto` | Modify/create/delete and run shell commands without approval (not in the dropdown) |
| `bypassPermissions` | `auto` | Same as above. The explicit opt-in to full autonomy |

`acceptEdits` is the mode with no faithful target. Everywhere else in Kangentic it means "auto-approve edits, still gate shell commands", and Goose has no such mode: the only way to stop prompting on edits is `auto`, which also stops prompting on shell. It therefore resolves DOWN to `smart_approve` rather than up to `auto`, and this matters more than it looks: `DEFAULT_CONFIG.agent.permissionMode` is `acceptEdits` and `resolveEffectivePermissionMode` falls through task -> lane -> that global without consulting the adapter's `permissions` list, so whatever `acceptEdits` maps to is the out-of-the-box spawn for every Goose session on a fresh install. Mapping it to `auto` made that a fully unattended agent nobody chose. The practical consequence of resolving down is that a Goose agent on default settings prompts on file writes; choose "Auto (Skip All Approvals)" for unattended board runs.

`defaultPermission` is `default`. Model/provider selection is left to Goose's own `--model`/`--provider` flags and `~/.config/goose/config.yaml`; per `cli-features-over-custom-layers.md` the adapter keeps no model list and does not shadow the CLI's model control.

### Activity Detection

Runtime activity is PTY-only. The silence timer drives the idle transition; `detectFirstOutput` returns true on any non-empty data (no alternate screen buffer). There is no hook or status pipeline.

### Limitations

Every item here is "not wired in this adapter", not "the CLI cannot do it", except where noted.

- No hook plugin installed, so no structured status or event output: the PTY silence timer is the sole idle detection, with the false-idle exposure that implies. Goose's hook system (see above) is the obvious way to close this.
- No MCP wiring, so a Goose session cannot call the `kangentic_*` tools. Goose supports MCP extensions natively (`--with-extension`, `--with-streamable-http-extension <url>`), so this is a follow-up too.
- No settings merge and no trust mechanism (Goose genuinely has no folder-trust gate).
- No transcript parsing or capability discovery, and no `summarize` (auto-name not yet wired).
- `locateSessionHistoryFile` returns null - resume rides on the caller-supplied `--name` instead.
- `plan` mode maps to Goose `chat`, which has no file access at all, so a plan-mode Goose session cannot read the repo it is planning against.

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
| Grok Build | `~/.grok/sessions/<encodeURIComponent(cwd)>/` session dirs and `[folders.'<path>']` headers in `~/.grok/trusted_folders.toml`. | Encoded-dir rename mirrors Droid's slug rename; the trust rewrite mirrors Codex's header rewrite (backup + atomic write). |
| Antigravity | `trustedWorkspaces` entries in `~/.gemini/antigravity-cli/settings.json` and the workspace key in `~/.gemini/antigravity-cli/cache/last_conversations.json`. | Conversation data (`conversations/<uuid>.db`, `brain/<uuid>/`) is keyed by conversation id, not path, and Kangentic resumes by explicit `--conversation <id>` (cross-directory), so only trust and the user's own `agy -c` continuity need migrating. |
| Goose | None. | Resume rides on the caller-supplied `--name` (cwd-independent), so no path-keyed state needs migrating; `onProjectRelocated` omitted. |

## Prompt Templates

A legacy `spawn_agent` automation row can carry a `promptTemplate` with `{{placeholder}}` variables. Every variable is documented once, in the transition engine's [Template Variables](transition-engine.md#template-variables) section. The two families worth calling out for prompt authoring:

- `{{task_xml}}` is the preferred default: a `<task><title>...</title><description>...</description></task>` envelope (escaped).
- `{{title}}` / `{{description}}` remain for backward compatibility with custom prose templates.

Default template: `{{task_xml}}{{workflow_xml}}{{attachments}}` (`{{workflow_xml}}` is empty, and dropped, for a task outside a workflow)

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

Four standalone Node.js scripts in `src/main/agent/`:

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
- **Appended events:** `appendBackgroundLaunch` and `appendBackgroundStop` write a `background_shell_start` or `background_shell_end` line beside the hook's own event, from the adapter's `BackgroundCommandSpec` (see [Background commands](#background-commands)). They are new kinds rather than flags on an old one, so a stale bridge copy rejects them through its unknown-directive branch instead of misreading them. A suppressed main event still lets an appended line land.
- **Watched by:** SessionManager with 50ms debounce, incremental byte-offset reads
- **Supported by:** Claude Code (18 hook points), Codex CLI (via `-c hooks.*` overrides and a per-spawn workspace copy, `<cwd>/.kangentic/codex-event-bridge.cjs`, with the `env:KANGENTIC_EVENTS_PATH` sentinel - see [Codex Hook Integration](#hook-integration)), Gemini CLI (via .gemini/settings.json hooks), Qwen Code (on Windows via a per-spawn workspace copy, `<cwd>/.kangentic/qwen-event-bridge.cjs`, and the `env:KANGENTIC_EVENTS_PATH` sentinel - see [Paths in hook commands](#paths-in-hook-commands)), Aider, GitHub Copilot CLI, Grok Build (via `.grok/hooks/kangentic.json`, with the events path resolved through the `env:KANGENTIC_EVENTS_PATH` sentinel - see [Grok Build](#grok-build)), and Antigravity CLI (via a per-spawn workspace copy, `<cwd>/.kangentic/agy-event-bridge.cjs` - see [Antigravity](#antigravity))

### `plan-approval-bridge.js`

- **Hook point:** a second `PermissionRequest` entry, matcher exactly `ExitPlanMode`, beside the event bridge's catch-all one. Registered on every spawn of an adapter that declares `supportsPlanAutoApproval`, whatever the column says, so a column or workflow switched to Automatic while the agent plans needs no hook reload. A question the agent asks (`AskUserQuestion`) never reaches it.
- **Input:** the session's decision file, `.kangentic/sessions/<ptySessionId>/plan-approval.json` (`{ approve, mode, detail }`), and a base64 spec (`PlanApprovalHookSpec` in `src/main/agent/shared/plan-approval-hook.ts`) naming the tool, where its input sits, and the reply the CLI expects. The tool approval entry carries a `PlanToolApprovalHookSpec` instead (the allowed tools, the excluded ones, the modes it answers in, a bare reply). All agent knowledge is in the spec, never in the script.
- **Output:** to approve, the reply on stdout, after one `plan_approval_sent` line appended to `events.jsonl` (`tool_approval_sent` for the tool entry). Claude's reply (`CLAUDE_PLAN_APPROVAL_SPEC` in `adapters/claude/hook-manager.ts`) is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":<tool_input>,"updatedPermissions":[{"type":"setMode","mode":<mode>,"destination":"session"}]}}}`. The input is echoed exactly, since Claude 2.1.300 and later deny a call whose input changed. `setMode` is needed because a hook approval otherwise restores the mode the session had before plan mode, and a session launched in plan mode has none.
- **Allowed tools while planning (task #870):** Claude's plan mode prompts for every tool that is not read-only. An MCP tool whose server does not annotate it `readOnlyHint` is not read-only, and an allow rule does not reach it there, so an unattended Planning session stopped at that prompt. When the session's allow rules name such a tool, the builder registers the same bridge a second time (a third `PermissionRequest` entry), matcher `mcp__.*`, with a `PlanToolApprovalHookSpec`: the tools and server prefixes the rules allow, the ones a deny or ask rule names, and Kangentic's own server, always excluded so its mutating tools keep prompting ([mcp-server.md](mcp-server.md)). It answers a bare allow, after one `tool_approval_sent` line naming the tool, only in plan mode (`permission_mode`) and only while the decision file says `approve: true`. The rules are read from the session's merged settings (project, project local, worktree local) and the user's `~/.claude/settings.json`, in `adapters/claude/plan-tool-approval.ts`. Measured on Claude 2.1.306 by `scripts/probe-claude-plan-tool-approval.js`, in `-p` and the interactive TUI: the hook's allow ran the call, a subagent's included, and outranked an ask rule, which is why the builder leaves an asked tool out. An ask or deny rule it cannot read as one of the MCP forms (a partial wildcard such as `mcp__docs__get_*`, or a specifier) excludes every tool its text before the `*` or `(` begins. Managed settings are not read, so a managed ask rule for a tool a project or user rule allows is answered anyway. The captured requests are in `tests/fixtures/plan-exit/claude-2.1.306-permission-request-mcp-tool*.json`.
- **Fails closed:** another tool, no decision file, `approve: false`, or any error prints nothing and exits 0, so the CLI shows its own dialog and the user decides. Diagnostics go to `plan-approval-bridge.error.log` beside the decision file, never to stdout.
- **Decision writer:** `PlanApprovalWriter` (`src/main/plan-approval/plan-approval-writer.ts`) writes the file through `safeWriteJson` (source `plan_approval`) when a task session first appears, and rewrites every live session's file, coalesced at 100 ms, on any board change and on a Board Profile edit, a settings change or a `kangentic.json` apply (`refreshPlanApprovals`). The decision comes from `resolvePlanApprovalDecision` (`src/main/plan-approval/resolve-decision.ts`): a running workflow's value, else the column's own while it runs in plan mode, and never an approval where the session's agent cannot approve plans or the task's automations are disabled (`canTaskRunAutomations`). `mode` is the destination's effective permission mode (the After Plan Mode target, or the next column on a workflow task's route); where that is `plan`, or `bypassPermissions` in a session launched without bypass available, it falls back to the task's own mode, then the global mode, then `default`. A plan-mode spawn whose approval would continue in `bypassPermissions` launches with `CommandOptions.bypassAvailable`. Transient sessions (a Command Terminal, a workflow's own agent) get no decision file, so their plans always wait.
- **Supported by:** Claude Code (measured on 2.1.302: `acceptEdits` and `auto` apply through `setMode`; `bypassPermissions` applies only to a session launched with bypass available)

### `background-shell-hint-bridge.js`

- **Hook point:** a second post-tool entry beside the event bridge's catch-all one, matcher-scoped to the launch tools where the CLI has matchers (Claude's `Bash|PowerShell`). Registered only for a session whose MCP URL names it as the caller (`urlNamesTaskSessionCaller`), because the hint points at `kangentic_mark_background_service`, which the server offers only to such a session. A Command Terminal, or a session with the MCP server off, gets none.
- **Input:** the hook payload on stdin, and a base64 spec (`src/main/agent/shared/background-shell-hint-hook.ts`) naming the tools, where the command and the shell id sit, the opt-out flag, and the reply. All agent knowledge is in the spec, never in the script. Claude sends the v1 shape (`BackgroundShellHintSpec`), which its replay fixtures pin. Every other agent sends v2 (`BackgroundShellHintSpecV2`, `{ launch, reply }`), whose `launch` is the same match its `appendBackgroundLaunch` directive carries. A stale bridge prints nothing for v2, since it requires the v1 fields.
- **Output:** for a result carrying an id-shaped background shell id, from a command without `--kangentic-no-activity-hold`, the reply on stdout, with the one hint text `BACKGROUND_SHELL_HINT_TEXT` in the CLI's own envelope. Claude's (`CLAUDE_BACKGROUND_SHELL_HINT_SPEC` in `adapters/claude/hook-manager.ts`) is `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":<hint>}}`: the shell keeps the task working and holds the column's turn-end automations until it exits, and a server or watcher can be marked with the tool. See "Opting a background shell out of the hold" in [Activity Detection](activity-detection.md).
- **Prints nothing** for a foreground call, another tool, a flagged command, stdin over 1 MiB, or any error, and exits 0, so it never fails or blocks a tool.
- **Supported by:** Claude Code (probed headless on 2026-10-20: the context reached the model for a Bash and a PowerShell `run_in_background` launch, both results carried `tool_response.backgroundTaskId`, and Claude runs one event's hooks in parallel, so the hint adds no wall time to a tool call), Qwen Code 0.25.3, Gemini CLI 0.64.0 and GitHub Copilot CLI 1.0.100 (each probed headless against a local stand-in for its model API, with a nonce in the reply found in the next model request)

All four scripts are stateless (no persistent process), read JSON from stdin, and exit. All writes are try/catch wrapped for non-fatal failures.

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
