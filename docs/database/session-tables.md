---
type: Reference
title: Session tables
description: Schema and invariants for sessions (status, suspended_by, PTY grid, tool_breakdown), usage_history per-leg cost deltas, transcript chunks, handoffs, session_messages_sent, the conversation_turn_usage and turn_spawn_links token ledger, session_activity_intervals, and command_terminal_history.
tags: [database, schema, sessions, usage]
sources:
  - resource: src/main/db/migrations/project-schema.ts
    title: session, usage and ledger tables
  - resource: src/main/db/repositories/sent-session-message-repository.ts
  - resource: src/main/held-messages/held-messages.ts
    title: held messages, the log's held rows
  - resource: src/main/retrieval/conversation/conversation-usage-store.ts
  - resource: src/main/activity-engine/activity-interval-store.ts
  - resource: src/main/pty/buffer/transcript-writer.ts
  - resource: src/main/db/repositories/command-terminal-history-repository.ts
  - resource: src/main/ipc/helpers/command-terminal-history.ts
---
# Session tables

## sessions table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks | |
| session_type | TEXT | NOT NULL | |
| agent_session_id | TEXT | | NULL |
| isolated_swimlane_id | TEXT | | NULL |
| command | TEXT | NOT NULL | |
| cwd | TEXT | NOT NULL | |
| permission_mode | TEXT | | NULL |
| prompt | TEXT | | NULL |
| status | TEXT | NOT NULL | 'running' |
| exit_code | INTEGER | | NULL |
| started_at | TEXT | NOT NULL | |
| suspended_at | TEXT | | NULL |
| exited_at | TEXT | | NULL |
| suspended_by | TEXT | | NULL |
| total_cost_usd | REAL | | NULL |
| total_input_tokens | INTEGER | | NULL |
| total_output_tokens | INTEGER | | NULL |
| model_id | TEXT | | NULL |
| model_display_name | TEXT | | NULL |
| applied_model | TEXT | | NULL |
| applied_effort | TEXT | | NULL |
| total_duration_ms | INTEGER | | NULL |
| tool_call_count | INTEGER | | NULL |
| lines_added | INTEGER | | NULL |
| lines_removed | INTEGER | | NULL |
| files_changed | INTEGER | | NULL |
| tool_breakdown | TEXT | | NULL |
| compaction_count | INTEGER | NOT NULL | 0 |
| last_pty_cols | INTEGER | | NULL |
| last_pty_rows | INTEGER | | NULL |
| result_tokens_read_at | TEXT | | NULL |
| transcript_path | TEXT | | NULL |
| cli_target | TEXT | | NULL |

`transcript_path` is the transcript file the agent reported, written from its status line when it changes. A new row for a conversation that already has one inherits the newest reported path of the same `agent_session_id` at insert (`SessionRepository.insert`), because a resumed Claude conversation keeps writing the file it started in.

Valid session_type values: `claude_agent`, `codex_agent`, `gemini_agent`, `qwen_agent`, `aider_agent`, `cursor_agent`, `copilot_agent`, `warp_agent`, `kimi_agent`, `opencode_agent`, `droid_agent`, `ollama_agent`, `grok_agent`, `antigravity_agent`, `goose_agent`, `run_script`.

Valid status values: `running`, `queued`, `suspended`, `exited`, `orphaned`.

Valid suspended_by values: `user` (an explicit pause: the desktop Pause button or a paired phone's `pause-session`), `auto` (Kangentic paused an agent that was waiting on the user: the idle timeout, or the low-memory pause), `system` (shutdown, task move, or a column/Board Profile edit turning `auto_spawn` off via `reconcileAutoSpawnChange`), or `NULL` (legacy records, treated as `system`). `user` and `auto` are held pauses (`isHeldPause`, `src/shared/held-pause.ts`): neither a restart nor an auto-spawn column starts the task again until the user resumes it. The column is TEXT with no CHECK constraint, so `auto` needed no migration.

`total_cost_usd` and `total_duration_ms` are the agent's RUNNING totals for the whole conversation, and a `--resume` is a new row, so a task's rows must never be summed flat (the same trap the `usage_history` section below describes). Every summary read (`getSummaryForTask`, `listAllSummaries`, and `BOARD_TASK_FACTS_SQL` in `src/main/retrieval/board-task-facts.ts`) takes one value per conversation (`COALESCE(agent_session_id, id)`), its `MAX`, and adds the conversations: on one dogfooding task, $47.58 where the flat sum read $75.46. Tokens come from each conversation's latest costed row that reported tokens: a row with a cost and no tokens is no reading, so it never zeroes the conversation. A task with no token reading at all reads 0 in the summary and null in the board facts. Tool calls and compactions are per-run counters and sum. Churn reads every row of the task, costed or not. A run's own share (the completed task view's Runs table, `kangentic_list_sessions`) is `legDeltas` in `src/shared/leg-deltas.ts`, which skips a row with no reading as a baseline, so an empty row between two legs cannot book the next leg's whole running total.

`isolated_swimlane_id`: NULL = the task's main session; a swimlane id = the separate, context-isolated session belonging to that `isolated`-strategy column. Lets one task hold multiple independently-resumable sessions (see [Isolated Sessions](../architecture/sessions/spawn-flow.md#isolated-sessions-per-column-session-model)).

Valid permission_mode values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto` (see `PermissionMode` type in `src/shared/types.ts`).

`tool_breakdown` is JSON-encoded `PerToolStat[]` (see `src/shared/types.ts`). One entry per distinct tool name with `callCount`, `totalDurationMs`, `interruptedCount`, optional `costUsd` / `inputTokens` / `outputTokens` when the adapter emits per-tool telemetry on `tool_end` events, and an optional `resultTokens` estimate (the size of the tool's results in the main conversation, from the agent's transcript; not billed tokens). `totalDurationMs` pairs each end with its own start by `toolId`, falling back to FIFO by tool name only for events without one. It is run time only: a call that paused for the user's answer or approval is counted but its time is left out, and the optional `waitedCount` says how many such calls the row has. A permission prompt (an `idle` event with `detail: permission`) is credited to the most recently started call still running in the current turn, the same call the activity engine records as `permissionAwaitedToolId`. Nothing marks the moment the user answers, so a waited call's time cannot be split into waiting and running. Rows saved before that pairing are corrected once from their event logs (see [`schema_meta`](board-tables.md#schema_meta-table)), `waitedCount` included. NULL on records captured before the column existed and on records whose session produced no tool events. Written by `captureSessionMetrics` from `UsageAccumulator` (`src/main/activity-engine/usage-accumulator.ts`), which pairs `tool_start` / `tool_end` timestamps in a per-session aggregator and is tracked independently of the bounded event cache so totals are not truncated for long sessions. A second, fire-and-forget writer, `SessionRepository.updateTranscriptToolCounts` (invoked via `refineTranscriptToolCounts` in `session-metrics.ts`, mirroring the [token refinement](../integrations/agents/session-history.md#claude)), backfills `tool_call_count` / `tool_breakdown` from the agent's own transcript when the live `UsageAccumulator` count is NULL or 0 (e.g. a parked/suspended session whose `tool_start` / `tool_end` hook events never reached the accumulator) - it never overwrites a nonzero live count, since the live count carries real durations and an interrupted tally the transcript-derived breakdown cannot. Over a nonzero live count it merges only the transcript's per-tool `resultTokens` onto the live entries, matched by tool name. For Claude both read only the calls made since the session's own start, because its transcript holds every `--resume` of the conversation while a record covers one run. Grok and Antigravity cannot scope their transcript reads, so their empty-count backfill counts the whole transcript and runs only for a conversation's first run (see below), and they supply no `resultTokens`. The run-end backfill also closes its window at the moment the run ended, so a resume that follows at once cannot add the next run's calls to this record.

Each record's `tool_call_count` and `tool_breakdown` hold its own run only, and nothing writes a total back. Every resume is a new record, so the two readers that want a total merge at read time with `mergeToolBreakdowns` (`src/shared/tool-call-totals.ts`), which sums each tool's fields by name. The context bar's tool-call count and popover cover the session's track: the records of the same `task_id` and `isolated_swimlane_id`, any agent, the live record excluded by id and replaced by the live accumulator (`SessionRepository.getEarlierRunToolTotals`). The completed task view's Total covers every record its own `tool_call_count` sums, and each run in its Runs table shows its record's own rows. A run that ended at app quit has no `resultTokens`, because the run-end backfill never runs on the synchronous quit path. When a later run of the track spawns, `fillEarlierRunResultTokens` (`session-metrics.ts`) reads each such record's estimates from its own transcript window, from its `started_at` to the next run's start, and writes only `resultTokens`. It reads only agents that declare `scopesTranscriptReadsByTime`, and looks for the transcript under the record's own `cwd`, then under later runs' cwds of the same conversation, since resuming in a renamed worktree moves the history. A read that answered but left the record nothing to keep stamps `result_tokens_read_at` (UTC ISO), so that transcript is not parsed again on every launch; a transcript found under no cwd is looked for once per launch; a read that failed is tried again once 10 seconds have passed (`FAILED_FILL_RETRY_MS`), since the popover reads on every tool call. The spawn queues its fill behind other background transcript reads. The popover's read shares a fill that is reading or done, but a queued fill that has not started is overtaken: the popover reads that window at once, and the queued fill stands down when its turn comes. The run-end count backfill has the same scoping limit: for an agent without the flag it reads only a conversation's first run, because its whole-transcript count would include the earlier runs (`SessionRepository.hasEarlierRecordOfConversation`). Rows written before that rule may still carry such an inflated count.

`transcript_path`: the transcript path the agent reported for the session (Claude's status line), written by `SessionRepository.setTranscriptPath` from the session manager's `usage` event whenever it changes (`ipc/handlers/session-transcript-path.ts`), never per status tick. The resume check (`assessResumeConversation`, see `docs/architecture/sessions/resume.md`) reads it to prove a conversation's file is gone after a quit or a removal deleted the session's own folder. NULL when the agent never reported one; there is no backfill, since the check reads a surviving session folder as its fallback.

`cli_target`: where the session's agent CLI ran when it was not this machine, as JSON (`StoredCliTarget`), for a CLI installed in a WSL distro and configured by its `\\wsl.localhost\...` path: the distro, its home as Linux and share paths (`homeLinux`, `homeUnc`), the share root (`uncRoot`), the agent home overrides its shell sets (`env`, only the `WSL_ENV_KEYS` names such as `CODEX_HOME`, never the rest of the distro's environment), and the CLI's own path as the distro sees it (`linuxCliPath`, an absolute Linux path or nothing), for a reader that asks the CLI itself after the session (OpenCode, whose distro database a share cannot read safely; `targetOfPlace`). Written once at insert by the spawn paths (`serializeCliTarget`, `src/main/agent/shared/cli-target.ts`) and read back with `parseStoredCliTarget`, which reads anything it does not recognize as this machine. That distro holds the session's transcripts and leftover processes after it ends, and every reader finds them from this column with no call into the distro (`placeOfRecord`): the Conversation viewer, the index and archive in the retrieval worker, the MCP transcript tools, the resume check, and the metrics backfill. Reading a stopped distro's share starts the distro, so the readers nobody asked for (the index and archive walks, the Command Terminal's Earlier list) skip a row whose distro is stopped (`mayReadPlaceUnattended`) and read it on a later pass. NULL for this machine, which every row before the column is.

`last_pty_cols` / `last_pty_rows`: the PTY grid the session last had, its spawn grid and then every applied resize except a phone's (a phone-held grid is the size guard's to give back). Written by `SessionRepository.updatePtyGrid` from the session manager's `pty-resize` event (`ipc/handlers/session-grid-persistence.ts`), at each change rather than at suspend, so an OS kill keeps it too and the synchronous quit path writes nothing. Read back as `SpawnSessionInput.restoredGrid` when the session is resumed with no in-memory predecessor to take a grid from: startup recovery after a desktop restart, a pty host crash, or a Resume or move after a restart (through the spawn intent of the record it retires). A grid under 20 rows is not restored. NULL = never recorded.

Indexes: `idx_sessions_task_started` on (task_id, started_at DESC), `idx_sessions_task_type_isolation_started` on (task_id, session_type, isolated_swimlane_id, started_at DESC) (the resume-decision hot path for per-column isolated sessions), `idx_sessions_status` on (status), `idx_sessions_agent_session_id` on (agent_session_id).

## usage_history table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| session_record_id | TEXT | NOT NULL UNIQUE | |
| recorded_at | TEXT | NOT NULL | |
| session_started_at | TEXT | NOT NULL | |
| session_type | TEXT | | NULL |
| conversation_id | TEXT | | NULL |
| cumulative_cost_usd | REAL | | NULL |
| cumulative_duration_ms | INTEGER | | NULL |
| total_cost_usd | REAL | NOT NULL | |
| total_input_tokens | INTEGER | NOT NULL | 0 |
| total_output_tokens | INTEGER | NOT NULL | 0 |
| total_duration_ms | INTEGER | | NULL |
| tool_call_count | INTEGER | NOT NULL | 0 |
| model_id | TEXT | | NULL |
| model_display_name | TEXT | | NULL |
| lines_added | INTEGER | NOT NULL | 0 |
| lines_removed | INTEGER | NOT NULL | 0 |
| files_changed | INTEGER | NOT NULL | 0 |
| compaction_count | INTEGER | NOT NULL | 0 |
| agent | TEXT | | NULL |
| effort | TEXT | | NULL |

Indexes: `idx_usage_history_session_started_at` on (session_started_at), `idx_usage_history_recorded_at` on (recorded_at), `idx_usage_history_conversation` on (conversation_id, session_started_at) for the per-leg baseline lookup.

Append-only ledger of finalized session usage. Decoupled from `sessions` and `tasks`: rows have no foreign keys, so they survive task deletion, bulk-archive cleanup, and revert-to-backlog. The usage dashboard's period totals (Live/Today/Week/Month/All Time), cost-per-day series, and by-model / by-agent / by-effort breakdowns read from this table via `USAGE_GET_DASHBOARD_STATS` (and the `kangentic_get_usage_stats` MCP tool) so cost totals reflect every session ever finalized on the project, not just the ones whose source task still exists.

**Cost and duration are PER-LEG DELTAS; `cumulative_*` are the raw readings and must never be summed.** The agent reports `total_cost_usd` and `total_duration_ms` as running totals for the whole CONVERSATION, and a `--resume` is a new `sessions` row and therefore a new row here, so a flat `SUM` counted the running total once per leg. Measured on the dogfooding install: $113,948 against $50,580, and one lineage carried the identical $22.16 across about 20 consecutive rows with 0 tool calls each. `conversation_id` is the session's `agent_session_id`, which tracks CLI forks (both the resume-time reconcile and the stale-ID recovery persist the agent-reported id), so a `/clear` starts a new lineage whose first leg counts in full. A NULL `conversation_id` (a row whose `sessions` row was deleted) is its own lineage and keeps its reading.

The other summed columns were audited against the same ledger and are safe: `tool_call_count` and `compaction_count` are per-leg counters, the three git-churn columns are already held to one non-zero row per task by `setTaskGitStats`, and the token columns are per-capture snapshots (they sum without double-counting, but the sum is not a token count). The per-column evidence is on the `UsageHistoryRepository` class docblock; re-run that audit before adding a summed column.

`costKnownCount` is the one read that deliberately does NOT use the summable column: it counts rows whose `cumulative_cost_usd` is above zero, because a resume leg that did no work has a real reading and a zero delta, and 539 of 2,434 rows on the dogfooding install are exactly that. Counting the delta would let a window of only such legs claim no agent reported any cost.

`LINEAGE_DELTA_SET_SQL` in `usage-history-repository.ts` is the single definition of a delta, used by both the backfill migration and `recordSessionUsage`. The write path recomputes this leg AND every later leg of the lineage rather than deriving one delta, which is what keeps `SUM(total_cost_usd) == MAX(cumulative_cost_usd)` per lineage true even when the shutdown sweep re-captures an older leg after its successors already stored deltas. This mirrors the `setTaskGitStats` canonical-record invariant for branch-cumulative git churn, applied to a conversation lineage instead of a task lineage.

**The token columns are NOT a token count.** They hold the status line's `context_window` totals, which Claude Code 2.1.132+ reports as CURRENT CONTEXT OCCUPANCY, so summing them across sessions yields the sum of each session's last context size. The dashboard's token figures read `conversation_turn_usage` instead; these columns survive for the live-overlay baseline (`sumSessionsRepresented`) and the footer parity the snapshot semantics were chosen for.

`agent` records which agent (claude, codex, gemini, ...) ran the session, stamped generically from the session manager's recorded agent name at capture time; a one-shot migration backfills it from surviving `sessions` -> `tasks.agent` joins, and rows whose task was already deleted stay NULL (rendered as "(unknown)").

`effort` records the session's last-applied `--effort` value, stamped at capture time from `sessions.applied_effort` (the spawn/resume ground truth); a one-shot migration backfills it from surviving session rows. NULL means agent default (no flag) - a real bucket rendered as "(default)", not missing data. A session that switches effort mid-run attributes all of its usage to the final value (the same snapshot semantics as `model_id`).

`session_record_id` is the `sessions.id` of the row this entry mirrors. The UNIQUE constraint plus an `ON CONFLICT(session_record_id) DO UPDATE` clause in `recordSessionUsage` makes capture idempotent: re-capturing the same record at suspend AND again at app shutdown updates the existing row instead of producing duplicates. Git stat columns (`lines_added`, `lines_removed`, `files_changed`) are intentionally excluded from the UPSERT's `DO UPDATE SET` clause because they are owned by `setTaskGitStats`, which runs separately after `captureGitChurn` finishes its `git diff` against the base branch (fired on every session finalization, not just move-to-Done).

`session_started_at` is used for period bucketing (`WHERE session_started_at >= ?`) so "Today" means "session started today", not "metrics flushed today" - the difference matters for sessions that finalize across midnight. Written by `captureSessionMetrics` whenever `usage` is defined (i.e. metrics were actually captured). Cost = 0 with non-zero tokens is the Claude subscription-user case (Plus/Max) and IS recorded; the gate is `if (usage)`, not `cost > 0`. The migration backfills existing `sessions` rows with `total_cost_usd IS NOT NULL` so installs upgrading to this version do not lose their lifetime totals.

TypeScript types: `UsageDashboardStats` / `UsageKpis` (the composite read shape) in `src/shared/types.ts`. Repository: `UsageHistoryRepository` in `src/main/db/repositories/usage-history-repository.ts`; the aggregation itself lives in `src/main/usage-stats/` (`usageStatsService` + pure bucketing math), shared by the IPC handler and the MCP tool.

## session_transcript_chunks table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| session_id | TEXT | NOT NULL, PRIMARY KEY (session_id, seq) | |
| seq | INTEGER | NOT NULL | |
| chars | INTEGER | NOT NULL | |
| bytes | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |
| text | TEXT | NOT NULL | |

A session's raw terminal transcript as ordered pieces, one row per flush. The `TranscriptWriter` in `src/main/pty/buffer/transcript-writer.ts` strips ANSI escape sequences from PTY output and flushes every 30 seconds, early once a session's pending buffer exceeds 64KB, each flush one INSERT of the next `seq`. Each session writes to its own project's database, read from the session registry on its first output, so a background project's live session no longer writes into the focused project's database. `text` is the last column, so the size and count reads behind a tail never touch its overflow pages. Transcripts are kept whole and never trimmed, and outlive their session row: agent CLIs clean up their own session files, so this is Kangentic's durable copy of what the terminal showed. Raw `kangentic_get_transcript` by session id still reaches one whose session row is gone. A live flush never takes a `seq` below 0, which is where a legacy conversion writes. Command Terminal sessions keep no transcript.

## session_transcripts table (legacy)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| session_id | TEXT | PRIMARY KEY | |
| transcript | TEXT | NOT NULL | '' |
| size_bytes | INTEGER | NOT NULL | 0 |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

The old store, one growing value per session, rewritten whole on every flush (127 to 164 ms for a 19 MB transcript). Nothing writes it now. The retrieval worker converts its rows into pieces at each project open (`transcripts.convertLegacy`), one session at a time in 64 KB pieces with negative `seq` (ahead of anything written since), deleting each legacy row once its pieces are in. That delete frees the row's whole overflow chain in one transaction and cannot be split (emptying the value first frees the same chain): 14 ms for a 19 MB row in the preview, 8 ms at 5 MB, 3 ms at 1 MB. It is the one worker write allowed past the 5 ms target, once per large row per install. Progress per session is kept in `memory_meta` (`transcript_legacy:<projectId>:<sessionId>`), so a conversion cut short resumes without writing a piece twice. A row whose session is in another project's database (misfiled while one writer followed the focused project) moves to that project; one whose session is in no project stays where it is. Until converted, a row reads as the oldest part of its session's transcript, and the pieces its conversion has written so far are left out of every read, so no text is read twice: they are the ones below seq 0 stamped with the row's own `created_at` or `updated_at`. Its delete trigger on `sessions` is dropped, so a legacy row too outlives its session.

## handoffs table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| from_session_id | TEXT | FK->sessions ON DELETE SET NULL | |
| to_session_id | TEXT | FK->sessions ON DELETE SET NULL | |
| from_agent | TEXT | NOT NULL | |
| to_agent | TEXT | NOT NULL | |
| trigger | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |
| session_history_path | TEXT | | |

Index: `idx_handoffs_task_id` on (task_id).

Handoffs pass session context through `session_history_path`, a pointer to the source agent's native session history file. A database created before [migration 95](migrations.md) also had `packet_json`, the context packet handoffs carried before that. It stayed `NOT NULL` after the repository stopped writing it, so every handoff insert failed until migration 95 dropped it.

TypeScript type: `HandoffRecord` in `src/shared/types.ts`. Repository: `HandoffRepository` in `src/main/db/repositories/handoff-repository.ts`.

## session_messages_sent table

Provenance for messages sent into a session via `kangentic_send_session_message` (see [Session tools](../integrations/mcp-server/session-tools.md#kangentic_send_session_message)) - by another agent, or by a human steering that session directly. The delivered message carries no in-band marker, so these rows are the only record that a turn arrived through the tool rather than being typed at the keyboard. It also holds the messages held for a task whose agent is not running ([Held messages](../architecture/sessions/held-messages.md)): the row is the hold itself.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| session_id | TEXT | FK->sessions ON DELETE CASCADE | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| caller_session_id | TEXT | | NULL |
| caller_task_id | TEXT | | NULL |
| caller_project_id | TEXT | | NULL |
| message | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | |
| error | TEXT | | NULL |
| created_at | TEXT | NOT NULL | |

Indexes: `idx_session_messages_sent_session_id` on (session_id), `idx_session_messages_sent_task_status` on (task_id, status).

`session_id` is the session that RECEIVED the message, and `task_id` is the task it was for. `status` is one of `delivered`, `queued` (both produced a turn), `refused` (a guard rejected it), `failed` (delivery threw; whether a turn landed is unknown), or, for a message held for a task with no running agent, `held`, `delivered_from_hold` (a turn, with the session that got it) and `cleared` - so a row exists for every attempt, not just the successes. `error` carries the refusal or failure detail and is NULL on success.

A held message is one row whose status moves on once. It reads `held` with a NULL `session_id` while it waits: the task may have no session at all, and a To Do move deletes the task's sessions, which would cascade a session-keyed row away. It then becomes `delivered_from_hold` with the session that got it, `cleared` when the task moved to Done or To Do first, or `failed` when its delivery began and did not finish. Every one of those writes is a compare-and-swap on `status = 'held'`, so a clear that ran first is never undone by a delivery that settles later. A deleted task, a Backlog demote and a move to another project take every row of the task with them (`TaskRepository.delete` deletes them, and `task_id` cascades).

The three `caller_*` columns are deliberately NOT foreign keys: a cross-project steer originates in a different project's database, so those ids are unresolvable locally. They are NULL for a human-driven caller with no Kangentic session.

`message` is stored as the caller supplied it, which is how a consumer correlates it to the transcript turn it produced. The delivered text is byte-identical for ordinary prose; the paste path additionally collapses CR/CRLF to LF and strips C0 control characters, so a message carrying those differs from the stored row by exactly that normalization. Reconstructing "which turns arrived this way" means filtering to `delivered` / `queued` / `delivered_from_hold`. A held message reaches its agent inside an opening message, after the column's own and numbered when there are several, so its turn holds more than the stored text.

TypeScript type: `SentSessionMessage` in `src/shared/types.ts`. Repository: `SentSessionMessageRepository` in `src/main/db/repositories/sent-session-message-repository.ts`.

## conversation_turn_usage table

Durable per-turn token-usage ledger. One row per assistant turn that reported usage, written by `ConversationIndexer` from the parsed transcript at index time so it persists after the agent prunes its native JSONL (unlike the in-transcript `usage` field, which is re-derived on each parse). Counts are kept as raw components so cost analysis can weight fresh input against the cheaper cache reads. Read via `ConversationUsageStore` (`getForTask` / `getForSession` / `getForTurns`, plus `getGroupedUsageSince`, the UTC-bucketed project-wide read behind the usage dashboard's burn-rate and token-trend charts and the Tokens view's by-model bars - 5-minute buckets for the Live period, 15-minute otherwise; each row carries a SQL-computed `allocatedCostUsd` (per-turn shares of each owning session's `usage_history` cost), windowed by the same `session_started_at` bounds the dashboard's other reads use). `getGroupedUsageSince` returns one row per bucket and turn model, so its payload is O(active bucket and model pairs) rather than O(sessions x buckets). The by-model bars fold from those same rows, so they sum to the token series with no second scan. All four are main-thread only (`subagent_id IS NULL`); `getSubagentTotalsByType` and `getTaskFanOuts` read the subagent rows. A seventh, `getEarliestTurnMs`, is filtered by NEITHER session nor subagent (`SELECT MIN(ts) ... WHERE ts IS NOT NULL`): it answers how far back per-turn capture reaches at all, which the dashboard and `kangentic_get_usage_stats` surface as `earliestTurnMs` so a range starting before that can say its token coverage is shorter than its cost coverage. See "Main-thread and subagent rows" below. Of the main-thread four, only `getGroupedUsageSince` has a production caller today (the dashboard); `getForTask` / `getForSession` / `getForTurns` are the read API a conversation view would use and are currently exercised by tests only.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| turn_uuid | TEXT | PRIMARY KEY | |
| agent_session_id | TEXT | | NULL |
| session_id | TEXT | | NULL |
| task_id | TEXT | | NULL |
| model | TEXT | | NULL |
| ts | INTEGER | | NULL |
| input_tokens | INTEGER | NOT NULL | 0 |
| output_tokens | INTEGER | NOT NULL | 0 |
| cache_creation_input_tokens | INTEGER | NOT NULL | 0 |
| cache_read_input_tokens | INTEGER | NOT NULL | 0 |
| recorded_at | TEXT | NOT NULL | |
| subagent_id | TEXT | | NULL |
| agent_type | TEXT | | NULL |
| spawn_depth | INTEGER | | NULL |
| parent_tool_use_id | TEXT | | NULL |

Keyed by `turn_uuid` because a `--resume` replays its parent's turns verbatim under the same uuid; the PK dedups a replayed turn back onto one row so per-task / per-project totals never double-count a shared turn. That PK is the second of two guards, not the only one: an agent reports one API message's tokens on several transcript LINES, each with its own uuid, so the adapter attributes that usage to one line per `message.id` before any row is produced (see `parseTranscriptWindow` in [Optional adapter properties](../integrations/agents/optional-properties.md)). Two lines of one message would otherwise reach this table under two different keys, which the PK cannot collapse. Indices: `idx_turn_usage_task` (task_id), `idx_turn_usage_session` (session_id), `idx_turn_usage_ts` (ts), `idx_turn_usage_agent_type` (agent_type, ts), and `idx_turn_usage_main_session` (session_id, ts, input_tokens, output_tokens) partial on `subagent_id IS NULL`, which covers the two per-session main-thread rollups the dashboard runs on every load. Deliberately has NO `sessions` DELETE cascade, and the record sweep that purges a deleted session's `memory_chunks` leaves it alone: it is a durable ledger, not a rebuildable index, so token history outlives the session rows it describes.

### Main-thread and subagent rows

`subagent_id` is the discriminator. It is NULL for a main-thread (driver) turn and set for a turn a Task-tool subagent ran, along with `agent_type` (`review-finder`, `test-builder`, `Explore`, ...), `spawn_depth`, and `parent_tool_use_id` (the tool-use id of the call that spawned it). Every row written before subagent capture existed is a main-thread turn, so NULL is also the right historical value.

`parent_tool_use_id` is NOT a key of this table, and it does not always point at a main-thread row. It names a tool call, which `turn_spawn_links` maps to the turn that emitted it: a main-thread turn at depth 1, another subagent's turn deeper. Resolving a nested subagent to the fan-out that ultimately caused it therefore takes a walk, not a join, which is what `getTaskFanOuts` does.

Every driver-facing reader spells `subagent_id IS NULL`: `getForTask`, `getForSession`, `getForTurns`, and `getGroupedUsageSince`. In `getGroupedUsageSince` the clause appears in BOTH the outer aggregate and the `session_tokens` CTE, because that CTE is the denominator of the per-turn cost allocation: filtering only the outer query leaves every token count correct while silently redistributing a session's cost into the subagents' time buckets. The CTE also stays grouped by session alone while the outer query groups by bucket and model, so a session that switches model splits its cost by each model's share of the session's tokens. Two readers want the other set (`subagent_id IS NOT NULL`), and neither reports cost, because `usage_history.total_cost_usd` already covers the whole session tree and pricing these tokens again would double count. `getSubagentTotalsByType` groups by `agent_type` and carries the depth aggregates (`nestedTurnCount`, `nestedSubagentCount`, `maxSpawnDepth`, all computed from `spawn_depth` with no join, so they work on every historical row). `getTaskFanOuts` groups one task's subagent turns by the DRIVER TURN that started each fan-out, which the per-type rollup cannot express: a `/code-review` task spawns the same `review-finder` type from several different turns.

Subagents whose parent does not resolve are returned by `getTaskFanOuts` under a null driver rather than dropped. Links only exist for sessions indexed since `turn_spawn_links` shipped, so on an older task that bucket is everything; omitting it would make the fan-out rows disagree with the per-type totals over the same task.

### turn_spawn_links table

The other half of `parent_tool_use_id`. One row per subagent-spawning tool call, mapping that call's id to the turn that emitted it.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| tool_use_id | TEXT | PRIMARY KEY | |
| turn_uuid | TEXT | NOT NULL | |
| recorded_at | TEXT | NOT NULL | |

Index: `idx_turn_spawn_links_turn` (turn_uuid), which serves the reverse direction (given a driver turn, which spawns did it make); the forward direction rides the primary key. No `sessions` DELETE cascade, for the same reason the ledger it serves has none.

Deliberately minimal: `turn_uuid` joins straight back to `conversation_turn_usage`, which already carries `session_id` / `task_id` / `ts`, so denormalizing them here would only create a second copy to keep in sync. Rows are written by whichever parser saw the emitting turn - the main transcript for a depth-1 spawn, the subagent transcript for a deeper one - which is what lets a nested subagent resolve to the subagent that spawned it rather than only to a depth number.

Which tool counts as a spawn is the adapter's `subagentSpawnToolName` (Claude: `Task`), not a literal in the retrieval layer. Filtering on it is what keeps the table small: a session emits thousands of tool-use ids and only the spawning ones are ever referenced.

Links are collected INDEPENDENTLY of the usage fold in both parsers. Each drops turns before they reach the ledger (the main path skips an entry with no `usage`; the subagent path skips a message group whose four counts are all zero), and a link lost to either filter is lost for good, because a re-walk drops it identically and that subtree becomes permanently unattributable. Tokens are recoverable; this is not.

Subagent rows are written by `ConversationIndexer.indexSubagentUsage` from the Claude adapter's `parseSubagentUsage`, which reads `~/.claude/projects/<slug>/<agentSessionId>/subagents/agent-<id>.jsonl` plus its `.meta.json` sidecar. That walk has its own `memory_index_state` row (doc id `<agentSessionId>#subagents`) because a running subagent moves no byte of the main transcript, and it runs on session finalize and the project-open sweep only, never on the live turn-boundary re-index. A `turn_uuid` there is `sub:<subagentId>:<message.id>` - stable across re-walks and disjoint from the main path's JSONL record uuids. Usage is folded field-wise max per `message.id`, not first-record-wins: subagent transcripts re-emit a message as its output grows, and taking the first record undercounts output by about 30%.

Module: `src/main/retrieval/` (store `RetrievalStore`, usage ledger `ConversationUsageStore`, indexer `ConversationIndexer`, service `retrievalService`, query `searchConversationMemory`); the Knowledge Graph's projection lives in `src/main/retrieval/graph/` (`projection-math.ts`, `neighbor-edges.ts`, `coverage-aggregate.ts`, `cluster-labels.ts`, `projection-engine.ts`, `graph-service.ts`). Ask's prompt is built by `related-work.ts` (the related set, rolled up per task from deep semantic and keyword pools), `answer-tasks.ts` (the complete task table), and `answer-prompt.ts` (the rules, and the `SELECTED:` line parsed back out of the reply). The task table's columns are declared once in `src/shared/knowledge-graph-task-fields.ts` and generate the prompt header, its glossary, and its summary.

## session_activity_intervals table

Durable activity-disposition ledger. One row per continuous span a session spent in one `ActivityDisposition` bucket - `'idle'` (needing the user, covering both the `idle` and `permission` activity states) or `'active'` (the agent working on its own, the `thinking` state); see `dispositionOf` in `src/shared/activity-state.ts`. Written the moment the activity engine commits a disposition-changing transition, so it survives the engine's own in-memory state (wiped on `deleteSession`/dispose) and is faithful where `events.jsonl` is not (that file logs raw hook events, not committed transitions, and is not reliably retained). Symmetric by design: both dispositions are recorded directly, so "active time" and "idle time" are each a straight SUM rather than an inverse requiring session-boundary reconciliation.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| session_id | TEXT | NOT NULL | |
| task_id | TEXT | | NULL |
| disposition | TEXT | NOT NULL | |
| state | TEXT | NOT NULL | |
| previous_state | TEXT | NOT NULL | |
| enter_trigger | TEXT | NOT NULL | |
| started_ms | INTEGER | NOT NULL | |
| started_at | TEXT | NOT NULL | |
| ended_ms | INTEGER | | NULL |
| ended_at | TEXT | | NULL |
| duration_ms | INTEGER | | NULL |
| exit_trigger | TEXT | | NULL |
| recorded_at | TEXT | NOT NULL | |

One row per INTERVAL, not per transition: a `permission` to `idle` crossing stays inside the same `'idle'`-disposition interval, so nothing closes and reopens. `enter_trigger` / `exit_trigger` carry the engine's own `TransitionTrigger` labels, so a consumer can tell a hook-authoritative park (`event:idle`) from a watchdog guess (`timer:stale-thinking`), and a genuine human reply (`event:prompt`) from the agent resuming itself (`event:prompt:pty-activity`). `started_at` / `ended_at` are TEXT UTC ISO 8601 mirrors of `started_ms` / `ended_ms`, written by the store from the same value so the two representations cannot drift; `ended_at` is NULL exactly when `ended_ms` is (the interval is still open). Indices: `idx_activity_intervals_task` (task_id), `idx_activity_intervals_session` (session_id), `idx_activity_intervals_started` (started_ms), `idx_activity_intervals_open` (session_id, ended_ms - resolves the one open interval per session without holding row ids across a restart). Deliberately has NO `sessions` DELETE cascade, for the same reason as `conversation_turn_usage`: it is a durable ledger, so an interval outlives the session row that produced it. Both ordinary ends close the open interval: the PTY's `exit`, and `session-removed` for a direct `SessionManager.remove()`, which deletes the registry row synchronously and so lands before that exit can resolve a project (see [Suspend and cleanup](../architecture/sessions/suspend-and-cleanup.md)). Only an abrupt end that fires neither, an app crash or an OS kill, leaves an interval permanently open; consumers filter `ended_ms IS NOT NULL`.

Module: `src/main/activity-engine/` (store `ActivityIntervalStore`, recorder `ActivityIntervalRecorder`). Read directly via the `kangentic_get_activity_intervals` MCP tool (see [Session tools](../integrations/mcp-server/session-tools.md#kangentic_get_activity_intervals)) or `kangentic_query_db`, and indirectly by the usage dashboard: `getActiveTotals` sums this ledger behind `usage:getDashboardStats`, backing the `activeMs` / `activeSessionsCovered` KPI pair and the per-project Avg Active column. See [Activity engine](../architecture/activity/activity-engine.md#durable-activity-interval-history), which owns this ledger.

## command_terminal_history table

The conversations a project's Command Terminals held, so the Command Terminal panel's Earlier list (and a resume) can offer one back after its terminal ended. A Command Terminal has no `sessions` row, whose `task_id` is a foreign key to tasks, and its registry row goes when it ends, so it keeps this record instead. One row per agent conversation.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| agent_session_id | TEXT | PRIMARY KEY | |
| agent_name | TEXT | NOT NULL | |
| label | TEXT | | NULL |
| first_prompt | TEXT | | NULL |
| cwd | TEXT | NOT NULL | |
| started_at | TEXT | NOT NULL | |
| touched_at | TEXT | | NULL |
| ended_at | TEXT | | NULL |
| updated_at | TEXT | NOT NULL | |
| cli_target | TEXT | | NULL |

Written in main by `CommandTerminalHistory` (`src/main/ipc/helpers/command-terminal-history.ts`) from `SessionManager`'s events, for every terminal, one a phone started included:
- A row is written when the agent reports its session id. A `/clear` or `/resume` inside a terminal reports a new id, which stamps the previous row's `ended_at` and writes a new one.
- `touched_at` is set once someone used the terminal (`Session.hasUserInput`). Only touched rows are listed, and an untouched row is deleted when it ends, so a terminal nobody used leaves nothing behind.
- `label` follows the terminal's name: each change of it is written, a rename or a clear back to null included, and a push that leaves the name as it was writes nothing, so a conversation `/resume`d into a renamed terminal keeps its own name. A rename made before the agent reports its id is held and written once the row exists.
- `first_prompt` takes the conversation's first prompt on one line (capped at 200 characters), first write wins, so a resume keeps the original. The Earlier row and the phone's list show it when `label` is null, which is every row while no Automation agent is set and nobody renamed the terminal. The activity engine's synthetic prompt marker is skipped.
- `ended_at` is stamped when the terminal ends.
- `cli_target` is the terminal's CLI target, as the `sessions` column holds it, taking the newest on each write. The Earlier list asks the agent for the transcript where it is, so a conversation a WSL distro holds is not dropped as purged. NULL for this machine.

Rows are written as the id is captured rather than at the end because a quit removes no row (`killAll` never calls `remove()`). A row left open by a quit is listed once no live terminal holds it, and the list stamps its `ended_at` from `updated_at`. An id that a `sessions` or `workflows` row owns is never recorded: a `/resume` into a task's or a workflow's conversation belongs to its card. The list drops a row whose agent can no longer find the transcript (`locateSessionHistoryFile`), since it can never be resumed. Pruned to the newest 50 ended rows (`COMMAND_TERMINAL_HISTORY_LIMIT`). A row with no `ended_at` is never pruned, so an unused live terminal's row is still there when it is first touched. All timestamps are UTC ISO 8601. Index: `idx_command_terminal_history_ended` (ended_at), which the prune filters and sorts on.
