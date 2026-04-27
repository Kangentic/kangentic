# Adapter Session History Sources

This document describes the native session history files that Kangentic reads to surface real-time telemetry (model, context window, token counts, activity) for agents that don't provide a status.json/hooks integration like Claude Code does.

This is the authoritative reference for the `AdapterRuntimeStrategy.sessionHistory` hook. If a CLI release breaks one of the file formats described here, this doc tells you what we depend on and where.

## How the pipeline works

The session-history subsystem is split into four layers with strict separation of concerns, and sits alongside a parallel `StatusFileReader` subsystem that handles the older hook/status-file telemetry pipeline:

| Layer | File | Responsibility |
|---|---|---|
| Adapter parser | `adapters/<agent>/session-history-parser.ts` | Agent-specific file format knowledge. Implements `locate()` + `parse()`. |
| Reader (dispatcher) | `src/main/pty/session-history-reader.ts` | Generic file watching, cursor tracking, parse dispatch. Owns all session-history-specific runtime logic. |
| Consumer primitives | `src/main/pty/usage-tracker.ts` | Generic primitives (`setSessionUsage`, `ingestEvents`, `forceActivity`, `suppressPty`, `processStatusUpdate`, `captureHookSessionIds`) — no telemetry-source-specific vocabulary. |
| Session lifecycle | `src/main/pty/session-manager.ts` | Calls `reader.attach()` on agent-session-id capture, `reader.detach()` on removal. Composes both telemetry readers symmetrically. Knows nothing else about session history. |

**Symmetric pipeline**: `StatusFileReader` (`src/main/pty/status-file-reader.ts`) handles Claude's hook-based telemetry (status.json + events.jsonl) using the exact same pattern. Both readers own their own `FileWatcher` instances and dispatch through generic `UsageTracker` primitives. Neither reader mentions a specific agent name. See the "Claude status-file pipeline" section below for details.

Runtime flow:

1. An agent adapter declares a `sessionHistory` block in its `runtime` strategy (`src/shared/types.ts` - `AdapterRuntimeStrategy.sessionHistory`).
2. On PTY spawn, the adapter's full runtime strategy is stored on `ManagedSession.agentParser` - SessionManager does nothing session-history-specific.
3. The agent's session ID is captured via one of four paths (whichever fires first):
   - **Spawn-time short-circuit** (caller-owned IDs): when the adapter declares `supportsCallerSessionId = true`, the spawn pipeline pre-generates a UUID and passes it via `SpawnSessionInput.agentSessionId`. `session-spawn-flow.ts` calls `sessionHistoryReader.attach(...)` directly during spawn. Used by Claude (when `runtime.sessionHistory` is wired), Qwen, and Kimi.
   - `runtime.sessionId.fromHook` (Gemini hook stdin)
   - `runtime.sessionId.fromOutput` (PTY scraper)
   - `runtime.sessionId.fromFilesystem` (Codex rollout directory scan)

   See [Agent Integration](agent-integration.md) for the full table.
4. When `notifyAgentSessionId` fires (one of the latter three paths), SessionManager reads `session.agentParser?.runtime?.sessionHistory` and, if present, calls `sessionHistoryReader.attach(...)`. The spawn-time short-circuit calls `attach()` directly, bypassing the notify chain to avoid a DB ordering hazard with `recoverStaleSessionId`. `attach()` is idempotent, so a later capture pathway firing the full chain is harmless.
5. `SessionHistoryReader.attach()` calls `hook.locate({ agentSessionId, cwd })`, instantiates a `FileWatcher` on the resolved path, and triggers an initial read.
6. Each file-change event reads new content (append-mode cursor for JSONL, whole-file re-read for JSON) and dispatches to `sessionHistory.parse(content, mode)`.
7. The resulting `SessionHistoryParseResult` flows through `dispatchSessionHistoryResult()` into the generic callback primitives (`onUsageUpdate`, `onEvents`, `onActivity`, `onFirstTelemetry`) that SessionManager wired to UsageTracker at construction time.
8. On the first successful dispatch, `onFirstTelemetry` fires, which calls `UsageTracker.suppressPty(sessionId)` - PtyActivityTracker stops contributing activity signals for the rest of the session.

The PtyActivityTracker keeps running in parallel until suppressed, so the boot window (before the history file materializes) is still covered by the existing spinner + silence-timer mechanism.

**UsageTracker has zero session-history awareness.** Its new generic primitives (`ingestEvents`, `forceActivity`, `suppressPty`, plus the existing `setSessionUsage`) are useful for any telemetry source — session history is just the first caller. A future hypothetical telemetry source (WebSocket stream, API poll, etc.) would use the same primitives without any UsageTracker changes.

### `SessionHistoryParseResult`

`src/shared/types.ts` defines the contract that every parser returns from its `parse(content, mode)` method:

| Field | Type | Semantics |
|-------|------|-----------|
| `usage` | `SessionUsage \| null` | Updated usage snapshot. Null when this parse pass didn't touch model or tokens. The reader's callback merges it into the existing `usageCache` entry via `UsageTracker.setSessionUsage`. |
| `events` | `SessionEvent[]` | New events to append to the session event log. Empty array when there are none. The reader pushes them through `UsageTracker.ingestEvents`, which runs each event through the activity state machine plus the per-event detectors (PTY suppression, ExitPlanMode, PR command). |
| `activity` | `Activity \| null` | Explicit activity transition hint (`Activity.Thinking`, `Activity.Idle`, or `null`). Set when a log entry maps directly to a state change (e.g. Codex `task_started` → `Thinking`, `task_complete` → `Idle`) rather than relying on the event stream alone. Null when events alone imply the transition. |

All three fields are optional in the sense that any combination is valid — parsers can return partial results (e.g. a token-only update yields `usage` populated and `events: []`).

## Key design principles

- **KISS**: no directory snapshotting, claim registries, timestamp windows, or provisional candidates. The PTY scraper gives us the session UUID; the filename contains that UUID; we look up the file directly. Two sessions cannot collide because the UUID in the filename is tied to our own PTY by construction.
- **Cross-platform**: every path uses `os.homedir()` + `path.join`. Directory listings use `fs.readdirSync`. No shell-outs. UTC dates via `toISOString().slice(0, 10)`. CRLF-tolerant line splitting.
- **Graceful degradation**: if the history file never appears, disappears mid-session, or contains malformed content, the parser logs a WARN and the PtyActivityTracker fallback keeps the session alive.
- **Defensive parsing**: every field access goes through `unknown`-based type guards (`isRecord`, `toNumber`, etc.). No `any` casts. No assumptions about field presence.

## Codex

**File path**: `~/.codex/sessions/<UTC-YYYY>/<UTC-MM>/<UTC-DD>/rollout-<iso-timestamp>-<sessionUUID>.jsonl`

**Format**: append-only JSONL. One JSON object per line. CRLF or LF line endings tolerated. `isFullRewrite: false` - parser receives newly-appended bytes on each file-change event.

**Parser**: `src/main/agent/adapters/codex/log-parser.ts`

### Line entries we depend on

Each line has top-level `timestamp`, `type`, and `payload` fields.

| `type` | Field(s) extracted | Effect |
|---|---|---|
| `session_meta` | `payload.id`, `payload.cwd`, `payload.cli_version` | First line of the file. UUID matches filename suffix. Not actively parsed today (we already have the UUID from the PTY scraper). |
| `task_started` | `payload.model_context_window` | Sets `SessionUsage.contextWindow.contextWindowSize`. Also triggers `Activity.Thinking`. |
| `turn_context` | `payload.model` | Sets `SessionUsage.model.id` and `.displayName`. Emitted on every turn, so respects mid-session `/model` changes. |
| `token_count` | `payload.info.total_token_usage.{input_tokens,cached_input_tokens,output_tokens}` | Sets `SessionUsage.contextWindow.{totalInputTokens,cacheTokens,totalOutputTokens}`. |
| `task_complete` | (none) | Triggers `Activity.Idle`. |
| `response_item` with `payload.type: "function_call"` | `payload.name` | Emits `SessionEvent { type: ToolStart }`. Tool name mapping is coarse - currently all function calls map to `AgentTool.Bash`. |

All other entry types are ignored.

### Assumptions that could break on CLI upgrades

- The directory structure `sessions/YYYY/MM/DD/` is stable.
- Filenames embed the session UUID as the suffix before `.jsonl`.
- JSONL format (one complete JSON object per line, ending in `\n`).
- The field names inside `payload` (`id`, `cwd`, `model`, `model_context_window`, `total_token_usage`, etc.) are stable across minor Codex releases.
- Context window size is reported in raw token count (not K, M).

If a Codex release breaks any of these, the parser will silently return null/empty `SessionHistoryParseResult` and the card will fall back to the minimal pill. Fix: update the field extraction in `codex/session-history-parser.ts` and the regexes in `locate()`.

## Gemini

**File path**: `~/.gemini/tmp/<projectDirName>/chats/session-<sessionId>.json`

The `<projectDirName>` is the **lowercased basename** of the cwd, NOT a hash - despite the misleading `projectHash` field inside the JSON body (which appears to be a SHA-256 of something else, possibly the absolute path, but is not what Gemini uses to name the directory). Verified empirically against live Gemini directory listings:

| cwd | Directory name |
|---|---|
| `C:/Users/dev/project-a` | `project-a` |
| `C:/Users/dev/Parent/MyProject` | `myproject` |
| `<parent>/worktree-mixed-case-123` | `worktree-mixed-case-123` |

**Collision risk**: two projects sharing the same basename (e.g. two `app/` directories in different parent paths) will share this Gemini directory. That's Gemini's design choice, not ours. Worktrees created by tools like Kangentic typically have unique hash-suffixed names, so collisions are rare in practice.

**Format**: single JSON object, rewritten atomically on every message. `isFullRewrite: true` - parser receives the full file content on each change.

**Parser**: `src/main/agent/adapters/gemini/log-parser.ts`

### JSON shape we depend on

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

The parser walks `messages[]` backwards to find the most recent `"type": "gemini"` entry and extracts its `model` and `tokens`. This naturally respects mid-session `/model` changes since each assistant message carries its own model identifier.

### Context window size

**Not present in the file.** The parser uses a hardcoded model-name → window-size lookup:

| Model prefix | Context window |
|---|---|
| `gemini-3-flash*` | 1,000,000 |
| `gemini-3-pro*` | 2,000,000 |
| `gemini-3*` | 1,000,000 |
| `gemini-2.5-pro*` | 2,000,000 |
| `gemini-2.5-flash*` | 1,000,000 |
| `gemini-2.5*` | 1,000,000 |
| `gemini-2.0*` | 1,000,000 |
| (default) | 1,000,000 |

Source: Google's published model cards. Update the table in `gemini/log-parser.ts` when Google publishes new model specs.

### Assumptions that could break on CLI upgrades

- The directory structure `~/.gemini/tmp/<dir>/chats/` is stable.
- The directory naming scheme is lowercased basename of cwd.
- Filenames start with `session-` and contain the session UUID.
- The JSON shape (`messages[]`, `type: "gemini"`, `model`, `tokens`) is stable.
- `tokens.input` represents cumulative context tokens (not per-turn delta).

If a Gemini release breaks any of these, the parser will silently return null/empty and the card falls back to the minimal pill. Fix: update the field extraction in `gemini/session-history-parser.ts`.

## Claude

Claude does **not** participate in the `sessionHistory` pipeline. Telemetry comes exclusively from the hook-driven `statusFile` pipeline (see "Claude status-file pipeline" below). Claude Code's own native session log at `~/.claude/projects/<projectSlug>/<sessionId>.jsonl` is read on demand by `src/main/agent/adapters/claude/transcript-parser.ts` for the renderer's Transcript tab, but is not wired into the live telemetry pipeline.

A previous version of this adapter ran a parallel `runtime.sessionHistory` parser against the same JSONL file for cumulative token counts. It was removed because the hook output is strictly richer (it carries Claude Code's own `display_name` and the real `context_window_size`, including the 1M-context variant), and a second source raced against it - the task card visibly flashed a raw model id and a different window size between messages. The hook pipeline alone now owns model identity, window size, token counts, and cost.

The `<projectSlug>` is computed by `claudeProjectSlug()` (exported from `transcript-parser.ts`). It is NOT a hash - it is the cwd with every `/`, `\`, `:`, and `.` character replaced individually by `-`. Each character is replaced one-for-one (not collapsed), so `C:\Users` produces `C--Users` (one dash from `:`, one from `\`).

| cwd | Slug |
|---|---|
| `C:\Users\dev\project` | `C--Users-dev-project` |
| `/home/dev/project` | `-home-dev-project` |
| `C:\Users\dev\my.app` | `C--Users-dev-my-app` |
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
};
```

`StatusFileReader` (`src/main/pty/status-file-reader.ts`) reads `session.agentParser?.runtime?.statusFile` at attach time and dispatches through the hook's `parseStatus` / `parseEvent` methods. It contains no Claude-specific parsing code - swap the hook and the same reader serves any future adapter that wants to ride the same pipeline.

| Field | Semantics |
|-------|-----------|
| `parseStatus(raw)` | Decode the rewritten contents of `status.json` into a `SessionUsage`. Returns null for partial or malformed content. |
| `parseEvent(line)` | Decode a single appended line from `events.jsonl` into a `SessionEvent`. Returns null for blank/invalid lines. |
| `isFullRewrite` | True for `status.json` (whole-file rewrite on every update). The events file is always append-only, tracked by a separate byte cursor regardless of this flag. |

**File paths** (`status.json`, `events.jsonl` under `.kangentic/sessions/<sessionId>/`) are caller-supplied at spawn time on `SpawnSessionInput.statusOutputPath` / `eventsOutputPath`. They are runtime values, not static adapter metadata.

## Known gaps

### WSL on Windows

If Codex or Gemini runs under WSL on a Windows host, their history files live inside the WSL Linux filesystem (`\\wsl$\<distro>\home\<user>\.codex\...`). Node.js `fs.watch` on UNC paths is unreliable. In this case:

1. `locate()` typically returns `null` because `fs.readdirSync` on the WSL UNC path fails.
2. The session still works via the existing PtyActivityTracker fallback.
3. The card shows the "Starting agent…" spinner + working/idle dot, not the full telemetry pill.

This is graceful degradation, not a regression - it matches pre-telemetry behavior. Fix (future): detect WSL mode and shell out to `wsl cat` to read the file from inside the WSL environment.

### Remote SSH sessions

Same as WSL: the history file is on the remote machine, not accessible via local `fs`. Falls back to PtyActivityTracker.

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
