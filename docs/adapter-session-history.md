# Adapter Session History Sources

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
   - **Spawn-time short-circuit** (caller-owned IDs): when the adapter declares `supportsCallerSessionId = true`, the spawn pipeline pre-generates a UUID and passes it via `SpawnSessionInput.agentSessionId`. `session-spawn-flow.ts` calls `sessionHistoryReader.attach(...)` directly during spawn. Used by Claude (when `runtime.sessionHistory` is wired), Qwen, and Kimi.
   - `runtime.sessionId.fromHook` (Gemini hook stdin)
   - `runtime.sessionId.fromOutput` (PTY scraper)
   - `runtime.sessionId.fromFilesystem` (Codex rollout directory scan)

   See [Agent Integration](agent-integration.md) for the full table.
4. When `notifyAgentSessionId` fires (one of the latter three paths), SessionManager reads `session.agentParser?.runtime?.sessionHistory` and, if present, calls `sessionHistoryReader.attach(...)`. The spawn-time short-circuit calls `attach()` directly, bypassing the notify chain to avoid a DB ordering hazard with `recoverStaleSessionId`. `attach()` is idempotent, so a later capture pathway firing the full chain is harmless.
5. `SessionHistoryReader.attach()` calls `hook.locate({ agentSessionId, cwd })`, instantiates a `FileWatcher` on the resolved path, and triggers an initial read.
6. Each file-change event reads new content (append-mode cursor for JSONL, whole-file re-read for JSON) and dispatches to `sessionHistory.parse(content, mode)`.
7. The resulting `SessionHistoryParseResult` flows through `dispatchSessionHistoryResult()` into the generic callback primitives (`onUsageUpdate`, `onEvents`, `onActivity`, `onFirstTelemetry`) that SessionManager wired to SessionTelemetry at construction time.
8. On the first successful dispatch, `onFirstTelemetry` fires, which calls into `SessionTelemetry`'s PTY-tracker suppression - PtyActivityTracker stops contributing activity signals for the rest of the session.

The PtyActivityTracker keeps running in parallel until suppressed, so the boot window (before the history file materializes) is still covered by the existing spinner + silence-timer mechanism.

**SessionTelemetry has zero session-history awareness.** Its generic primitives (`ingestEvents`, `forceActivity`, plus the existing `setSessionUsage`) are useful for any telemetry source - session history is just one caller. A future hypothetical telemetry source (WebSocket stream, API poll, etc.) would use the same primitives without any SessionTelemetry changes.

### `SessionHistoryParseResult`

`src/shared/types.ts` defines the contract that every parser returns from its `parse(content, mode)` method:

| Field | Type | Semantics |
|-------|------|-----------|
| `usage` | `SessionUsage \| null` | Updated usage snapshot. Null when this parse pass didn't touch model or tokens. The reader's callback merges it into the existing `usageCache` entry via `SessionTelemetry.setSessionUsage`. |
| `events` | `SessionEvent[]` | New events to append to the session event log. Empty array when there are none. The reader pushes them through `SessionTelemetry.ingestEvents`, which runs each event through the activity engine plus the per-event detectors (PTY suppression, ExitPlanMode, PR command). |
| `activity` | `Activity \| null` | Explicit activity transition hint (`Activity.Thinking`, `Activity.Idle`, or `null`). Set when a log entry maps directly to a state change (e.g. Codex `task_started` → `Thinking`, `task_complete` → `Idle`) rather than relying on the event stream alone. Null when events alone imply the transition. |

All three fields are optional in the sense that any combination is valid - parsers can return partial results (e.g. a token-only update yields `usage` populated and `events: []`).

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

Claude's **authoritative** live telemetry comes from the hook-driven `statusFile` pipeline (see "Claude status-file pipeline" below): it carries Claude Code's own `display_name`, the real `context_window_size` (including the 1M-context variant), `used_percentage`, cost, and rate limits, and it stays the source of truth whenever it is flowing.

Claude **also** declares a `runtime.sessionHistory` block, but as a **background-session fallback**, not a co-equal source. Claude Code only runs its statusLine command when its TUI paints (after an assistant message, `/compact`, a permission-mode change, or the `refreshInterval` timer), so a heavy resume can boot for a while before its first `status.json` write, and the board card would sit on the spawn-time model placeholder meanwhile. The transcript JSONL at `~/.claude/projects/<projectSlug>/<sessionId>.jsonl` is appended continuously regardless of painting, so `ClaudeSessionHistoryParser` (`src/main/agent/adapters/claude/session-history-parser.ts`) tails it to derive a live model + token occupancy until `status.json` starts flowing.

The two sources never race: on the **first** successful `status.json` parse, `StatusFileReader` fires `onFirstStatus`, which detaches the transcript reader (see "Claude status-file pipeline" below), so `status.json`'s full usage replace cleanly supersedes the fallback's partial merge. If a background session is never opened, the fallback keeps the card current for its whole life.

The same transcript JSONL is still read on demand by `transcript-parser.ts` for the renderer's Transcript tab and for lifetime-token refinement (`refineTranscriptTokens` on exit paths) - those are unchanged.

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

**First-status handoff (`onFirstStatus`).** `StatusFileReaderCallbacks` carries an `onFirstStatus(sessionId)` primitive that fires once per attachment, immediately after the first successful `parseStatus` dispatch. SessionManager wires it to `sessionHistoryReader.detach(sessionId)`, retiring the transcript fallback the moment `status.json` starts flowing (see the "Claude" section). The ordering is load-bearing: `onFirstStatus` fires *after* `onUsageParsed`, so the detach also cancels any transcript re-attach that the usage path's one-shot agent-session-id capture can trigger. SessionManager additionally guards the `onAgentSessionId` re-attach with `statusFileReader.hasReceivedStatus(sessionId)`. This is capability-driven, not agent-named: adapters whose `parseStatus` returns null (Codex, Gemini) never fire `onFirstStatus`, so nothing changes for them.

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

| Agent | Resume invocation | Where `--resume` reads | Keyed by | cwd-bound resume? | Same path as `locateSessionHistoryFile`? |
|---|---|---|---|---|---|
| Claude | `claude --resume <id>` | `~/.claude/projects/<slug(cwd)>/<id>.jsonl` | cwd slug + id | yes | yes |
| Codex | `codex resume <id> -C <cwd>` | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl` | session id (filename scan) | no | yes |
| Gemini | `gemini --resume <id>` | `~/.gemini/tmp/<basename(cwd)>/chats/session-<id>.json` | cwd basename + id | yes | yes |
| Qwen | `qwen --resume <id>` / `--session-id <id>` | `~/.qwen/projects/<slug(cwd)>/chats/<id>.jsonl` | cwd slug + id | yes | yes |
| Kimi | `kimi --session <id>` | `~/.kimi/sessions/<md5(cwd)>/<id>/` (wire JSONL) | md5(cwd) + id | yes | yes |
| Droid | `droid --resume <id>` | `~/.factory/sessions/<slug(cwd)>/<id>.jsonl` | cwd slug + id | yes | yes |
| OpenCode | `opencode --session <id>` | `~/.local/share/opencode/opencode.db` (+ `storage/session_diff/ses_<id>.json`) | session id (global DB) | no | yes (the DB) |
| Copilot | `copilot --resume <id>` | `~/.copilot/session-state/<id>/` (+ `session-store.db`) | session id (global) | no | **no** (locator returns null) |
| Cursor | `agent --resume=<id>` | `~/.cursor/chats/<chat-id-hash>/` | chat id (global) | no | **no** (locator returns null) |
| Aider | `aider --restore-chat-history` | `<cwd>/.aider.chat.history.md` | cwd file (no session id) | yes | n/a (no per-session file) |
| Warp | (no resume) | none | n/a | n/a | n/a |

Reading the table by class:

- **cwd-keyed per-session file that `--resume` reads (Claude-like):** Gemini, Qwen, Kimi, Droid
  (and Claude). The resume target is a file under a directory derived from the cwd (basename,
  slug, or `md5`), so moving the project to a path with a different cwd-derived key, or deleting
  that file, makes the stored id unresolvable.
- **id-keyed / global store (cwd-independent):** Codex, OpenCode, Copilot, Cursor. Resume
  resolves by session id against a global location, so the working directory does not gate it.
  Codex scans `~/.codex/sessions/` by id (`codex-rs find_thread_path_by_id_str`; the per-rollout
  cwd only filters the interactive picker, which has an `--all` escape hatch). OpenCode keys the
  shared SQLite DB by session id. Copilot and Cursor attach by id; for Copilot the saved `cwd`
  only affects *where* the resumed session reopens, not whether it attaches, and Cursor's
  per-cwd `~/.cursor/projects/<slug>/` directory holds only `repo.json` / trust metadata, not the
  conversation, which lives in `~/.cursor/chats/<chat-id-hash>/`.
- **project-wide reload, no session id:** Aider. `--restore-chat-history` reloads the cwd-local
  `.aider.chat.history.md`; there is no per-session id, so there is nothing to verify or
  downgrade.
- **no resume at all:** Warp. The `oz` one-shot runner streams and exits.

### Why there is no `canResumeSession` transcript-presence guard

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
`CLAUDE_CODE_*` marker (`src/main/pty/spawn/pty-spawn.ts`, commit `4b236593`), which makes every
spawned Claude a clean top-level session that persists its own resumable transcript. With that in
place the resume target reliably exists, so the presence guard earns nothing and was dropped.

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
   gate that suppresses resume. id-keyed agents (Codex, OpenCode) locate the file regardless of cwd,
   so the helper no-ops for them.
4. A load-bearing guard restricts migration to an `oldCwd` under
   `<projectPath>/.kangentic/worktrees/`. The enable-worktree flow resumes a session whose oldCwd is
   the shared project root; relocating that would move the whole `~/.claude/projects/<root-slug>/`
   directory and orphan every other task's main-repo session.

Pre-existing orphans (a task that already failed a resume and wrote an empty transcript under the
new slug) are left to one-time manual recovery: copy the intact `<id>.jsonl` from the old slug
directory into the current worktree's slug directory.

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
