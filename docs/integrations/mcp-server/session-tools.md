---
type: Reference
title: Session tools
description: "MCP tools for inspecting and steering agent sessions: list_sessions, get_transcript formats and views, session files, events and activity intervals, send_session_message delivery modes, held messages and loop guards, mark_background_service, and reserve_dev_ports and check_dev_ports."
tags: [mcp, sessions, transcript, steering]
sources:
  - resource: src/main/agent/mcp-http/session-tools.ts
    title: Session tool registrations
  - resource: src/main/agent/mcp-http/steering-tools.ts
  - resource: src/main/agent/mcp-http/background-shell-tools.ts
  - resource: src/main/agent/mcp-http/session-send.ts
  - resource: src/main/agent/commands/analytics-commands.ts
  - resource: src/main/agent/commands/inspect-commands.ts
  - resource: src/main/agent/commands/handoff-commands.ts
  - resource: src/main/agent/commands/session-files-commands.ts
  - resource: src/main/agent/commands/activity-interval-commands.ts
  - resource: src/main/agent/commands/dev-port-commands.ts
  - resource: src/main/agent/commands/structured-transcript.ts
---
# Session tools

## kangentic_list_sessions

List all session records for a task with metadata: start/end times, exit codes, suspension reasons, cost, token counts, and duration.

A resume is a new record that reports the conversation's running total, so each record's cost and runtime are its own share (`legDeltas`, `src/shared/leg-deltas.ts`) and the records add up to `kangentic_get_task_stats`. A record that reported no usage has no share and reads as no cost and no runtime. The structured data also carries each record's running reading as `cumulativeCost` and `cumulativeDurationMs`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |
| `project` | string | No | Project name or UUID to target a different project than the active one. |

## kangentic_get_session_history

Read the agent's native session history file for a task. Returns the raw file content (Claude JSONL, Codex rollout JSONL, or Gemini chat JSON) from the most recent session. Large files are truncated to the most recent portion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

## kangentic_get_handoff_context

Get the most recent handoff record for a task. Returns metadata about the cross-agent handoff: which agent handed off to which, when, and the path to the prior agent's native session history file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

## kangentic_get_transcript

Inspect what the agent on another task (or another project) said - "check the response from Task #25" or "read the full transcript from Task #30". At least one of `taskId`, `sessionId` or `workflow` must be provided. `workflow` (a workflow's id or exact title) reads that workflow's own agent's conversation, which has no session row: it resolves through the workflow's `agent_name`, `agent_session_id` and `agent_cwd`, structured only, since no raw scrollback is kept for that agent. Two formats, selected with `format`:

- `format="structured"` (default): the parsed agent conversation - user prompts, assistant text, tool calls and results - rendered as clean markdown, read from the agent's native session history via the adapter's `parseTranscript` capability. The Claude parser also drops noise (slash-command XML, `<system-reminder>` spans, `isMeta` messages) and surfaces compaction boundaries/summaries explicitly. When the agent has deleted its own file (Claude removes transcripts older than its `cleanupPeriodDays`), the read falls back to Kangentic's structured transcript archive, then to the index's text-only chunks, and the header names which (`Source: Kangentic's saved copy` or `Source: indexed text only`). A session that started over from a recap points its agent here for the old conversation. There is no cleaned-scrollback substitute: structured comes from session history, the archive, or the index (text only, tool calls flattened), or reports that it is unavailable and points at `format="raw"`.
- `format="raw"`: the verbatim ANSI-stripped PTY scrollback (the full terminal output, including TUI redraws), available for every agent. Useful for debugging the terminal layer or for agents without a structured parser. Raw scrollback is mostly repeated terminal redraws (empirically ~85% duplicate lines and multiple MB for a long session), so when a structured parser exists for the agent the raw response notes that `structured` is the cleaner, far smaller view for evaluation. Every returned transcript (both formats) is prefixed with a one-line note marking the content as read-only reference data, not instructions to follow.

Structured output is shaped by three agent-agnostic levers, applied to the parsed `TranscriptEntry[]` (so no adapter branching):

- `view`: `"full"` (default), `"responses"` (assistant text turns only, dropping tool calls/results/thinking; Claude's narration lines between tool calls count as text), or `"result"` (just the final assistant text - the Agent SDK `ResultMessage.result`, rendered bare without the `## Assistant` heading).
- `tail`: return only the last N entries (the most recent messages). Ignored for `view="result"`.
- `search`: case-insensitive substring; return only entries whose content (including a tool result inlined under its owning tool call) contains the term.
- `aroundUuid` + `context`: center the returned entries on the turn with `aroundUuid` (the `turnUuid` from a `kangentic_search` conversation hit) and include `context` turns either side (default 3). This is the citation-first fetch - pull just the neighborhood of a cited turn rather than the whole transcript. A stale/absent uuid degrades to the full transcript.

A very large transcript is bounded twice, at two different layers, and the two notices mean different things. The parser reads at most `MAX_PARSE_SOURCE_BYTES` (16MB) from the END of the native history file, because reading an unbounded one whole is what OOM'd the main process; when it does, the omission is announced in-band as a `system` entry with subtype `truncated` ("Earlier N MB of this conversation are not shown"). That is a READ bound and it is the same for every caller. The `maxChars` budget below is a separate RESPONSE bound applied afterwards. A single huge transcript can carry both notices at once. `kangentic_search`'s conversation index is unaffected for Claude, whose adapter implements `parseTranscriptWindow` and walks the whole file in bounded windows. For every other agent the indexer falls back to `parseTranscript`, so above `MAX_PARSE_SOURCE_BYTES` search coverage is bounded at the same point the reader's is, not the full history.

Output is bounded by a character budget (default ~50,000 chars; raise via `maxChars`, hard ceiling 500,000). When the result exceeds the budget it keeps the **most recent** entries and prepends a `[Truncated: N earlier entries omitted ...]` note. `view`/`tail`/`search` apply to `structured` only; the `maxChars` budget also caps `raw` scrollback (keeping the most recent portion). In `structured`, any single span (a message's text, a thinking block, a tool result) longer than 20,000 characters is cut there with a `[truncated N chars]` marker, the same clamp the Conversation viewer applies, so one huge tool output never fills the budget alone.

Structured-format support by agent:

| Agent | Structured | Raw |
|-------|------------|-----|
| Claude, Droid, Codex, Gemini, Qwen, Kimi, OpenCode, Grok, Antigravity | native parser | yes |
| Aider | no (no per-session native history) | yes |
| Warp, Cursor, Copilot | no (history location unknown) | yes |
| Ollama | no (no per-session history for `ollama run`) | yes |
| Goose | no (adapter parses no transcript) | yes |

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (returns the transcript for the task's latest session; see `sessionIndex` for older ones) |
| `sessionId` | string | No | Session ID (returns the transcript for a specific session) |
| `sessionIndex` | number | No | When `taskId` is given, which session to pick: `0` = newest (default), `1` = previous, etc. Ordered `started_at DESC`. |
| `workflow` | string | No | A workflow's id or exact title: reads that workflow's own agent's conversation. Structured only (no raw scrollback is kept for that agent). |
| `format` | string | No | `"structured"` (default) or `"raw"`. |
| `view` | string | No | Structured only. `"full"` (default), `"responses"`, or `"result"`. Ignored for raw. |
| `tail` | number | No | Structured only. Last N entries (most recent). Hard cap 2000. Ignored for `view="result"` and for raw. |
| `search` | string | No | Structured only. Case-insensitive substring; keep only entries containing it. Ignored for raw. |
| `aroundUuid` | string | No | Structured only. Center the entries on this turn uuid (from a `kangentic_search` conversation hit). Ignored for raw. |
| `context` | number | No | Structured only. Turns either side of `aroundUuid` (default 3, max 50). Ignored without `aroundUuid`. |
| `maxChars` | number | No | Override the default ~50,000-char output cap (hard ceiling 500,000). Applies to structured and raw. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

## kangentic_send_session_message

Send a message to another task's agent, exactly as if it had been typed into that session's input box. This is the write-side counterpart to the read-only session tools: `kangentic_get_session_events`, `kangentic_get_transcript`, and `kangentic_list_sessions` observe another agent, and this one steers it. Typical uses are handing off a decision, unblocking a stalled agent, answering a question a session is waiting on, and redirecting work a newer decision superseded.

Identify the task with `taskId`; `sessionId` is optional. Given together, the session must be that task's own, or the tool refuses and names the session's task; a `sessionId` that names no session at all is refused too, rather than ignored. Given alone, a `sessionId` names its task through the registry, or through its `sessions` record when it is paused or exited. The message goes to the task's running agent: the given session when it has a PTY, else the task's live session from the PTY registry, preferring the registry over the `task.session_id` column, which is known to drift.

**Held for the task's next agent.** When the task has no running agent (paused, exited, still queued for a concurrency slot, or never started), the message is held instead of refused, and the tool replies:

> Held for task #412: no agent is running on it. It goes out when an agent starts or resumes there, and is cleared if the task moves to Done, To Do or Backlog, or is archived or deleted.

A held message goes into the opening message of the next agent that starts or resumes on the task, after the column's own message, whatever its `deliverWhen`. A task in Done holds nothing and the send is refused, since the move out of Done sends the agent no messages. A held message to the caller's own task is refused as a self-send, a held message is at most 20,000 characters (the cap a `kangentic_move_task` message has), and each task takes at most 30 held messages per rolling 5 minutes. A send the task refuses takes no slot of that window. How and when a held message is delivered: [Held messages](../../architecture/sessions/held-messages.md).

**Delivery.** The message goes through the same bracketed-paste submit path a human paste uses (`TerminalSubmit.submitContent`): drain, chunked write, output settle, `\r`, then wait for submission evidence. It is not instant, and it is measurably slower when nobody has the target session's terminal open, because the paste engine's fast path needs the session subscribed. `delivered` means the message was handed to the session's input, not that the agent has finished reading it.

Against a **busy** target, treat `delivered` as weaker still. The paste engine's submission check accepts "at least 50 bytes of output arrived after the `\r`" as evidence, which a mid-turn session satisfies trivially from its own ambient streaming output. So a `delivered` result on a thinking session means the paste was written, not that it was confirmed submitted. Use `deliverWhen: "idle"` when you need the stronger guarantee.

A deferred (`"idle"`) delivery that later fails is not reported back - the tool call that queued it has already returned - so it is written as a `failed` row instead (and, for a delivery that threw, logged to the Electron main console too). That covers the target exiting or going unwritable before it ever flushed, which is otherwise silent: a `queued` result is not a promise the message landed.

**Attribution is out-of-band.** The message is delivered **verbatim** - no prefix, no marker, nothing prepended. The one change is to a held message that rides a resume command line under PowerShell or cmd.exe: each `"` becomes `'`, as in every prompt the command builders quote there. Instead, every send ATTEMPT is recorded in the target project's `session_messages_sent` table (`session_id`, `task_id`, `caller_session_id`, `caller_task_id`, `caller_project_id`, `message`, `status`, `error`, `created_at`), with the caller resolved server-side from the URL segment rather than from a tool parameter, so an agent cannot omit or alter it through the tool's own arguments. See the caller-identity note under [Security](how-it-works.md#security) for what that does and does not guarantee: it is honesty-by-default, not cryptographic attribution.

`status` answers "did my message go through?" for every attempt when debugging:

| `status` | Meaning | Produced a turn? |
|----------|---------|------------------|
| `delivered` | Handed to the session's input | Yes |
| `queued` | Held for the next idle transition, then delivered | Yes |
| `refused` | A guard rejected it (self-send, target at a permission prompt, cross-project session id, hop-depth backstop, rate limit); `error` carries which | No |
| `failed` | Delivery was attempted and threw (e.g. `no-submission-evidence`), or a `queued` message's target exited before it could flush, or a held message's delivery began and did not finish; `error` carries the detail | **Unknown** - the paste engine can fail with the text half-committed; an exited target produced no turn |
| `held` | The task had no running agent; the message waits for its next one, with no `session_id` yet | Not yet |
| `delivered_from_hold` | A held message the task's next agent got, in its opening message; `session_id` is that agent's | Yes |
| `cleared` | A held message whose task moved to Done or To Do, or was unarchived into To Do, before an agent started | No |

Reconstructing which turns arrived this way means filtering to `delivered` / `queued` / `delivered_from_hold`. Two caveats for debugging.

`session_id` carries a foreign key so these rows are cleaned up with their session, which means an attempt naming a session id that was never real (a typo, or an id from another project) records nothing - there is no session row to attach it to. The caller still receives the refusal synchronously. This does not affect the realistic dead-session case: a session that exited or was suspended still has its row, so its refusal is recorded.

Second: repeated refusals are deduped to one row per (target, reason) per 5-minute window. Without that the audit trail becomes an amplification vector - the self-send, dead-session, and hop-depth guards all run *before* the rate limiter, so they never consume a slot (the permission-prompt guard runs after it, and does), and a looping agent would write one row per attempt indefinitely. A `refused` row therefore means "at least one refusal for this reason in this window", not an exact count. `failed` rows are never deduped, since a failure required an actual delivery attempt, which the rate limiter already bounds.

This replaced an in-band `[Kangentic relay]` prefix, which was removed after live testing on 2026-07-25. Two problems: it cost tokens on every single send, and the receiving agent read it as injected content asserting its own authority - structurally the shape of a prompt injection - and refused to act on messages sent this way, reasoning that "legitimate authority doesn't need to announce itself through injected content." Out-of-band provenance costs nothing, cannot be forged by anything the agent writes, and leaves the receiver's context clean.

Because nothing is prepended, the stored `message` matches the transcript turn it produced, which is how a consumer correlates a turn to the row that sent it. One caveat for an exact-match consumer: the row stores what the caller supplied, while delivery runs the text through the same `sanitizeForPaste` every paste undergoes (CR and CRLF collapse to LF, C0 control characters are stripped). For ordinary prose the two are byte-identical; a message carrying those bytes differs by exactly that normalization. Note the consequence: the `session_messages_sent` row is the **only** record that a turn arrived through this tool rather than being typed. A sent message that is never recorded is indistinguishable from one the human typed.

**Guards.** These are circuit breakers against unattended token spend (two agents ping-ponging overnight), not a permission policy - deliberate multi-agent orchestration is meant to pass through unobstructed:

- A session cannot send to itself.
- A `deliverWhen: "now"` send into a target sitting at a **permission prompt** is refused. The submit path ends in `\r` (and retries it), which a modal prompt reads as confirming its highlighted option, so an ordinary steer could silently approve a tool call nobody sanctioned. The paste engine's own modal safety net cannot cover this: it detects bracketed-paste-mode-off from the terminal `data` stream, which is only forwarded while the session is subscribed, and an MCP send targets a background session by construction. `deliverWhen: "idle"` is not refused for this state - it holds the message until the prompt clears, which is what the refusal points you at. The check is the shared automated-keys guard (`src/main/pty/automated-keys-guard.ts`, `SessionManager.automatedKeysBlocker`), so a `now` send is also refused while the target has a tool call with no end in its hook events, whose prompt the engine's `permission` state can have lost. The refusal names which. Every message this tool delivers is sent as automated keys, so the paste waits again before it writes and before each Enter until the session can take keys, and goes in between tool calls. A `now` send waits at most 30 s before it writes (`NOW_SEND_CLEARANCE_MS`), since it answers the sending agent's own call: a tool call that opened after the check fails the send as held rather than holding the sender's turn while the tool runs. A held `idle` send has nobody waiting on it and waits for as long as the target needs.
- An explicit `sessionId` naming a session in a **different project** is refused. Liveness is checked against the global PTY registry, so such a send would otherwise deliver while its provenance row silently vanished into the wrong project's database. Pass `project` naming the session's own project.
- Each target accepts at most 30 messages per rolling 5 minutes. A genuine orchestration hop costs the receiving agent a whole turn, so only a runaway loop approaches this.
- A steer chain deeper than 25 hops is refused as a loop. Depth is tracked server-side from the caller's session id rather than a tool parameter; it is deliberately not a low cap, because a legitimate A -> B -> C -> D -> E chain must work. The depth is one scalar per session (the most recent inbound hop), so two independent chains converging on one target overwrite each other's count - fine for a runaway backstop, but not an exact per-chain measure.
- Concurrent sends to one session are serialized, so two callers cannot interleave their pastes.

Every refusal comes back as a normal tool result with `isError: true` and text explaining what to do next.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (numeric display ID like `"42"` or full UUID). The message goes to that task's running agent, or is held for its next one. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). With `taskId` it must be that task's session; alone, it names the task through its session. |
| `message` | string | Yes | The message to deliver. Write it as a self-contained prompt: it lands in a session that cannot see your conversation. |
| `deliverWhen` | string | No | For a running agent only. `"now"` (default) delivers immediately, like a human typing mid-turn - a busy agent picks it up when its current turn ends. `"idle"` holds the message until the target finishes its turn. A held message ignores it. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

At least one of `taskId` and `sessionId` is required. Returns `status` (`"delivered"` or `"queued"`), the resolved `sessionId`, the target's `targetActivity` at send time, and the `hopDepth` of this steer chain. `"queued"` is returned only for `deliverWhen: "idle"` against a busy target; if the target is already idle, `"idle"` delivers immediately rather than waiting for a transition that would never come. A held message returns the "Held for task #N" text above instead.

## kangentic_get_session_messages_sent

Read the log of messages sent **into** a session by another agent via `kangentic_send_session_message`. This is the debugging counterpart to that tool: it answers "did my message actually go through?" for every attempt, including the ones that never produced a turn.

Provide either `taskId` or `sessionId` (not both). `taskId` returns messages across **all** of the task's sessions and the messages held for it, which is usually what you want - a task accumulates sessions across resumes and agent handoffs, and you should not have to work out which session was live at the time. A `sessionId` lists only what reached that session, so a message still held (no session yet) shows up only by task.

Each entry carries the caller (`caller_session_id`, `caller_task_id`, `caller_project_id` - all null for a human-driven send), the exact `message` text, a `status`, and an `error` for anything that did not land cleanly. See the `status` table under `kangentic_send_session_message` for what each value means; the short version is that `delivered`, `queued` and `delivered_from_hold` produced a turn, `refused` and `cleared` did not, `held` is still waiting, and `failed` is genuinely unknown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (numeric display ID or full UUID). Covers every session the task has had, and its held messages. Mutually exclusive with `sessionId`. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). Mutually exclusive with `taskId`. |
| `status` | string | No | Only return attempts with this status: `delivered`, `queued`, `refused`, `failed`, `held`, `delivered_from_hold`, or `cleared`. |
| `tail` | number | No | Return only the last N attempts (most recent). Default 100, hard cap 500. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

Returns `total` (matching the filter), `returned` (after `tail`), and the `messages` array. Note that a send naming a session id that was never real records nothing at all - see the foreign-key caveat above - so an empty result can also mean the target id was wrong.

## kangentic_mark_background_service

Mark background shells the calling agent started as services meant to keep running after its turn, such as a dev server or a watcher. A background shell keeps its task showing as working, and holds the column's On agent turn end automations, until it exits, because the agent may be waiting on it. A marked shell stops counting. It keeps running, and Kangentic still tracks it until it exits.

For Claude, Qwen, Gemini and Copilot, a post-tool hook names this tool beside every background launch whose command does not carry `--kangentic-no-activity-hold`, so the agent decides when it knows the answer. Grok, Kimi and Codex have no hook that can add to the model's context at a launch, so their agents learn of it from this description, which therefore says when to call it (as soon as a service starts in the background) and that `--kangentic-no-activity-hold` in the command does the same at launch. Whether a real model acts on the description alone was not measured: the probes ran against a scripted stand-in for each model API. See "Opting a background shell out of the hold" in [Background shells](../../architecture/activity/background-shells.md#opting-a-background-shell-out-of-the-hold), and [Background commands](../agents/background-commands.md#background-commands) for each agent.

The tool acts only on the session in the caller URL (`/mcp/<projectId>/<callerSessionId>`), so an agent can mark only its own shells. It is registered only for a connection that names a task's session whose agent reports its background commands (`AgentAdapter.backgroundCommands`, read onto the session row at spawn as `reportsBackgroundCommands`). An agent that does not report them never starts a hold, so a mark from it could only park an id. A Command Terminal, a client outside Kangentic, a workflow's own agent and a Knowledge Graph answer run never see it either. A call from a session that is no longer running changes nothing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `shellIds` | string[] | Yes | 1 to 10 background command ids, as the background command returned them: the shell, task or process id (letters, digits, `-` and `_`). |

Returns one line per id: `marked` (it was holding the session and no longer does), `already marked`, or not seen yet (Kangentic has not ingested the shell's start; the mark applies when it does, for up to 16 such ids per session).

## kangentic_get_session_files

Get the absolute paths to every per-session file: `events.jsonl` (activity log), `status.json` (usage/metrics), `settings.json`, `commands.jsonl` (MCP queue), `mcp.json`, the `responses/` directory, and the agent's native session history file (Claude JSONL, Codex JSONL, or Gemini JSON). Session directories are keyed by Kangentic PTY session id under `.kangentic/sessions/<id>/`. Each file entry includes an `exists` flag. Provide either `taskId` or `sessionId`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID. Picks the latest session for the task by default. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). |
| `sessionIndex` | number | No | When `taskId` is given, which session to pick: `0` = newest (default), `1` = previous, etc. Ordered `started_at DESC`. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

## kangentic_get_session_events

Read parsed events from a session's `events.jsonl` activity log without locating or opening the file yourself. Each line is a JSON event emitted by the Claude Code hook bridge (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`, etc.). Useful for idle-detection debugging, tracing tool usage, or replaying what an agent did. Provide either `taskId` or `sessionId`. Files over 1MB are read as a bounded tail window (the last 1MB): the response sets `truncated: true` and `totalBytes`, the `since`/`eventTypes` filters apply within the scanned window, and a huge file may therefore return fewer than `tail` matches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID. Picks the latest session by default. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). |
| `sessionIndex` | number | No | When `taskId` is given, which session to pick: `0` = newest (default). |
| `tail` | number | No | Return the last N matching events. Default 200, hard cap 2000. |
| `since` | number | No | Epoch milliseconds. Only return events with `timestamp >= since`. |
| `eventTypes` | string[] | No | Only return events whose `hook_event_name` or `type` is in this list (e.g. `["PreToolUse", "Stop", "Notification"]`). |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

## kangentic_get_activity_intervals

Read the durable activity-disposition history for a task or session: every span the agent spent `'active'` (working on its own) or `'idle'` (needing the user - covering both the `idle` and `permission` engine states) since Kangentic started tracking it. This SURVIVES app restarts and session end - it is written the moment the activity engine commits a transition, independent of the in-memory engine state and of `events.jsonl` (which records raw hook events, not committed transitions, and is not reliably retained). Use it to answer "how long has this task been waiting on me" or "how much of this session was the agent actually working vs blocked on approval/input". Provide either `taskId` (every session the task has ever accumulated - a resume creates a new session row) or `sessionId` (one session only).

Response shape:

- `intervals` - raw rows (`id`, `sessionId`, `taskId`, `disposition`, `state`, `previousState`, `enterTrigger`, `exitTrigger`, `startedMs`, `startedAt`, `endedMs`, `endedAt`, `durationMs`, `recordedAt`), oldest first. `startedAt`/`endedAt` are UTC ISO 8601 mirrors of `startedMs`/`endedMs` (stored, not computed on read) - `endedAt` is `null` exactly when `endedMs` is.
- `totals` - `{ activeMs, idleMs }`, summing `durationMs` across CLOSED intervals only.
- `openIntervals` - intervals still in progress (`durationMs` is `null` until closed), each with `startedAt` and a `liveElapsedMs` computed at read time so a still-parked task is not silently excluded from an elapsed-time answer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID. Returns intervals across every session the task has ever had. |
| `sessionId` | string | No | Kangentic session UUID (the `sessions.id` column). Returns intervals for that session only. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

## kangentic_reserve_dev_ports

Reserve free TCP ports before starting a dev server, so two agents working at the same time never
bind the same one.

Kangentic does not decide what a project's ports should be - the project already does, in
`angular.json`, a vite config, a compose file - so **nothing is reserved until something asks**.
What Kangentic can do that a project cannot is see every task and every project on the machine at
once. Reach for this only when the configured port might already be taken: several tasks sit in one
board column and run concurrently, and they all default to the same port.

Request every port you are about to bind in ONE call. A project needing an API and a frontend asks
for 2, because asking twice leaves a window where a sibling task takes the second. Each returned
port has been probed as genuinely free, not merely unclaimed. Fewer ports than requested means the
range ran out - fall back to the project's own configured ports for the rest.

Reservations persist for the life of the task, so a restart reuses the same ports. They are released
when the task (or its project) is deleted, and those are the only two release paths - nothing
reclaims in the background, so a range that fills up stays full.

The ledger spans every project in ONE Kangentic instance, not the machine: it lives in the global
database, whose path honours `KANGENTIC_DATA_DIR`, so a `/preview` keeps its own. The bind probe is
what holds across instances and against every other process on the machine.

The scan range is `devServer.portRangeStart` / `portRangeEnd` (default 7300-7499), chosen to miss the
common framework defaults - 3000, 4200, 4321, 5000, 5173, 8000, 8080.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | The task reserving the ports, as a display ID (`42` or `#42`) or a UUID. Defaults to the caller's own task. |
| `count` | number | No | How many ports to reserve (1-10). Default 1. Ask for all of them at once. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

Both port tools resolve `taskId` to the task's UUID before they touch the ledger
(`resolvePortTask`), since the ledger is keyed by UUID. Before task #952 a display ID was used as the
key as given, and reserved ports under a task that does not exist. With no `taskId`, the caller's own
task comes from the MCP request's caller segment, not from the parameters. A call from no task, or
from a task that is not in the target project, is refused with a line saying to pass `taskId`.

## kangentic_check_dev_ports

Report what Kangentic has reserved for a task **and** what the machine actually says about those
ports. Reserves nothing.

Every port reported is probed, because a reservation is a promise rather than a fact. Reading the
ledger alone is silent about the case that bites most often: a dev server the user started outside
Kangentic entirely, on a port the ledger never handed out. Pass `ports` to ask about specific
numbers - the ones a project's own config pins - which is the only way to learn that short of trying
to bind and failing.

Each port comes back with two fields, giving four answers:

| `reservation` | `listening` | Means |
|---|---|---|
| `this-task` | `true` | Yours, server already running |
| `this-task` | `false` | Yours, nothing on it - free to start |
| `other-task` | either | Another task holds it; reserve a different one |
| `null` | `true` | **In use outside Kangentic** - taken, though nothing reserved it |
| `null` | `false` | Genuinely free |

The other task is deliberately not named: a caller needs to know a port is spoken for, not whose it
is. An empty result is the normal state for a task using its project's own configured ports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | No | Task ID (display ID, `#N`, or UUID). Defaults to the caller's own task, resolved as for `kangentic_reserve_dev_ports`. |
| `ports` | number[] | No | Extra ports to check alongside the task's own reservations (at most 20). Each is probed. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. |

Returns `data.ports` (the task's own reservations, unchanged) and `data.statuses` (one
`{ port, reservation, listening }` row per port checked).
