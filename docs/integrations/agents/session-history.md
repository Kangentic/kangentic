---
type: Reference
title: Adapter session history
description: "The native session history files Kangentic tails for telemetry: reader attach and parse flow, the SessionHistoryParseResult contract, Codex, Gemini and Claude file formats, where a Claude transcript is found when its cwd changed, the Claude status-file pipeline, the per-agent resume map, the /clear fork reconcile, known gaps, and how to add a parser."
tags: [session-history, telemetry, resume, parsers]
sources:
  - resource: src/main/pty/readers/session-history-reader.ts
  - resource: src/main/pty/readers/status-file-reader.ts
  - resource: src/main/activity-engine/session-telemetry.ts
  - resource: src/main/activity-engine/conversation-switch-gate.ts
  - resource: src/main/agent/shared/session-start-hook.ts
  - resource: src/main/agent/adapters/claude/background-sessions.ts
    title: stopClaudeBackgroundSession, resolveClaudeResumableSessionId, claudeBackgroundSessionOf
  - resource: src/main/ipc/helpers/command-terminal-background-session.ts
  - resource: src/main/agent/adapters/codex/session-history-parser.ts
  - resource: src/main/agent/adapters/gemini/session-history-parser.ts
  - resource: src/main/agent/adapters/claude/session-history-parser.ts
  - resource: src/main/agent/adapters/claude/transcript-locator.ts
  - resource: src/main/agent/adapters/claude/transcript-parser.ts
    title: claudeProjectSlug, locateClaudeTranscriptFile
  - resource: src/main/agent/adapters/codex/transcript-parser.ts
    title: findCodexTranscriptFile
  - resource: src/main/agent/adapters/qwen-code/session-history-parser.ts
  - resource: src/main/agent/adapters/kimi/session-history-parser.ts
  - resource: src/main/agent/adapters/grok/session-history-parser.ts
  - resource: src/main/agent/adapters/opencode/session-history-parser.ts
  - resource: src/main/agent/adapters/aider/session-history-parser.ts
  - resource: src/main/transition-engine/resume-id-reconcile.ts
  - resource: src/main/transition-engine/resume-cwd-migration.ts
  - resource: src/main/transition-engine/resume-conversation-guard.ts
  - resource: src/shared/types.ts
    title: SessionHistoryParseResult, AdapterRuntimeStrategy
---
# Adapter session history

This document describes the native session history files that Kangentic reads to surface real-time telemetry (model, context window, token counts, activity) for agents that don't provide a status.json/hooks integration like Claude Code does.

This is the authoritative reference for the `AdapterRuntimeStrategy.sessionHistory` hook. If a CLI release breaks one of the file formats described here, this doc tells you what we depend on and where.

## How the pipeline works

The session-history subsystem is split into four layers with strict separation of concerns, and sits alongside a parallel `StatusFileReader` subsystem that handles the older hook/status-file telemetry pipeline:

| Layer | File | Responsibility |
|---|---|---|
| Adapter parser | `adapters/<agent>/session-history-parser.ts` | Agent-specific file format knowledge. Implements `locate()` + `parse()`. |
| Reader (dispatcher) | `src/main/pty/readers/session-history-reader.ts` | Generic file watching, cursor tracking, parse dispatch. Owns all session-history-specific runtime logic. |
| Consumer primitives | `src/main/activity-engine/session-telemetry.ts` | Generic primitives (`setSessionUsage`, `ingestEvents`, `forceActivity`, `notifyPtyData`, `processStatusUpdate`, `captureHookSessionIds`) - no telemetry-source-specific vocabulary. |
| Session lifecycle | `src/main/pty/session-manager.ts` | Calls `reader.attach()` on agent-session-id capture, `reader.detach()` on removal. Composes both telemetry readers symmetrically. Knows nothing else about session history. |

**Symmetric pipeline**: `StatusFileReader` (`src/main/pty/readers/status-file-reader.ts`) handles Claude's hook-based telemetry (status.json + events.jsonl) using the exact same pattern. Both readers own their own `FileWatcher` instances and dispatch through generic `SessionTelemetry` primitives. Neither reader mentions a specific agent name. See the "Claude status-file pipeline" section below for details.

Runtime flow:

1. An agent adapter declares a `sessionHistory` block in its `runtime` strategy (`src/shared/types.ts` - `AdapterRuntimeStrategy.sessionHistory`).
2. On PTY spawn, the adapter's full runtime strategy is stored on `ManagedSession.agentParser` - SessionManager does nothing session-history-specific.
3. The agent's session ID is captured via one of four paths (whichever fires first):
   - **Spawn-time short-circuit** (caller-owned IDs): when the adapter declares `supportsCallerSessionId = true`, the spawn pipeline pre-generates a UUID and passes it via `SpawnSessionInput.agentSessionId`. `session-spawn-flow.ts` calls `sessionHistoryReader.attach(...)` directly during spawn. Used by Claude (when `runtime.sessionHistory` is wired), Qwen, Kimi, and Grok.
   - `runtime.sessionId.fromHook` (Gemini hook stdin)
   - `runtime.sessionId.fromOutput` (PTY scraper)
   - `runtime.sessionId.fromFilesystem` (Codex rollout directory scan)

   See [Adapter types and capability discovery](adapter-types.md#adapterruntimestrategy) for the full table.
4. When `notifyAgentSessionId` fires (one of the latter three paths), SessionManager reads `session.agentParser?.runtime?.sessionHistory` and, if present, calls `sessionHistoryReader.attach(...)`. The spawn-time short-circuit calls `attach()` directly, bypassing the notify chain to avoid a DB ordering hazard with `recoverStaleSessionId`. `attach()` is idempotent, so a later capture pathway firing the full chain is harmless.
5. `SessionHistoryReader.attach()` calls `hook.locate({ agentSessionId, cwd })`, instantiates a `FileWatcher` on the resolved path, and triggers an initial read.
6. Each file-change event reads new content (append-mode cursor for JSONL, whole-file re-read for JSON) and dispatches to `sessionHistory.parse(content, mode)`.
7. The resulting `SessionHistoryParseResult` flows through `dispatchSessionHistoryResult()` into the generic callback primitives (`onUsageUpdate`, `onEvents`, `onActivity`, `onFirstTelemetry`) that SessionManager wired to SessionTelemetry at construction time.
8. On the first successful dispatch, `onFirstTelemetry` fires, which calls into `SessionTelemetry`'s PTY-tracker suppression - PtyActivityTracker stops contributing activity signals for the rest of the session. An adapter whose history file carries only part of the activity picture sets `sessionHistory.suppressesPtyFallback: false` (Codex, whose rollout reports background commands, interrupts and failed turns beside its hooks), and neither the first read nor a turn-initiating event it reports turns the tracker off.

The PtyActivityTracker keeps running in parallel until suppressed, so the boot window (before the history file materializes) is still covered by the existing spinner + silence-timer mechanism.

**SessionTelemetry has zero session-history awareness.** Its generic primitives (`ingestEvents`, `forceActivity`, plus the existing `setSessionUsage`) are useful for any telemetry source - session history is just one caller. A future hypothetical telemetry source (WebSocket stream, API poll, etc.) would use the same primitives without any SessionTelemetry changes.

### `SessionHistoryParseResult`

`src/shared/types.ts` defines the contract that every parser returns from its `parse(content, mode)` method:

| Field | Type | Semantics |
|-------|------|-----------|
| `usage` | `SessionUsage \| null` | Updated usage snapshot. Null when this parse pass didn't touch model or tokens. The reader's callback merges it into the existing `usageCache` entry via `SessionTelemetry.setSessionUsage`. |
| `events` | `SessionEvent[]` | New events to append to the session event log. Empty array when there are none. The reader pushes them through `SessionTelemetry.ingestEvents`, which runs each event through the activity engine plus the per-event detectors (PTY suppression, ExitPlanMode, PR command). |
| `activity` | `Activity \| null` | Explicit activity transition hint (`Activity.Thinking`, `Activity.Idle`, or `null`). Set when a log entry maps directly to a state change (e.g. Gemini's whole-file rewrite) rather than relying on the event stream alone. Codex and Kimi return `null`: their turn starts and ends are events (a Stop hook, a wire `TurnEnd` Idle event), because a forced idle ends no turn for `onTurnEnded` and clears background shells. Null when events alone imply the transition. |

All three fields are optional in the sense that any combination is valid - parsers can return partial results (e.g. a token-only update yields `usage` populated and `events: []`).

## Key design principles

- **KISS**: no directory snapshotting, claim registries, timestamp windows, or provisional candidates. The PTY scraper gives us the session UUID; the filename contains that UUID; we look up the file directly. Two sessions cannot collide because the UUID in the filename is tied to our own PTY by construction.
- **Cross-platform**: every path uses `os.homedir()` + `path.join`. Directory listings use `fs.readdirSync`. No shell-outs. UTC dates via `toISOString().slice(0, 10)`. CRLF-tolerant line splitting.
- **Graceful degradation**: if the history file never appears, disappears mid-session, or contains malformed content, the parser logs a WARN and the PtyActivityTracker fallback keeps the session alive.
- **Defensive parsing**: every field access goes through `unknown`-based type guards (`isRecord`, `toNumber`, etc.). No `any` casts. No assumptions about field presence.

## Codex

**File path**: `~/.codex/sessions/<UTC-YYYY>/<UTC-MM>/<UTC-DD>/rollout-<iso-timestamp>-<sessionUUID>.jsonl`

**Format**: append-only JSONL. One JSON object per line. CRLF or LF line endings tolerated. `isFullRewrite: false` - parser receives newly-appended bytes on each file-change event.

**Parser**: `src/main/agent/adapters/codex/session-history-parser.ts`

**Locate**: the live attach (`CodexSessionHistoryParser.locate`, `runtime.sessionHistory`) polls today's and yesterday's UTC folders for up to 5 s, for a rollout the CLI is about to write. Every on-demand read (`locateSessionHistoryFile`: the index, the archive, the handoff, a Command Terminal's Earlier conversations row) walks the whole date tree newest day first with no wait (`findCodexTranscriptFile`, on `fs.promises` because several of those callers run on main). Before that split the on-demand reads used the live locate too, so a conversation older than yesterday read as missing after 5 s.

### Line entries we depend on

Each line has top-level `timestamp`, `type`, and `payload` fields.

| `type` | Field(s) extracted | Effect |
|---|---|---|
| `session_meta` | `payload.id`, `payload.cwd`, `payload.cli_version` | First line of the file. UUID matches filename suffix. Not actively parsed today (we already have the UUID from the PTY scraper). |
| `task_started` | `payload.model_context_window` | Sets `SessionUsage.contextWindow.contextWindowSize`. No activity effect: the turn's start is the UserPromptSubmit hook's. |
| `turn_context` | `payload.model` | Sets `SessionUsage.model.id` and `.displayName`. Emitted on every turn, so respects mid-session `/model` changes. |
| `token_count` | `payload.info.total_token_usage.{input_tokens,cached_input_tokens,output_tokens}` | Sets `SessionUsage.contextWindow.{totalInputTokens,cacheTokens,totalOutputTokens}`. |
| `task_complete` | `payload.error` | No activity effect: turn ends come from the Stop hook. A `task_complete` that carries an `error` (a failed model request, which fires no Stop) emits `TurnFailed`. |
| `turn_aborted` | (none) | Emits `Interrupted`. An Esc interrupt fires no hook. |
| `response_item` with `payload.type: "function_call"` | `payload.call_id`, `payload.name`, `payload.arguments` | Emits nothing: the PreToolUse hook reports the tool, with its id. The parser remembers the call (bounded, by `call_id`) so its output, which arrives in a later read, can be paired with it. |
| `response_item` with `payload.type: "function_call_output"` | `payload.call_id`, `payload.output` | "Process running with session ID N" (a command still running at its yield; no PostToolUse fires) emits a named `BackgroundShellStart` keyed by the call id, flagged `noActivityHold` when the command carried `--kangentic-no-activity-hold`. A `write_stdin` poll that finds the process exited ("Process exited with code") emits `BackgroundShellEnd` for its exec session. |

All other entry types are ignored.

### Assumptions that could break on CLI upgrades

- The directory structure `sessions/YYYY/MM/DD/` is stable.
- Filenames embed the session UUID as the suffix before `.jsonl`.
- JSONL format (one complete JSON object per line, ending in `\n`).
- The field names inside `payload` (`id`, `cwd`, `model`, `model_context_window`, `total_token_usage`, etc.) are stable across minor Codex releases.
- Context window size is reported in raw token count (not K, M).

If a Codex release breaks any of these, the parser will silently return null/empty `SessionHistoryParseResult` and the card will fall back to the minimal pill. Fix: update the field extraction in `codex/session-history-parser.ts` and the regexes in `locate()`.

## Gemini

**File path**: `~/.gemini/tmp/<projectDirName>/chats/session-<timestamp><shortId>.jsonl` on current
builds, `.json` on older ones. **Both generations are live and both must be matched.**

`<shortId>` is only the FIRST 8 CHARACTERS of the session UUID, so
`session-2026-04-09T19-18-08889b8d.jsonl` belongs to session `08889b8d-c485-...`. A pattern built
from the full UUID matches nothing; `locate()` keeps a full-UUID branch only as a defensive
fallback that has never fired.

Gemini cut over to append-only `.jsonl` on 2026-04-28; on a real machine every chat file written
since is `.jsonl`. Kangentic's patterns anchored on `\.json$`, whose `$` cannot match `.jsonl`, so
for every Gemini session after the cutover `locate()` found nothing and
`captureSessionIdFromFilesystem` never captured a session id - which silently took out session-id
capture and all Gemini live telemetry. Both now test `/^session-.*\.jsonl?$/`. Pinned by
`tests/unit/gemini-session-file-format.test.ts`; do not re-anchor either pattern.

The `<projectDirName>` is the **lowercased basename** of the cwd, NOT a hash - despite the misleading `projectHash` field inside the JSON body (which appears to be a SHA-256 of something else, possibly the absolute path, but is not what Gemini uses to name the directory). Verified empirically against live Gemini directory listings:

| cwd | Directory name |
|---|---|
| `C:/Users/dev/project-a` | `project-a` |
| `C:/Users/dev/Parent/MyProject` | `myproject` |
| `<parent>/worktree-mixed-case-123` | `worktree-mixed-case-123` |

**Collision risk**: two projects sharing the same basename (e.g. two `app/` directories in different parent paths) will share this Gemini directory. That's Gemini's design choice, not ours. Worktrees created by tools like Kangentic typically have unique hash-suffixed names, so collisions are rare in practice.

**Format**: two generations. `isFullRewrite: true` either way - the parser receives the whole file
content on each change, and `collectGeminiMessages()` normalizes both into one `messages[]` array.

**Parser**: `src/main/agent/adapters/gemini/session-history-parser.ts`

### Current generation: append-only JSONL

A header line, then some mixture of `$set` patch lines carrying a whole `messages[]` array and
standalone message lines. Gemini **re-emits the same message `id` while a reply streams**, so
`collectGeminiMessages` deduplicates by `id`, last write wins. Without that dedupe a streaming reply
appears many times over.

```jsonl
{"sessionId":"<uuid>","projectHash":"<sha256>","startTime":"<iso>","kind":"main"}
{"$set":{"messages":[{"id":"m1","type":"user","content":[{"text":"..."}]}]}}
{"id":"m2","type":"gemini","content":"partial...","model":"gemini-3-flash-preview","tokens":{}}
{"id":"m2","type":"gemini","content":"partial reply, complete","model":"gemini-3-flash-preview","tokens":{"input":11199,"output":47,"cached":0,"thoughts":0,"tool":0,"total":11246}}
```

### Legacy generation: one JSON object

Written before the 2026-04-28 cutover, still readable. `collectGeminiMessages` tries a whole-file
`JSON.parse` first and falls back to the JSONL walk, so ordering the attempts this way keeps old
sessions working.

```json
{
  "sessionId": "<uuid>",
  "projectHash": "<sha256>",
  "startTime": "<iso>",
  "lastUpdated": "<iso>",
  "messages": [
    { "type": "user", "content": [{ "text": "..." }] },
    {
      "type": "gemini",
      "content": "...",
      "model": "gemini-3-flash-preview",
      "tokens": {
        "input": 11199,
        "output": 47,
        "cached": 0,
        "thoughts": 0,
        "tool": 0,
        "total": 11246
      }
    }
  ],
  "kind": "main"
}
```

### Parsing strategy

Once normalized, the parser walks `messages[]` backwards to find the most recent `"type": "gemini"` entry and extracts its `model` and `tokens`. This naturally respects mid-session `/model` changes since each assistant message carries its own model identifier.

Note that `readGeminiSessionMeta` falls back to the FIRST line when the file is JSONL: the session
metadata lives in the header line, not in a whole-file object.

### Context window size

**Not present in the file, and not available anywhere else.** The parser emits the `0` "unknown
size" sentinel for every Gemini model, so the card shows token counts with no progress bar.

There used to be a hardcoded model-prefix to window-size lookup here, transcribed from Google's
model cards and kept current by hand. It is gone, per
`.claude/rules/cli-features-over-custom-layers.md`: we do not track model releases, and a guessed
limit renders a percentage that looks precise and is not. Gemini's session JSON carries no window
size and the Gemini CLI has no command that reports one, so there is nothing to discover and the
honest answer is to show nothing.

The bar comes back on its own if Gemini ever starts reporting a window, through the live-telemetry
path that fills `discoveredContextWindowsByAgent`. Do not reintroduce the table.

### Assumptions that could break on CLI upgrades

- The directory structure `~/.gemini/tmp/<dir>/chats/` is stable.
- The directory naming scheme is lowercased basename of cwd.
- Filenames start with `session-` and contain the session UUID, ending in `.json` OR `.jsonl`. A
  third extension, or an anchored `\.json$` pattern reintroduced anywhere, breaks capture silently.
- The message shape (`messages[]`, `type: "gemini"`, `model`, `tokens`) is stable in both
  generations, and a streamed message keeps a stable `id` across its re-emissions so dedupe works.
- `tokens.input` represents cumulative context tokens (not per-turn delta).

If a Gemini release breaks any of these, the parser will silently return null/empty and the card falls back to the minimal pill. Fix: update the field extraction in `gemini/session-history-parser.ts`.

## Claude

Claude's **authoritative** live telemetry comes from the hook-driven `statusFile` pipeline (see "Claude status-file pipeline" below): it carries Claude Code's own `display_name`, the real `context_window_size` (including the 1M-context variant), `used_percentage`, cost, and rate limits, and it stays the source of truth whenever it is flowing.

Claude **also** declares a `runtime.sessionHistory` block, but as a **background-session fallback**, not a co-equal source. Claude Code only runs its statusLine command when its TUI paints (after an assistant message, `/compact`, a permission-mode change, or the `refreshInterval` timer), so a heavy resume can boot for a while before its first `status.json` write, and the board card would sit on the spawn-time model placeholder meanwhile. The transcript JSONL at `~/.claude/projects/<projectSlug>/<sessionId>.jsonl` is appended continuously regardless of painting, so `ClaudeSessionHistoryParser` (`src/main/agent/adapters/claude/session-history-parser.ts`) tails it to derive a live model + token occupancy until `status.json` starts flowing.

The two sources never race: on the **first** successful `status.json` parse, `StatusFileReader` fires `onFirstStatus`, which detaches the transcript reader (see "Claude status-file pipeline" below), so `status.json`'s full usage replace cleanly supersedes the fallback's partial merge. If a background session is never opened, the fallback keeps the card current for its whole life.

The same transcript JSONL is still read on demand by `transcript-parser.ts` for the renderer's Transcript tab and for lifetime-token refinement (`refineTranscriptTokens` on exit paths), but both read paths are now bounded, and they run in the retrieval worker (`transcript.task`, `transcript.usage`, plus `transcript.toolCounts` and `transcript.toolResultTokens` for the per-tool table, each scoped to one run's window because Claude appends every `--resume` to one file), so main parses no transcript. `parseTranscript` reads at most the most recent `MAX_PARSE_SOURCE_BYTES` (16MB) rather than the whole file, prepending a `truncated` system entry when it does; reading an unbounded transcript whole is what OOM'd the main process. `refineTranscriptTokens` / `refineTranscriptToolCounts` stream the file instead of materializing it, and are serialized through a shared `PQueue({concurrency: 1})` in `session-metrics.ts`, so several sessions ending together can no longer each launch a concurrent whole-file read. The live Tokens read behind the tool-call popover (`readTranscriptToolResultTokens`) is deliberately not queued, so it never waits behind a run-end backfill. Its fill of an earlier run's missing Tokens overtakes a fill the spawn queued that has not started yet, for the same reason. Both tool reads share a resumable per-path cursor in `claude/transcript-parser.ts` that reads only appended bytes: it keeps the offset of the last complete line and the 64 bytes before it, and starts over when the file shrinks, its mtime goes back, its inode changes or those 64 bytes differ. An unchanged file is answered from `stat` without opening it. Both are scoped by `sinceMs` and, for a run that has ended, `untilMs`, because Claude appends every `--resume` to the same transcript. The fallback tailing pipeline described above (`ClaudeSessionHistoryParser`) is unaffected.

### Where a Claude transcript is

Claude files a conversation under the slug of the folder it STARTED in, and a `--resume` from another folder keeps appending to that file. Measured on Claude Code 2.1.312: four task agents started in the project root (a race since fixed) were later resumed with their worktree as cwd, and every turn after that landed in the root-slug files, 472 lines of one of them carrying the worktree as their `cwd`. A path built from the session's current cwd then names a file that does not exist. Every read missed it: the turn end's reply, the auto_command check, the message trail, the viewer, `get_transcript`, the index, the archive, the hang check. The workflow those tasks ran stalled.

So every Claude read resolves its path through `claude/transcript-locator.ts`, in this order:

1. The path Claude reported for the conversation, when it is absolute, is named `<id>.jsonl` (a row from before a `/clear` fork names the other id), sits in a `projects/<slug>/` folder, and the file is there (a project relocation does not rewrite it). Generic readers pass it as the trailing `reportedPath` of the transcript methods, from the session row's `transcript_path` or the live usage's `transcriptPath`. A new row for a resumed conversation inherits the newest `transcript_path` of its `agent_session_id` at insert (`SessionRepository.insert`), so the report is there from the first turn end, before the new session's status line paints.
2. The cwd-derived path (`locateClaudeTranscriptFile`, which stays the pure builder). A fresh session's file appears here, and this check is never cached.
3. Where an earlier search found it, checked again on every use, so a deleted file never reads as present.
4. The cwd's parent folders: `slug(parent)/<id>.jsonl` for each, up to the drive root. From `<root>/.kangentic/worktrees/<n>` this finds the root's file in three stats with no `readdir`. That is both the case above and the enable-worktree one, where a suspended row's cwd is rewritten to the new worktree.
5. Every folder under the projects folder, from one listing of their transcripts (a `readdir` of each, 32 at a time) that answers every search for 30 s; the newest copy wins when a name sits in two folders. Session ids are UUIDs, so a hit is the conversation. One listing is what keeps a sweep cheap: the index and the archive ask for every conversation of a project, most of them deleted after 30 days, and a stat in every folder per conversation cost a full scan each. A conversation found nowhere is not searched for again for 30 s, steps 4 and 5 both, so the 500 ms locate poll of a fresh session and every turn end on a gone conversation cost one search per 30 s. A cached find whose file is gone drops the listing with it.

The cache is per process: main and the retrieval worker each keep one. The sync readers on main (the background-shell and permission-rejection polls, the subagent folder's signature) take `peekClaudeTranscriptFile`, which checks steps 1 to 3 and never searches. On a miss it starts the async find, unless one is running or a miss is still remembered, so the next 2 s poll has the answer. A WSL place searches the distro's home only after the cwd check has already read through the distro's share, so the search starts nothing the read did not.

`proveConversationGone` checks the path every reader would open before its own scan, so a conversation the locator finds is never proved gone. Where Kangentic can read a history and where Claude's `--resume` reads it are two questions: the migrate-on-resume below asks the narrower one (`findClaudeResumeTranscriptFile`, steps 2 and 4 only), so a history under a renamed worktree's old slug still moves, and one under a parent folder's slug stays.

### What the fallback parser reads

`ClaudeSessionHistoryParser.parse(chunk, 'append')` (append mode; the transcript is append-only JSONL) keeps the **latest** qualifying assistant entry in the chunk - its per-message `usage` is the size of the prompt sent to the model on the most recent turn, i.e. the current context occupancy (distinct from `parseClaudeTranscriptUsage`, which sums a cumulative lifetime total and would over-report a live percentage).

An entry qualifies when `type === 'assistant'`, `isSidechain !== true` (subagent turns carry the subagent's context, not the main thread's), `message.model` is a real id (not `<synthetic>`, which Claude writes for API-error notices), and the input side (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`) is positive. No `message.id` dedupe is needed (latest-wins is equivalent); no compaction special-casing is needed (the `compact_boundary` line is a skipped `system` entry, and the first post-compaction assistant entry naturally carries the shrunken context, so the percentage drops on its own).

Fields depended on per assistant entry: `type`, `isSidechain`, `message.model`, and `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`. The parser emits token counts and the model ONLY - a **sparse** `SessionUsage` with no `contextWindowSize`, `usedPercentage`, cost, rate limits, effort, reportedByAgent, sessionId, or transcriptPath keys - so the shallow spread merge in `UsageAccumulator.setSessionUsage` never clobbers base values, and never sets `activity` or `events` (Claude's activity stays hooks-owned).

**The window is never derived from the model id.** Claude Code's effective context window depends on the account/plan, not the id: a plain `claude-opus-4-8` runs a 1M window on a 1M-entitled account (Max / Team / Enterprise auto-upgrade Opus to 1M) and 200K elsewhere, with no `[1m]` suffix to distinguish them. So the parser emits no window at all. The **authoritative** window comes exclusively from `status.json`.

The effective window is, however, an account+model CONSTANT (every real `status.json` on a 1M-entitled account reports 1M for that model), so `UsageAccumulator` remembers the window observed for each base model id (`recordKnownWindow`, fed from any live `status.json` in `SessionTelemetry.processStatusUpdate`). When a session's only telemetry is the transcript fallback (tokens + model, no window), `setSessionUsage` fills the window from that known account+model value, so a background/parked session whose own `statusLine` never painted - and thus never wrote `status.json` - still shows a correct percentage on the board without being opened. Learning the window also RETROACTIVELY back-fills and re-emits any already-cached background session of that model (an idle card that emitted before a sibling painted). When no window has ever been observed for the model this run, the merged window stays at the 0 "unknown size" sentinel and the card / ContextBar show the model name only, never a bar against a guess. `setSessionUsage` is the single place a percentage is computed, and it degrades to the 0 sentinel if `usedTokens` ever exceeds the window (physically impossible, so the window is wrong).

The known-window map is also **hydrated at boot**, not just learned live: `applyRuntimeConfig` (called on every project-open and config-set) reads the persisted global config field `discoveredContextWindowsByAgent` - written from the same usage tick that feeds the model-picker's context-window badge - flattens it across agents, and pushes it through `SessionManager.hydrateDiscoveredContextWindows` -> `SessionTelemetry.hydrateKnownWindows` -> `UsageAccumulator.hydrateKnownWindows` (one `recordKnownWindow` call per entry, so the same retroactive-refill-and-reemit behavior applies). This means a model's window learned in a *previous* run already fills a parked session's card on the very first paint of the board this run, with no live `status.json` needed at all. A live `status.json` this run still overrides the hydrated value (last-observation-wins), and the impossible-window degrade still protects against a stale persisted window (e.g. an entitlement drop).

**Resumes tail from EOF.** On a resume the transcript already holds the pre-suspend conversation, whose last entry is stale occupancy (Claude prunes / recomputes context on resume). The eager spawn-time attach passes `startAtEnd`, so the reader starts its byte cursor at end-of-file and only entries appended *after* the resume produce usage. Until a fresh entry appends, the card shows the spawn-time model seed alone.

**Assumptions that could break on CLI upgrades:** the `~/.claude/projects/<slug>/<sessionId>.jsonl` location, and the assistant-entry shape (`type`, `isSidechain`, `message.model`, `message.usage.*`). A format change makes the parser return `usage: null` and the card falls back to the spawn-time model seed until `status.json` flows.

The `<projectSlug>` is computed by `claudeProjectSlug()` (exported from `transcript-parser.ts`), reproducing Claude Code's own algorithm: replace every non-alphanumeric character (so `/`, `\`, `:`, `.`, `_`, spaces, and unicode all become `-`), one-for-one and not collapsed, so `C:\Users` produces `C--Users` (one dash from `:`, one from `\`). If the sanitized result exceeds 200 characters it is truncated to 200 and a `-<base36 hash>` suffix (a Java-style string hash of the original, un-sanitized path) is appended to disambiguate; paths whose sanitized form is at most 200 characters (the overwhelming case) carry no suffix.

| cwd | Slug |
|---|---|
| `C:\Users\dev\project` | `C--Users-dev-project` |
| `/home/dev/project` | `-home-dev-project` |
| `C:\Users\dev\my.app` | `C--Users-dev-my-app` |
| `/home/dev/my_project` | `-home-dev-my-project` |
| `C:\Users\dev\proj\.kangentic\worktrees\feature-x` | `C--Users-dev-proj--kangentic-worktrees-feature-x` |

## Claude status-file pipeline (`runtime.statusFile`)

The hook-based telemetry source is declared on the adapter as Claude's only live telemetry pipeline:

```ts
readonly runtime: AdapterRuntimeStrategy = {
  activity: ActivityDetection.hooks(),
  statusFile: {
    parseStatus: ClaudeStatusParser.parseStatus,
    parseEvent: ClaudeStatusParser.parseEvent,
    isFullRewrite: true,
  },
  // Background-session fallback (see the "Claude" section above).
  sessionHistory: {
    locate: ClaudeSessionHistoryParser.locate,
    parse: ClaudeSessionHistoryParser.parse,
    isFullRewrite: false,
  },
};
```

`StatusFileReader` (`src/main/pty/readers/status-file-reader.ts`) reads `session.agentParser?.runtime?.statusFile` at attach time and dispatches through the hook's `parseStatus` / `parseEvent` methods. It contains no Claude-specific parsing code - swap the hook and the same reader serves any future adapter that wants to ride the same pipeline.

| Field | Semantics |
|-------|-----------|
| `parseStatus(raw)` | Decode the rewritten contents of `status.json` into a `SessionUsage`. Returns null for partial or malformed content. |
| `parseEvent(line)` | Decode a single appended line from `events.jsonl` into a `SessionEvent`. Returns null for blank/invalid lines. |
| `isFullRewrite` | True for `status.json` (whole-file rewrite on every update). The events file is always append-only, tracked by a separate byte cursor regardless of this flag. |

**File paths** (`status.json`, `events.jsonl` under `.kangentic/sessions/<sessionId>/`) are caller-supplied at spawn time on `SpawnSessionInput.statusOutputPath` / `eventsOutputPath`. They are runtime values, not static adapter metadata.

**The files are emptied before the agent starts.** `performSpawn` awaits `resetStatusFiles` before it asks the pty host for the PTY, and `attach()` writes nothing. A previous run's lines are never replayed, and lines the agent writes before the watchers arm are read rather than erased: `attach()` reads status.json at once, and the events poll finds anything past its cursor. The reset is asynchronous because done synchronously in `attach()` it held main's thread 108 ms under a disk load. It truncates rather than unlinks, so the watcher arms on the file and not on the session directory (see `readers/file-watcher.ts`).

**First-status handoff (`onFirstStatus`).** `StatusFileReaderCallbacks` carries an `onFirstStatus(sessionId)` primitive that fires once per attachment, immediately after the first successful `parseStatus` dispatch. SessionManager wires it to `sessionHistoryReader.detach(sessionId)`, retiring the transcript fallback the moment `status.json` starts flowing (see the "Claude" section). The ordering is load-bearing: `onFirstStatus` fires *after* `onUsageParsed`, so the detach also cancels any transcript re-attach that the usage path's agent-session-id capture (change-sensitive on this channel; see "Mid-session fork reconcile" below) can trigger. SessionManager additionally guards the `onAgentSessionId` re-attach with `statusFileReader.hasReceivedStatus(sessionId)`. This is capability-driven, not agent-named: adapters whose `parseStatus` returns null (Codex, Gemini) never fire `onFirstStatus`, so nothing changes for them.

## Resume mechanisms (the resume artifact is not always the history file)

The sections above describe the **history file** each adapter reads for live telemetry and for
the `get_transcript` MCP feature, located by `adapter.locateSessionHistoryFile(agentSessionId,
cwd)`. That is a separate question from **what `--resume` actually reads** to restore a
conversation. The two are usually the same file, but not always: Copilot and Cursor return `null`
from `locateSessionHistoryFile` (no telemetry history file wired) yet still persist resumable
session state elsewhere on disk. So do not assume "history file" equals "resume file" - this
section records the resume side, audited separately.

**How this was audited:** empirically, from (a) the on-disk session stores that real CLI runs
left in this environment, (b) each adapter's command builder (the exact `--resume` form Kangentic
emits), (c) the adapters' `session-history-parser.ts` locators, and (d) the `project-relocation.ts`
modules for Codex and Copilot, which encode Kangentic's reverse-engineered model of how those
CLIs resolve a resume across a working-directory change. (Codex's binary was not on the audit
shell's PATH, so Codex is grounded in its on-disk rollout files plus the relocation module rather
than a live `--help` run.) Per-adapter parsers describe the history-file format; the resolution
behavior below is the resume contract.

### Per-adapter resume map

| Agent | Resume invocation | Where `--resume` reads | Keyed by | cwd-bound resume? | Same path as `locateSessionHistoryFile`? | Prompt on resume |
|---|---|---|---|---|---|---|
| Claude | `claude --resume <id>` | `~/.claude/projects/<slug>/<id>.jsonl`, the slug of the folder the conversation started in | start folder's slug + id | no from a worktree of the folder it started in (measured on 2.1.312); other folders unmeasured | yes (found by id when it is not under the cwd's slug) | on the command line, after `--` |
| Codex | `codex resume <id> -C <cwd>` | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl` | session id (filename scan) | no | yes | on the command line, positional `[PROMPT]` |
| Gemini | `gemini --resume <id>` | `~/.gemini/tmp/<basename(cwd)>/chats/session-<id>.json` | cwd basename + id | yes | yes | on the command line, positional (`-p` non-interactive) |
| Qwen | `qwen --resume <id>` / `--session-id <id>` | `~/.qwen/projects/<slug(cwd)>/chats/<id>.jsonl` | cwd slug + id | yes | yes | on the command line, `-i` (`-p` non-interactive) |
| Kimi | `kimi --session <id>` | `~/.kimi/sessions/<md5(cwd)>/<id>/` (wire JSONL) | md5(cwd) + id | yes | yes | on the command line, `--prompt` (stays interactive) |
| Droid | `droid --resume <id>` | `~/.factory/sessions/<slug(cwd)>/<id>.jsonl` | cwd slug + id | yes | yes | on the command line, positional |
| OpenCode | `opencode --session <id>` | `~/.local/share/opencode/opencode.db` (+ `storage/session_diff/ses_<id>.json`) | session id (global DB) | no | yes (the DB) | typed once the TUI is ready |
| Copilot | `copilot --session-id <id>` | `~/.copilot/session-state/<id>/` (+ `session-store.db`) | session id (global) | no | **no** (locator returns null) | typed once the TUI is ready |
| Cursor | `agent --resume=<id>` | `~/.cursor/chats/<chat-id-hash>/` | chat id (global) | no | **no** (locator returns null) | typed once the CLI is ready |
| Aider | `aider --restore-chat-history` | `<cwd>/.aider.chat.history.md` | cwd file (no session id) | yes | n/a (no per-session file) | n/a: no id to resume by, so the engine never resumes it |
| Warp | (no resume) | none | n/a | n/a | n/a | n/a |
| Grok Build | `grok --resume <id>` | `~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/` (updates.jsonl + chat_history.jsonl) | URL-encoded cwd + id | yes | yes | typed once the TUI is ready |
| Ollama | (no resume - `ollama run` has no CLI-level session ids) | none | n/a | n/a | n/a | n/a |
| Antigravity | `agy --conversation <id>` | `~/.gemini/antigravity-cli/conversations/<id>.db` (SQLite; the parseable transcript sits beside it under `brain/<id>/`) | conversation id (global store) | no | **no** (the locator returns the brain-dir `transcript.jsonl`, which resume itself does not read) | on the command line, `-i` (`-p` non-interactive) |
| Goose | `goose run -r -n <name>` / `goose session -r -n <name>` | Goose's own session store, resolved by name | caller-owned name (global store) | no | **no** (locator returns null; resume needs no transcript file) | on the command line, `-t` |

Reading the table by class:

- **cwd-keyed per-session file that `--resume` reads:** Gemini, Qwen, Kimi, Droid, Grok. The
  resume target is a file under a directory derived from the cwd (basename, slug, `md5`, or
  Grok's `encodeURIComponent`), so moving the project to a path with a different cwd-derived key,
  or deleting that file, makes the stored id unresolvable. These rows come from each relocation
  module's model of its CLI, not from a measured resume in another folder; Droid's and Grok's are
  the least certain.
- **keyed by the folder the conversation started in:** Claude. The file is named from the cwd of
  the conversation's FIRST session, and a `--resume` from a worktree of that folder keeps
  appending to it (measured on 2.1.312). Kangentic's reads find it by id wherever it is (see
  [Where a Claude transcript is](#where-a-claude-transcript-is)); moving the project still needs
  `onProjectRelocated`.
- **id-keyed / global store (cwd-independent):** Codex, OpenCode, Copilot, Cursor, Antigravity,
  and Goose.
  Resume resolves by session id against a global location, so the working directory does not gate it.
  Codex scans `~/.codex/sessions/` by id (`codex-rs find_thread_path_by_id_str`; the per-rollout
  cwd only filters the interactive picker, which has an `--all` escape hatch). OpenCode keys the
  shared SQLite DB by session id. Copilot and Cursor attach by id; for Copilot the saved `cwd`
  only affects *where* the resumed session reopens, not whether it attaches, and Cursor's
  per-cwd `~/.cursor/projects/<slug>/` directory holds only `repo.json` / trust metadata, not the
  conversation, which lives in `~/.cursor/chats/<chat-id-hash>/`. Goose resolves by the
  caller-supplied `--name` against Goose's own session store, so resume is cwd-independent and
  Kangentic reads no transcript file (`locateSessionHistoryFile` returns null).
- **project-wide reload, no session id:** Aider. `--restore-chat-history` reloads the cwd-local
  `.aider.chat.history.md`; there is no per-session id, so there is nothing to verify or
  downgrade.
- **no resume at all:** Warp and Ollama. The `oz` one-shot runner streams and exits, and
  `ollama run` has no CLI-level session ids.

The last column is each adapter's `resumePromptDelivery`. "On the command line" is `command-line`:
a resume that carries a message (a column's message, a plan continuation, held messages) passes it
on the resume command. "Typed" is `typed`: the CLI takes a prompt on a new session, but nothing it
documents says the prompt runs on a resumed one, so Kangentic types the message in once the agent
is ready. Even a `command-line` resume types its message when the launch would flatten its lines or
it is over the 6,000-character cap. See [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives).

### Why there is no `canResumeSession` transcript-presence guard

> Not to be confused with `assessResumeConversation`
> (`src/main/transition-engine/resume-conversation-guard.ts`), which DOES start a resume fresh, on
> both chokepoints, when it can prove the conversation never started or that the agent deleted it.
> It is deliberately narrower than the guard rejected here, and that narrowness is what makes it
> safe. It never derives a transcript path: the AGENT must have reported one (its status file, the
> SessionStart hook payload, or the copy on the session row). A deleted conversation also
> needs the adapter's own proof (`AgentAdapter.proveConversationGone`): for Claude, the reported
> file and the one every reader would open (the locator's, which looks past the cwd) both ENOENT,
> the projects folder above readable, and no project folder
> holding the file. Absence of evidence is never evidence, so a missing report leaves today's
> behavior untouched, which is exactly what keeps the mocked resumes below passing. A wrong
> verdict costs a new conversation, never data: the old record is kept and the new one opens on a
> recap. See [A resume the CLI cannot serve starts fresh instead](../../architecture/sessions/resume.md#a-resume-the-cli-cannot-serve-starts-fresh-instead). The
> rejection below still stands for the BLANKET form described in this section.

A natural-looking robustness idea is an optional `canResumeSession(agentSessionId, cwd)` adapter
method that returns `false` when the resume target is verifiably absent, plus a shared chokepoint
(`isResumeTranscriptMissing`) in both spawn paths that downgrades a doomed `--resume <id>` to a
clean fresh spawn. **That guard was built in full for Claude and then deliberately removed during
task #255 ("Done then back loses the Claude conversation"). Do not re-introduce it.** Two
empirical findings killed it:

1. **It broke the test suite.** `mock-claude.js` (and the other agent mocks) never write a real
   native transcript at the located path, so a `canResumeSession` wired to the real locator
   returned `false` and downgraded *every* mocked resume to a fresh spawn - 10 E2E session-resume
   specs timed out waiting for `MOCK_CLAUDE_RESUMED:`. The only fix would be to make the mocks
   write under the real home directory, which violates the `cross-platform-parity` rule ("test
   filesystem writes stay under `os.tmpdir()`").
2. **It traded a visible failure for silent conversation loss on the critical path.** The guard
   gated *every* resume on an `fs.accessSync` of a computed path. Any slug-algorithm drift,
   long-path edge, transient filesystem hiccup, or future change to a CLI's storage layout would
   silently turn a recoverable resume into a fresh session - worse than the visible "No
   conversation found" it was meant to replace. The cwd-keyed agents above each have a *more*
   fragile locator than Claude's (Gemini basename collisions, Kimi `md5(cwd)`, Droid/Qwen slugs),
   so extending the guard to them would multiply that risk, not reduce it.

The actual root cause of the #255 bug was unrelated to a missing transcript: when Kangentic was
launched from inside a Claude Code session it leaked `CLAUDE_CODE_*` markers into spawned agents,
so a Claude spawned with `--session-id <id>` never persisted a transcript under that id and the
later `--resume` found nothing. The cure was `buildSpawnEnv` stripping `CLAUDECODE` plus every
`CLAUDE_CODE_*` identity marker (`src/main/pty/spawn/pty-spawn.ts`, commit `4b236593`; the
exceptions are the keeplisted `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT` and `CLAUDE_CODE_SCROLL_SPEED`
renderer tuning flags, which carry no session identity), which makes every spawned Claude a clean
top-level session that persists its own resumable transcript. With that in place the resume
target reliably exists, so the presence guard earns nothing and was dropped.

The non-Claude agents never exhibited an analogous missing-resume-target failure: each captures
or owns its session id against a store the CLI itself writes, and none inherits the Claude env
leak. If a future, *demonstrated* resume regression for a specific agent ever needs a guard, scope
it to that one adapter with a mock that round-trips the resume artifact under `os.tmpdir()` - do
not reinstate a blanket transcript-presence check on the shared spawn path.

### Migrate-on-resume after a worktree rename (not the `canResumeSession` guard)

A separate, narrower failure exists for the cwd-keyed agents: when a task's branch is renamed, its
worktree directory is later recreated at a new path (the folder follows the renamed branch). The
re-spawned agent then runs with the new worktree as cwd, so `--resume <id>` looks under the new
cwd's slug and finds nothing - the transcript is intact, just orphaned under the old slug. A
worktree rename is a per-cwd relocation, so `migrateResumeCwdIfRenamed`
(`src/main/transition-engine/resume-cwd-migration.ts`) reuses the same `onProjectRelocated(oldCwd,
newCwd)` hook the project-move path uses to move the history to the new slug on the first resume,
before any empty transcript is written.

This is **not** the reverted `canResumeSession` guard, and does not reintroduce its problems:

1. It never downgrades resume to fresh. It performs a non-destructive directory rename, then issues
   the same `--resume <id>`. On any failure it degrades to today's exact behavior (a visible "No
   conversation found"), never to silent loss.
2. It is gated on `oldCwd !== newCwd`. The mocked E2E resume specs keep cwd identical across spawns,
   so the helper early-returns before touching `locateSessionHistoryFile` or `onProjectRelocated` -
   the 10 specs that killed the old guard cannot be reached.
3. `locateSessionHistoryFile` is used as a positive "already reachable? then skip" check, not as a
   gate that suppresses resume. An adapter that reads histories from more places than its CLI
   resumes from answers the check with `locateResumeHistoryFile` instead. Agents whose resume finds
   the file regardless of cwd no-op: Codex and OpenCode by id. Claude no-ops for a history under a
   parent folder's slug, which 2.1.312 resumed from a worktree, and still migrates one under a
   renamed worktree's old slug, which its locator reads but its resume was never measured to reach.
   Worktree folders no longer move (`WorktreeManager.createWorktree`), so the rename reaches the
   helper only from an older install.
4. A load-bearing guard restricts migration to an `oldCwd` under
   `<projectPath>/.kangentic/worktrees/`. The enable-worktree flow resumes a session whose oldCwd is
   the shared project root; relocating that would move the whole `~/.claude/projects/<root-slug>/`
   directory and orphan every other task's main-repo session.

Pre-existing orphans (a task that already failed a resume and wrote an empty transcript under the
new slug) are left to one-time manual recovery: copy the intact `<id>.jsonl` from the old slug
directory into the current worktree's slug directory. For Claude, a reader that has the path
Claude reported reads the reported file over such an orphan; one without it reads the orphan,
which sits at the cwd's own path.

### Mid-session fork reconcile (/clear moves the conversation to a new id)

**The invariant: a task points at the conversation its agent last said it moved to.**
Kangentic never chooses or guesses a session id. It follows the agent's own report, adopts it
idempotently (same-id reports are no-ops), and no path can turn a resume into a fresh session or
touch a transcript on disk. Everything in this section is that one rule enforced at two moments
(live, and at resume), plus the lockdown that keeps every other channel from moving the pointer.

When the user runs `/clear` inside a Claude session, the CLI **continues under a brand-new
session id**: later turns persist to a new `<slug(cwd)>/<newId>.jsonl` and the pre-clear file is
never touched again. The facts this design rests on:

- The **statusline payload flips to the new id within about one refresh** of the move.
  Kangentic's `status-bridge.js` persists that payload verbatim as the session dir's
  `status.json`, so the live id is always on disk. The statusline reflects only the main REPL
  session, so subagent ids never reach it (validated live on v2.1.220 with
  `scripts/validate-clear-fork.mjs`).
- **The status file can have more than one writer.** Every process started with the session's
  `--settings` runs the statusLine and the hooks into the same session dir. Claude Code 2.1.316
  moved a live task into its background daemon (`claude daemon run --origin transient`, started
  through WMI, so outside the task PTY's process tree). The daemon started the moved
  conversation (`--fork-session --resume`) and an empty pre-warmed "spare" worker, both with the
  task's `--settings`. Their writes alternated about 0.6 s apart on every 10 s refresh. Read as
  one writer, each alternation was a /clear: a "Conversation moved" toast, a
  `sessions.agent_session_id` rewrite and the spare's zeros on the context bar, twice every 10 s,
  until the daemon retired the idle spare after 60 minutes.
- **The SessionStart hook says which id is the conversation.** Its payload carries `session_id`
  and `source`. The spare said `startup`, and the moved conversation said `fork` 236 ms later. A
  /clear sends `clear` (measured on 2.1.294 by `scripts/probe-claude-exit-paths.js`, about 720 ms
  after the command), a `/resume` choice sends `resume`, and a compaction sends `compact` with
  the id unchanged.
- `claude --resume <id>` **continues the same id** in current versions, so "reported id differs
  from stored id" means a move, never routine resume noise.

Kangentic tracks the move at two layers. Neither branches on an agent name. Both ride the
generic `runtime.statusFile` capability: a `parseStatus` that returns a live payload, which only
Claude's does today (Copilot's and Grok's `statusFile` declarations carry only the events
channel), and `parseSessionStart`, which reads the hook. An adapter without `parseSessionStart`
follows every status id change, as before.

1. **Live reconcile.** `SessionTelemetry.processStatusUpdate`'s agent-session-id capture is
   **change-sensitive on the status-file channel**. Its first id-bearing write is the session's
   baseline and needs no hook, so a `--resume` that silently started fresh (a new id with
   `source: startup`) is still followed. After that, `ConversationSwitchGate`
   (`src/main/activity-engine/conversation-switch-gate.ts`) adopts a different id only once a
   SessionStart whose `source` is not `startup` named it. `SessionManager` hands every events
   batch to `SessionTelemetry.noteSessionStartHooks`. Either may land first. A write without a
   confirmation is held and stops before the usage cache, and the hook that confirms it applies
   the held usage at once. A confirmation is spent by the switch it allows, together with every
   older one, so a late write from a move it superseded is not adopted. One naming the current id
   is ignored, so a stale writer can never carry the pointer back. A replaced id returns only
   through a new hook that names it, as an in-terminal `/resume` to an earlier conversation
   sends. A background session's hook needs one more proof, that the conversation moved rather
   than a copy starting beside it ([Claude Code background sessions](#claude-code-background-sessions-bg)).
   An adopted id flows through the existing `recoverStaleSessionId` chain to
   rewrite `sessions.agent_session_id` in place. The PTY-output and hook capture channels stay
   strictly **one-shot** (multi-shot output capture would reintroduce the OpenCode
   stale-flag-echo poisoning bug), and any capture closes them, so only the status file may
   later revise the id.
2. **Resume-time reconcile.** `reconcileResumeAgentSessionId`
   (`src/main/transition-engine/resume-id-reconcile.ts`), run at both resume chokepoints
   (`executeSpawnAgent` before `migrateResumeCwdIfRenamed`, and `prepareAgentSpawn` for startup
   recovery), reads the retiring record's own `.kangentic/sessions/<recordId>/status.json` and
   swaps the resumed id when the agent's last report disagrees with the DB. This covers the
   suspend race (suspend closes the status watcher before the CLI exits, so a move in the final
   ~2s can miss the live reconcile) and records from before the fix shipped. For an adapter with
   `parseSessionStart` it applies the same rule: the record's own `events.jsonl` must hold a
   SessionStart that moved the conversation to the reported id, because a sibling writer can
   have written the status file last.

The resume-time reconcile is **not** the reverted `canResumeSession` guard. It reads only
Kangentic's own session directory (mock CLIs write no status.json, so mocked E2E resumes no-op
structurally), and it can only swap WHICH id is resumed, never downgrade resume to fresh. Its two
positive checks, the SessionStart hook and `locateSessionHistoryFile` on the reported id (which
guards a crash right after the move), each keep the stored id on a miss, degrading to exactly
the prior behavior.

**A /clear without a hook is not followed.** A scan of 1,557 session dirs from v2.1.187 to
v2.1.220 recorded no `clear` SessionStart, while live runs of v2.1.220 and v2.1.294 sent one.
Status writes were the only fork signal while that question was open. With two writers they
cannot be, so a Claude build whose /clear sends no SessionStart keeps the pre-clear id live and
at resume, and its context bar keeps the pre-clear numbers until the session restarts.

Three accepted consequences, all deliberate: (a) lifetime token rollups partition by
`COALESCE(agent_session_id, id)`, so a forked record's lineage key follows the fork and the
pre-clear leg leaves the rollups (the pre-clear context is what the user chose to discard); (b)
the stitched task transcript view follows the reconciled id, so the pre-clear conversation drops
out of it (the file itself remains on disk under the old id); (c) the conversation retrieval
index keys document identity on `agent_session_id ?? id`
(`src/main/retrieval/conversation/conversation-indexer.ts`), so the semantic-search corpus
partitions at the fork the same way as (a): pre-clear chunks stay indexed under the old document
id, and post-fork turns index as a new document. Note for MCP consumers: a task's
`agentSessionId` can rotate mid-session, so do not cache it across turns.

### Claude Code background sessions (`/bg`)

`/bg` (or `/background`) in a task's terminal moves the conversation into a background session
that Claude Code's supervisor runs. Measured on 2.1.316 (2026-10-31), on a live task and in a
`/preview`:

- The supervisor starts through WMI (`claude daemon run --origin transient`, parent
  `WmiPrvSE.exe`), outside the task PTY's process tree, and works in the user's home folder. Each
  background session runs under its own `--bg-pty-host`, in the task's folder, carrying the
  task's `KANGENTIC_TASK_ID`. The supervisor sometimes also starts a pre-warmed spare with the
  task's `--settings` and retires it after 60 idle minutes. Both write the task's status file,
  which is why the [fork reconcile](#mid-session-fork-reconcile-clear-moves-the-conversation-to-a-new-id)
  needs the SessionStart hook.
- The conversation continues under a new id: the old session's SessionEnd fires, then a
  SessionStart with `source: fork` names the new id, and the old transcript's last record,
  `continued-in`, names it too. The task's PTY keeps a `claude agents` client.
- A Kangentic pause closes that client, and the background session keeps running. A plain
  `claude --resume` beside it would put two processes on one conversation.
- `claude agents --json` lists it (`kind: background`, the full `sessionId`, a `pid` while its
  process is alive) in about 220 ms. `claude stop <id>` ends it in about 450 ms through Claude's
  own exit: its SessionEnd hook ran, its process and its pty host were gone, and its conversation
  was kept. `claude daemon stop --any` stops every background session on the machine and is
  never the right tool for one task.
- A fork's transcript holds only its title and name until the background session's first turn.
  Stopped before one, `claude --resume <new id>` answers "No conversation found", while
  `claude --resume <old id>` resumes the whole conversation. A fork that has taken turns holds
  the full history.
- `/fork` starts a background COPY while the terminal keeps the original. Its SessionStart is
  identical to `/bg`'s (`source: fork`, the same fields), but no SessionEnd fires, the terminal
  keeps writing the original id, and the original transcript gets no `continued-in` record. That
  record is the only difference Kangentic can read. `/bg` does not always send a SessionEnd
  either: the live task's `/bg` recorded none.

So a SessionStart with `inBackgroundSession` switches the live session only once
`statusFile.confirmsBackgroundMove` finds the `continued-in` record naming the new id in the
current conversation's transcript, through the path its status reported. The record landed about
2 s before the hook on the live task, so the check runs at once and four more times (1.5, 4, 10
and 30 s later). Until it succeeds, the background session's writes are held like any other
unconfirmed writer's, so a move never proven keeps the pre-move numbers on the context bar until
the next Resume. The resume-time reconcile applies the same check before it follows a status report
from a background session. Measured in a `/preview`: after `/fork`, Kangentic followed the copy
before this check, and stays on the terminal's conversation with it.

Kangentic handles a `/bg` move with three more optional adapter members, all implemented by Claude
(`adapters/claude/background-sessions.ts`):

1. **Before a resume** (`reconcileResumeAgentSessionId`, at both resume chokepoints),
   `stopBackgroundSession` stops the live background session holding the conversation, then
   `resolveResumableSessionId` swaps a fork that took no turn for the conversation it continued
   (its `continued-in` predecessor). Measured end to end in a `/preview`: after `/bg` and a
   pause, Resume stopped the background session and resumed the original id, and the agent
   quoted the task's first message. The whole Resume took 1.4 s.
2. **On a terminal transition** (`reapTaskLeftovers`, before the leftover reap),
   `stopBackgroundSession` stops it for each of the task's three newest records. The reap would
   otherwise kill it with no exit of its own. It is not gated on "Stop leftover processes",
   because it ends the task's own agent rather than something the agent left running. Measured
   with a Done move after `/bg`: the background session's SessionEnd ran and its process was gone.
3. **For a Command Terminal** (`ipc/helpers/command-terminal-background-session.ts`), which has
   no session record, and whose events file is deleted with its session directory.
   `backgroundSessionOf` reads the agent's own transcripts instead, with no CLI, and names the
   background session from either side of the move. Claude's names the session the
   conversation's own transcript ends by continuing in (its LAST record, so a `--resume` of the
   conversation the move left, which appends to it, ends that), or the conversation itself when
   another transcript in its folder ends by continuing in it. Listing and searching a folder of
   156 transcripts took 6 to 11 ms. The background session's own transcript need not exist: in a
   `/preview` one appeared 1.7 s after the move's record, one left idle for 30 s wrote none, and
   two stopped within seconds had none. So the search starts from the folder the cwd maps to,
   and `resolveResumableSessionId` reads a missing transcript as one with no turn. On that
   evidence the terminal's end runs `stopBackgroundSession` through the project's configured
   Claude: the leftover reaper starts the stop at the removal, while the registry row still
   names the agent and its place, and the reap waits for it. Measured in a `/preview`: a
   terminal stopped 25 s after `/bg`, and one stopped 37 ms after the live switch with no
   transcript written, each left its background session `stopped` in
   `claude agents --json --all`, the CLI's own stop. Before the search started from the cwd's
   folder, the second case was missed, the reap killed that session, and the CLI listed it
   `failed`. A terminal stopped between `/bg` and the live switch still holds the id the move
   left, and its own record names the background session. An Earlier resume runs the stop
   through the spawn's own Claude before the command is built. A quit stops nothing, so this is
   what stops a background session a terminal open at the quit left running, from either row:
   one that took no turn wrote no transcript, and Earlier offers only the conversation it left.
   A row that is the background session resumes by the id `resolveResumableSessionId` returns,
   claiming that one too, and refuses with `conversation-open` when another terminal holds it. A
   row the move left keeps its own id, by decision: its transcript holds the conversation up to
   the move, and a background session that took turns has a row of its own beside it. The
   alternative, resuming the background session instead, would open a conversation other than
   the one the row shows. Neither path stops a background session a live terminal holds: the
   terminal `/bg` ran in shows it, and Earlier offers the row the move left while it runs.

The first two run only when the session record's own events file shows the conversation in a
background session (`backgroundSessionHoldingConversation`). Either a SessionStart with `inBackgroundSession`
(Claude's `source: fork`) names the stored id, or one names another id that
`confirmsBackgroundMove` proves the stored conversation moved to. The second case is a pause or a
Done move between the background session's hook and its first status write, before the live
switch could follow it. A Resume then points the record at the background session, as the status
swap does. An ordinary resume runs no CLI. That matters because Claude Code's docs say
`claude agents` starts the supervisor on demand. The events file is streamed, never held whole,
and a resume reads it once for both of its checks. One stop (list, stop, and the wait for the
listing to show it gone) is bounded at 10 s in all. A terminal transition runs the stops for its
records two at a time, and after 20 s it starts no more of them and goes on to the reap.

A `/fork` copy is never stopped: the record follows the terminal's conversation, and no hook
names that id as a background session.

Decisions:
- The stop happens at the next Resume or terminal transition, not at the pause. The alternative,
  stopping at the pause, would keep a paused task from editing, at the cost of a CLI run on every
  pause of a task that used `/bg`.
- The Resume stops the background session and then runs `--resume`, rather than `claude attach`.
  An attached background session keeps the old record's `--settings`, so its hooks and status
  would land in a session folder Kangentic no longer watches.
- Kangentic does not set `CLAUDE_CODE_DISABLE_AGENT_VIEW`, which would turn `/bg` off for task
  sessions. That would block a Claude Code feature the user chose to use.

## Known gaps

### WSL on Windows

A CLI configured by its `\\wsl.localhost\<distro>\...` path keeps its history in the distro, and Kangentic reads it through the distro's share. Aider is the one whose file sits in the cwd on the Windows drive, read as before. The session row's `cli_target` records the distro home's share path (`homeUnc`) and the agent home overrides the distro's shell sets, such as `CODEX_HOME`. Each parser's `locate()` rebuilds a place from it (`placeFromStored`) and looks under that home: Claude's `~/.claude/projects/<slug>/`, with the slug built from the `/mnt` path the CLI ran in, Codex's `<CODEX_HOME>/sessions/<date>/`, and the Gemini, Qwen Code and Grok folders. `FileWatcher` (`src/main/pty/readers/file-watcher.ts`) tails the file with a one-second poll that runs beside `fs.watch` whether or not the native watcher fires, which is why tailing over the share works. Background readers skip a stopped distro, since reading its share would start it (`mayReadPlaceUnattended`). The conversation indexer and the transcript archive read it on a later pass, and the Command Terminal's Earlier list keeps the row without looking. OpenCode is the exception. Its SQLite WAL cannot be read over the share, so Kangentic asks the distro's own CLI (`opencode session list`, `opencode export`), as [OpenCode](opencode.md#wsl) describes. A Windows CLI run through a WSL shell has no `cli_target`, and its files stay in this machine's home, where they are read as before.

Two gaps remain. A worktree rename does not move a cwd-keyed CLI's history in a distro, such as Claude's. [Migrate-on-resume](#migrate-on-resume-after-a-worktree-rename-not-the-canresumesession-guard) logs and skips it, so that resume reports "No conversation found". Project relocation (`onProjectRelocated`) also rewrites only this machine's files. For an OpenCode session in a distro, the Conversation viewer gets no pages and handoff gets no history file.

### Remote SSH sessions

The history file of a session on a remote machine is not reachable through local `fs`. The session falls back to PtyActivityTracker.

### Claude Code background sessions

Gaps that remain in how Kangentic handles a Claude background session
([Claude Code background sessions (`/bg`)](#claude-code-background-sessions-bg)):

- A paused task's background session keeps working until the task's next Resume or terminal
  transition, which stop it. The pause itself does not, by decision (above).
- The startup sweep of archived and To Do tasks does not stop one, by decision. A task reaches
  those lanes through a transition that already stopped it, so the sweep could only catch a stop
  that failed, and it would run the CLI at every launch for that.
- `claude stop` and `/fork` were measured on Windows only. A Claude in a WSL distro is listed and
  stopped through the distro (`runClaudeCli`), and its move check reads the transcript in the
  distro's home, both unmeasured. macOS and Linux are unmeasured.
- A terminal transition stops a background session through the project's configured Claude.
  A record whose Claude ran somewhere that path no longer reaches (the CLI path changed since) is
  not found in the listing, and the reap ends that session with no exit of its own.
- A fork that took no turn resumes by its predecessor only when the predecessor's transcript is
  in the fork's own project folder. A conversation started in the project root and moved from a
  worktree is not found, and that resume answers "No conversation found" as before.

### First-session race

If a task completes in less than ~1 second (before the PTY scraper captures the session UUID), the history file watcher never starts and the card never shows telemetry. See the backlog task "Zero-latency telemetry pill for Codex/Gemini" for a potential pre-snapshot + claim-registry design that eliminates this window.

## Adding a new agent with a session history file

1. Implement a `FooSessionHistoryParser` class with `static locate()` and `static parse()` methods in the adapter's directory (e.g. `src/main/agent/adapters/foo/session-history-parser.ts`). Mirrors Claude's `status-parser.ts` convention - file is unprefixed, class is agent-prefixed.
2. Add it to the adapter's `runtime.sessionHistory` block:
   ```ts
   sessionHistory: {
     locate: FooSessionHistoryParser.locate,
     parse: FooSessionHistoryParser.parse,
     isFullRewrite: false, // true for whole-file-rewrite agents
   }
   ```
3. Write unit tests in `tests/unit/foo-session-history-parser.test.ts` with inline fixture strings.
4. Document the file format in this doc.
5. Ensure one of the `runtime.sessionId` capture paths (`fromHook`, `fromOutput`, or `fromFilesystem`) delivers a session ID that appears in the history filename - this is how we locate the file.
