---
type: Reference
title: Knowledge Graph tables
description: Schema of the per-project retrieval store behind the Knowledge Graph, covering memory_chunks and its corpora and indexes, the FTS5 table and triggers, sqlite-vec tables, memory_index_state, the transcript archive, memory_task_summaries, memory_meta keys and memory_doc_sums.
tags: [database, schema, knowledge-graph, fts]
sources:
  - resource: src/main/db/migrations/project-schema.ts
    title: memory_* and transcript archive tables
  - resource: src/main/retrieval/retrieval-store.ts
  - resource: src/main/retrieval/index-builds.ts
  - resource: src/main/retrieval/corpora.ts
  - resource: src/main/retrieval/vec-layout.ts
  - resource: src/main/retrieval/archive/transcript-archive.ts
  - resource: src/main/retrieval/graph/projection-engine.ts
---
# Knowledge Graph tables

## memory_chunks table

Memory index: a per-project retrieval store. The `corpus` column says what a row indexes, and `INDEX_CORPORA` (`src/main/retrieval/corpora.ts`) lists them in the order the embedding drain serves them: `conversation` (the STRUCTURED transcript, TranscriptEntry-derived chunks, not the raw `session_transcript_chunks` scrollback), `task` (a task's own record), `change` (the files a session changed), and `commit` (a first-parent commit on the project's default branch, `doc_id` = its sha, one chunk of subject and body without the trailer block). `session_id`/`task_id` are nullable; the conversation corpus always sets both. A commit's `task_id` is the task whose conversation first mentions the subject's first eight words, at or before the commit's time plus a minute, or NULL when none does (`commit-record.ts`; measured 1,254 right, 4 wrong and 14 unlinked of the 1,272 commits whose task a merged pull request names). Its `memory_index_state` row records the commit time in `source_mtime_ms` and whether it found its task in `entry_count` (1 or 0), which is how a young unlinked commit is tried again. A commit whose task is deleted is unlinked by the next sweep: its state row's `entry_count` goes to 0 first, then its chunk's `task_id` to NULL, so a sweep cut off between the two still finds it on the deleted task and finishes it. Last comes `code`, only while `knowledgeGraph.sourceCode` is on: a source file or doc on the default branch as committed, `doc_id` = its repository path, split at top-level declarations into passages of up to 1,600 characters that each open with the path (`code/code-record.ts`). A code row has no session, no task and no timestamps, and is embedded but kept out of the full-text index (below).

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

Constraint: `UNIQUE(corpus, doc_id, seq)`, whose own index serves a document's chunks in seq order. Indices: `idx_memory_chunks_doc_embedded` (corpus, doc_id, embedded_model), `idx_memory_chunks_session` (session_id), `idx_memory_chunks_task` (task_id; a search scoped to one task reads that task's chunk ids from it, 184 ms to 0.5 ms on 99k chunks), `idx_memory_chunks_embedded` (embedded_model), `idx_memory_chunks_corpus` (corpus), and `idx_memory_chunks_pending` (embedded_model, corpus). SQLite appends rowid to every index, so the last two answer per-corpus reads as seeks in id order: the map's scan and signature (a projection page measured 142 ms without them and 0.2 ms with, on 92k chunks) and the embedding drain's next never-embedded chunks of one corpus (214 ms against 0.01 ms). `idx_memory_chunks_doc_embedded` covers the per-document chunk and embedded totals the Knowledge Graph's coverage groups by, so that count never reads the table (266 ms to 10 ms on 93k chunks). It replaced `idx_memory_chunks_doc` (corpus, doc_id, seq), which duplicated the unique constraint's index and is dropped on open. `idx_memory_chunks_doc_embedded`, `idx_memory_chunks_task`, `idx_memory_chunks_corpus` and `idx_memory_chunks_pending` are not built by the migrations: the retrieval worker builds any that are missing as the last step of its storage upkeep (`index.buildWhenQuiet`, `retrieval/index-builds.ts`), one at a time, each once no other connection has committed for 2 s (read from `PRAGMA data_version`, with a 10 minute cap), and logs how long each took and which way its wait ended. Building one reads the whole table inside a write transaction (180 to 245 ms each on 97k chunks), so main and the pty host wait for any write they make meanwhile: built at the open sweep instead, the four landed on main's startup writes and held them for 542 ms. A migration runs on main. No trigger removes a deleted session's documents (its conversation, its subagent walk and the files it changed): the record sweep that follows every board change does (`ConversationIndexer.purgeDeletedSessions`, one document at a time, 64 chunks per transaction), so a deleted session's chunks stay searchable until that sweep, a few seconds later. The `trg_sessions_delete_memory` trigger that used to do it inside the session delete's own transaction is dropped on open.

## memory_chunks_fts (FTS5)

FTS5 external-content virtual table over `memory_chunks.text` (`content='memory_chunks'`, `content_rowid='id'`, `tokenize='unicode61 remove_diacritics 2'`), kept in sync by the `trg_memory_chunks_fts_ai`/`_ad`/`_au` triggers, each `WHEN corpus <> 'code'`: source code is found by meaning only (over 17 code questions, keyword search put the answer file in the top five 12 times against 16 by meaning), and keeping its 12k chunks out keeps every other keyword search from walking them. They replaced the unconditional `trg_memory_chunks_ai`/`_ad`/`_au`, which are dropped on open. Provides `bm25()` ranking and `snippet()` for conversation search. FTS5 is compiled into the shipped better-sqlite3, so this needs no extra dependency.

## Vector tables (vec0)

The vector tables (`USING vec0`, rowid = chunk id, `chunk_size=128`) are one per embedded corpus: `memory_vec_conversation` for conversations, `memory_vec_task` for task records, and `memory_vec_code` for source code (`vecTableName`, `EMBEDDED_CORPORA`). Releases before #529 stored conversations in `memory_chunks_vec` at vec0's default chunk size of 1,024, where the first vector of each new chunk zero-fills 4 MB inside the embedding write (a median 13 ms lock hold per batch with a 2 MB page cache, against 0.13 ms at 128). vec0 0.1.9 has no rename, so the retrieval worker copies that table into `memory_vec_conversation` at project open (`vec.migrateLayout`, `vec-layout.ts`): 16 vectors a step in short transactions, each step's chunk ids read by rowid (`CONVERSATION_VEC_COPY_IDS_SQL`) because the copy runs before the worker's indexes exist, and planned off the unique index a step sorted every conversation chunk (213 ms), its position in `memory_meta` (`vec_conversation_copy_through`) so it resumes, every embedding write and delete reaching both tables meanwhile, reads switched in one write, then the old table freed one 4 MB block per transaction before it is dropped. On the real install: 95,791 vectors in 6 minutes of worker time, no write transaction at 8 ms or more, the WAL at most 44 MB. Like the legacy transcript conversion, the record sweeps, the embedding writeback, the map's sums, and the corpus purges and model resets (a chunker change purges every conversation chunk on its own), it takes the write lock only within the worker's one shared budget for that database (`retrieval/write-budget.ts`): 20% of wall time while no other connection has committed for 2 s, and 5%, with background commits at least 50 ms apart, while one has (on the upgrade dry run, 20% made 11% of the board's writes wait a 15.6 ms timer tick). Its commits checkpoint like any worker write, at most once a second. Session changes and commits are kept as text only: ranking by the changes lowered recall on the real index, embedding the commits bought no recall that searching them by keyword did not, and the task summaries read the text of both. One table per corpus rather than a corpus column, because reading a vector back out costs 1.14 ms a row (a copy of the conversation table would have been about 105 s of synchronous reads) and a small table of its own gives an exact per-corpus top k (3.0 ms for 2.9k rows). A search over several corpora merges the tables by distance. They are NOT created by migrations: they need the sqlite-vec extension loaded, which only the retrieval worker loads and which may be unavailable, so the worker's `RetrievalStore.ensureVecTable()` creates them lazily at runtime only when the extension loaded. No trigger references them: main and the pty host never load the extension, so a trigger body naming vec0 would fail every write that fired it there. Vec rows are cleaned by the worker's own code.

## memory_index_state table

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
| resume_point | TEXT | | |

Constraint: `PRIMARY KEY (corpus, doc_id)`. `status` is one of `ok`, `unsupported`, `missing-source`, `error`.

`resume_point` is where the next walk of a conversation transcript starts, as JSON (`ResumePoint` in `src/main/retrieval/conversation/conversation-indexer.ts`): the start of the last window of the walk that advanced, the chunks and entries before it, the usage-attribution carry there, a hash of the 4 KB before it, and the session and task it was written for. A live conversation is indexed after every turn, and each walk from byte 0 parsed every window of the transcript; resumed, it parses the last window and what follows it, with the same result. A walk from byte 0 happens instead when the owner changed (a new session row re-points every chunk and turn), the path changed, the file shrank below the point, the hash no longer matches, or a chunk before the point is gone. Other corpora leave it null. Added in place on an existing database (`ALTER TABLE ... ADD COLUMN`).

## transcript_archive_state and transcript_archive_rows tables

The structured transcript archive (`src/main/retrieval/archive/transcript-archive.ts`): each session's parsed conversation (`TranscriptEntry[]`, as the Conversation tab renders it), kept so it stays readable after the agent CLI deletes its own file (Claude Code removes transcripts older than its `cleanupPeriodDays`). Before it, a deleted transcript left only the index's chunks, which keep the text and lose the structure. Read and written only by the retrieval worker, and written whatever the Knowledge Graph indexing switch says: it needs no model. Measured over one project's 629 conversations still on disk: 4.6 GB of JSONL parses to 470 MB of entries, 86 MB at Brotli quality 9 (gzip: 118 MB; zstd level 9: 89 MB, but Node 24 still marks zstd Experimental). No per-span clamp in storage: it would have cut 78 user messages and 1,371 tool results to save 3%, so reads clamp as a live read does.

`transcript_archive_state`, one row per conversation:

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| agent_session_id | TEXT | PRIMARY KEY | |
| session_id | TEXT | | |
| source_path | TEXT | | |
| resume_offset | INTEGER | NOT NULL | 0 |
| check_hash | TEXT | | |
| carry | TEXT | | |
| source_size | INTEGER | | |
| source_mtime_ms | REAL | | |
| revision | INTEGER | NOT NULL | 0 |
| updated_at | TEXT | NOT NULL | |

`transcript_archive_rows`, the entries of one walked window per row, its payload split into pieces:

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| agent_session_id | TEXT | NOT NULL | |
| row_start | INTEGER | NOT NULL | |
| piece | INTEGER | NOT NULL | |
| piece_count | INTEGER | NOT NULL | |
| source_end | INTEGER | NOT NULL | |
| entry_count | INTEGER | NOT NULL | |
| payload | BLOB | NOT NULL | |

Constraint: `PRIMARY KEY (agent_session_id, row_start, piece)`. A walk tiles the source file in the indexer's 8 MiB windows (`parseTranscriptWindow`), and each window with entries is one row keyed by its first byte, `JSON.stringify` of its entries Brotli-compressed and cut into 48 KB pieces so each insert fits the worker's per-transaction budget. Only the newest row is open: `resume_offset` is its start, the next walk re-parses from there with the usage `carry` as it stood, and rows before it never change. `check_hash` (sha1 of the 4 KB before `resume_offset`) tells an appended file from a rewritten one, which is walked from byte 0 with its old rows replaced only once the new walk produced entries; `source_size` and `source_mtime_ms` let an unchanged file skip the walk, and a whole-file walk that found no entries still records them. A missing file changes nothing. `revision` bumps on every write and on a walk that failed after it began replacing rows, and reads are cached by it, per database and conversation. A purge drops the conversation's cached read, since a re-archived one starts again at revision 1. A row whose payload is not a list of entries is skipped on read, and so is an element without a string `kind`.

Written on a settled turn, a suspend and an exit (`archive.session`, per-session debounce), and by the project-open pass (`archive.sweep`), which archives every conversation whose file changed, oldest first by the file's time, with no per-open cap. The same pass purges every conversation no `sessions` row names (a deleted task, a move to another project, a To Do reset); a workflow's own agent and a Command Terminal have no session row and are never archived. Read by `resolveSessionTranscript` between the live file and the index chunks (`TranscriptSource` `'archive'`, the newest rows up to the same 16 MB of source a live read has, stopping before the row that would pass it, but always keeping at least one, with the same `truncated` notice), by `kangentic_get_transcript`, by the recap a resume of a deleted conversation starts from, and one row at a time by the Conversation viewer's history pages (`readArchivedPage`).

`row_start` is the window's `startByte` as `parseTranscriptWindow` reports it, which points AT the newline before the window's first line, not at the line's first byte the way a live page's cursor does (except 0). `archiveRowLineStart(rowStart)` in `transcript-archive.ts` is the one place that converts it: the notice's position and every archived page's position are line starts, so a cursor from the live file continues against the archive once the file is gone. A query comparing `row_start` with a cursor directly would stop one byte short and ask for the same row again forever. Nothing bounds the archive by Claude's managed `cleanupPeriodDays`: the index already keeps conversation text past Claude's cleanup, so a policy bound belongs on both together.

## memory_task_summaries table

One summary per finished task: a sentence or two the Knowledge Graph's agent wrote (a task summary in the UI, on by default in the Index card) about what the task set out to do and what it did (`src/main/retrieval/summary/`). It is carried in the task's record (the `task` corpus, as a `Summary:` line), so it is searched, and shown beside the task in Ask's related work. A summary never holds a `#N`: Ask's answering agent names tasks that way, so a PR number would read as a task. The prompt asks for none, and the parser drops what the model writes anyway (about one Sonnet summary in five ended "merged in PR #306").

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| task_id | TEXT | PRIMARY KEY | |
| summary | TEXT | NOT NULL | |
| input_hash | TEXT | NOT NULL | |
| agent | TEXT | NOT NULL | |
| model | TEXT | | |
| effort | TEXT | | NULL |
| created_at | TEXT | NOT NULL | |

`input_hash` is a hash of what the summary was written from (title, the start of the description, the files the task's sessions changed, the subjects of the commits it landed on the default branch, and how its latest sessions ended), so a task whose input moved is rewritten. A task with no commits carries no commits line at all, so adding commits to the input rewrote only the summaries of tasks that have some. A summary is text an agent wrote and cannot be re-derived, so only the summary pass removes rows, for a task that no longer exists; switching summaries off keeps them. `agent`, `model` and `effort` record what wrote each one, since a new agent or model applies only to new and changed tasks until the Index card's Rebuild, which empties `input_hash` on the finished tasks' summaries written any other way, in every project, so the next pass rewrites them; each keeps its text until then. A summary always runs at the adapter's recommended effort, so `effort` changes only with the agent. `effort` is added by migration to a table made before it.

## memory_meta table

Key/value bookkeeping for the memory index: the chunker version, each record sweep's position
(the commit and code index heads), the vector layout copy's progress, the legacy transcript
conversion's progress, and the Knowledge Graph's cached map and region names (`graph_` keys).

- `chunker_version` - a mismatch against the current chunker version purges and reindexes the project's conversations and the session changes read from them; task records are left in place.
- `vec_dims` - the width of the vector tables, set from the selected embedding model. A width change, or a model change (`vec_model`), forces a full re-embed, since vec0 tables are fixed-width.
- `vec_model` - the model tag the vector tables hold, written by the embedding drain. A different selected model resets the tables even at the same width, and `searchSemantic` returns no vector hits while the tag differs, so a query answers by keyword until the drain has reset them. An index from before the key resets only if a stored vector came from another model. `resetVec` deletes the key, so the next model to write claims the tables.
- `graph_projection_v11` - the Knowledge Graph's cached projection (nodes, edges, the three region carve-ups, the 3D layout, each conversation's agent/model/effort and its duration/cost/tokens, the exact per-node neighbour lists, the index size on disk, and the corpus signature it was built from), JSON-encoded. The version suffix must be bumped whenever the payload SHAPE changes, because the freshness signature does not move for it and a stale blob would otherwise be served and rendered. It is bumped for a change to the CLUSTERING too, for the same reason: v6 chose the region count from the data, v8 replaced that score with a size rule, and v10 raised the region ceiling and stopped choosing the count from a leading slice of the corpus - none of which alters the shape, but each of which would otherwise keep serving the previous carve-up forever.
- `graph_region_names` - region names made with task summaries, laid over the cached projection: the projection signature and labeller version they were made for, whether summaries were on (`off` or the summaries' fingerprint), and the names by region id. Shown only while all three still match, so a rebuilt map or a summaries switch never shows another map's names.
- `commit_index_head` - the ref (`origin/<base>` or `<base>`) and head sha the commit corpus was last read at, and the commit record version. A sweep whose head has not moved stops at one `git rev-parse`; a head that moved forward is read from this sha on, and anything else is read whole and reconciled. A read of the whole branch (the first, or after a rewrite) waits until a minute after launch, clear of startup's own load, and the summary pass waits with it so its summaries see the commits.
- `commit_relink_marker` - the newest conversation `indexed_at` the last retry of young unlinked commits saw. The retry runs only when a conversation was indexed since, or when commits of a deleted task were unlinked (which empties the marker), since only those can change its answer.
- `code_index_head` - the ref and head sha the code corpus was last read at, and the code record version. A sweep whose head has not moved stops at one `git rev-parse`. One that moved lists the tree and re-reads only the files whose blob id changed, each file's blob id being kept on its `memory_index_state` row as `code-record-v<version>:<blob>`. The first fill waits until a minute after launch, as a whole-branch commit read does. The Knowledge Graph's Index panel and the Source code line in Settings read the corpus this ref fills. The ref is `origin/<base>`, else `<base>`, else `origin/HEAD`, else the checked-out HEAD.

The projection key is version-suffixed so a format change invalidates the cache rather than being mis-parsed: `v1` -> `v2` added a 3D layout beside the flat one, `v2` -> `v3` dropped the flat one so a node carries a single `x, y, z`. The freshness signature is `modelTag:chunkCount:maxChunkId`, which a change to the layout's SHAPE does not move, so without a bump an older blob would have matched and been served with coordinates the renderer does not have. Bump the projection key on every shape change; the signature will not do it for you. The vector sums behind the projection are rows of `memory_doc_sums`, so a layout change leaves them alone and a rebuild stays the kNN plus the layout rather than a read of every vector.

| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

## memory_doc_sums table

Each document's vector sum behind the Knowledge Graph's projection (`src/main/retrieval/graph/projection-engine.ts`), so a rebuild reads the vectors of changed documents only. Reading every embedding costs about 62 s on a large index (vec0 decodes each one), which this keeps a one-time cost. The sums were one JSON blob in `memory_meta` before, 19 MB rewritten whole on every rebuild.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| corpus | TEXT | NOT NULL | |
| doc_id | TEXT | NOT NULL | |
| version | INTEGER | NOT NULL | 0 |
| model_tag | TEXT | NOT NULL | |
| dimensions | INTEGER | NOT NULL | |
| chunk_count | INTEGER | NOT NULL | |
| embedded_count | INTEGER | NOT NULL | |
| indexed_at | TEXT | | |
| text_bytes | INTEGER | NOT NULL | |
| folded_count | INTEGER | NOT NULL | |
| full_sum | BLOB | | |
| prefix_through_seq | INTEGER | NOT NULL | -1 |
| prefix_count | INTEGER | NOT NULL | 0 |
| prefix_text_bytes | INTEGER | NOT NULL | 0 |
| prefix_sum | BLOB | | |

Constraint: `PRIMARY KEY (corpus, doc_id)`. Both sums are Float64 bytes, one value per dimension.

- A row holds while its model, width, chunk and embedded counts, and `indexed_at` still match the index. The index time catches a live conversation's newest chunk rewritten at the same count. An absent index time, which Rebuild index leaves while it re-indexes, counts as unchanged.
- The prefix is the run of chunks from seq 0 whose vectors are all in `prefix_sum`. It ends below the first chunk with no vector and two short of the newest chunk, since appending entries to a transcript rewrites at most its last chunk. A document that changed is read again from its prefix on, so a turn of a live conversation reads a few vectors, not the whole conversation.
- Two triggers on `memory_chunks` clear `full_sum` and bump `version` when any chunk of the document is deleted (`trg_memory_chunks_doc_sums_ad`) or loses or changes its vector (`trg_memory_chunks_doc_sums_au`), and empty the prefix when that chunk is in it. A model switch resets every vector first (`resetVec`, at any width), and the trigger fires on that loss; a vector replaced in place would move no count and no index time, so the cleared `full_sum` is what sends the document back to be read either way. Being triggers, they hold for any path that writes a chunk, including the record sweep's purge of a deleted session's conversation.
- A pass writes a row only if its `version`, the live counts and `indexed_at` are still what it read (`RetrievalStore.writeDocSums`), so a document re-indexed while the pass yielded is read again by the next pass rather than stored stale.
- `text_bytes` is `octet_length(text)` over the document's chunks, the text half of the index size on disk. A document with nothing embedded still has a row, for its size.
- Rows of a document gone from the index are deleted by the next pass. A purge of a corpus (a chunker change, the Rebuild of a corpus) and a model switch delete them a few rows per transaction.
