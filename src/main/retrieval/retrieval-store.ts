import type Database from 'better-sqlite3';
import { hasVecSupport } from './vec-support';
import { BOARD_TASK_FACTS_SQL, type BoardTaskFactsRow } from './board-task-facts';
import { EMBEDDED_CORPORA, isMemoryCorpus, MEMORY_CORPORA, vecTableName, type MemoryCorpus } from './corpora';
import {
  CONVERSATION_VEC_COPY_KEY,
  CONVERSATION_VEC_TABLE,
  LEGACY_CONVERSATION_VEC_BLOCKS,
  LEGACY_CONVERSATION_VEC_TABLE,
  legacyConversationVecPending,
  setVecLayout,
  vecLayout,
} from './vec-layout';
import type {
  ChunkInput,
  ChunkPlacement,
  CorpusDocumentRef,
  IndexStateRow,
  LexicalHit,
  SemanticHit,
  StoredChunk,
} from './types';
import { writeTransaction } from '../db/transaction';

/** Ids per `IN (...)` in `getChunkPlacements`. */
const PLACEMENT_BATCH = 500;

interface ExistingChunkRow {
  id: number;
  seq: number;
  content_hash: string;
  turn_uuid_start: string | null;
  turn_uuid_end: string | null;
  session_id: string | null;
  task_id: string | null;
}

/**
 * Chunks inserted per write transaction, and chunk ids deleted per one. The
 * index and the rest of the app write the same database, and SQLite lets one
 * connection write at a time, so a main commit that lands during an index
 * write waits for it, on main's thread (better-sqlite3's busy wait sleeps in
 * place). The target is under 5 ms a transaction. 64 chunks with their
 * full-text rows took about 2 ms in a node:sqlite rig, but a slice of that size
 * took 16 to 39 ms in the app on real task text, hence 16.
 */
export const CHUNKS_PER_TRANSACTION = 16;
export const DELETES_PER_TRANSACTION = 64;

/**
 * Vectors per vec0 storage chunk. vec0 allocates a whole chunk, zero-filled,
 * when the first vector lands in it: at its default of 1,024 and 1,024
 * dimensions that is a 4 MB write inside the embedding write's transaction,
 * which held the write lock 23 to 76 ms about once per thousand vectors. At
 * 128 it is 512 KB (measured on 30k real vectors: no batch of 8 at 16 ms or
 * more, against 30 of 3,750 at 1,024; a k=1000 KNN 115 ms against 122).
 *
 * Set when a table is created, and vec0 0.1.9 has no rename: the conversation
 * table older releases made at 1,024 is copied into one at this size by the
 * retrieval worker (`vec-layout.ts`, `vec.migrateLayout`).
 */
const VEC_CHUNK_SIZE = 128;

/** The column and chunk size of an embedded corpus's vec0 table. */
function vecTableDefinition(dimensions: number): string {
  return `USING vec0(embedding float[${dimensions}], chunk_size=${VEC_CHUNK_SIZE})`;
}

/**
 * Bytes of document sums written per transaction, and sums rows deleted per
 * one. A row holds two Float64 sums, 16 KB at 1,024 dimensions, so the cap is
 * the same 64 KB a record slice may write (`timed-slices.ts`).
 */
const SUM_BYTES_PER_TRANSACTION = 64 * 1024;
const DOC_SUMS_DELETED_PER_TRANSACTION = 4;

interface StoredChunkRow {
  id: number;
  corpus: string;
  doc_id: string;
  seq: number;
  session_id: string | null;
  task_id: string | null;
  agent_session_id: string | null;
  role: string;
  text: string;
  content_hash: string;
  token_estimate: number;
  ts_start: number | null;
  ts_end: number | null;
  turn_uuid_start: string | null;
  turn_uuid_end: string | null;
  embedded_model: string | null;
}

/** One chunk as a paged text read returns it. */
export interface ChunkTextRow {
  seq: number;
  text: string;
  sessionId: string | null;
  taskId: string | null;
  tsEnd: number | null;
}

function toStoredChunk(row: StoredChunkRow): StoredChunk {
  return {
    id: row.id,
    corpus: row.corpus,
    docId: row.doc_id,
    seq: row.seq,
    sessionId: row.session_id,
    taskId: row.task_id,
    agentSessionId: row.agent_session_id,
    role: row.role,
    text: row.text,
    contentHash: row.content_hash,
    tokenEstimate: row.token_estimate,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    turnUuidStart: row.turn_uuid_start,
    turnUuidEnd: row.turn_uuid_end,
    embeddedModel: row.embedded_model,
  };
}

/** A corpus list for SQL: one placeholder per corpus. */
function corpusPlaceholders(corpora: ReadonlyArray<MemoryCorpus>): string {
  return corpora.map(() => '?').join(',');
}

/** Prepared statements per connection (see `RetrievalStore.prepared`). Weak, so
 *  a closed connection's statements go with it. */
const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** One of a document's chunks as a projection pass reads it. */
export interface ChunkState {
  id: number;
  seq: number;
  embedded: boolean;
  textBytes: number;
}

/** A document's stored prefix (see `memory_doc_sums` in the project schema). */
export interface DocSumPrefix {
  /** -1 when the document has no prefix. */
  prefixThroughSeq: number;
  prefixCount: number;
  prefixTextBytes: number;
  prefixSum: Float64Array | null;
}

/** A document's stored prefix as `docSumPrefix` reads it. */
export interface StoredDocSumPrefix extends DocSumPrefix {
  version: number;
  modelTag: string;
  dimensions: number;
}

/** A document's stored sums, as a page of them reads. */
export interface DocSumRow {
  docId: string;
  version: number;
  modelTag: string;
  dimensions: number;
  chunkCount: number;
  embeddedCount: number;
  indexedAt: string | null;
  textBytes: number;
  foldedCount: number;
  fullSum: Float64Array | null;
  prefixThroughSeq: number;
}

/** Sums a pass computed for one document, and the row version it read. */
export interface DocSumWrite extends Omit<DocSumRow, 'version'>, Omit<DocSumPrefix, 'prefixThroughSeq'> {
  /** The row's version when the pass read it, or null when there was no row. */
  expectedVersion: number | null;
}

/** A Float64 sum from its stored bytes, copied so it does not alias SQLite's buffer. */
function toFloat64(blob: Buffer | null): Float64Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 8 !== 0) return null;
  const sum = new Float64Array(blob.byteLength / 8);
  new Uint8Array(sum.buffer).set(blob);
  return sum;
}

function toBlob(sum: Float64Array | null): Buffer | null {
  return sum ? Buffer.from(sum.buffer, sum.byteOffset, sum.byteLength) : null;
}

/**
 * Per-project-DB retrieval store. Owns memory_chunks (+ its FTS5 shadow) and
 * memory_index_state. The vector tables (one per corpus, see `corpora.ts`) are
 * created lazily by ensureVecTable() only when the sqlite-vec extension loaded
 * for this connection; all vec methods no-op when it did not, so the whole
 * engine degrades to lexical-only structurally.
 */
export class RetrievalStore {
  /** The corpora whose vec table exists on this connection. */
  private readonly vecTables = new Set<MemoryCorpus>();

  /** The vec0 table `corpus` reads and writes on this connection: the
   *  conversation one follows the layout while its old table is copied. */
  private tableOf(corpus: MemoryCorpus): string {
    return corpus === 'conversation' ? vecLayout(this.db).conversationTable : vecTableName(corpus);
  }

  constructor(private readonly db: Database.Database) {
    // The vec tables' dimension is fixed by the selected model, which only the
    // embedding path knows, so the store does NOT create them here. It only
    // DISCOVERS existing tables (created earlier by ensureVecTable) so the
    // search path can query them. A fake DB (unit tests) is never vec-capable,
    // so this no-ops and never runs the sqlite_master query.
    if (hasVecSupport(db)) {
      for (const corpus of MEMORY_CORPORA) {
        try {
          const exists = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(this.tableOf(corpus));
          if (exists !== undefined) this.vecTables.add(corpus);
        } catch {
          // Treated as absent: that corpus searches lexically only.
        }
      }
    }
  }

  // --- Document write path -------------------------------------------------

  /**
   * Diff-upsert one document's chunks by (seq, contentHash). The identical
   * leading prefix is left untouched (preserving embeddings on a resumed
   * session's re-finalize); from the first divergent seq onward, old rows are
   * deleted and the new chunks inserted. UNIQUE(corpus, doc_id, seq) is the
   * hard backstop against duplicates.
   *
   * Written in short transactions, not one: the prefix's anchors and owners
   * first, then the diverged tail deleted `DELETES_PER_TRANSACTION` ids at a
   * time, then the new chunks inserted `CHUNKS_PER_TRANSACTION` at a time. A
   * first index of a long conversation is thousands of chunks, and one
   * transaction would hold the database's write lock for all of them. Between
   * transactions a reader can see the document part-written; the caller writes
   * its index state last, so a crash part-way leaves it stale and the next pass
   * finishes the job. Inside a caller's own transaction these nest as
   * savepoints, as before.
   *
   * `fromSeq` says `chunks` start at that seq and the stored chunks below it
   * are the caller's, unchanged, owner included: a resumed walk of a growing
   * transcript passes only its tail (`ConversationIndexer`). Those rows are not
   * read, diffed or re-owned. The tail is diffed as the whole document is.
   */
  upsertDocument(
    ref: CorpusDocumentRef,
    chunks: ChunkInput[],
    fromSeq = 0,
  ): { insertedIds: number[]; deletedIds: number[] } {
    const existing = this.db
      .prepare(
        `SELECT id, seq, content_hash, turn_uuid_start, turn_uuid_end, session_id, task_id
         FROM memory_chunks WHERE corpus = ? AND doc_id = ? AND seq >= ? ORDER BY seq ASC`,
      )
      .all(ref.corpus, ref.docId, fromSeq) as ExistingChunkRow[];
    const existingBySeq = new Map<number, ExistingChunkRow>();
    for (const row of existing) existingBySeq.set(row.seq, row);

    // First seq where new content diverges from stored content.
    let divergence = fromSeq;
    const end = fromSeq + Math.max(existing.length, chunks.length);
    for (; divergence < end; divergence++) {
      const incoming = chunks[divergence - fromSeq];
      const stored = existingBySeq.get(divergence);
      if (!incoming || !stored || incoming.contentHash !== stored.content_hash) break;
    }

    const deletedIds: number[] = [];
    for (const row of existing) {
      if (row.seq >= divergence) deletedIds.push(row.id);
    }

    {
      // Re-anchor the identical leading prefix. Those rows are left in place to
      // preserve their embeddings, but `content_hash` is `sha1(text)` only, so a
      // chunk whose TEXT is unchanged while its turn uuids changed looks
      // identical to the diff above and would keep its old anchors forever. That
      // is not hypothetical: it is what a uuid-scheme change produces, and it is
      // why "Rebuild index" (`resetIndexState`) could not repair one. Updating
      // these two columns fires no FTS trigger (that one is `AFTER UPDATE OF
      // text`) and leaves `content_hash` alone, so nothing is re-embedded.
      //
      // Reach, precisely: this repairs a document only on a pass that actually
      // re-parses it. A sweep SKIPS a session whose source signature is
      // unchanged (`needsIndex`), so a finished session is repaired only once
      // "Rebuild index" clears the state rows and forces the re-parse. A
      // session whose transcript is GONE is never repaired at all: it returns
      // `missing-source` before reaching here and keeps its chunks, and
      // `entriesFromIndex` is exactly what serves those stale anchors to the
      // viewer. Both populations degrade gracefully (an unresolvable anchor
      // opens the full transcript), but neither self-heals.
      const reanchors: Array<{ id: number; start: string | null; end: string | null }> = [];
      for (const chunk of chunks) {
        if (chunk.seq >= divergence) continue;
        const stored = existingBySeq.get(chunk.seq);
        if (!stored) continue;
        if (stored.turn_uuid_start === chunk.turnUuidStart && stored.turn_uuid_end === chunk.turnUuidEnd) {
          continue;
        }
        reanchors.push({ id: stored.id, start: chunk.turnUuidStart, end: chunk.turnUuidEnd });
      }

      // Refresh ownership of the identical leading prefix. That prefix is left
      // in place to preserve its embeddings, but a resumed session re-indexes
      // the SAME agent transcript (same doc_id) under a NEW session row, so
      // those untouched rows would otherwise keep the OLD session_id. Re-point
      // them (and task_id) at the current session so the search badge (Terminal
      // vs History) stays accurate and the session-delete trigger - which keys
      // on session_id - tracks the live session instead of leaving orphans or
      // wiping a still-active conversation. Updating these columns does not fire
      // the FTS 'AFTER UPDATE OF text' trigger and does not touch embeddings.
      // Only when some prefix row's owner actually differs: on an ordinary turn
      // none does, and this rewrote every earlier chunk of the conversation.
      const reown = existing.some((row) => row.seq < divergence
        && (row.session_id !== ref.sessionId || row.task_id !== ref.taskId));

      if (reanchors.length > 0 || reown) {
        writeTransaction(this.db, () => {
          const reanchor = this.db.prepare(
            'UPDATE memory_chunks SET turn_uuid_start = ?, turn_uuid_end = ? WHERE id = ?',
          );
          for (const row of reanchors) reanchor.run(row.start, row.end, row.id);
          if (reown) {
            this.db
              .prepare(
                `UPDATE memory_chunks SET session_id = ?, task_id = ?
                 WHERE corpus = ? AND doc_id = ? AND seq >= ? AND seq < ? AND (session_id IS NOT ? OR task_id IS NOT ?)`,
              )
              .run(ref.sessionId, ref.taskId, ref.corpus, ref.docId, fromSeq, divergence, ref.sessionId, ref.taskId);
          }
        })();
      }
    }

    // FTS rows are removed by the AFTER DELETE trigger; vec rows are not (no
    // trigger may touch the vec table), so `deleteChunks` removes them in-code.
    this.deleteChunks(deletedIds, ref.corpus);

    const insertedIds: number[] = [];
    const now = new Date().toISOString();
    const tail = chunks.filter((chunk) => chunk.seq >= divergence);
    for (let start = 0; start < tail.length; start += CHUNKS_PER_TRANSACTION) {
      const batch = tail.slice(start, start + CHUNKS_PER_TRANSACTION);
      writeTransaction(this.db, () => {
        const insert = this.db.prepare(
          `INSERT INTO memory_chunks
            (corpus, doc_id, seq, session_id, task_id, agent_session_id, role, text,
             content_hash, token_estimate, ts_start, ts_end, turn_uuid_start, turn_uuid_end,
             embedded_model, meta_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        );
        for (const chunk of batch) {
          const result = insert.run(
            ref.corpus,
            ref.docId,
            chunk.seq,
            ref.sessionId,
            ref.taskId,
            ref.agentSessionId,
            chunk.role,
            chunk.text,
            chunk.contentHash,
            chunk.tokenEstimate,
            chunk.tsStart,
            chunk.tsEnd,
            chunk.turnUuidStart,
            chunk.turnUuidEnd,
            ref.metaJson,
            now,
          );
          insertedIds.push(Number(result.lastInsertRowid));
        }
      })();
    }

    return { insertedIds, deletedIds };
  }

  /** One document gone, its chunks deleted `DELETES_PER_TRANSACTION` at a time
   *  and its index state last. */
  deleteDocument(corpus: string, docId: string): void {
    const ids = (
      this.db
        .prepare('SELECT id FROM memory_chunks WHERE corpus = ? AND doc_id = ?')
        .all(corpus, docId) as Array<{ id: number }>
    ).map((row) => row.id);
    this.deleteChunks(ids, corpus);
    writeTransaction(this.db, () => {
      this.db.prepare('DELETE FROM memory_index_state WHERE corpus = ? AND doc_id = ?').run(corpus, docId);
    })();
  }

  /**
   * Documents whose session row is gone (a deleted task or session), as their
   * index state records them: a conversation, its subagent walk and the files
   * it changed. Replaces the session-delete trigger that deleted them inside
   * main's own transaction: the record sweep deletes these a page at a time
   * instead. A primary-key probe of `sessions` per state row, a few thousand
   * rows at most.
   */
  deletedSessionDocuments(limit: number): Array<{ corpus: string; docId: string }> {
    return this.prepared(
      `SELECT corpus, doc_id AS docId FROM memory_index_state AS state
        WHERE session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = state.session_id)
        LIMIT ?`,
    ).all(limit) as Array<{ corpus: string; docId: string }>;
  }

  /**
   * Documents holding chunks of a deleted session, read from the chunks rather
   * than the index state: a document whose writer died between its chunk
   * batches and its state row (written last) has no state to find it by. A
   * scan of the covering `idx_memory_chunks_session` index (7 ms on 36k
   * chunks), so it runs at project open, not on every board change. A document
   * whose index state names a live session is someone's, whatever one stale
   * chunk says (an owner rewrite in flight), and is left alone.
   */
  deletedSessionChunkDocuments(limit: number): Array<{ corpus: string; docId: string }> {
    return this.prepared(
      `SELECT DISTINCT chunk.corpus, chunk.doc_id AS docId FROM memory_chunks AS chunk
        WHERE chunk.session_id IN (
          SELECT DISTINCT session_id FROM memory_chunks AS orphan
           WHERE session_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = orphan.session_id))
          AND NOT EXISTS (
            SELECT 1 FROM memory_index_state AS state JOIN sessions ON sessions.id = state.session_id
             WHERE state.corpus = chunk.corpus AND state.doc_id = chunk.doc_id)
        LIMIT ?`,
    ).all(limit) as Array<{ corpus: string; docId: string }>;
  }

  /** How many of one document's chunks sit below `seq`: equal to `seq` while
   *  a resumed walk's untouched prefix is intact. A range count on the
   *  UNIQUE(corpus, doc_id, seq) index. */
  documentChunkCountBelow(corpus: string, docId: string, seq: number): number {
    const row = this.prepared('SELECT count(*) AS chunks FROM memory_chunks WHERE corpus = ? AND doc_id = ? AND seq < ?')
      .get(corpus, docId, seq) as { chunks: number };
    return row.chunks;
  }

  /** The chunks one document holds: what deleting it writes. */
  documentChunkCount(corpus: string, docId: string): number {
    const row = this.db
      .prepare('SELECT count(*) AS chunks FROM memory_chunks WHERE corpus = ? AND doc_id = ?')
      .get(corpus, docId) as { chunks: number };
    return row.chunks;
  }

  /**
   * Some corpora gone, the rest untouched. A chunker change invalidates the
   * conversation chunks (and what is derived from them), not the task records.
   * Their chunks go `DELETES_PER_TRANSACTION` at a time: a whole corpus is tens
   * of thousands of rows, each with a full-text delete behind it.
   */
  purgeCorpora(corpora: ReadonlyArray<MemoryCorpus>): void {
    if (corpora.length === 0) return;
    // One corpus at a time, so each page is a seek on `(corpus)` in id order
    // rather than a sort of every remaining row.
    const page = this.db.prepare(`SELECT id FROM memory_chunks WHERE corpus = ? ORDER BY id LIMIT ${DELETES_PER_TRANSACTION}`);
    for (const corpus of corpora) {
      for (;;) {
        const ids = (page.all(corpus) as Array<{ id: number }>).map((row) => row.id);
        if (ids.length === 0) break;
        this.deleteChunks(ids, corpus);
      }
    }
    writeTransaction(this.db, () => {
      this.db.prepare(`DELETE FROM memory_index_state WHERE corpus IN (${corpusPlaceholders(corpora)})`).run(...corpora);
      // Any vector left without a chunk; the table is otherwise empty by now.
      for (const corpus of corpora) {
        if (this.hasVecTable(corpus)) this.db.prepare(`DELETE FROM ${this.tableOf(corpus)}`).run();
        const copyTarget = corpus === 'conversation' ? vecLayout(this.db).copyTarget : null;
        if (copyTarget) this.db.prepare(`DELETE FROM ${copyTarget}`).run();
      }
    })();
    for (const corpus of corpora) this.clearDocSums(corpus);
  }

  /** Every stored document sum of one corpus, a few rows per transaction:
   *  each row is two vector sums, 16 KB at 1,024 dimensions. */
  private clearDocSums(corpus: MemoryCorpus): void {
    const clearPage = this.prepared(
      `DELETE FROM memory_doc_sums WHERE rowid IN
         (SELECT rowid FROM memory_doc_sums WHERE corpus = ? LIMIT ${DOC_SUMS_DELETED_PER_TRANSACTION})`,
    );
    for (;;) {
      const cleared = writeTransaction(this.db, () => clearPage.run(corpus).changes)();
      if (cleared === 0) break;
    }
  }

  /** Chunks gone by id, `DELETES_PER_TRANSACTION` at a time, with their
   *  vectors; the full-text rows follow by trigger. */
  private deleteChunks(ids: number[], corpus: string): void {
    for (let start = 0; start < ids.length; start += DELETES_PER_TRANSACTION) {
      const batch = ids.slice(start, start + DELETES_PER_TRANSACTION);
      writeTransaction(this.db, () => {
        this.deleteVecRows(batch, corpus);
        this.db.prepare(`DELETE FROM memory_chunks WHERE id IN (${batch.map(() => '?').join(',')})`).run(...batch);
      })();
    }
  }

  /** Clear the per-session index-state signatures WITHOUT touching the chunks or
   *  their embeddings. The next backfill sweep then re-indexes every session from
   *  its transcript, but `indexSession` only replaces a session's chunks on a
   *  successful parse - a session whose transcript is gone keeps its existing
   *  chunks. This is what makes "Rebuild index" non-destructive: it re-derives
   *  from the transcripts while never dropping a past conversation. */
  resetIndexState(): void {
    // A few thousand rows across every corpus, cleared in short transactions.
    const clearPage = this.db.prepare(
      `DELETE FROM memory_index_state WHERE rowid IN (SELECT rowid FROM memory_index_state LIMIT ${DELETES_PER_TRANSACTION})`,
    );
    for (;;) {
      const cleared = writeTransaction(this.db, () => clearPage.run().changes)();
      if (cleared === 0) break;
    }
  }

  // --- Index-state bookkeeping ---------------------------------------------

  getIndexState(corpus: string, docId: string): IndexStateRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_index_state WHERE corpus = ? AND doc_id = ?')
      .get(corpus, docId) as
      | {
          corpus: string;
          doc_id: string;
          session_id: string | null;
          source_path: string | null;
          source_mtime_ms: number | null;
          source_size: number | null;
          entry_count: number;
          chunk_count: number;
          status: IndexStateRow['status'];
          indexed_at: string;
          resume_point?: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      corpus: row.corpus,
      docId: row.doc_id,
      sessionId: row.session_id,
      sourcePath: row.source_path,
      sourceMtimeMs: row.source_mtime_ms,
      sourceSize: row.source_size,
      entryCount: row.entry_count,
      chunkCount: row.chunk_count,
      status: row.status,
      indexedAt: row.indexed_at,
      resumePoint: row.resume_point ?? null,
    };
  }

  setIndexState(row: IndexStateRow): void {
    this.db
      .prepare(
        `INSERT INTO memory_index_state
          (corpus, doc_id, session_id, source_path, source_mtime_ms, source_size,
           entry_count, chunk_count, status, indexed_at, resume_point)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(corpus, doc_id) DO UPDATE SET
           session_id = excluded.session_id,
           source_path = excluded.source_path,
           source_mtime_ms = excluded.source_mtime_ms,
           source_size = excluded.source_size,
           entry_count = excluded.entry_count,
           chunk_count = excluded.chunk_count,
           status = excluded.status,
           indexed_at = excluded.indexed_at,
           resume_point = excluded.resume_point`,
      )
      .run(
        row.corpus,
        row.docId,
        row.sessionId,
        row.sourcePath,
        row.sourceMtimeMs,
        row.sourceSize,
        row.entryCount,
        row.chunkCount,
        row.status,
        row.indexedAt,
        row.resumePoint ?? null,
      );
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // --- Read path -----------------------------------------------------------

  /** `corpora` restricts the match to those corpora: the FTS table covers every
   *  corpus, so a search that names none would rank task records against
   *  conversation turns. `taskId`, when given, restricts the FTS match itself to
   *  that task's chunks (a JOIN against memory_chunks, not a post-filter) so
   *  ranking and `limit` apply within the task instead of discarding most of a
   *  small result set after the fact.
   *
   *  CROSS JOIN pins the full-text match first. The app's SQLite (3.53) already
   *  plans it that way, but an older one tried here (Node 24's) walks the
   *  `(corpus)` index and runs the match once per chunk row instead: 2 to 29 s
   *  on 93k chunks, against 20 to 200 ms. The order is the whole cost, so it is
   *  not left to a planner version. */
  searchLexical(
    matchQuery: string,
    limit: number,
    corpora: ReadonlyArray<MemoryCorpus>,
    taskId?: string,
  ): LexicalHit[] {
    if (corpora.length === 0) return [];
    const taskFilter = taskId ? 'AND memory_chunks.task_id = ?' : '';
    const params: Array<string | number> = [matchQuery, ...corpora];
    if (taskId) params.push(taskId);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT memory_chunks_fts.rowid AS id,
                snippet(memory_chunks_fts, 0, '', '', '…', 12) AS snip,
                bm25(memory_chunks_fts) AS score
         FROM memory_chunks_fts
         CROSS JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.rowid
         WHERE memory_chunks_fts MATCH ? AND memory_chunks.corpus IN (${corpusPlaceholders(corpora)}) ${taskFilter}
         ORDER BY score
         LIMIT ?`,
      )
      .all(...params) as Array<{ id: number; snip: string; score: number }>;
    return rows.map((row, index) => ({
      chunkId: row.id,
      rank: index + 1,
      bm25: row.score,
      snippet: row.snip,
    }));
  }

  /**
   * Keyword matches in several corpora from ONE full-text scan, ranked within
   * each corpus (rank 1 = its best bm25), at most `limits.get(corpus)` each.
   *
   * The FTS table covers every corpus, so a query per corpus scans the whole
   * index and only then keeps its own rows: the task records' and the commits'
   * pools cost 18 to 93 ms each on about 100k chunks. One scan over both costs
   * what one of them did (17 to 92 ms), split here, and each corpus's ranks
   * equal its own query's exactly. No LIMIT, because a limit across corpora
   * would let one crowd out another, and the side corpora hold only a few
   * thousand chunks between them; never give it the conversations. No snippet:
   * the related-work rollup reads ranks only.
   */
  searchLexicalPerCorpus(
    matchQuery: string,
    limits: ReadonlyMap<MemoryCorpus, number>,
  ): Map<MemoryCorpus, Array<{ chunkId: number; rank: number }>> {
    const byCorpus = new Map<MemoryCorpus, Array<{ chunkId: number; rank: number }>>();
    const corpora = [...limits.keys()];
    if (corpora.length === 0) return byCorpus;
    const rows = this.db
      .prepare(
        `SELECT memory_chunks_fts.rowid AS id, memory_chunks.corpus AS corpus, bm25(memory_chunks_fts) AS score
         FROM memory_chunks_fts
         CROSS JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.rowid
         WHERE memory_chunks_fts MATCH ? AND memory_chunks.corpus IN (${corpusPlaceholders(corpora)})
         ORDER BY score`,
      )
      .all(matchQuery, ...corpora) as Array<{ id: number; corpus: string; score: number }>;
    for (const row of rows) {
      if (!isMemoryCorpus(row.corpus)) continue;
      const list = byCorpus.get(row.corpus) ?? [];
      if (list.length >= (limits.get(row.corpus) ?? 0)) continue;
      list.push({ chunkId: row.id, rank: list.length + 1 });
      byCorpus.set(row.corpus, list);
    }
    return byCorpus;
  }

  /**
   * The task whose conversation first mentions `phrase` (an FTS5 phrase), at or
   * before `atOrBeforeMs`, or null. How a commit finds the task that wrote it
   * (`commit-record.ts`). CROSS JOIN pins the full-text match first, as in
   * `searchLexical`: planned the other way it ran 28 to 168 s a subject.
   */
  firstTaskMentioning(phrase: string, atOrBeforeMs: number): string | null {
    const row = this.db
      .prepare(
        `SELECT memory_chunks.task_id AS taskId, MIN(COALESCE(memory_chunks.ts_start, memory_chunks.ts_end)) AS firstMs
         FROM memory_chunks_fts
         CROSS JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.rowid
         WHERE memory_chunks_fts MATCH ? AND memory_chunks.corpus = 'conversation' AND memory_chunks.task_id IS NOT NULL
         GROUP BY memory_chunks.task_id
         HAVING firstMs IS NOT NULL AND firstMs <= ?
         ORDER BY firstMs ASC
         LIMIT 1`,
      )
      .get(phrase, atOrBeforeMs) as { taskId: string; firstMs: number } | undefined;
    return row?.taskId ?? null;
  }

  /** Commits linked to a task that has since been deleted. A probe of `tasks`
   *  per linked commit chunk (one chunk per commit), a few thousand at most. */
  commitsOfDeletedTasks(): string[] {
    return (this.prepared(
      `SELECT doc_id AS docId FROM memory_chunks AS chunk
        WHERE corpus = 'commit' AND task_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = chunk.task_id)`,
    ).all() as Array<{ docId: string }>).map((row) => row.docId);
  }

  /** Point one document's chunks at a task, text and embeddings untouched. */
  setDocumentTask(corpus: MemoryCorpus, docId: string, taskId: string | null): void {
    this.db
      .prepare('UPDATE memory_chunks SET task_id = ? WHERE corpus = ? AND doc_id = ?')
      .run(taskId, corpus, docId);
  }

  /** Every chunk id belonging to one task, for scoping a semantic (vec0) search
   *  down to that task after an over-fetched KNN query (vec0 has no per-query
   *  WHERE filter, so this narrows the candidate set after the fact instead). */
  getChunkIdsForTask(taskId: string): Set<number> {
    const rows = this.db
      .prepare('SELECT id FROM memory_chunks WHERE task_id = ?')
      .all(taskId) as Array<{ id: number }>;
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The default-branch commits linked to one task, newest first: sha, text and
   * commit time. The link is where the subject was first written (see
   * commit-record.ts), not a merge record. One `idx_memory_chunks_task` lookup.
   */
  commitsForTask(taskId: string): Array<{ sha: string; text: string; committedMs: number }> {
    return this.db
      .prepare(
        `SELECT doc_id AS sha, text, ts_start AS committedMs FROM memory_chunks
         WHERE task_id = ? AND corpus = 'commit' AND seq = 0
         ORDER BY ts_start DESC`,
      )
      .all(taskId) as Array<{ sha: string; text: string; committedMs: number }>;
  }

  /**
   * Commits whose sha starts with a prefix, newest first, with the task each is
   * linked to. A range on the document key, so it uses the corpus/doc index;
   * the full-text index never holds a sha.
   */
  commitsByShaPrefix(prefix: string, limit: number): Array<{ sha: string; text: string; committedMs: number; taskId: string | null }> {
    const lower = prefix.toLowerCase();
    // The first key past every sha with this prefix: 'g' follows 'f' in ASCII.
    const upper = `${lower}g`;
    return this.db
      .prepare(
        `SELECT doc_id AS sha, text, ts_start AS committedMs, task_id AS taskId FROM memory_chunks
         WHERE corpus = 'commit' AND seq = 0 AND doc_id >= ? AND doc_id < ?
         ORDER BY ts_start DESC LIMIT ?`,
      )
      .all(lower, upper, limit) as Array<{ sha: string; text: string; committedMs: number; taskId: string | null }>;
  }

  /**
   * Where each chunk sits, without its text.
   *
   * The related-work rollup reads well over a thousand of these per question,
   * and needs the text of only the dozen passages it shows, so this leaves the
   * text column out. Batched so a deep pool stays well under SQLite's
   * bound-parameter limit, whatever build it is compiled with.
   */
  getChunkPlacements(ids: number[]): ChunkPlacement[] {
    const placements: ChunkPlacement[] = [];
    for (let start = 0; start < ids.length; start += PLACEMENT_BATCH) {
      const batch = ids.slice(start, start + PLACEMENT_BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT id, corpus, doc_id AS docId, session_id AS sessionId, task_id AS taskId,
                  ts_start AS tsStart, turn_uuid_start AS turnUuidStart
           FROM memory_chunks WHERE id IN (${placeholders})`,
        )
        .all(...batch) as ChunkPlacement[];
      placements.push(...rows);
    }
    return placements;
  }

  getChunks(ids: number[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM memory_chunks WHERE id IN (${placeholders})`)
      .all(...ids) as StoredChunkRow[];
    return rows.map(toStoredChunk);
  }

  getChunksForDoc(corpus: string, docId: string): StoredChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_chunks WHERE corpus = ? AND doc_id = ? ORDER BY seq ASC')
      .all(corpus, docId) as StoredChunkRow[];
    return rows.map(toStoredChunk);
  }

  /** A page of one document's chunks after `afterSeq`, in seq order, holding
   *  only what a change record reads, so a long conversation can be read in
   *  pieces between yields. */
  chunkTextPage(corpus: string, docId: string, afterSeq: number, limit: number): ChunkTextRow[] {
    return this.db
      .prepare(
        `SELECT seq, text, session_id AS sessionId, task_id AS taskId, ts_end AS tsEnd
         FROM memory_chunks WHERE corpus = ? AND doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(corpus, docId, afterSeq, limit) as ChunkTextRow[];
  }

  // --- Vector path (Phase 2; no-op until ensureVecTable succeeds) -----------

  /** True when the conversation vectors are searchable, which is what the map
   *  and the semantic status mean by "semantic". */
  get hasVec(): boolean {
    return this.vecTables.has('conversation');
  }

  /** Create every embedded corpus's vec table at `dimensions` that does not
   *  exist yet. Only the embedding path calls this (it alone knows the selected
   *  model's dimension). No-op when sqlite-vec is unavailable. */
  ensureVecTable(dimensions: number): void {
    if (!hasVecSupport(this.db)) return;
    for (const corpus of EMBEDDED_CORPORA) {
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableOf(corpus)} ${vecTableDefinition(dimensions)}`);
        this.vecTables.add(corpus);
      } catch (error) {
        console.warn(`[retrieval] vec table create failed for ${corpus}, lexical-only:`, error);
        this.vecTables.delete(corpus);
      }
    }
  }

  /** Recreate every vec table at a new dimension (a model switch that changes
   *  vector width) and clear every chunk's embedding marker so they re-embed.
   *  vec0 tables are fixed-width, so a dimension change requires a full reset. */
  resetVec(dimensions: number): void {
    if (!hasVecSupport(this.db)) return;
    // Every embedded chunk back to pending, its vector deleted with it, a page
    // at a time: one statement over the whole index rewrote about 95k rows
    // while holding the database's write lock.
    for (const corpus of MEMORY_CORPORA) {
      const page = this.db.prepare(
        `SELECT id FROM memory_chunks WHERE embedded_model IS NOT NULL AND corpus = ? LIMIT ${DELETES_PER_TRANSACTION}`,
      );
      for (;;) {
        const ids = (page.all(corpus) as Array<{ id: number }>).map((row) => row.id);
        if (ids.length === 0) break;
        writeTransaction(this.db, () => {
          this.deleteVecRows(ids, corpus);
          this.db.prepare(`UPDATE memory_chunks SET embedded_model = NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        })();
      }
    }
    // The tables themselves, at the new width. Dropping a vec0 table frees its
    // storage in one statement even once its rows are gone, since vec0 keeps a
    // table's vector blocks allocated. It runs once per model switch that
    // changes the width, which the user asks for.
    writeTransaction(this.db, () => {
      // The older conversation table too, and any copy into the new one.
      this.db.exec(`DROP TABLE IF EXISTS ${LEGACY_CONVERSATION_VEC_TABLE}`);
      this.db.prepare('DELETE FROM memory_meta WHERE key = ?').run(CONVERSATION_VEC_COPY_KEY);
      for (const corpus of MEMORY_CORPORA) this.db.exec(`DROP TABLE IF EXISTS ${vecTableName(corpus)}`);
      for (const corpus of EMBEDDED_CORPORA) {
        this.db.exec(`CREATE VIRTUAL TABLE ${vecTableName(corpus)} ${vecTableDefinition(dimensions)}`);
      }
    })();
    setVecLayout(this.db, { conversationTable: CONVERSATION_VEC_TABLE, copyTarget: null });
    this.vecTables.clear();
    for (const corpus of EMBEDDED_CORPORA) this.vecTables.add(corpus);
    // Sums of vectors at the old width. The pass would replace them anyway,
    // since each row names its model and width; this frees them now.
    for (const corpus of MEMORY_CORPORA) this.clearDocSums(corpus);
  }

  /**
   * Write embedding vectors for chunks fetched earlier via
   * `chunksNeedingEmbedding`. `contentHash` is each row's hash AT FETCH TIME;
   * it is re-validated against the live row inside this same transaction
   * before writing, and the row is skipped (left pending) on a mismatch or if
   * the chunk no longer exists.
   *
   * This guard closes a race introduced by decoupling the background
   * embedding drain from the indexer's serial job chain: `memory_chunks.id`
   * is `INTEGER PRIMARY KEY` WITHOUT `AUTOINCREMENT`, so a concurrent
   * `upsertDocument` that deletes-then-reinserts a churning chunk's row (e.g.
   * a live session actively being re-indexed) can have SQLite reuse the freed
   * rowid for a DIFFERENT chunk before this write lands. Without the guard,
   * `writeEmbeddings` would stamp a stale vector onto that new chunk and mark
   * it embedded - a silent, wrong embedding that never gets corrected. Because
   * this whole method is one synchronous better-sqlite3 transaction and the
   * only `await` in the drain loop happens before it is called, the
   * check-and-write here is atomic with respect to any concurrent
   * `upsertDocument`.
   */
  writeEmbeddings(
    rows: Array<{ chunkId: number; vector: Float32Array; contentHash: string }>,
    modelTag: string,
  ): void {
    if (this.vecTables.size === 0 || rows.length === 0) return;
    const run = writeTransaction(this.db, () => {
      // vec0 virtual tables do NOT support UPSERT - an
      // `INSERT ... ON CONFLICT DO UPDATE` throws "UPSERT not implemented for
      // virtual table". Re-embedding a chunk (a model switch, or a rowid reused
      // after a content change) is therefore a DELETE followed by a plain
      // INSERT, which is sqlite-vec's documented update path.
      //
      // The live row also says which corpus, and so which vec table, the
      // vector belongs to.
      const checkHash = this.db.prepare('SELECT content_hash, corpus FROM memory_chunks WHERE id = ?');
      const markChunk = this.db.prepare('UPDATE memory_chunks SET embedded_model = ? WHERE id = ?');
      // Prepared once per vec table a batch touches, not twice per row.
      const statementsByTable = new Map<string, { remove: Database.Statement; insert: Database.Statement }>();
      const statementsFor = (table: string): { remove: Database.Statement; insert: Database.Statement } => {
        let statements = statementsByTable.get(table);
        if (!statements) {
          statements = {
            remove: this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`),
            insert: this.db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`),
          };
          statementsByTable.set(table, statements);
        }
        return statements;
      };
      const copyTarget = vecLayout(this.db).copyTarget;
      for (const { chunkId, vector, contentHash } of rows) {
        const current = checkHash.get(chunkId) as { content_hash: string; corpus: string } | undefined;
        if (!current || current.content_hash !== contentHash) continue;
        // A corpus with no table on this connection stays pending.
        if (!isMemoryCorpus(current.corpus) || !this.vecTables.has(current.corpus)) continue;
        // While the older conversation table is copied, the new one gets every
        // vector too, so one written behind the copy is not lost at the switch.
        const tables = current.corpus === 'conversation' && copyTarget
          ? [this.tableOf(current.corpus), copyTarget]
          : [this.tableOf(current.corpus)];
        // vec0 rejects a JS number for its rowid ("Only integers are allowed
        // for primary key values") - it must be bound as a BigInt (verified
        // against sqlite-vec 0.1.9 under Electron).
        const rowid = BigInt(chunkId);
        const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        for (const table of tables) {
          const statements = statementsFor(table);
          statements.remove.run(rowid);
          statements.insert.run(rowid, blob);
        }
        markChunk.run(modelTag, chunkId);
      }
    });
    run();
  }

  /**
   * The nearest chunks across `corpora`, closest first.
   *
   * Each corpus is its own vec0 table, so each is searched for its own top
   * `limit` and the lists merge by distance. Every table holds the same model's
   * vectors, so distances compare across them.
   */
  searchSemantic(query: Float32Array, limit: number, corpora: ReadonlyArray<MemoryCorpus>): SemanticHit[] {
    const buffer = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
    const merged: Array<{ id: number; distance: number }> = [];
    for (const corpus of corpora) {
      if (!this.vecTables.has(corpus)) continue;
      const rows = this.db
        .prepare(
          `SELECT rowid AS id, distance
           FROM ${this.tableOf(corpus)}
           WHERE embedding MATCH ? AND k = ?
           ORDER BY distance`,
        )
        .all(buffer, limit) as Array<{ id: number; distance: number }>;
      merged.push(...rows);
    }
    if (corpora.length > 1) merged.sort((left, right) => left.distance - right.distance);
    return merged.slice(0, limit).map((row, index) => ({ chunkId: row.id, rank: index + 1, distance: row.distance }));
  }

  /**
   * The next chunks to embed: never-embedded ones corpus by corpus in
   * `MEMORY_CORPORA` order (conversations first), then any left under another
   * model's tag.
   *
   * Written against `idx_memory_chunks_pending (embedded_model, corpus)`. The
   * older single query (`embedded_model IS NULL OR embedded_model != ?`, by id)
   * scanned the whole table whenever nothing was pending, measured at 214 ms on
   * 92k chunks, and it ran on every drain poll. Each query here is an index seek:
   * the index stores rowid last, so a (NULL, corpus) range comes back in id
   * order with no sort, and the stale-tag range is empty in the steady state.
   */
  chunksNeedingEmbedding(modelTag: string, limit: number): StoredChunk[] {
    if (this.vecTables.size === 0) return [];
    const rows: StoredChunkRow[] = [];
    for (const corpus of EMBEDDED_CORPORA) {
      if (rows.length >= limit) break;
      if (!this.vecTables.has(corpus)) continue;
      rows.push(...this.db
        .prepare('SELECT * FROM memory_chunks WHERE embedded_model IS NULL AND corpus = ? ORDER BY id ASC LIMIT ?')
        .all(corpus, limit - rows.length) as StoredChunkRow[]);
    }
    if (rows.length < limit) {
      // Rows left under another model of the same width (a switch that did not
      // reset the tables). Rare, so order does not matter here.
      const stale = this.db
        .prepare('SELECT * FROM memory_chunks WHERE embedded_model < ? OR embedded_model > ? LIMIT ?')
        .all(modelTag, modelTag, limit - rows.length) as StoredChunkRow[];
      rows.push(...stale.filter((row) => isMemoryCorpus(row.corpus) && this.vecTables.has(row.corpus)));
    }
    return rows.map(toStoredChunk);
  }

  /**
   * Chunks still waiting for a `modelTag` vector, by corpus: the same rows
   * `chunksNeedingEmbedding` serves, counted. For Settings > Knowledge Graph's Index
   * card, read on every status poll, so it has to stay cheap while the index is
   * large: three ranges of `(embedded_model, corpus)`, never-embedded and
   * either side of the tag, so the cost follows what is waiting rather than
   * the index's size (nothing to read once caught up). `+corpus` keeps the
   * planner off the `(corpus)` index, which would read every chunk row.
   */
  countChunksNeedingEmbedding(modelTag: string): Map<string, number> {
    const waiting = new Map<string, number>();
    if (this.vecTables.size === 0) return waiting;
    const rows = this.db
      .prepare(
        `SELECT corpus, COUNT(*) AS count FROM memory_chunks
         WHERE embedded_model IS NULL OR embedded_model < ? OR embedded_model > ?
         GROUP BY +corpus`,
      )
      .all(modelTag, modelTag) as Array<{ corpus: string; count: number }>;
    for (const row of rows) waiting.set(row.corpus, row.count);
    return waiting;
  }

  /**
   * A page of one document's chunks after `afterSeq`, in seq order: each one's
   * id, whether it has a vector, and its text size in bytes. What a projection
   * pass reads of a changed document, from its stored prefix on (-1 for the
   * whole of it). A range seek on the table's UNIQUE(corpus, doc_id, seq)
   * index. `octet_length` reads a value's size without reading the value:
   * 11 ms against 70 ms for `length`, which counts characters, over 50 MB.
   */
  chunkStatesAfter(corpus: MemoryCorpus, docId: string, afterSeq: number, limit: number): ChunkState[] {
    const rows = this.prepared(
      `SELECT id, seq, embedded_model IS NOT NULL AS embedded, octet_length(text) AS textBytes
       FROM memory_chunks WHERE corpus = ? AND doc_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(corpus, docId, afterSeq, limit) as Array<{ id: number; seq: number; embedded: number; textBytes: number | null }>;
    return rows.map((row) => ({ id: row.id, seq: row.seq, embedded: row.embedded === 1, textBytes: row.textBytes ?? 0 }));
  }

  /** A page of stored document sums, in doc id order, without their prefixes
   *  (read per changed document with `docSumPrefix`). */
  docSumsPage(corpus: MemoryCorpus, afterDocId: string, limit: number): DocSumRow[] {
    const rows = this.prepared(
      `SELECT doc_id AS docId, version, model_tag AS modelTag, dimensions, chunk_count AS chunkCount,
              embedded_count AS embeddedCount, indexed_at AS indexedAt, text_bytes AS textBytes,
              folded_count AS foldedCount, full_sum AS fullSum, prefix_through_seq AS prefixThroughSeq
       FROM memory_doc_sums WHERE corpus = ? AND doc_id > ? ORDER BY doc_id LIMIT ?`,
    ).all(corpus, afterDocId, limit) as Array<Omit<DocSumRow, 'fullSum'> & { fullSum: Buffer | null }>;
    return rows.map((row) => ({ ...row, fullSum: toFloat64(row.fullSum) }));
  }

  /** One document's stored prefix, with the model it was summed under and the
   *  row's version it was read at. */
  docSumPrefix(corpus: MemoryCorpus, docId: string): StoredDocSumPrefix | null {
    const row = this.prepared(
      `SELECT version, model_tag AS modelTag, dimensions, prefix_through_seq AS prefixThroughSeq,
              prefix_count AS prefixCount, prefix_text_bytes AS prefixTextBytes, prefix_sum AS prefixSum
       FROM memory_doc_sums WHERE corpus = ? AND doc_id = ?`,
    ).get(corpus, docId) as (Omit<StoredDocSumPrefix, 'prefixSum'> & { prefixSum: Buffer | null }) | undefined;
    return row ? { ...row, prefixSum: toFloat64(row.prefixSum) } : null;
  }

  /**
   * Store document sums a projection pass computed, each only if its document
   * is still what the pass read. A pass reads a row, then yields while it reads
   * vectors, and the index can change under it in between: a turn's re-index, a
   * trigger emptying the prefix, another pass. So, inside one transaction, a
   * write goes in only when the row's version is the one the pass read (or there
   * is still no row), the live chunk and embedded counts are the ones it folded,
   * and the index time has not moved (an absent one, mid Rebuild, has not moved).
   * Anything else is skipped and read again by the next pass. Written
   * `SUM_BYTES_PER_TRANSACTION` of sums at a time. Returns how many went in.
   */
  writeDocSums(corpus: MemoryCorpus, writes: ReadonlyArray<DocSumWrite>): number {
    let written = 0;
    let batch: DocSumWrite[] = [];
    let batchBytes = 0;
    for (const write of writes) {
      const bytes = (write.fullSum?.byteLength ?? 0) + (write.prefixSum?.byteLength ?? 0);
      if (batch.length > 0 && batchBytes + bytes > SUM_BYTES_PER_TRANSACTION) {
        written += this.writeDocSumsBatch(corpus, batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(write);
      batchBytes += bytes;
    }
    if (batch.length > 0) written += this.writeDocSumsBatch(corpus, batch);
    return written;
  }

  private writeDocSumsBatch(corpus: MemoryCorpus, writes: ReadonlyArray<DocSumWrite>): number {
    const currentVersion = this.prepared('SELECT version FROM memory_doc_sums WHERE corpus = ? AND doc_id = ?');
    // Covered by (corpus, doc_id, embedded_model): the counts never read the table.
    const liveCounts = this.prepared(
      'SELECT COUNT(*) AS chunks, COUNT(embedded_model) AS embedded FROM memory_chunks WHERE corpus = ? AND doc_id = ?',
    );
    const liveIndexedAt = this.prepared('SELECT indexed_at AS indexedAt FROM memory_index_state WHERE corpus = ? AND doc_id = ?');
    const upsert = this.prepared(
      `INSERT INTO memory_doc_sums
         (corpus, doc_id, version, model_tag, dimensions, chunk_count, embedded_count, indexed_at, text_bytes,
          folded_count, full_sum, prefix_through_seq, prefix_count, prefix_text_bytes, prefix_sum)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(corpus, doc_id) DO UPDATE SET
         version = memory_doc_sums.version + 1,
         model_tag = excluded.model_tag, dimensions = excluded.dimensions,
         chunk_count = excluded.chunk_count, embedded_count = excluded.embedded_count,
         indexed_at = excluded.indexed_at, text_bytes = excluded.text_bytes,
         folded_count = excluded.folded_count, full_sum = excluded.full_sum,
         prefix_through_seq = excluded.prefix_through_seq, prefix_count = excluded.prefix_count,
         prefix_text_bytes = excluded.prefix_text_bytes, prefix_sum = excluded.prefix_sum`,
    );
    return writeTransaction(this.db, () => {
      let written = 0;
      for (const write of writes) {
        const row = currentVersion.get(corpus, write.docId) as { version: number } | undefined;
        if ((row?.version ?? null) !== write.expectedVersion) continue;
        const counts = liveCounts.get(corpus, write.docId) as { chunks: number; embedded: number };
        if (counts.chunks !== write.chunkCount || counts.embedded !== write.embeddedCount) continue;
        const stamp = (liveIndexedAt.get(corpus, write.docId) as { indexedAt: string } | undefined)?.indexedAt ?? null;
        if (stamp !== null && stamp !== write.indexedAt) continue;
        upsert.run(
          corpus, write.docId, write.modelTag, write.dimensions, write.chunkCount, write.embeddedCount,
          write.indexedAt, write.textBytes, write.foldedCount, toBlob(write.fullSum),
          write.prefixThroughSeq, write.prefixCount, write.prefixTextBytes, toBlob(write.prefixSum),
        );
        written += 1;
      }
      return written;
    })();
  }

  /** Stored sums of documents no longer in the index, a few rows per transaction. */
  deleteDocSums(corpus: MemoryCorpus, docIds: ReadonlyArray<string>): void {
    for (let start = 0; start < docIds.length; start += DOC_SUMS_DELETED_PER_TRANSACTION) {
      const batch = docIds.slice(start, start + DOC_SUMS_DELETED_PER_TRANSACTION);
      writeTransaction(this.db, () => {
        this.db
          .prepare(`DELETE FROM memory_doc_sums WHERE corpus = ? AND doc_id IN (${batch.map(() => '?').join(',')})`)
          .run(corpus, ...batch);
      })();
    }
  }

  /**
   * `db.prepare(sql)`, prepared once per connection and reused. Preparing is
   * not free: a fresh commit sweep spent 102 ms of one stall profile in the
   * statement constructor, where the same few statements were prepared per call.
   */
  private prepared(sql: string): Database.Statement {
    let cache = statementCaches.get(this.db);
    if (!cache) {
      cache = new Map();
      statementCaches.set(this.db, cache);
    }
    let statement = cache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  }

  /**
   * Bulk-read embedding vectors by chunk id.
   *
   * `WHERE rowid IN (...)` is the only bulk read verified to work against a
   * vec0 table (sqlite-vec 0.1.9): an unconstrained `SELECT rowid, embedding`
   * scan also works, but is no faster (62s vs 68s across 51k rows) because both
   * pay the same per-row blob decode. Rowids are NOT contiguous - deleted
   * chunks leave gaps - so a page can legitimately return fewer rows than it
   * asked for, and that must not be read as end-of-scan.
   */
  readVectors(chunkIds: number[], corpus: MemoryCorpus): Map<number, Float32Array> {
    const vectors = new Map<number, Float32Array>();
    if (!this.vecTables.has(corpus) || chunkIds.length === 0) return vectors;
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT rowid AS id, embedding FROM ${this.tableOf(corpus)} WHERE rowid IN (${placeholders})`)
      .all(...chunkIds) as Array<{ id: number; embedding: Buffer }>;
    for (const row of rows) {
      // Copy out of the sqlite-owned buffer: the statement's memory is reused
      // for the next row, so a view would alias whatever comes next.
      const copy = new Float32Array(row.embedding.byteLength / 4);
      copy.set(
        new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
      );
      vectors.set(row.id, copy);
    }
    return vectors;
  }

  /** Per-document chunk and embedded counts in `corpora`, for the coverage
   *  strip and for detecting a re-indexed document during an incremental
   *  projection pass. */
  documentChunkTotals(corpora: ReadonlyArray<MemoryCorpus>): Array<{
    corpus: string;
    docId: string;
    chunkCount: number;
    embeddedCount: number;
  }> {
    if (corpora.length === 0) return [];
    return this.db
      .prepare(
        `SELECT corpus, doc_id AS docId, COUNT(*) AS chunkCount,
                SUM(CASE WHEN embedded_model IS NOT NULL THEN 1 ELSE 0 END) AS embeddedCount
         FROM memory_chunks
         WHERE corpus IN (${corpusPlaceholders(corpora)})
         GROUP BY corpus, doc_id`,
      )
      .all(...corpora) as Array<{ corpus: string; docId: string; chunkCount: number; embeddedCount: number }>;
  }

  /**
   * When each document in `corpus` was last indexed, keyed by doc id. An
   * incremental projection pass compares it with the time its stored sum was
   * read at, because a document rewritten at the same embedded count (a live
   * conversation's tail chunk growing in place) moves no count. One range seek
   * on the `(corpus, doc_id)` primary key.
   */
  documentIndexTimes(corpus: MemoryCorpus): Map<string, string> {
    const rows = this.db
      .prepare('SELECT doc_id AS docId, indexed_at AS indexedAt FROM memory_index_state WHERE corpus = ?')
      .all(corpus) as Array<{ docId: string; indexedAt: string }>;
    return new Map(rows.map((row) => [row.docId, row.indexedAt]));
  }

  /**
   * A cheap summary of everything conversation coverage is computed from, so a
   * caller can tell whether a coverage it already holds is still true.
   *
   * Coverage groups every chunk by document, which measured about 285 ms on an
   * 89k-chunk index. These reads are index seeks and small tables. Chunks added
   * or removed move the count and the top id; embedding progress moves the
   * embedded count; a document's state moving moves its status tallies; a new
   * transcript moves the session count.
   *
   * Conversations only. Coverage describes conversations, and a task edit
   * re-indexes that task's record: counted here, every board change would throw
   * the coverage away and pay the 285 ms again.
   *
   * The `+` on the embedded count's corpus is load-bearing. Without it the
   * planner seeks `(corpus)` and reads every conversation chunk's row to test
   * `embedded_model`: 264 ms on a 93k-chunk index, on main, on EVERY snapshot
   * read, which an open graph makes on every push. With it, the covering
   * `(embedded_model, corpus)` index: 5.4 ms.
   */
  coverageFingerprint(): string {
    const chunks = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM memory_chunks WHERE corpus = 'conversation'")
      .get() as { count: number; maxId: number };
    const embedded = this.db
      .prepare("SELECT COUNT(*) AS count FROM memory_chunks WHERE embedded_model IS NOT NULL AND +corpus = 'conversation'")
      .get() as { count: number };
    const states = this.db
      .prepare(
        "SELECT status, COUNT(*) AS count, MAX(indexed_at) AS latest FROM memory_index_state WHERE corpus = 'conversation' GROUP BY status ORDER BY status",
      )
      .all() as Array<{ status: string; count: number; latest: string | null }>;
    const sessions = this.db
      .prepare('SELECT COUNT(DISTINCT agent_session_id) AS count FROM sessions WHERE agent_session_id IS NOT NULL')
      .get() as { count: number };
    return [
      chunks.count,
      chunks.maxId,
      embedded.count,
      states.map((state) => `${state.status}:${state.count}:${state.latest ?? ''}`).join(','),
      sessions.count,
    ].join('|');
  }

  /** Highest chunk id in one corpus: half the projection's cache signature.
   *  A seek on `idx_memory_chunks_corpus`, which carries rowid. */
  maxChunkId(corpus: MemoryCorpus): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM memory_chunks WHERE corpus = ?').get(corpus) as {
      id: number;
    };
    return row.id;
  }

  /**
   * Every conversation doc id the corpus could hold, for the coverage strip's
   * "not yet reached by the sweep" bucket.
   *
   * These are `sessions.agent_session_id`, the agent CLI's own transcript id,
   * NOT `sessions.id`. Verified against the live corpus: joining
   * `memory_chunks.doc_id` to `sessions.id` matches zero rows. Rows with a null
   * `agent_session_id` never produced a transcript and are excluded rather than
   * counted as pending, which would report ~1000 phantom un-indexed documents.
   */
  knownConversationDocIds(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT agent_session_id AS id FROM sessions WHERE agent_session_id IS NOT NULL')
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Map chunk ids to their graph node keys (`${corpus}::${docId}`).
   *
   * Needed because the search layer speaks in session ids and chunk ids while
   * the graph is keyed by CORPUS + DOC id - and for conversations the doc id is
   * the agent CLI's transcript id, not `sessions.id`. Resolving the join here
   * keeps that translation in one place instead of every caller re-deriving it.
   */
  docKeysForChunks(chunkIds: number[]): Map<number, string> {
    const keys = new Map<number, string>();
    if (chunkIds.length === 0) return keys;
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, corpus, doc_id AS docId FROM memory_chunks WHERE id IN (${placeholders})`)
      .all(...chunkIds) as Array<{ id: number; corpus: string; docId: string }>;
    for (const row of rows) keys.set(row.id, `${row.corpus}::${row.docId}`);
    return keys;
  }

  /**
   * Per-document display metadata for the Knowledge Graph's nodes: what to call
   * it, which conversation to open, and when it last happened.
   *
   * Without this a node is an opaque hash, which is exactly what made the first
   * version unusable - you could see the shape of the index but not what any
   * point in it was. `sessionId` is what lets a click open the real transcript.
   *
   * Paged by document: the conversations after `afterDocId`, at most `limit` of
   * them (all when negative), in doc id order. Grouping every chunk row in one
   * statement held main for about 270 ms on 1,005 conversations. Ordered by the
   * UNIQUE(corpus, doc_id, seq) index, a page streams its groups and stops at
   * the limit, so 50 conversations cost at most about 38 ms there.
   */
  documentMetadata(afterDocId = '', limit = -1): Array<{
    corpus: string;
    docId: string;
    sessionId: string | null;
    taskId: string | null;
    title: string | null;
    /** The board's `#N` for the owning task. Null for a conversation with no
     *  task, and for a task predating the display_id backfill. */
    displayId: number | null;
    agent: string | null;
    model: string | null;
    effort: string | null;
    durationMs: number | null;
    costUsd: number | null;
    tokens: number | null;
    lastActivityMs: number | null;
    outcome: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT c.corpus AS corpus,
                c.doc_id AS docId,
                MAX(c.session_id) AS sessionId,
                MAX(c.task_id) AS taskId,
                MAX(t.title) AS title,
                -- The ticket the board prints on the card. Carried so the
                -- memory surface can label a task with the number the user
                -- already knows it by, rather than an index into a prompt.
                MAX(t.display_id) AS displayId,
                MAX(s.session_type) AS agent,
                -- What the session actually RAN at, not what was configured:
                -- applied_model / applied_effort are written when the agent
                -- reports its settings, so they survive a mid-session change.
                MAX(COALESCE(s.applied_model, s.model_display_name)) AS model,
                MAX(s.applied_effort) AS effort,
                -- What the work COST, in units a person recognises. "N indexed
                -- chunks" is an artifact of how the index is stored and answers
                -- nothing anyone asks about a past conversation; how long it ran
                -- and what it spent do. Captured on the session at exit/suspend,
                -- so an in-flight conversation reports null and the row is simply
                -- absent rather than showing a zero it has not earned.
                MAX(s.total_duration_ms) AS durationMs,
                MAX(s.total_cost_usd) AS costUsd,
                MAX(COALESCE(s.total_input_tokens, 0) + COALESCE(s.total_output_tokens, 0)) AS tokens,
                MAX(c.ts_end) AS lastActivityMs,
                -- Where the work ENDED UP, so the map can show which
                -- explorations shipped and which are still open.
                --
                -- A Done lane is done, and so is an archived task wherever its
                -- lane is now: archive() has exactly one caller, the move into
                -- Done. Two earlier rules were wrong on the real board. Letting
                -- archived_at mean "abandoned" reported 485 of 496 finished tasks
                -- as abandoned; the lane-first fix kept an "abandoned" value for
                -- archived-outside-Done, which matched 0 of 673 tasks here, since
                -- the app never produces that state.
                MAX(CASE
                  WHEN w.role = 'done' OR t.archived_at IS NOT NULL THEN 'done'
                  WHEN t.id IS NULL THEN NULL
                  ELSE 'active'
                END) AS outcome
         FROM memory_chunks c
         LEFT JOIN tasks t ON t.id = c.task_id
         LEFT JOIN swimlanes w ON w.id = t.swimlane_id
         LEFT JOIN sessions s ON s.id = c.session_id
         -- Conversations only: they are the map's nodes. A task record or a
         -- session's changes is looked up through its task, not drawn.
         WHERE c.corpus = 'conversation' AND c.doc_id > ?
         GROUP BY c.corpus, c.doc_id
         -- Both columns, in the index's order. Ordered by doc_id alone the
         -- planner sorted every remaining group before applying the limit,
         -- so each page cost as much as the whole read.
         ORDER BY c.corpus, c.doc_id
         LIMIT ?`,
      )
      .all(afterDocId, limit) as Array<{
        corpus: string;
        docId: string;
        sessionId: string | null;
        taskId: string | null;
        title: string | null;
        displayId: number | null;
        agent: string | null;
        model: string | null;
        effort: string | null;
        durationMs: number | null;
        costUsd: number | null;
        tokens: number | null;
        lastActivityMs: number | null;
        outcome: string | null;
      }>;
  }

  /**
   * How many conversations and task records this project has indexed, and when
   * its index last took a conversation in: the Projects picker's row for this
   * project. Conversations are what its map draws; task records are searched.
   *
   * Each count reads the (corpus, doc_id) index alone. The obvious
   * COUNT(DISTINCT doc_id) with MAX(ts_end) beside it builds a temp B-tree and
   * reads every chunk row: measured at 350ms across 19 real projects, warm,
   * against 12ms for this. Recency comes from the index state instead, which a
   * conversation's own re-index keeps current.
   */
  projectIndexSummary(): { conversations: number; taskRecords: number; lastIndexedAt: string | null } {
    const documentsIn = (corpus: MemoryCorpus): number => (this.db
      .prepare('SELECT COUNT(*) AS count FROM (SELECT DISTINCT doc_id FROM memory_chunks WHERE corpus = ?)')
      .get(corpus) as { count: number }).count;
    const recency = this.db
      .prepare("SELECT MAX(indexed_at) AS lastIndexedAt FROM memory_index_state WHERE corpus = 'conversation'")
      .get() as { lastIndexedAt: string | null };
    return { conversations: documentsIn('conversation'), taskRecords: documentsIn('task'), lastIndexedAt: recency.lastIndexedAt };
  }

  /** When anything was last written to the index, any corpus: the Index's
   *  "Updated" line. One row per document, so a small read. */
  lastIndexedAt(): string | null {
    const row = this.db
      .prepare('SELECT MAX(indexed_at) AS lastIndexedAt FROM memory_index_state')
      .get() as { lastIndexedAt: string | null };
    return row.lastIndexedAt;
  }

  /**
   * What each corpus holds: documents, chunks, and chunks with a vector. The
   * Index panel's rows.
   *
   * Three index reads rather than one GROUP BY over the table: the documents
   * come off `(corpus, doc_id, seq)`, the chunks off `(corpus)`, and the
   * embedded chunks off `(embedded_model, corpus)`, each covering, so no chunk
   * row is read. A corpus with nothing in it is absent.
   *
   * The `+` on the embedded count's GROUP BY is load-bearing. Without it the
   * planner groups off `(corpus)` to skip a sort, and has to read every chunk
   * row to test `embedded_model`: 277 ms on a 97k-chunk index, on main, on
   * every Index read while task records embed (about every 9 s during a summary
   * backfill). With it, the covering `(embedded_model, corpus)` index and a
   * small sort: 21 ms.
   */
  corpusTotals(): Array<{ corpus: string; documents: number; chunks: number; embeddedChunks: number }> {
    const documents = this.db
      .prepare('SELECT corpus, COUNT(*) AS count FROM (SELECT DISTINCT corpus, doc_id FROM memory_chunks) GROUP BY corpus')
      .all() as Array<{ corpus: string; count: number }>;
    const chunks = this.db
      .prepare('SELECT corpus, COUNT(*) AS count FROM memory_chunks GROUP BY corpus')
      .all() as Array<{ corpus: string; count: number }>;
    const embedded = this.db
      .prepare('SELECT corpus, COUNT(*) AS count FROM memory_chunks WHERE embedded_model IS NOT NULL GROUP BY +corpus')
      .all() as Array<{ corpus: string; count: number }>;
    const countOf = (rows: Array<{ corpus: string; count: number }>, corpus: string): number =>
      rows.find((row) => row.corpus === corpus)?.count ?? 0;
    return documents.map((row) => ({
      corpus: row.corpus,
      documents: row.count,
      chunks: countOf(chunks, row.corpus),
      embeddedChunks: countOf(embedded, row.corpus),
    }));
  }

  /**
   * One corpus's files, passages, and passages embedded by `modelTag`: three
   * index range counts, for a status line polled while Settings is open. The
   * embedded count reads `(embedded_model, corpus)` for exactly this model, so
   * passages still carrying another model's vectors count as waiting.
   */
  corpusProgress(corpus: MemoryCorpus, modelTag: string): { documents: number; chunks: number; embedded: number } {
    const documents = (this.db
      .prepare('SELECT COUNT(*) AS count FROM memory_index_state WHERE corpus = ?')
      .get(corpus) as { count: number }).count;
    const chunks = (this.db
      .prepare('SELECT COUNT(*) AS count FROM memory_chunks WHERE corpus = ?')
      .get(corpus) as { count: number }).count;
    const embedded = (this.db
      .prepare('SELECT COUNT(*) AS count FROM memory_chunks WHERE embedded_model = ? AND corpus = ?')
      .get(modelTag, corpus) as { count: number }).count;
    return { documents, chunks, embedded };
  }

  /** Bytes of text held in some corpora. For the small ones: the conversation
   *  total is the projection pass's sum of its per-document sizes. */
  corpusTextBytes(corpora: ReadonlyArray<MemoryCorpus>): number {
    if (corpora.length === 0) return 0;
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(octet_length(text)), 0) AS bytes FROM memory_chunks WHERE corpus IN (${corpusPlaceholders(corpora)})`)
      .get(...corpora) as { bytes: number };
    return row.bytes;
  }

  /** A cheap summary of every corpus's size, so a caller can tell whether the
   *  corpus totals it holds are still true: the chunk count, the top id, and
   *  the embedded count, each an index read. */
  corpusFingerprint(): string {
    const chunks = this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM memory_chunks')
      .get() as { count: number; maxId: number };
    const embedded = this.db
      .prepare('SELECT COUNT(*) AS count FROM memory_chunks WHERE embedded_model IS NOT NULL')
      .get() as { count: number };
    return `${chunks.count}|${chunks.maxId}|${embedded.count}`;
  }

  /**
   * The finished tasks (in a Done column) that can have a summary, and how many
   * of them do. A summary outlives its task leaving Done, so it is counted only
   * while the task is back in one: "N of M" never reads past M.
   */
  summaryCounts(): { written: number; finishedTasks: number } {
    const written = (this.db
      .prepare(`SELECT COUNT(*) AS count FROM memory_task_summaries d
                JOIN tasks t ON t.id = d.task_id JOIN swimlanes w ON w.id = t.swimlane_id
                WHERE w.role = 'done'`)
      .get() as { count: number }).count;
    const finishedTasks = (this.db
      .prepare("SELECT COUNT(*) AS count FROM tasks t JOIN swimlanes w ON w.id = t.swimlane_id WHERE w.role = 'done'")
      .get() as { count: number }).count;
    return { written, finishedTasks };
  }

  /** Every board task's id, ticket and title: what a task-record match needs
   *  to become a row when none of the task's conversations is in scope. */
  /**
   * The session and task each indexed conversation belongs to, read off its
   * chunks. Neither column is in an index, so this reads every conversation
   * chunk row: about 300 ms on a 94k-chunk index. `indexedConversationNodes`
   * keeps the result until `coverageFingerprint` moves.
   */
  conversationOwners(): Array<{ docId: string; sessionId: string | null; taskId: string | null }> {
    return this.db
      .prepare(
        `SELECT doc_id AS docId, MAX(session_id) AS sessionId, MAX(task_id) AS taskId
         FROM memory_chunks
         WHERE corpus = 'conversation'
         GROUP BY doc_id`,
      )
      .all() as Array<{ docId: string; sessionId: string | null; taskId: string | null }>;
  }

  boardTaskTitles(): Array<{ taskId: string; displayId: number | null; title: string }> {
    return this.db
      .prepare('SELECT id AS taskId, display_id AS displayId, title FROM tasks')
      .all() as Array<{ taskId: string; displayId: number | null; title: string }>;
  }

  /**
   * Every task on the board, active and finished, with its facts rolled up from
   * its sessions, whether or not any conversation of it was ever indexed.
   *
   * The Knowledge Graph's task table used to be built from indexed conversations
   * alone, while its prompt told the agent the table was complete. On this
   * project four of the fourteen tasks that added an agent (#14 to #17) have no
   * indexed conversation, so "how many adapters did we add?" could not see them
   * and the agent was told not to look further. The query lives in
   * `board-task-facts.ts` so the Ask harness runs the same one.
   */
  boardTaskFacts(): BoardTaskFactsRow[] {
    return this.db.prepare(BOARD_TASK_FACTS_SQL).all() as BoardTaskFactsRow[];
  }


  /**
   * What is ACTUALLY stored in the vec table: its width, and the model tag the
   * chunks were embedded under.
   *
   * The Knowledge Graph reads this rather than the configured model, because the
   * two legitimately disagree. `memory_chunks_vec` is fixed-width and is only
   * rebuilt by the embedding path, so between a model switch and the re-embed
   * finishing, config says one width and the table holds another - and a
   * projection built on the configured width would silently reject every
   * vector and produce an empty map. Reading the table is also what makes the
   * cache signature self-invalidating: the tag changes when the corpus is
   * re-embedded, without anything having to notify the graph.
   *
   * Returns null when nothing is embedded yet.
   */
  storedEmbeddingSignature(): { dimensions: number; modelTag: string } | null {
    const dimensionsRaw = this.getMeta('vec_dims');
    const dimensions = dimensionsRaw ? Number(dimensionsRaw) : 0;
    if (!Number.isFinite(dimensions) || dimensions <= 0) return null;

    // The dominant tag, so a handful of rows left over from a previous model
    // mid-re-embed do not flip the signature back and forth.
    const row = this.db
      .prepare(
        `SELECT embedded_model AS modelTag, COUNT(*) AS count
         FROM memory_chunks
         WHERE embedded_model IS NOT NULL
         GROUP BY embedded_model
         ORDER BY count DESC
         LIMIT 1`,
      )
      .get() as { modelTag: string; count: number } | undefined;
    if (!row) return null;
    return { dimensions, modelTag: row.modelTag };
  }

  /** Each indexed document's source signature in one corpus, keyed by doc id:
   *  what a record sweep compares against without reading any chunk. */
  indexSignatures(corpus: MemoryCorpus): Map<string, { sourcePath: string | null; sourceMtimeMs: number | null }> {
    const rows = this.db
      .prepare('SELECT doc_id AS docId, source_path AS sourcePath, source_mtime_ms AS sourceMtimeMs FROM memory_index_state WHERE corpus = ?')
      .all(corpus) as Array<{ docId: string; sourcePath: string | null; sourceMtimeMs: number | null }>;
    return new Map(rows.map((row) => [row.docId, { sourcePath: row.sourcePath, sourceMtimeMs: row.sourceMtimeMs }]));
  }

  /** Every document id holding chunks in one corpus. */
  documentIds(corpus: MemoryCorpus): string[] {
    return (this.db
      .prepare('SELECT DISTINCT doc_id AS docId FROM memory_chunks WHERE corpus = ?')
      .all(corpus) as Array<{ docId: string }>).map((row) => row.docId);
  }

  listIndexState(corpus: MemoryCorpus): Array<{ corpus: string; docId: string; status: string }> {
    return this.db
      .prepare('SELECT corpus, doc_id AS docId, status FROM memory_index_state WHERE corpus = ?')
      .all(corpus) as Array<{ corpus: string; docId: string; status: string }>;
  }

  /** Startup GC: drop vec rows whose chunk was removed while the extension was
   *  unavailable (triggers cannot touch the vec table), in every corpus. A row
   *  that belongs to another corpus's chunk goes too. */
  reconcileVecOrphans(): void {
    for (const corpus of this.vecTables) {
      // Found by a read, deleted in short transactions.
      const orphans = (this.db
        .prepare(`SELECT rowid AS id FROM ${this.tableOf(corpus)} WHERE rowid NOT IN (SELECT id FROM memory_chunks WHERE corpus = ?)`)
        .all(corpus) as Array<{ id: number | bigint }>).map((row) => Number(row.id));
      for (let start = 0; start < orphans.length; start += DELETES_PER_TRANSACTION) {
        const batch = orphans.slice(start, start + DELETES_PER_TRANSACTION);
        writeTransaction(this.db, () => this.deleteVecRows(batch, corpus))();
      }
    }
  }

  /** Delete vec rows by chunk id: from `corpus`'s table when it is known, from
   *  every table when it is not. */
  private deleteVecRows(ids: number[], corpus: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const tables = isMemoryCorpus(corpus) ? [corpus] : [...MEMORY_CORPORA];
    const rowids = ids.map((id) => BigInt(id));
    for (const table of tables) {
      if (!this.hasVecTable(table)) continue;
      // vec0 rowids must be bound as BigInt (see writeEmbeddings).
      this.db.prepare(`DELETE FROM ${this.tableOf(table)} WHERE rowid IN (${placeholders})`).run(...rowids);
      const copyTarget = table === 'conversation' ? vecLayout(this.db).copyTarget : null;
      if (copyTarget) this.db.prepare(`DELETE FROM ${copyTarget} WHERE rowid IN (${placeholders})`).run(...rowids);
    }
  }

  // --- The conversation table's move to chunk size 128 (`vec-layout.ts`) ---

  /**
   * Start copying the older conversation table into the new one: create it at
   * the old table's width and record where the copy stands, in one write.
   * False when there is nothing to copy (no older table, a copy already
   * running, or no sqlite-vec here). An older table holding no vector is
   * dropped at once, since it frees nothing worth splitting up.
   */
  beginConversationVecCopy(): boolean {
    if (!hasVecSupport(this.db)) return false;
    const layout = vecLayout(this.db);
    if (layout.conversationTable !== LEGACY_CONVERSATION_VEC_TABLE || layout.copyTarget) return false;
    const sample = this.db.prepare(`SELECT embedding FROM ${LEGACY_CONVERSATION_VEC_TABLE} LIMIT 1`).get() as { embedding: Buffer } | undefined;
    if (!sample) {
      const dimensions = Number(this.getMeta('vec_dims')) || 0;
      writeTransaction(this.db, () => {
        this.db.exec(`DROP TABLE ${LEGACY_CONVERSATION_VEC_TABLE}`);
        if (dimensions > 0) this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${CONVERSATION_VEC_TABLE} ${vecTableDefinition(dimensions)}`);
      })();
      setVecLayout(this.db, { conversationTable: CONVERSATION_VEC_TABLE, copyTarget: null });
      if (dimensions > 0) this.vecTables.add('conversation');
      else this.vecTables.delete('conversation');
      return false;
    }
    const dimensions = sample.embedding.byteLength / 4;
    writeTransaction(this.db, () => {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${CONVERSATION_VEC_TABLE} ${vecTableDefinition(dimensions)}`);
      this.db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(CONVERSATION_VEC_COPY_KEY, '0');
    })();
    setVecLayout(this.db, { conversationTable: LEGACY_CONVERSATION_VEC_TABLE, copyTarget: CONVERSATION_VEC_TABLE });
    return true;
  }

  /**
   * Copy the next `limit` conversation vectors, in chunk id order, into the
   * new table: read outside the transaction (vec0 reads cost about 1 ms a
   * vector), written in one short one with the copy's new position. A vector
   * written or deleted since went to both tables, so copying it again is the
   * same delete and insert. Returns how many chunks the step covered (0 when
   * the copy is through, or was stopped by a reset) and how long it held the
   * write lock.
   */
  copyConversationVecBatch(limit: number): { covered: number; heldMs: number } {
    const layout = vecLayout(this.db);
    if (!layout.copyTarget) return { covered: 0, heldMs: 0 };
    const through = Number(this.getMeta(CONVERSATION_VEC_COPY_KEY) ?? NaN);
    if (!Number.isFinite(through)) return { covered: 0, heldMs: 0 };
    const ids = (this.db
      .prepare(`SELECT id FROM memory_chunks WHERE corpus = 'conversation' AND embedded_model IS NOT NULL AND id > ? ORDER BY id LIMIT ?`)
      .all(through, limit) as Array<{ id: number }>).map((row) => row.id);
    if (ids.length === 0) return { covered: 0, heldMs: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const vectors = this.db
      .prepare(`SELECT rowid AS id, embedding FROM ${LEGACY_CONVERSATION_VEC_TABLE} WHERE rowid IN (${placeholders})`)
      .all(...ids) as Array<{ id: number | bigint; embedding: Buffer }>;
    const target = layout.copyTarget;
    const writeStarted = performance.now();
    writeTransaction(this.db, () => {
      const remove = this.db.prepare(`DELETE FROM ${target} WHERE rowid = ?`);
      const insert = this.db.prepare(`INSERT INTO ${target}(rowid, embedding) VALUES (?, ?)`);
      for (const vector of vectors) {
        const rowid = BigInt(vector.id);
        remove.run(rowid);
        insert.run(rowid, vector.embedding);
      }
      this.db.prepare('UPDATE memory_meta SET value = ? WHERE key = ?').run(String(ids[ids.length - 1]), CONVERSATION_VEC_COPY_KEY);
    })();
    return { covered: ids.length, heldMs: performance.now() - writeStarted };
  }

  /** Switch conversation reads to the new table, in one write. */
  finishConversationVecCopy(): void {
    if (!vecLayout(this.db).copyTarget) return;
    writeTransaction(this.db, () => {
      this.db.prepare('DELETE FROM memory_meta WHERE key = ?').run(CONVERSATION_VEC_COPY_KEY);
    })();
    setVecLayout(this.db, { conversationTable: CONVERSATION_VEC_TABLE, copyTarget: null });
    this.vecTables.add('conversation');
  }

  /**
   * Free the older table once nothing reads it: one 4 MB vector block per
   * call, each in its own transaction, then the table itself (its other
   * shadow tables are a few MB). Dropping it whole would free about 400 MB in
   * one transaction. Returns true while there is more to free.
   */
  freeLegacyConversationVecStep(): boolean {
    if (!legacyConversationVecPending(this.db)) return false;
    const blocks = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(LEGACY_CONVERSATION_VEC_BLOCKS) !== undefined
      ? this.db.prepare(`SELECT rowid AS id FROM ${LEGACY_CONVERSATION_VEC_BLOCKS} LIMIT 1`).get() as { id: number } | undefined
      : undefined;
    if (blocks) {
      writeTransaction(this.db, () => {
        this.db.prepare(`DELETE FROM ${LEGACY_CONVERSATION_VEC_BLOCKS} WHERE rowid = ?`).run(blocks.id);
      })();
      return true;
    }
    if (!hasVecSupport(this.db)) return false;
    writeTransaction(this.db, () => {
      this.db.exec(`DROP TABLE IF EXISTS ${LEGACY_CONVERSATION_VEC_TABLE}`);
    })();
    return false;
  }

  /**
   * Whether `corpus`'s vec table exists, looked up again when this store has
   * not seen it. Another store on the same connection (the embedding drain's)
   * can create it after this one was built, and a delete that skipped it would
   * leave a vector behind for a chunk id SQLite may hand out again
   * (`memory_chunks.id` is not AUTOINCREMENT, so a deleted top id is reused).
   *
   * Throws when the table exists but this connection cannot open it (sqlite-vec
   * did not load here), so the delete's transaction rolls back rather than
   * leaving that vector behind.
   */
  private hasVecTable(corpus: MemoryCorpus): boolean {
    if (this.vecTables.has(corpus)) return true;
    if (!EMBEDDED_CORPORA.includes(corpus)) return false;
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(this.tableOf(corpus));
    if (exists === undefined) return false;
    if (!hasVecSupport(this.db)) {
      throw new Error(`${this.tableOf(corpus)} exists but sqlite-vec is not loaded on this connection; its vectors cannot be deleted`);
    }
    this.vecTables.add(corpus);
    return true;
  }
}
