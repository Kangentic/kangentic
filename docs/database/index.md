# Database

## Storage

* [Storage model](storage-model.md) - The two-database split, where index.db and each project database live (KANGENTIC_DATA_DIR override), the WAL pragmas and checkpoint policy, the dialog and softly() fallback when index.db cannot be read, the global tables, connection helpers and the seven default swimlanes.

## Schema

* [Board tables](board-tables.md) - Columns, defaults, indexes and write rules for the board tables, covering swimlanes, tasks (worktree, PR, override pins, workflow route), column_automations, automation_runs, background_calls, workflows, task_links, task_moves, backlog, attachments, project_meta and remote_item_cache.
* [Session tables](session-tables.md) - Schema and invariants for sessions (status, suspended_by, PTY grid, tool_breakdown), usage_history per-leg cost deltas, transcript chunks, handoffs, session_messages_sent, the conversation_turn_usage and turn_spawn_links token ledger, session_activity_intervals, and command_terminal_history.
* [Knowledge Graph tables](knowledge-graph-tables.md) - Schema of the per-project retrieval store behind the Knowledge Graph, covering memory_chunks and its corpora and indexes, the FTS5 table and triggers, sqlite-vec tables, memory_index_state, the transcript archive, memory_task_summaries, memory_meta keys and memory_doc_sums.

## Change and access

* [Migrations](migrations.md) - How project and global migrations run on open, then the numbered history of every schema change, including guarded column adds, table recreations, backfills, the one-way actions-to-automations conversion, and the unconditional role and permission-mode repairs.
* [Repositories](repositories.md) - Every repository class and its methods, including Project, Task (move, recordWorktree, archive, workflow membership), Swimlane, Automation and AutomationRun, Session, UsageHistory (per-leg delta SQL), Handoff, Transcript, attachments, backlog and DevPort (fails soft).
