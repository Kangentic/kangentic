# Database Architecture

## Two-Database Architecture

Kangentic uses a two-database design:

- **Global DB** (`<configDir>/index.db`) -- stores the project list and global configuration.
- **Per-project DB** (`<configDir>/projects/<projectId>.db`) -- stores tasks, swimlanes, actions, and sessions for a single project.

This separation keeps project data isolated. Deleting a project removes only its database file.

## Database Locations

The config directory is platform-dependent:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%/kangentic/` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`) |

Overridable via the `KANGENTIC_DATA_DIR` environment variable. When set, all database files are stored under that directory instead of the platform default.

## Configuration

All database connections are opened with three pragmas:

- `journal_mode = WAL` -- concurrent reads without blocking writers
- `busy_timeout = 5000` -- wait up to 5 seconds on locked databases before returning SQLITE_BUSY
- `foreign_keys = ON` -- enforce referential integrity on all foreign key constraints

All queries are synchronous via **better-sqlite3** -- they block the Node.js event loop briefly but avoid callback complexity.

## Global DB Schema

### projects table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| path | TEXT | NOT NULL | |
| github_url | TEXT | | NULL |
| default_agent | TEXT | NOT NULL | 'claude' |
| default_model | TEXT | | NULL |
| default_effort | TEXT | | NULL |
| group_id | TEXT | | NULL |
| position | INTEGER | NOT NULL | 0 |
| last_opened | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

### project_groups table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| position | INTEGER | NOT NULL | |
| is_collapsed | INTEGER | NOT NULL | 0 |

### global_config table

| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

## Per-Project DB Schema

### swimlanes table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| role | TEXT | | NULL |
| position | INTEGER | NOT NULL | |
| color | TEXT | NOT NULL | '#3b82f6' |
| icon | TEXT | | NULL |
| is_archived | INTEGER | NOT NULL | 0 |
| permission_mode | TEXT | | NULL |
| auto_spawn | INTEGER | NOT NULL | 1 |
| auto_command | TEXT | | NULL |
| plan_exit_target_id | TEXT | | NULL |
| is_ghost | INTEGER | NOT NULL | 0 |
| agent_override | TEXT | | NULL |
| model_override | TEXT | | NULL |
| effort_override | TEXT | | NULL |
| handoff_context | INTEGER | NOT NULL | 0 |
| session_target | TEXT | NOT NULL | 'main' |
| session_spawn_strategy | TEXT | NOT NULL | 'create_or_resume' |
| created_at | TEXT | NOT NULL | |
| description | TEXT | | NULL |

Valid role values: `todo`, `done`, or NULL (custom column).

Per-column session model (two orthogonal axes; see `src/shared/types.ts` and `docs/session-lifecycle.md` "Isolated Sessions"):
- `session_target` (renamed from the original `session_strategy`): `main` (default, the task's main session) or `isolated` (a separate, context-isolated session keyed by the swimlane id). See `SessionTarget`.
- `session_spawn_strategy`: `create_or_resume` (default, resume the target track's session or spawn one) or `always_spawn_new` (always spawn fresh on entry, retiring the prior session for that `(task, target)`). See `SessionSpawnStrategy`. The fresh-vs-resume default is context-aware (`resolveForceFresh`): isolated columns default to `always_spawn_new`, main columns to `create_or_resume`.

### tasks table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| display_id | INTEGER | UNIQUE INDEX | NULL |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | '' |
| swimlane_id | TEXT | NOT NULL, FK->swimlanes | |
| position | INTEGER | NOT NULL | |
| agent | TEXT | | NULL |
| session_id | TEXT | | NULL |
| worktree_path | TEXT | | NULL |
| branch_name | TEXT | | NULL |
| pr_number | INTEGER | | NULL |
| pr_url | TEXT | | NULL |
| pr_state | TEXT | | NULL |
| head_sha | TEXT | | NULL |
| external_id | TEXT | | NULL |
| external_source | TEXT | | NULL |
| external_url | TEXT | | NULL |
| base_branch | TEXT | | NULL |
| use_worktree | INTEGER | | NULL |
| labels | TEXT | NOT NULL | '[]' |
| priority | INTEGER | NOT NULL | 0 |
| model_override | TEXT | | NULL |
| effort_override | TEXT | | NULL |
| agent_override | TEXT | | NULL |
| permission_mode | TEXT | | NULL |
| auto_command | TEXT | | NULL |
| detail_view_state | TEXT | | NULL |
| archived_at | TEXT | | NULL |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

Indexes: `idx_tasks_swimlane_position` on (swimlane_id, position), `idx_tasks_display_id` on (display_id) UNIQUE, `idx_tasks_session_id` on (session_id), `idx_tasks_external` on (external_source, external_id).

### actions table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| type | TEXT | NOT NULL | |
| config_json | TEXT | NOT NULL | '{}' |
| created_at | TEXT | NOT NULL | |

Valid types: `spawn_agent`, `send_command`, `run_script`, `kill_session`, `create_worktree`, `cleanup_worktree`, `create_pr`, `webhook`.

### swimlane_transitions table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| from_swimlane_id | TEXT | NOT NULL | |
| to_swimlane_id | TEXT | NOT NULL, FK->swimlanes | |
| action_id | TEXT | NOT NULL, FK->actions | |
| execution_order | INTEGER | NOT NULL | 0 |

Note: `from_swimlane_id` has no foreign key constraint. This allows a wildcard value (`*`) as the source, meaning the transition fires regardless of which column the task came from.

Index: `idx_transitions_from_to` on (from_swimlane_id, to_swimlane_id).

### sessions table

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

Valid session_type values: `claude_agent`, `codex_agent`, `gemini_agent`, `qwen_agent`, `aider_agent`, `cursor_agent`, `copilot_agent`, `warp_agent`, `kimi_agent`, `opencode_agent`, `droid_agent`, `ollama_agent`, `run_script`.

Valid status values: `running`, `queued`, `suspended`, `exited`, `orphaned`.

Valid suspended_by values: `user` (explicit pause button), `system` (shutdown, task move, idle timeout), or `NULL` (legacy records, treated as `system`).

`isolated_swimlane_id`: NULL = the task's main session; a swimlane id = the separate, context-isolated session belonging to that `isolated`-strategy column. Lets one task hold multiple independently-resumable sessions (see `docs/session-lifecycle.md` "Isolated Sessions").

Valid permission_mode values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto` (see `PermissionMode` type in `src/shared/types.ts`).

`tool_breakdown` is JSON-encoded `PerToolStat[]` (see `src/shared/types.ts`). One entry per distinct tool name with `callCount`, `totalDurationMs`, `interruptedCount`, and optional `costUsd` / `inputTokens` / `outputTokens` when the adapter emits per-tool telemetry on `tool_end` events. NULL on records captured before the column existed and on records whose session produced no tool events. Written by `captureSessionMetrics` from `UsageAccumulator` (`src/main/activity-engine/usage-accumulator.ts`), which pairs `tool_start` / `tool_end` timestamps in a per-session aggregator and is tracked independently of the bounded event cache so totals are not truncated for long sessions. A second, fire-and-forget writer, `SessionRepository.updateTranscriptToolCounts` (invoked via `refineTranscriptToolCounts` in `session-metrics.ts`, mirroring the token refinement below), backfills `tool_call_count` / `tool_breakdown` from the agent's own transcript when the live `UsageAccumulator` count is NULL or 0 (e.g. a parked/suspended session whose `tool_start` / `tool_end` hook events never reached the accumulator) - it never overwrites a nonzero live count, since the live count carries real durations and an interrupted tally the transcript-derived callCount-only breakdown cannot.

Indexes: `idx_sessions_task_started` on (task_id, started_at DESC), `idx_sessions_task_type_isolation_started` on (task_id, session_type, isolated_swimlane_id, started_at DESC) (the resume-decision hot path for per-column isolated sessions), `idx_sessions_status` on (status), `idx_sessions_agent_session_id` on (agent_session_id).

### usage_history table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| session_record_id | TEXT | NOT NULL UNIQUE | |
| recorded_at | TEXT | NOT NULL | |
| session_started_at | TEXT | NOT NULL | |
| session_type | TEXT | | NULL |
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

Indexes: `idx_usage_history_session_started_at` on (session_started_at), `idx_usage_history_recorded_at` on (recorded_at).

Append-only ledger of finalized session usage. Decoupled from `sessions` and `tasks`: rows have no foreign keys, so they survive task deletion, bulk-archive cleanup, and revert-to-backlog. The usage dashboard's period totals (Live/Today/Week/Month/All Time), cost-per-day series, and by-model / by-agent / by-effort breakdowns read from this table via `USAGE_GET_DASHBOARD_STATS` (and the `kangentic_get_usage_stats` MCP tool) so cost and token totals reflect every session ever finalized on the project, not just the ones whose source task still exists.

`agent` records which agent (claude, codex, gemini, ...) ran the session, stamped generically from the session manager's recorded agent name at capture time; a one-shot migration backfills it from surviving `sessions` -> `tasks.agent` joins, and rows whose task was already deleted stay NULL (rendered as "(unknown)").

`effort` records the session's last-applied `--effort` value, stamped at capture time from `sessions.applied_effort` (the spawn/resume/live-switch ground truth); a one-shot migration backfills it from surviving session rows. NULL means agent default (no flag) - a real bucket rendered as "(default)", not missing data. A session that switches effort mid-run attributes all of its usage to the final value (the same snapshot semantics as `model_id`).

`session_record_id` is the `sessions.id` of the row this entry mirrors. The UNIQUE constraint plus an `ON CONFLICT(session_record_id) DO UPDATE` clause in `recordSessionUsage` makes capture idempotent: re-capturing the same record at suspend AND again at app shutdown updates the existing row instead of producing duplicates. Git stat columns (`lines_added`, `lines_removed`, `files_changed`) are intentionally excluded from the UPSERT's `DO UPDATE SET` clause because they are owned by `setTaskGitStats`, which runs separately after `captureGitChurn` finishes its `git diff` against the base branch (fired on every session finalization, not just move-to-Done).

`session_started_at` is used for period bucketing (`WHERE session_started_at >= ?`) so "Today" means "session started today", not "metrics flushed today" - the difference matters for sessions that finalize across midnight. Written by `captureSessionMetrics` whenever `usage` is defined (i.e. metrics were actually captured). Cost = 0 with non-zero tokens is the Claude subscription-user case (Plus/Max) and IS recorded; the gate is `if (usage)`, not `cost > 0`. The migration backfills existing `sessions` rows with `total_cost_usd IS NOT NULL` so installs upgrading to this version do not lose their lifetime totals.

TypeScript types: `UsageDashboardStats` / `UsageKpis` (the composite read shape) in `src/shared/types.ts`. Repository: `UsageHistoryRepository` in `src/main/db/repositories/usage-history-repository.ts`; the aggregation itself lives in `src/main/usage-stats/` (`usageStatsService` + pure bucketing math), shared by the IPC handler and the MCP tool.

### task_attachments table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| filename | TEXT | NOT NULL | |
| file_path | TEXT | NOT NULL | |
| media_type | TEXT | NOT NULL | |
| size_bytes | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |

Index: `idx_task_attachments_task_id` on (task_id).

### backlog_tasks table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | '' |
| priority | INTEGER | NOT NULL | 0 |
| labels | TEXT | NOT NULL | '[]' |
| position | INTEGER | NOT NULL | |
| external_id | TEXT | | NULL |
| external_source | TEXT | | NULL |
| external_url | TEXT | | NULL |
| sync_status | TEXT | | NULL |
| assignee | TEXT | | NULL |
| due_date | TEXT | | NULL |
| item_type | TEXT | | NULL |
| external_metadata | TEXT | | NULL |
| attachment_count | INTEGER | NOT NULL | 0 |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

Indexes: `idx_backlog_position` on (position), `idx_backlog_external` on (external_source, external_id).

### backlog_attachments table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| backlog_task_id | TEXT | NOT NULL, FK -> backlog_tasks(id) ON DELETE CASCADE | |
| filename | TEXT | NOT NULL | |
| file_path | TEXT | NOT NULL | |
| media_type | TEXT | NOT NULL | |
| size_bytes | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |

Index: `idx_backlog_attachments_task_id` on (backlog_task_id).

Mirrors `task_attachments` for backlog tasks. Files stored at `.kangentic/backlog/<backlogTaskId>/attachments/`. When a backlog task is promoted to a task, attachments are copied to `task_attachments` and backlog attachment files are cleaned up.

### session_transcripts table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| session_id | TEXT | PRIMARY KEY | |
| transcript | TEXT | NOT NULL | '' |
| size_bytes | INTEGER | NOT NULL | 0 |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

No foreign key constraint on `session_id`. Cascade cleanup is handled via a DELETE trigger on the `sessions` table. The `TranscriptWriter` in `src/main/pty/transcript-writer.ts` strips ANSI escape sequences from PTY output and debounces writes to this table every 30 seconds.

### handoffs table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| from_session_id | TEXT | FK->sessions ON DELETE SET NULL | |
| to_session_id | TEXT | FK->sessions ON DELETE SET NULL | |
| from_agent | TEXT | NOT NULL | |
| to_agent | TEXT | NOT NULL | |
| trigger | TEXT | NOT NULL | |
| packet_json | TEXT | NOT NULL | |
| session_history_path | TEXT | | |
| created_at | TEXT | NOT NULL | |

Index: `idx_handoffs_task_id` on (task_id).

`packet_json` is a legacy column retained for schema compatibility. Current handoffs pass session context via `session_history_path` (a pointer to the source agent's native session history file). Repository queries no longer SELECT or write `packet_json`, and it is absent from the `HandoffRecord` TypeScript type.

TypeScript type: `HandoffRecord` in `src/shared/types.ts`. Repository: `HandoffRepository` in `src/main/db/repositories/handoff-repository.ts`.

### memory_chunks table

Conversation-memory index: a per-project retrieval store over the STRUCTURED transcript (TranscriptEntry-derived chunks), not the raw `session_transcripts` scrollback blob. Corpus-generic (a `corpus` column) so the same store can later index repo files/docs; `session_id`/`task_id` are nullable for that reuse and always set for the conversation corpus.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | INTEGER | PRIMARY KEY (rowid) | |
| corpus | TEXT | NOT NULL | 'conversation' |
| doc_id | TEXT | NOT NULL | |
| seq | INTEGER | NOT NULL | |
| session_id | TEXT | | |
| task_id | TEXT | | |
| agent_session_id | TEXT | | |
| role | TEXT | NOT NULL | |
| text | TEXT | NOT NULL | |
| content_hash | TEXT | NOT NULL | |
| token_estimate | INTEGER | NOT NULL | |
| ts_start | INTEGER | | |
| ts_end | INTEGER | | |
| turn_uuid_start | TEXT | | |
| turn_uuid_end | TEXT | | |
| embedded_model | TEXT | | (NULL = not embedded) |
| meta_json | TEXT | | |
| created_at | TEXT | NOT NULL | |

Constraint: `UNIQUE(corpus, doc_id, seq)`. Indices: `idx_memory_chunks_doc` (corpus, doc_id, seq), `idx_memory_chunks_session` (session_id), `idx_memory_chunks_embedded` (embedded_model). Cascade cleanup via the `trg_sessions_delete_memory` DELETE trigger on `sessions`.

### memory_chunks_fts (FTS5)

FTS5 external-content virtual table over `memory_chunks.text` (`content='memory_chunks'`, `content_rowid='id'`, `tokenize='unicode61 remove_diacritics 2'`), kept in sync by the `trg_memory_chunks_ai`/`_ad`/`_au` triggers. Provides `bm25()` ranking and `snippet()` for conversation search. FTS5 is compiled into the shipped better-sqlite3, so this needs no extra dependency.

The vector table `memory_chunks_vec` (`USING vec0`) is NOT created by migrations: it needs the sqlite-vec extension loaded, which may be unavailable, so `RetrievalStore.ensureVecTable()` creates it lazily at runtime only when the extension loaded. No trigger references it (a missing-module trigger body would break every `DELETE FROM sessions`); vec rows are cleaned by application code.

### memory_index_state table

Per-document index bookkeeping: the source-file staleness signature (path/mtime/size) so a sweep skips unchanged sources, and a terminal `unsupported` status for raw-only agents with no structured parser.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| corpus | TEXT | NOT NULL | |
| doc_id | TEXT | NOT NULL | |
| session_id | TEXT | | |
| source_path | TEXT | | |
| source_mtime_ms | INTEGER | | |
| source_size | INTEGER | | |
| entry_count | INTEGER | NOT NULL | 0 |
| chunk_count | INTEGER | NOT NULL | 0 |
| status | TEXT | NOT NULL | 'ok' |
| indexed_at | TEXT | NOT NULL | |

Constraint: `PRIMARY KEY (corpus, doc_id)`. `status` is one of `ok`, `unsupported`, `missing-source`, `error`.

### memory_meta table

Key/value bookkeeping for the memory index. Holds `chunker_version`; a mismatch against the current chunker version purges and reindexes the project.

| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

### conversation_turn_usage table

Durable per-turn token-usage ledger. One row per assistant turn that reported usage, written by `ConversationIndexer` from the parsed transcript at index time so it persists after the agent prunes its native JSONL (unlike the in-transcript `usage` field, which is re-derived on each parse). Counts are kept as raw components so cost analysis can weight fresh input against the cheaper cache reads. Read via `ConversationUsageStore` (`getForTask` / `getForSession` / `getForTurns`, plus `getGroupedUsageSince`, the 5-minute-bucketed project-wide read behind the usage dashboard's burn-rate and token-trend charts).

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

Keyed by `turn_uuid` because a `--resume` replays its parent's turns verbatim under the same uuid; the PK dedups a replayed turn back onto one row so per-task / per-project totals never double-count a shared turn. Indices: `idx_turn_usage_task` (task_id), `idx_turn_usage_session` (session_id), `idx_turn_usage_ts` (ts). Deliberately has NO `sessions` DELETE cascade (unlike `memory_chunks`): it is a durable ledger, not a rebuildable index, so token history outlives the session rows it describes.

Module: `src/main/retrieval/` (store `RetrievalStore`, usage ledger `ConversationUsageStore`, indexer `ConversationIndexer`, service `retrievalService`, query `searchConversationMemory`).

## Migration Strategy

Migrations run automatically on database open via `runGlobalMigrations()` (from `src/main/db/migrations/global-schema.ts`) and `runProjectMigrations()` (from `src/main/db/migrations/project-schema.ts`). Default swimlane and action seeding lives in `src/main/db/migrations/default-data.ts`. The strategy uses three approaches depending on the change:

- **Initial schema** uses `CREATE TABLE IF NOT EXISTS` so first-run and re-runs are idempotent.
- **Incremental changes** use `ALTER TABLE ADD COLUMN` with existence checks via `PRAGMA table_info()` to avoid errors on already-migrated databases.
- **Table recreation** is used when foreign key constraints need removal (e.g., `swimlane_transitions` wildcard source required dropping the FK on `from_swimlane_id`).
- **Data migrations** (e.g., converting explicit transitions to wildcards, updating legacy permission modes) run alongside schema changes.

### Key Migrations (Per-Project DB)

Grouped by feature. The numbering is for cross-reference only and does not reflect the exact execution order within `runProjectMigrations()` (several column adds run earlier or later than their position here suggests):

1. **`role` column on swimlanes** -- adds the `role` column and backfills `todo` (originally `backlog`), `planning`, `running` by position, plus `done` for archived columns.
2. **`icon` column on swimlanes** -- adds custom icon support.
3. **`archived_at` column on tasks** -- supports the Done auto-archive feature.
4. **`base_branch` column on tasks** -- per-task base branch override.
5. **`use_worktree` column on tasks** -- per-task worktree override.
6. **`swimlane_transitions` table recreation** -- drops the foreign key constraint on `from_swimlane_id` to allow wildcard `*` source. SQLite requires full table recreation to remove a constraint.
7. **Wildcard transition data migration** -- converts explicit per-source transitions (e.g., To Do->Planning) into wildcard transitions (*->Planning). Groups by target swimlane and action, keeping the lowest execution_order.
8. **`task_attachments` table** -- creates the table with `ON DELETE CASCADE` on `task_id` and an index on `task_id`.
9. **`spawn_agent` config data migrations** (single pass over all spawn_agent actions):
   - Appends `{{attachments}}` to prompt templates that lack it
   - Removes legacy permission modes (`dangerously-skip`, `bypass-permissions`) from action config (action-level permissionMode was removed in a later migration)
   - Updates old `Task: {{title}}...` prompt template to `{{title}}{{description}}{{attachments}}`
   - Migrates the prior default `{{title}}{{description}}{{attachments}}` to the XML envelope form `{{task_xml}}{{attachments}}` (only rewrites exact-match defaults; user-customized templates are left alone)
10. **`permission_strategy` and `auto_spawn` columns on swimlanes** -- adds per-column permission strategy and auto-spawn toggle. Backfills: todo/done get `auto_spawn = 0`, planning gets `permission_strategy = 'plan'`, running role is converted to a custom column. (Column later renamed to `permission_mode` in migration 17.)
11. **`auto_command` column on swimlanes** -- per-column auto-command support.
12. **`is_terminal` renamed to `is_archived`** -- uses `ALTER TABLE RENAME COLUMN`.
13. **`plan_exit_target_id` column on swimlanes** -- adds plan exit target and removes the `planning` system role. Sets icon to `map` for former planning-role columns, clears the role, and auto-sets `plan_exit_target_id` to the next column by position.
14. **`suspended_by` column on sessions** -- tracks who suspended the session (`user` or `system`). Used by session recovery to skip user-paused sessions on relaunch.
15. **`is_ghost` column on swimlanes** -- adds ghost column support for board config reconciliation. Ghost columns are columns removed from `kangentic.json` but still holding tasks.
16. **Session metrics columns** -- adds `total_cost_usd`, `total_input_tokens`, `total_output_tokens`, `model_id`, `model_display_name`, `total_duration_ms`, `tool_call_count`, `lines_added`, `lines_removed`, `files_changed`, `tool_breakdown` to sessions for completed task summaries. The same idempotent ALTER TABLE loop adds new metric columns over time; `tool_breakdown` was appended later for per-tool aggregates.
17. **`permission_strategy` column renamed to `permission_mode`** -- renames the `permission_strategy` column to `permission_mode` on swimlanes. Migrates old values: `bypass-permissions` to `bypassPermissions`, removes `manual` (alias for `default`). Adds `dontAsk` as a new valid mode. Also removes `permissionMode` from action `config_json` (action-level override removed; resolution is now swimlane override then global setting).
18. **Legacy `permission_mode` value normalization** -- unconditional data migration that runs on every DB open. Normalizes legacy values in both swimlanes and sessions: `project-settings` to `default`, `manual` to `default`, `dangerously-skip` to `bypassPermissions`, `bypass-permissions` to `bypassPermissions`. Ensures all records use the current `PermissionMode` union values regardless of when they were created.
19. **Swimlane role rename (`backlog` to `todo`)** -- renames the "Backlog" swimlane to "To Do" (also catches "Not Started") and migrates role values from `backlog` to `todo`.
20. **`backlog_tasks` table** -- creates the staging area table for the Backlog View feature. Stores pre-board tasks with priority, labels, external source tracking, and position ordering. Includes indexes on position and (external_source, external_id). Databases that created this table under its original name `backlog_items` are renamed to `backlog_tasks` (and `backlog_attachments.backlog_item_id` to `backlog_task_id`) for existing DBs.
21. **`backlog_attachments` table** -- creates the attachment table for backlog tasks with `ON DELETE CASCADE` on `backlog_task_id` and an index on `backlog_task_id`. Mirrors `task_attachments` structure.
22. **Import-related columns on `backlog_tasks`** -- adds `assignee`, `due_date`, `item_type`, and `external_metadata` columns for richer external source integration (GitHub Issues, GitHub Projects, Azure DevOps).
23. **`display_id` column on tasks** -- adds a human-readable sequential integer ID for tasks. Backfills existing tasks with sequential IDs ordered by `created_at ASC`. Creates a unique index on `display_id`.
24. **`labels` and `priority` columns on tasks** -- adds label and priority support to board tasks (mirroring backlog_tasks). Labels default to `'[]'` (JSON array), priority defaults to `0`. Preserved during promote from backlog.
25. **`claude_session_id` renamed to `agent_session_id`** -- renames the `claude_session_id` column to `agent_session_id` on the `sessions` table. Generalizes the column name to support multiple agent adapters.
26. **`agent_override` column on swimlanes** -- adds per-column agent override support. When set, tasks moving into this column use the specified agent instead of the project default.
27. **`handoff_context` column on swimlanes** -- adds per-column toggle for cross-agent handoff context packaging. Default `0` (off) - users must opt in. When enabled, agent transitions package transcript, git diff, and metrics for the target agent.
28. **`model_override` and `effort_override` columns on swimlanes and tasks** -- adds per-column model and effort/reasoning level overrides. Both default to NULL (inherit agent default). Read at spawn time by `prepare-spawn.ts` to set `--model` / `--effort` CLI flags. Live-applied to running sessions via adapter-specific slash injection (`getInjectionSequence`) on column transition; falls back to suspend+respawn for adapters without live-swap support. The same migration block also adds `model_override` and `effort_override` columns to the **tasks** table for per-task overrides set via the ContextBar popover. Per-task values take precedence over the swimlane override; NULL falls through to the swimlane and ultimately to the agent default.
29. **`agent_override` column on tasks** -- adds per-task agent override set at task creation via the New Task dialog's Advanced section. Wins over `swimlane.agent_override` and the project default for the task's entire lifetime; column moves cannot change the agent. NULL means inherit from the swimlane. Resolved at spawn time by `resolveTargetAgent()` (priority 1) in `src/main/transition-engine/agent-resolver.ts`. Companion guard in `task-move.ts` skips the cross-agent clear of `model_override` / `effort_override` when `agent_override` is set, since those values were picked for the locked agent.
30. **`session_transcripts` table** -- creates the table for storing ANSI-stripped PTY transcripts. No FK constraint; uses a DELETE trigger on `sessions` for cascade cleanup.
31. **`handoffs` table** -- creates the table for tracking cross-agent context handoffs. FK on `task_id` with CASCADE delete, FKs on `from_session_id` and `to_session_id` with SET NULL. Indexed on `task_id`.
32. **Remove hardcoded agent from `spawn_agent` action configs** -- data migration that strips a legacy `agent: 'claude'` value from existing `spawn_agent` action `config_json`. The seed data previously hardcoded `agent: 'claude'`, which shadowed the project default and per-column `agent_override`; clearing it lets the agent resolution chain respect user configuration. Malformed configs are skipped.
33. **`session_history_path` column on handoffs** -- adds the `session_history_path TEXT` column to the `handoffs` table. Session history passthrough stores the source agent's native session history file path instead of a manufactured context packet, so `packet_json` becomes a legacy column that repository queries no longer read or write.
34. **Performance indices on sessions and tasks** -- adds idempotent hot-path indices: `idx_sessions_task_started` on (task_id, started_at DESC) for per-task session lookups and cost summaries, `idx_sessions_task_type_isolation_started` on (task_id, session_type, isolated_swimlane_id, started_at DESC) for the per-column isolated-session resume-decision path, `idx_sessions_status` on (status) for getResumable/getOrphaned/markRunningAsOrphaned, `idx_sessions_agent_session_id` on (agent_session_id) for the resume-by-agent-id path, and `idx_tasks_session_id` on (session_id) for session-change IPC events. Targets startup reconciliation and live board state lookups under accumulated session history.
35. **`external_id`, `external_source`, `external_url` columns on tasks** -- carries external origin (GitHub/Asana/etc.) onto board tasks promoted from imported backlog items, plus an `idx_tasks_external` index on (external_source, external_id). Promotion deletes the `backlog_tasks` row, so without these columns the board task loses all trace of its origin and the same issue could be re-imported. The dedup query (`findByExternalIds`) now unions `backlog_tasks` with `tasks` (archived included) so a previously imported-and-promoted issue stays "imported". Carried back through demote via `createFromTask`.
36. **`usage_history` append-only ledger** -- creates the `usage_history` table (in the initial `CREATE TABLE IF NOT EXISTS` block) plus two query indices (`idx_usage_history_session_started_at`, `idx_usage_history_recorded_at`) for StatusBar period bucketing. Adds a one-shot guarded backfill that copies existing `sessions` rows where `total_cost_usd IS NOT NULL` into `usage_history` so installs upgrading to this version retain their lifetime totals. Backfill is wrapped in a single transaction and uses `INSERT OR IGNORE` plus a `COUNT(*) = 0` guard so re-running is safe. Rows in this table have no foreign keys to `tasks` or `sessions`, so totals survive task deletion (the original bug this feature fixes).
37. **`pr_state` column on tasks** -- adds `pr_state TEXT DEFAULT NULL` so the authoritative branch->PR resolver can persist normalized PR state (`open`/`draft`/`merged`/`closed`) and re-resolution can reflect state changes on the card pill. Idempotent guarded `ALTER TABLE`.
38. **`head_sha` column on tasks** -- adds `head_sha TEXT DEFAULT NULL`, the captured worktree HEAD commit SHA. An immutable anchor that lets PR resolution match by commit (`gh api repos/{owner}/{repo}/commits/{sha}/pulls`) even after the worktree is reclaimed on Done or the branch is renamed. Captured opportunistically during resolution and on worktree deletion. Idempotent guarded `ALTER TABLE`.
39. **`isolated_swimlane_id` column on sessions** - adds `isolated_swimlane_id TEXT DEFAULT NULL` so a task can hold multiple parallel, independently-resumable sessions. NULL = the task's main session; a swimlane id = the separate, context-isolated session belonging to that `isolated`-target column. Existing rows are NULL (main). Companion index `idx_sessions_task_type_isolation_started` (see migration 34) keys the resume-decision lookup. Idempotent guarded `ALTER TABLE`.
40. **`applied_model` and `applied_effort` columns on sessions** - adds `applied_model TEXT DEFAULT NULL` and `applied_effort TEXT DEFAULT NULL`. They record the model/effort a session was actually spawned, resumed, or live-switched with (the `--model` / `--effort` flag value; NULL = agent default, no flag). This is the ground truth the column-transition injection delta compares against in `prepareInjectionPlan`: a move injects `/model` or `/effort` only when the session's real running value differs from the destination's effective value, so a drifted column config (or a null leaving-column) no longer triggers a spurious injection. Maintained by `SessionRepository.updateAppliedSettings` at spawn/resume and after every live settings switch. Distinct from `model_id` (the agent-reported model captured at exit via metrics). Both columns are idempotent guarded `ALTER TABLE`.
41. **Per-column session model on swimlanes (`session_target` + `session_spawn_strategy`)** - renames the original `session_strategy` column to `session_target` (`main` | `isolated`, values unchanged) via a guarded `RENAME COLUMN`, and adds `session_spawn_strategy TEXT NOT NULL DEFAULT 'create_or_resume'` (`create_or_resume` | `always_spawn_new`). Idempotent across fresh DBs, DBs still on the old `session_strategy` column, and already-migrated DBs. Together they select which session track a column runs a task on and whether it resumes or always spawns fresh on entry; the fresh-vs-resume default is context-aware (`resolveForceFresh`). See `docs/session-lifecycle.md` "Isolated Sessions".
42. **`description` column on swimlanes** - adds `description TEXT DEFAULT NULL`, a free-form, team-shared blurb describing a column's purpose. Surfaced as a header tooltip and round-trips through `kangentic.json` (`BoardColumnConfig.description`). Idempotent guarded `ALTER TABLE`.
43. **`compaction_count` columns on sessions and usage_history** - adds `compaction_count INTEGER NOT NULL DEFAULT 0` to `sessions` (via the metrics-columns loop, migration 16) and the same to `usage_history` (in the `CREATE TABLE` block plus a guarded `ALTER TABLE` for existing DBs). Counts context compactions per CLI run (Claude `PreCompact` hook -> `EventType.Compact`, counted in `UsageAccumulator`); the per-task lifetime "sessions compacted" total is the SUM across the task's session rows. NOT NULL DEFAULT 0 so existing rows and never-compacted runs aggregate correctly.
44. **`detail_view_state` column on tasks** - adds `detail_view_state TEXT DEFAULT NULL`, a per-task JSON blob (`TaskDetailViewState`) holding the task-detail dialog's layout (divider ratio, which side panel is open, Changes view mode, selected diff file, reviewed files, diff scope, file-tree width, selected commit in the Changes panel's history browser, commit-history region height). Hydrated into the session store on board load and saved debounced via the task-scoped `TASK_SET_DETAIL_VIEW_STATE` IPC so reopening a task restores its layout across restarts. The dedicated `setDetailViewState` writer deliberately does not bump `updated_at` (view-state churn must not reorder the board). Idempotent guarded `ALTER TABLE`.
45. **Conversation-memory index (`memory_chunks` + FTS + `memory_index_state` + `memory_meta`)** - creates the per-project retrieval store over the structured transcript: `memory_chunks` (corpus-generic chunk store, `UNIQUE(corpus, doc_id, seq)`), the `memory_chunks_fts` FTS5 external-content shadow (with `_ai`/`_ad`/`_au` sync triggers), `memory_index_state` (per-doc staleness signature + status), and `memory_meta` (chunker version). Cascade cleanup via `trg_sessions_delete_memory` on `sessions`. The `memory_chunks_vec` (vec0) table is created at runtime by `RetrievalStore.ensureVecTable()` only when the sqlite-vec extension loaded, never by migrations, and no trigger references it. Idempotent `CREATE ... IF NOT EXISTS`.
46. **Durable per-turn token-usage ledger (`conversation_turn_usage`)** - creates the table plus its `idx_turn_usage_task` / `idx_turn_usage_session` / `idx_turn_usage_ts` indices. One row per assistant turn that reported usage, keyed by `turn_uuid` (so a `--resume` replay dedups back onto one row), populated by `ConversationIndexer` from the parsed transcript at index time so token counts survive the agent pruning its native JSONL. Deliberately has NO `sessions` DELETE cascade (unlike `memory_chunks`): it is a long-lived ledger, not a rebuildable index, so token history outlives the session rows it describes. See the `conversation_turn_usage table` section above. Idempotent `CREATE ... IF NOT EXISTS`.
47. **`permission_mode` column on tasks** - adds `permission_mode TEXT DEFAULT NULL`, a per-task permission override mirroring `agent_override`/`model_override`/`effort_override`: settable via the New Task dialog's Advanced section and the task-detail edit form (pre-spawn or suspended only, same lock as `agent_override`). Takes precedence over the swimlane's `permission_mode` and the project's default permission mode; NULL means inherit. Idempotent guarded `ALTER TABLE`.
48. **`auto_command` column on tasks** - adds `auto_command TEXT DEFAULT NULL`, an MCP-only per-task initial command set via `kangentic_create_task`'s `autoCommand` param so a skill can mint a task that runs a command (e.g. `/code-review`) once the agent spawns. Not surfaced in the New Task dialog or project settings. Takes precedence over the swimlane's `auto_command` for this task only; NULL means inherit from the swimlane. Idempotent guarded `ALTER TABLE`.
49. **`agent` and `effort` columns on `usage_history`** - adds `agent TEXT` and `effort TEXT` (both in the `CREATE TABLE` block plus guarded `ALTER TABLE` for existing DBs) so the usage dashboard can break usage down by agent and by reasoning effort. `agent` is stamped at capture time from the session manager's recorded agent name; `effort` from `sessions.applied_effort` (the last-applied `--effort` value, NULL = agent default). Each has a one-shot backfill: `agent` from surviving `sessions` -> `tasks.agent` joins, `effort` from surviving `sessions.applied_effort`. Rows whose source was deleted stay NULL (rendered "(unknown)" / "(default)"). The one-shot `usage_history` seed backfill (migration 36) also carries both columns. Idempotent guarded `ALTER TABLE`.

### Key Migrations (Global DB)

Listed in execution order (idempotent, gated on `IF NOT EXISTS` / `pragma table_info`):

1. **`project_groups` table** -- creates the project groups table for organizing projects into named, collapsible sections.
2. **`group_id` column on projects** -- adds nullable foreign key linking projects to their group.
3. **`position` column on projects** -- adds explicit project ordering. Backfills positions based on `last_opened DESC` order to preserve the original visual order.
4. **`default_model` and `default_effort` columns on projects** - adds `default_model TEXT` and `default_effort TEXT` (both nullable, no default). Per-project model/effort defaults mirroring the existing `default_agent`; unlike `default_agent`, NULL is a valid "no project preference" state that falls through to the CLI/agent default. Read at spawn time as the tier between a column's `model_override`/`effort_override` and the CLI default. Idempotent guarded `ALTER TABLE`.

## Repository Pattern

One repository class per table. All queries are synchronous (better-sqlite3). Transactions are used for position shifts (task move, swimlane reorder, project reorder) to ensure consistent ordering.

### ProjectRepository

Operates on the global DB. Uses `getGlobalDb()` internally -- no constructor argument needed.

| Method | Description |
|--------|-------------|
| `list()` | All projects ordered by position ASC |
| `getById(id)` | Single project by ID |
| `create(input)` | Insert at position 0, shifting all existing projects down |
| `getLastOpened()` | Most recently opened project (by `last_opened` DESC) |
| `updateLastOpened(id)` | Set `last_opened` to now |
| `rename(id, name)` | Rename a project |
| `delete(id)` | Delete and reindex positions to keep them contiguous (0..N-1) |
| `reorder(ids)` | Set positions from the ordered array of IDs |

### TaskRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list(swimlaneId?)` | Active (non-archived) tasks, optionally filtered by swimlane. Includes `attachment_count` via LEFT JOIN on `task_attachments`. |
| `getById(id)` | Single task by ID (includes `attachment_count`) |
| `getBySessionId(sessionId)` | Find the active (non-archived) task that owns a given PTY session |
| `create(input)` | Insert at the end of the target swimlane (next position) |
| `update(input)` | Partial update -- only provided fields are changed |
| `move(input)` | Transactional move: shift positions in old and new swimlanes, update task |
| `archive(id)` | Set `archived_at` to now (soft-delete for Done column) |
| `unarchive(id, targetSwimlaneId, position)` | Clear `archived_at`, move to target swimlane and position |
| `listArchived()` | All archived tasks ordered by `archived_at` DESC |
| `listArchivedPreview(limit)` | The newest `limit` archived tasks plus the total archived count; cheap hydration for the Done column (full list loads lazily via `listArchived`) |
| `delete(id)` | Hard delete with position shift in the owning swimlane |

### SwimlaneRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list()` | All swimlanes ordered by position ASC. Maps integer columns to booleans (`is_archived`, `auto_spawn`). |
| `getById(id)` | Single swimlane by ID |
| `create(input)` | Insert before the `done` column (if any), otherwise at the end. Shifts positions of existing columns. |
| `update(input)` | Partial update -- only provided fields are changed |
| `reorder(ids)` | Set positions from ordered array. Enforces constraints: todo must be position 0, custom columns (role=null) cannot be position 0. |
| `delete(id)` | Delete a custom column. System columns (`todo`, `done`) cannot be deleted. Columns with tasks cannot be deleted. Also cleans up related transitions and dangling `plan_exit_target_id` references. |

### ActionRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list()` | All actions ordered by name ASC |
| `getById(id)` | Single action by ID |
| `create(input)` | Insert a new action |
| `update(input)` | Partial update -- only provided fields are changed |
| `delete(id)` | Delete action and all associated transitions |
| `listTransitions()` | All transitions ordered by from_swimlane_id, to_swimlane_id, execution_order |
| `getTransitionsFor(fromId, toId)` | Get transitions for a specific move. Exact source match takes priority; falls back to wildcard `*` source if no exact match exists. |
| `getAgentSwimlaneIds()` | Returns the set of swimlane IDs that have `spawn_agent` transitions targeting them |
| `setTransitions(fromId, toId, actionIds)` | Replace all transitions for a given from/to pair. Deletes existing, inserts new with execution_order from array index. |

### SessionRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `insert(record)` | Insert a new session record. Caller provides the `id` (PTY session ID = DB primary key, enabling unified session identity across the in-memory PTY layer and the database). |
| `updateStatus(id, status, extra?)` | Update session status with optional `exit_code`, `suspended_at`, `exited_at`, `suspended_by` |
| `getResumable()` | Get suspended agent sessions that can be resumed (any `session_type` except `run_script`) |
| `markAllRunningAsOrphaned()` | Mark all `running` sessions as `orphaned` (crash recovery on startup) |
| `markRunningAsOrphanedExcluding(excludeTaskIds)` | Same as above but skips sessions whose task_id is in the exclusion set (prevents HMR re-entrant recovery from orphaning active sessions) |
| `getOrphaned()` | Get orphaned agent sessions (any `session_type` except `run_script`) |
| `deleteByTaskId(taskId)` | Delete all session records for a given task |
| `getLatestForTask(taskId)` | Find the most recent session record for a task (by `started_at` DESC) |
| `listForTaskNewestFirst(taskId)` | All session records for a task, newest first. Used by `captureGitChurn` to enumerate the full record-id list for `setTaskGitStats`. |
| `getUserPausedTaskIds()` | Get task IDs whose latest session was user-paused (`suspended_by = 'user'`) |
| `listAllSessionIds()` | Get all distinct session record IDs (for stale session directory cleanup) |
| `updateGitStats(id, stats)` | Update `lines_added`, `lines_removed`, `files_changed` for a single session record, unconditionally. |
| `setTaskGitStats(recordIds, canonicalRecordId, stats)` | Mirrors `UsageHistoryRepository.setTaskGitStats`: writes churn to `canonicalRecordId` only and zeros every other id in `recordIds`, so `getSummaryForTask` / `listAllSummaries`'s `SUM(lines_added)` reflects the branch's actual churn instead of double-counting it across `--resume` records. |

### AttachmentRepository

Operates on a per-project DB. Manages both database records and files on disk under `<projectPath>/.kangentic/tasks/<taskId>/attachments/`.

| Method | Description |
|--------|-------------|
| `list(taskId)` | All attachments for a task ordered by `created_at` ASC |
| `getById(id)` | Single attachment by ID |
| `add(projectPath, taskId, filename, base64Data, mediaType)` | Decode base64 data, write file to disk, insert DB record. Filename is sanitized and prefixed with the attachment UUID. |
| `remove(id)` | Delete file from disk and DB record |
| `deleteByTaskId(taskId)` | Delete all attachments for a task (files + DB records). Attempts to clean up empty directories. |
| `getPathsForTask(taskId)` | Get file paths for all attachments on a task (for passing to Claude CLI) |
| `getDataUrl(id)` | Read file from disk and return as a `data:` URL with the correct media type |

### BacklogRepository

Operates on a per-project DB. Manages items in the Backlog View staging area.

| Method | Description |
|--------|-------------|
| `list()` | All backlog items ordered by position ASC |
| `getById(id)` | Single backlog item by ID |
| `create(input)` | Insert at the end (next position) |
| `update(input)` | Partial update - only provided fields are changed |
| `delete(id)` | Delete and shift positions to keep them contiguous |
| `reorder(ids)` | Set positions from ordered array of IDs |
| `bulkDelete(ids)` | Delete multiple items and reindex positions |
| `renameLabel(oldName, newName)` | Rename a label across all items |
| `deleteLabel(name)` | Remove a label from all items |
| `remapPriorities(mapping)` | Remap priority values across all items using a mapping |

### TranscriptRepository

Operates on a per-project DB. Manages ANSI-stripped session transcripts.

| Method | Description |
|--------|-------------|
| `create(sessionId)` | Insert an empty transcript row for a new session (call before any data arrives so `appendChunk` has a row to update) |
| `appendChunk(sessionId, chunk)` | Append a chunk of ANSI-stripped text to the session's transcript via SQLite string concatenation |
| `getBySessionId(sessionId)` | Get the full transcript record for a session |
| `getTranscriptText(sessionId)` | Get just the transcript text for a session (lighter than `getBySessionId` when only the content is needed) |
| `getTranscriptTail(sessionId, maxChars)` | Get the last `maxChars` characters of a session's transcript plus its full length, computed in SQLite (`substr`) so a multi-MB transcript is not materialized in JS |
| `getSizeBytes(sessionId)` | Get the transcript size in bytes without loading the content |

### HandoffRepository

Operates on a per-project DB. Tracks cross-agent context handoffs.

| Method | Description |
|--------|-------------|
| `insert(record)` | Insert a new handoff record |
| `updateToSession(id, toSessionId)` | Update the target session ID after the handoff spawn completes |
| `listByTaskId(taskId)` | List all handoff records for a task (ordered by `created_at` ASC) |
| `getLatestForTask(taskId)` | Get the most recent handoff record for a task |
| `getByFromSession(sessionId)` | Forward lookup: where did this session's context go? |
| `getByToSession(sessionId)` | Backward lookup: where did this session's context come from? |

### BacklogAttachmentRepository

Operates on a per-project DB. Manages both database records and files on disk under `<projectPath>/.kangentic/backlog/<backlogTaskId>/attachments/`. Mirrors `AttachmentRepository` for backlog tasks.

| Method | Description |
|--------|-------------|
| `list(backlogTaskId)` | All attachments for a backlog task ordered by `created_at` ASC |
| `getById(id)` | Single attachment by ID |
| `add(projectPath, backlogTaskId, filename, base64Data, mediaType)` | Decode base64 data, write file to disk, insert DB record. Syncs `attachment_count` on the parent backlog task. |
| `remove(id)` | Delete file from disk and DB record. Syncs `attachment_count`. |
| `deleteByTaskId(backlogTaskId)` | Delete all attachments for a backlog task (files + DB records). Attempts to clean up empty directories. |
| `getPathsForTask(backlogTaskId)` | Get file paths for all attachments on a backlog task |
| `getDataUrl(id)` | Read file from disk and return as a `data:` URL with the correct media type |

### UsageHistoryRepository

Operates on a per-project DB. Append-only ledger of finalized session usage. Decoupled from `sessions` and `tasks` so lifetime cost and token totals survive task deletion, bulk-archive, and revert-to-backlog.

| Method | Description |
|--------|-------------|
| `recordSessionUsage(input)` | Insert or UPSERT a history row keyed by `session_record_id`. UPSERT updates cost / tokens / duration / tool count / model / compaction-count fields on conflict but intentionally excludes git stat columns from the `DO UPDATE SET` clause (those are owned by `setTaskGitStats`). Called from `captureSessionMetrics` whenever `usage` is defined - including subscription-user sessions where `cost = 0` with real token counts. Token columns here hold the per-capture SNAPSHOT (not the transcript cumulative), so period stats summed across a session's `--resume` rows do not double-count. |
| `updateGitStats(sessionRecordId, stats)` | Update `lines_added`, `lines_removed`, `files_changed` for a single history row, unconditionally. Silent no-op if no row exists for the given `sessionRecordId`. Superseded as the churn-write entry point by `setTaskGitStats` below; kept as the low-level single-row primitive. |
| `setTaskGitStats(recordIds, canonicalRecordId, stats)` | Write git churn to exactly ONE row per task lineage: `canonicalRecordId` gets `stats`, every other id in `recordIds` is zeroed. Called from `captureGitChurn` in `src/main/ipc/handlers/git-stats-capture.ts`, fired on every session finalization (suspend, move, handoff, respawn, natural exit) - not just move-to-Done - alongside the matching `SessionRepository.setTaskGitStats` call. Prevents the dashboard's flat SUM from double-counting a branch's cumulative churn across `--resume` records; a canonical row with no history entry (`changes === 0`) leaves siblings untouched rather than zeroing a real earlier capture. |
| `listRowsAfter(since)` | List all history rows where `session_started_at >= since`, oldest first. Pass `null` for "All Time" (no WHERE clause). Period bucketing uses `session_started_at` (when work happened), not `recorded_at` (when metrics flushed), so Today/Week/Month semantics are preserved across midnight boundaries. One query feeds the usage dashboard's KPI totals, cost-per-day series, and by-model / by-agent breakdowns; the aggregation lives in the pure functions of `src/main/usage-stats/bucketing.ts`, consumed by the `USAGE_GET_DASHBOARD_STATS` IPC handler and the `kangentic_get_usage_stats` MCP tool via `usageStatsService`. |

## Connection Management

- `getGlobalDb()` -- singleton, created on first access.
- `getProjectDb(projectId)` -- cached per project ID, reused across the app lifecycle.
- `closeProjectDb(projectId)` -- close and remove from cache on project delete.
- `closeAll()` -- close all connections on app shutdown.

## Default Seed Data

New projects are seeded with 7 default swimlanes:

1. **To Do** (role: `todo`)
2. **Planning**
3. **Executing**
4. **Code Review**
5. **Tests**
6. **Ship It**
7. **Done** (role: `done`)

Two default actions are created:

- **Start Planning Agent** (`spawn_agent`) -- wired to transitions into the Planning column.
- **Kill Session** (`kill_session`) -- wired to transitions into the Done column.

Default transitions:

- **`* → Planning`** -- Kill Session (execution_order 0), Start Planning Agent (execution_order 1)
- **`* → Done`** -- Kill Session (execution_order 0)
