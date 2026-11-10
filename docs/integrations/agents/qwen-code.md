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
  - resource: src/main/agent/adapters/qwen-code/accounts.ts
  - resource: src/main/agent/adapters/qwen-code/session-history-parser.ts
  - resource: src/main/agent/adapters/qwen-code/transcript-parser.ts
  - resource: src/main/agent/adapters/qwen-code/transcript-metrics.ts
  - resource: src/main/agent/adapters/qwen-code/subagent-usage.ts
  - resource: src/main/agent/adapters/qwen-code/conversation-gone.ts
  - resource: src/main/agent/adapters/qwen-code/status-parser.ts
  - resource: src/main/agent/shared/git-exclude.ts
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
qwen --approval-mode <mode> --session-id <uuid> -i "prompt text"
```

Kangentic generates a UUID up front and passes it via `--session-id`, mirroring Claude. Qwen 0.15.3+ honors caller-owned UUIDs and writes its session JSONL at exactly `<our-uuid>.jsonl`.

The prompt rides `-i` (`--prompt-interactive`), which opens the TUI with it loaded, or `-p` in a non-interactive run. Qwen treats a bare positional prompt as a one-shot run that exits after one response, so the builder never sends one.

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
| `acceptEdits` | `--approval-mode auto-edit` | Auto Edit (Auto-Approve Edits) |
| `auto` | `--approval-mode auto` on 0.16.0 and later, else `auto-edit` | Auto (Classifier Approves Safe Actions) |
| `bypassPermissions` | `--approval-mode yolo` | YOLO (Auto-Approve All) |

The fork swapped Gemini's `auto_edit` (underscore) flag value for `auto-edit` (hyphen). The unit tests guard against the underscore form regressing.

Qwen has its own `auto` mode, in which an LLM classifier approves safe shell commands, network calls and out-of-workspace edits and blocks risky ones. Its yargs `choices` gain `auto` in v0.16.0 and do not have it in v0.15.6 ([config.ts at v0.16.0](https://github.com/QwenLM/qwen-code/blob/v0.16.0/packages/cli/src/config/config.ts), [approval mode docs](https://qwenlm.github.io/qwen-code-docs/en/users/features/approval-mode/)). A value outside `choices` stops Qwen from starting, so an older Qwen, or one whose version was not detected, runs `auto` as `auto-edit` (`supportsAutoApprovalMode`). That is the opposite default to `--mcp-config`, where an unknown version takes the flag. Qwen has no mode that denies what was not pre-approved, so `dontAsk` keeps plan, the nearest mode that never prompts.

## Hooks

`src/main/agent/adapters/qwen-code/hook-manager.ts`

Qwen's `HookEventName` uses Claude Code's names (read from the 0.21.7 and 0.24.0 bundles, and the
same in upstream v0.12.0 and v0.15.3), and Qwen skips any other key with an "Invalid hook event
name" warning. The adapter wrote Gemini's names before plan approval shipped, so on those versions only
SessionStart, SessionEnd and Notification ever fired. Each event now maps as Claude's does:

| Qwen event | Kangentic event |
|------------|-----------------|
| `PreToolUse` | `tool_start` (tool, `tool_use_id`, the subagent's `agent_id`, file path, command, query, pattern, URL or description), marked a subagent launch for `agent` and `task` |
| `PostToolUse` | `tool_end` (fires only for a result with no error), with `agent_id` |
| `PostToolUseFailure` | `tool_end`, or `interrupted` when `is_interrupt` is true, with `agent_id` |
| `UserPromptSubmit` / `Stop` | `prompt` / `idle`, both with the session's plan mode; a Command Terminal's prompt also carries `submitted_prompt`, else `prompt`, for its namer |
| `StopFailure` | `turn_failed` (an API error or loop detection ended the turn) |
| `PermissionRequest` | `idle` with detail `permission`, naming the tool, with its kind (`waitKind`): `ask_user_question` is a question, every other tool (the plan exit included) an approval |
| `SubagentStart` / `SubagentStop` | `subagent_start` / `subagent_stop`, with `agent_type` in `detail` and `agent_id` as the subagent id |
| `PreCompact` | `compact` |
| `Notification`, `SessionStart`, `SessionEnd` | the same-named events (a `Notification`, `idle_prompt` included, stays log-only) |

Every payload carries `agent_id` only when the event fires inside a subagent ([hooks.md at v0.26.6](https://github.com/QwenLM/qwen-code/blob/v0.26.6/docs/users/features/hooks.md)), so the tool events carry it as Claude's do: a subagent's tool end cannot drain a main-agent tool of the same name. The `agent` tool (and `task`, its legacy alias, per `tool-names.ts`) is marked as a subagent launch, so only that call's own approval lets its `subagent_start` close the prompt it waited on. On 0.25.2's order the call is pending when the prompt opens and the mark pairs them. On 0.25.3's reverse order it does nothing.

`idle_prompt` is not an idle hint, unlike Claude's "waiting for your input". Qwen fires it each time its streaming state passes through Idle (`useAttentionNotifications.ts`), and the live 0.25.2 session sent it right after almost every `PreToolUse`, mid-turn (`notification-idle-prompt-mid-turn.json`). The source alone reads like a turn-end signal; the capture shows it is not one.

A live 0.25.2 session fires `PreToolUse` and then `PermissionRequest`, the same order as Claude
(Qwen's own payload timestamps put the shell tool's `PreToolUse` 344 ms before its
`PermissionRequest`). The 0.25.3 bundle reads the other way: the scheduler's `_schedule` fires
`PermissionRequest` before the call waits for approval, and `PreToolUse` fires only in
`_executeToolCallBody`, after the answer. `ask_user_question` takes that same path. Either order
gives a correct question wait (GitHub #452): on 0.25.2 the wait lands after its tool's start and
holds until the tool ends, and on 0.25.3 the wait comes first and the `PreToolUse` that follows
the answer ends it. The 0.25.3 order was read from the bundle, not captured. A
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

Qwen Code reads settings from `.qwen/settings.json` in the project directory. Like Gemini it has no `--settings` flag, so Kangentic writes merged settings (with event-bridge hooks) directly to `.qwen/settings.json` in the CWD. Concurrent sessions in the same folder are serialized by per-session holds in `QwenAdapter.hookHolds`, identical to the Gemini implementation. As with Gemini, the base file (the project root's in the main repo, and in a worktree the branch's own tracked copy, else the root's) is read on every spawn with Kangentic's own hooks and `mcpServers.kangentic` entry stripped (`stripKangenticEntries`), so an edit reaches the next session and the previous spawn's entries never become the baseline. In a worktree a copy git tracks is the branch's and is read instead, so a spawn never replaces it with the root's (see [Gemini's Settings Merge](gemini-cli.md#settings-merge)). When Kangentic creates the file the builder seeds `.qwen/settings.json` and `.kangentic/` into `.git/info/exclude` (created-by-us carve-out: a pre-existing user file keeps its git visibility).

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

Every `~/.qwen` path on this page is Qwen's global directory, `$QWEN_HOME` when set (`qwenHomeDir`, `qwen-home.ts`), the variable Qwen's settings docs name for moving it. The trust write and removal and the settings read use it, so Kangentic writes trust where Qwen reads it. A leading `~` is expanded. A relative value is left out: Qwen resolves one against its own working directory, which a global reader does not have. The chats, the subagent transcripts and `tmp/` live under the runtime directory instead (see [Session History](#session-history)), which is `~/.qwen` unless the user moved it.

Two things differ from the Gemini implementation:

- The write is gated on `security.folderTrust.enabled` in `~/.qwen/settings.json`. With that flag unset (the upstream default) Qwen implicitly trusts every folder, so `ensureTrust` writes nothing rather than cluttering the user's home directory. Gemini has no such gate, because 0.54.4 enforces trust with the flag unset.
- There is no ancestor check. Gemini skips the write when an already-trusted ancestor covers the path; Qwen records one key for every worktree it spawns into. Those keys are redundant, not load-bearing: `LoadedTrustedFolders.isPathTrusted` in qwen-code 0.21.7 matches a `TRUST_FOLDER` rule with a containment test (`isWithinRoot`), so a trusted project root already trusts every worktree beneath it. Porting Gemini's `hasTrustedAncestor` skip would remove the accumulation at its source rather than reaping it afterwards.

Qwen's `DO_NOT_TRUST` is the mirror image and is worth knowing before copying more of Gemini's logic here: the same function matches a deny with raw string equality, so it applies to the exact path only and never cascades. The trusted loop also runs first and returns early, so a covering `TRUST_FOLDER` beats an exact-path deny. Kangentic's write honors a `DO_NOT_TRUST` recorded at the worktree path itself, which is the only place the CLI would have honored one either. Both are exact string lookups against the canonical forward-slash key, so a deny stored under a different separator style is invisible to Kangentic's write and to the CLI alike. Removal is deliberately the asymmetric one: it matches on the resolved location, so it reaps a `TRUST_FOLDER` key whatever separators it was stored with.

The second difference is what makes cleanup load-bearing here. `QwenAdapter.onWorktreeRemoved` calls `removeWorktreeTrust` when Kangentic deletes a worktree, or the file grows by one dead path per task forever (the accumulation that reached 473 entries in Codex's `config.toml`). Removal diverges from the write in two deliberate ways. It is NOT gated on `security.folderTrust.enabled`: that flag lives in a separate file the user and the CLI both edit, so gating on it would leak every entry a user wrote before turning folder trust back off. And it never throws, because by the time it runs the worktree is gone and a failed write only leaves a stale entry, so it goes through `atomicWriteFileWithBackup` (temp file plus rename, `.kangentic-backup`) which logs and returns false instead. Matching is on the resolved location rather than the raw key, since the relocation pass and Qwen's own CLI both write keys and the file ends up holding mixed separator styles. Only a `TRUST_FOLDER` entry is taken, so a `TRUST_PARENT` or `DO_NOT_TRUST` at that path survives the directory and a later worktree there still honors it.

## Session History

Native chat session JSONL file:

```
<runtime>/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
```

`<runtime>` is Qwen's runtime directory (`qwenRuntimeDir`, `qwen-home.ts`), resolved in Qwen's own order (`Storage.getRuntimeBaseDir` in [storage.ts at v0.26.6](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/config/storage.ts)):

1. `QWEN_RUNTIME_DIR`
2. `advanced.runtimeOutputDir`, from the workspace's `.qwen/settings.json` and then the user's, resolved against the workspace
3. `QWEN_HOME`, else `~/.qwen`

Reading `QWEN_HOME` alone would leave a user with either override no history, transcript, verifier or model list. A settings file that is not plain JSON (Qwen accepts comments) is skipped. A Qwen in a WSL distro reads the distro shell's own `QWEN_RUNTIME_DIR`, which `WSL_ENV_KEYS` (`wsl-distro.ts`) collects, and its settings.

`<sanitized-cwd>` is the cwd lowercased (on Windows) with every non-alphanumeric character replaced
by `-`, so `C:\Users\dev\proj` becomes `c--users-dev-proj`. The filename is exactly the session UUID
with no prefix or timestamp, and since Kangentic supplies that UUID via `--session-id`, `locate()`
is direct path construction rather than a directory scan.

Verified against Qwen Code 0.15.3 on disk. Qwen is a gemini-cli fork but moved chat persistence
entirely: it does NOT use Gemini's `~/.gemini/tmp/<basename>/chats/session-<timestamp><shortId>.json`
layout. See the note at the top of `qwen-code/session-history-parser.ts`.

The parser walks the `messages[]` array backwards to find the most recent assistant message and reads its `model` + `tokens` fields. Both `type: 'qwen'` (rebranded build) and `type: 'gemini'` (some forks retain the upstream literal) are accepted.

Context window size is read straight off the event: Qwen records a real `contextWindowSize` on every assistant event, so there is no lookup table to maintain. A missing field (older builds) falls through to the `0` sentinel, and the renderer hides the progress bar and shows only the model name.

## Transcript, usage and subagents

`transcript-parser.ts`, `transcript-metrics.ts`, `subagent-usage.ts`

Record shapes come from `ChatRecord` in [chatRecordingService.ts at v0.26.6](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/services/chatRecordingService.ts). `type` is `user`, `assistant`, `tool_result` or `system`, and every record carries `uuid` and a `timestamp`:

- **Tool results.** `recordToolResult` writes a `tool_result` record whose `message.parts` hold the `functionResponse`. The parser reads it, and the same parts in a `user` record, where older writers put them. A parser that read only `user` and `assistant` would show no Qwen tool result in the Conversation viewer.
- **Per-turn usage.** `recordAssistantTurn` writes one API response's `usageMetadata` on each assistant record, and the parser puts it on the entry (`usage`) for the turn-usage ledger:
  - Fresh input is `promptTokenCount - cachedContentTokenCount`, and the cached part is a cache read.
  - Output follows Qwen's own rule (`outputTokenCount` in `telemetry/gen-ai-usage.ts`). An OpenAI-compatible provider counts reasoning inside `candidatesTokenCount`; Gemini reports it apart in `thoughtsTokenCount`. `totalTokenCount - promptTokenCount` decides when it falls between the two, and otherwise the candidates count stands, so reasoning is never counted twice.
  - `system` ui_telemetry records repeat the counts and are never read.
- **Lifetime readers.**
  - `transcriptUsage` sums every assistant record once, with the full input side (cache included, as Claude's lifetime input counts it).
  - `transcriptToolCounts` and `transcriptToolResultTokens` share the append cursor Claude's readers use (`shared/tool-call-cursor.ts`), with Qwen's own line reader. They count distinct `functionCall` ids, size each `functionResponse` at characters/4, and scope a read to one run by the records' timestamps.
  - A `--resume` appends to the same file, so `scopesTranscriptReadsByTime` is true.
- **`parseTranscriptWindow`.** Reads the chat window by window for the conversation indexer. Lines before a window are counted only when it holds a record with no `uuid`, so a fallback uuid matches the tail's and the pages'.
- **Subagents.** Each subagent writes its own transcript ([agent-transcript.ts at v0.26.6](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/agents/agent-transcript.ts)):
  - Its files are `<runtime>/projects/<slug>/subagents/<sessionId>/agent-<id>.jsonl` with a `.meta.json` sidecar. The parent's `agent` result has its calls stripped, so these files are the only record of a subagent's spend.
  - `statSubagentTranscripts` signs the `.jsonl` files and leaves out the transient `.jsonl.stream`.
  - `parseSubagentUsage` records one turn per assistant record with usage. The sidecar supplies `agentType`, `model`, and `toolUseId` (the parent's `agent` call), and depth follows its `parentAgentId` chain, since Qwen says its own `depth` is never trusted raw. Spawn links come from `agent`/`task` calls, and `subagentSpawnToolName` is `agent`.
- **File changes.** `fileChangeTools` names `edit` and its legacy alias `replace`, plus `write_file` by `file_path` and `notebook_edit` by `notebook_path` (`edit.ts`, `write-file.ts`, `tool-names.ts` at v0.26.6).
- **Model on the card.** `configuredModelFromCommand` reads the spawn's `--model` with the raw id as its label. Qwen serves many providers' ids, and `humanizeModelId` would turn `gpt-4.1` into "Gpt 4.1", so there is no `modelDisplayName` either.

## Following `/clear`

`/clear` and `/branch` start a new session id (`config.startNewSession()` in [clearCommand.ts at v0.26.6](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/cli/src/ui/commands/clearCommand.ts)), and an in-TUI `/resume` loads another. Each fires SessionStart with its `source` (`SessionStartSource` in [hooks/types.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/hooks/types.ts)).

Qwen writes no status file, so the SessionStart hook is the only signal of a move. Without it, the session record would keep the conversation the terminal started with, and a pause and resume would reopen the conversation the user had cleared away.

- `statusFile.parseSessionStart` reads `clear`, `branch`, `resume` and `compact` as moves and `startup` as a launch. A payload carrying `agent_id` fired inside a subagent and reads as nothing, as does a `session_id` holding a path separator or `..`, since the id names the chat file.
- `runtime.sessionId.followsSessionStartMoves` lets such a hook switch the session's id by itself, through the same chain that records any captured id.
- The session manager re-points the history tail at the new conversation's chat, unless the session already ended. Qwen creates a chat with its first record, the next prompt, so that attach keeps locating for as long as the session runs (`waitForFile` in `session-history-reader.ts`) where a spawn's attach gives up after about 5 s. Until that prompt the card keeps the old conversation's usage. A detach while the first attach is still locating cancels it, and the new attach starts clean.

Built from Qwen's source: the live 0.25.2 capture holds only a `startup` SessionStart.

## Resume of a deleted chat

`conversation-gone.ts`

`qwen --resume <uuid>` with no saved chat exits 1 with "No saved session found with ID <id>" ([config.ts at v0.26.6](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/cli/src/config/config.ts)). It does not start fresh, so `proveConversationGone` proves the chat gone and the resume starts a new conversation from a recap.

The proof is Claude's, over Qwen's layout:

1. The SessionStart hook's reported `transcript_path` must be missing. That path follows any runtime override Kangentic does not know about.
2. The reader's path must be missing too.
3. The `projects` folder above it must be readable.
4. No other project folder may hold `chats/<id>.jsonl`.

Anything short of that resumes as before.

## Built from documentation, not checked against the real CLI

No signed-in Qwen was available, so these were built from Qwen's docs and source at the versions named, and have not met a real Qwen session:

| Behavior | Source |
|----------|--------|
| `--approval-mode auto` from 0.16.0 | [config.ts at v0.15.6](https://github.com/QwenLM/qwen-code/blob/v0.15.6/packages/cli/src/config/config.ts) and [at v0.16.0](https://github.com/QwenLM/qwen-code/blob/v0.16.0/packages/cli/src/config/config.ts); [approval mode docs](https://qwenlm.github.io/qwen-code-docs/en/users/features/approval-mode/) |
| `agent_id` on tool events, the `agent`/`task` launch mark, `submitted_prompt`/`prompt` capture | [hooks/types.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/hooks/types.ts), [hooks.md](https://github.com/QwenLM/qwen-code/blob/v0.26.6/docs/users/features/hooks.md), [tool-names.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/tools/tool-names.ts), all v0.26.6 |
| The runtime directory (`QWEN_RUNTIME_DIR`, `advanced.runtimeOutputDir`) | [storage.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/config/storage.ts), [config.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/cli/src/config/config.ts), v0.26.6 |
| `tool_result` records, per-turn usage, the lifetime and tool-call readers, `parseTranscriptWindow` | [chatRecordingService.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/services/chatRecordingService.ts), [gen-ai-usage.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/telemetry/gen-ai-usage.ts), v0.26.6, and the 0.15.3 fixture |
| `fileChangeTools`, `subagentSpawnToolName` | [edit.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/tools/edit.ts), [write-file.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/tools/write-file.ts), [tool-names.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/tools/tool-names.ts), v0.26.6 |
| `statSubagentTranscripts`, `parseSubagentUsage` | [agent-transcript.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/agents/agent-transcript.ts) and [agent/agent.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/tools/agent/agent.ts) (`toolUseId: this.callId`, and [turn.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/core/turn.ts) makes `callId` the model's `functionCall.id`, so the sidecar, the chat and the spawn links name the same call), v0.26.6 |
| `proveConversationGone` | [config.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/cli/src/config/config.ts), v0.26.6 |
| Following `/clear` (`parseSessionStart`, `followsSessionStartMoves`) | [clearCommand.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/cli/src/ui/commands/clearCommand.ts), [hooks/types.ts](https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/hooks/types.ts), v0.26.6 |

The lifetime, tool-call and subagent readers were run once by hand over a developer's real chats, 0.15.3 to 0.25.3. Across the 24 chats with usage, every API response outside a subagent matches an assistant record's usage exactly, so the lifetime totals equal Qwen's own `qwen-code.api_response` telemetry less its subagent responses. Three chats held tool results and one a subagent folder: the tool and subagent readers returned plausible totals, every key they read is in the real records, and a sidecar's `toolUseId` is in its parent chat. No record held a nonzero `thoughtsTokenCount`, so that branch of `qwenTurnUsage` has not met real data. No real record is committed, so the repository cannot repeat that run.

The transcript and subagent readers replay `tests/fixtures/qwen-0.25.2-session/`. Its content is invented, but its structure is hand-written to match a real 0.25.2 session with a subagent: every key a reader uses, usage on the thought record before a tool call, `tool_result` records, `ui_telemetry` lines of the kinds each file holds (`qwen-code.*` in a chat, `tool_lifecycle` in a subagent's), and a sidecar whose `depth` counts from 0. A sanitized copy of the real capture would replace it, but committing one carries a developer's local Qwen data into a public repository, so that needs an explicit go-ahead.

Not built from docs, because their contract asks for a measurement of the real CLI first:

- `pastedImageNativeExtensions`: `pasted-image-paths.ts` lists `png|jpe?g|gif|webp|bmp`
- the paste verifier, and escalation for the command-injection verifier
- `answerCapabilities` streaming and search, and `openAnswerSession` (`--input-format stream-json`)
- `supportsReadOnlyLaunch`
- `supportsPlanAutoApproval`
- `hungTurn`
- `consoleCloseIsGraceful`
- `describeStartupFailure` for "No saved session found with ID"
- `firstPromptMayBeTyped`

## Accounts

**Built, not enabled.** Qwen has no card in Settings > Accounts yet. Its key-file accounts were written from the bundle's source and never run, so the adapter does not declare them. What follows describes it as built ([accounts](../accounts.md), Per agent).

Each extra Qwen account is a key file the user owns (task #1057, [accounts](../accounts.md)). Qwen's login is an API key under the variable its chosen provider names (`modelProviders.<type>[].envKey`), and Qwen reads a variable from the process env first, then its `.env` files, then `settings.env`, each only when still unset (0.21.7 and 0.26.5 bundles). So a session on a key-file account gets the file's keys in its env and they win. The names taken are the ones Qwen's built-in providers use, plus any `QWEN_CUSTOM_API_KEY_*`, the name it generates for a custom provider. The key file must set the variable the user's selected model reads.

A `QWEN_HOME` folder per account was researched and not built. An account folder still reads the user's own `~/.qwen/.env`. Chats would need `QWEN_RUNTIME_DIR` worked out per working directory. Qwen removes a linked `file-history` folder daily on Windows and refuses one elsewhere. And Qwen names no signed-in user, so two accounts could not be told apart.

## WSL

A Qwen installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Qwen's Linux path in a `wsl -d <distro>` shell. Its `.qwen/settings.json` hooks call the WSL hook transport's script (`wsl-hook.sh event <type> <directives>`) in place of the node bridge, with the same events and directives, since a distro may have no node, and the background shell hint goes through the transport's `reply`. The file is shared by every session in the folder, so the commands name the folder's copy of the script, `<cwd>/.kangentic/qwen-wsl-hook.sh`, which finds the session's own folder through `KANGENTIC_WSL_HOOK_DIR`. Naming one session's script would break every other session's hooks once that session's folder was removed. Qwen passes each hook its payload on stdin and closes it, which the script's `event` mode reads, so these commands keep stdin (unlike Aider's notification command). `--mcp-config` names the session's `mcp.json` in the distro's form. On mirrored networking the distro reaches this machine's loopback and the entry is the `httpUrl` one. On NAT networking it is the transport's stdio bridge, `{"command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": <token>}}`, in the same session file. Trust reads the distro's Qwen directory (its own `QWEN_HOME`, else `~/.qwen`). The chats and the model scan read the distro's runtime directory (its own `QWEN_RUNTIME_DIR`, else its settings' `advanced.runtimeOutputDir`, else that Qwen directory), keyed by the `/mnt` cwd with Linux case, so the slug keeps capitals. A removed worktree's trust entry goes from the distro's file while the distro runs. `--help`, a title summary and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Qwen installed in a distro: the `qwen` on this machine's Ubuntu is the Windows one through interop.

## SSH

A Qwen on a remote host over SSH (#913) runs as `qwen`, found by the host's login `PATH` (`remoteCliName`), so it must be installed and signed in there. It is checked only against a fake host in `tests/unit/qwen-ssh-remote.test.ts`, never against a real Qwen or host.

- **Synced files.** `remoteFiles()` declares the host's `~/.qwen/settings.json` and `~/.qwen/trustedFolders.json` (home), and the project's `.qwen/settings.json` and `.kangentic/qwen-wsl-hook.sh` (project). Both home files are declared because the trust step reads `security.folderTrust.enabled` from the first, and an empty mirror would read as "off" and skip the trust write. The host's settings file is only read, so it is never written back. With folder trust on, the project folder's `TRUST_FOLDER` entry is merged into the user's trusted folders. The project settings carry the hooks, merged into the user's file read from the working folder itself, and are restored when the session releases.
- **MCP** is `--mcp-config` naming the session's `mcp.json` by its host path, with the transport's stdio bridge inside. The session relay sends that file, which holds the token, and `QWEN_HOME` is not honored on a host.
- **Transcript.** The session id is caller-owned (`--session-id`, `--resume`), so nothing is captured and the chat file is named at spawn. `remoteTranscriptFiles()` names `~/.qwen/projects/<slug>/chats/<id>.jsonl`, in this computer's mirror of the host's home, filed under the slug of the folder on the host ([SSH remote hosts](../../platforms/ssh-remote.md#transcripts)). The Conversation viewer, the search index and the archive read what has arrived and never wait (`locateSessionHistoryFile` looks once). Subagent transcripts are not carried. The live model and token reader still answers nothing for a host.
- **A removed worktree's trust entry** is not dropped from the host.

## Session ID Capture

Caller-owned via `--session-id <uuid>`, mirroring Claude. `supportsCallerSessionId` is `true`. Empirically verified against Qwen 0.15.3: real qwen accepts a UUID and writes its JSONL at exactly `<runtime>/projects/<sanitized-cwd>/chats/<our-uuid>.jsonl` (`~/.qwen` with no override). `--session-id` and `--resume` are mutex (yargs enforces). The runtime keeps `fromHook` and `fromOutput` capture paths as belt-and-suspenders for forks that pre-empt the caller's UUID.

## Limitations / Out of Scope

- **No statusLine telemetry, by decision.** Qwen has had a Claude-style `ui.statusLine` since v0.14.3 ([status-line.md](https://github.com/QwenLM/qwen-code/blob/v0.26.6/docs/users/features/status-line.md)), and Kangentic does not wire it. The session history tail already gives the model, context and tokens. The payload has no cost and no model id, and its session id is what [Following `/clear`](#following-clear) gets from the SessionStart hook. Wiring it would also replace the user's own Qwen status line with an empty one, and would need a status path in the session's environment plus an `env:` sentinel in `status-bridge.js`, since the setting sits in the folder-shared `.qwen/settings.json`.
- **No effort control.** Qwen's only effort control is `/effort`, which writes `model.reasoningEffort` to the user's settings, and there is no launch flag. A per-column effort would rewrite the user's own default.
- **No cost or rate limits.** No Qwen output carries either.
- **OpenAI gpt-5 family unsupported (upstream bug):** Qwen Code 0.15.3's bundled `cli.js` sends `max_tokens` in OpenAI requests and never `max_completion_tokens`. OpenAI's gpt-5 family (e.g. gpt-5, gpt-5-mini, gpt-5-nano, gpt-5.1, and any gpt-5.x / gpt-5.x-codex variant) requires `max_completion_tokens` and rejects `max_tokens` with HTTP 400. Picking any gpt-5 variant via `/model` in the Qwen TUI surfaces `[API Error: 400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.]`. Workarounds until upstream patches: stay on the gpt-4.1 family for OpenAI, or use the Anthropic provider (Opus 4.7, Sonnet 4.6, Haiku 4.5) which is fully supported. Kangentic cannot work around this - the adapter is a pure CLI wrapper with no request-parameter interception. Tracked upstream at https://github.com/QwenLM/qwen-code (search issues for `max_completion_tokens`).
