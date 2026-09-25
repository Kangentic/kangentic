import type Database from 'better-sqlite3';
import { hasVecSupport } from './vec-support';
import type {
  ChunkInput,
  CorpusDocumentRef,
  IndexStateRow,
  LexicalHit,
  SemanticHit,
  StoredChunk,
} from './types';

interface ExistingChunkRow {
  id: number;
  seq: number;
  content_hash: string;
  turn_uuid_start: string | null;
  turn_uuid_end: string | null;
}

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

/**
 * Per-project-DB retrieval store. Owns memory_chunks (+ its FTS5 shadow) and
 * memory_index_state. The vector table (memory_chunks_vec) is created lazily by
 * ensureVecTable() only when the sqlite-vec extension loaded for this
 * connection; all vec methods no-op when it did not, so the whole engine
 * degrades to lexical-only structurally.
 */
export class RetrievalStore {
  private vecReady = false;

  constructor(private readonly db: Database.Database) {
    // The vec table's dimension is fixed by the selected model, which only the
    // embedding path knows, so the store does NOT create it here. It only
    // DISCOVERS an existing table (created earlier by ensureVecTable) so the
    // search path can query it. A fake DB (unit tests) is never vec-capable, so
    // this no-ops and never runs the sqlite_master query.
    if (hasVecSupport(db)) {
      try {
        const exists = this.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_chunks_vec'")
          .get();
        this.vecReady = exists !== undefined;
      } catch {
        this.vecReady = false;
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
   */
  upsertDocument(
    ref: CorpusDocumentRef,
    chunks: ChunkInput[],
  ): { insertedIds: number[]; deletedIds: number[] } {
    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT id, seq, content_hash, turn_uuid_start, turn_uuid_end FROM memory_chunks WHERE corpus = ? AND doc_id = ? ORDER BY seq ASC',
        )
        .all(ref.corpus, ref.docId) as ExistingChunkRow[];
      const existingBySeq = new Map<number, ExistingChunkRow>();
      for (const row of existing) existingBySeq.set(row.seq, row);

      // First seq where new content diverges from stored content.
      let divergence = 0;
      const maxLen = Math.max(existing.length, chunks.length);
      for (; divergence < maxLen; divergence++) {
        const incoming = chunks[divergence];
        const stored = existingBySeq.get(divergence);
        if (!incoming || !stored || incoming.contentHash !== stored.content_hash) break;
      }

      const deletedIds: number[] = [];
      for (const row of existing) {
        if (row.seq >= divergence) deletedIds.push(row.id);
      }
      if (deletedIds.length > 0) {
        const placeholders = deletedIds.map(() => '?').join(',');
        // FTS rows are removed by the AFTER DELETE trigger; vec rows are not
        // (no trigger may touch the vec table), so remove them in-code.
        this.deleteVecRows(deletedIds);
        this.db
          .prepare(`DELETE FROM memory_chunks WHERE id IN (${placeholders})`)
          .run(...deletedIds);
      }

      const insertedIds: number[] = [];
      const now = new Date().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO memory_chunks
          (corpus, doc_id, seq, session_id, task_id, agent_session_id, role, text,
           content_hash, token_estimate, ts_start, ts_end, turn_uuid_start, turn_uuid_end,
           embedded_model, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
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
      const reanchor = this.db.prepare(
        'UPDATE memory_chunks SET turn_uuid_start = ?, turn_uuid_end = ? WHERE id = ?',
      );
      for (const chunk of chunks) {
        if (chunk.seq >= divergence) continue;
        const stored = existingBySeq.get(chunk.seq);
        if (!stored) continue;
        if (stored.turn_uuid_start === chunk.turnUuidStart && stored.turn_uuid_end === chunk.turnUuidEnd) {
          continue;
        }
        reanchor.run(chunk.turnUuidStart, chunk.turnUuidEnd, stored.id);
      }

      for (const chunk of chunks) {
        if (chunk.seq < divergence) continue;
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

      // Refresh ownership of the identical leading prefix. That prefix is left
      // in place to preserve its embeddings, but a resumed session re-indexes
      // the SAME agent transcript (same doc_id) under a NEW session row, so
      // those untouched rows would otherwise keep the OLD session_id. Re-point
      // them (and task_id) at the current session so the search badge (Terminal
      // vs History) stays accurate and the session-delete trigger - which keys
      // on session_id - tracks the live session instead of leaving orphans or
      // wiping a still-active conversation. Updating these columns does not fire
      // the FTS 'AFTER UPDATE OF text' trigger and does not touch embeddings.
      if (divergence > 0) {
        this.db
          .prepare(
            'UPDATE memory_chunks SET session_id = ?, task_id = ? WHERE corpus = ? AND doc_id = ? AND seq < ?',
          )
          .run(ref.sessionId, ref.taskId, ref.corpus, ref.docId, divergence);
      }

      return { insertedIds, deletedIds };
    });
    return run();
  }

  deleteDocument(corpus: string, docId: string): void {
    const run = this.db.transaction(() => {
      const ids = (
        this.db
          .prepare('SELECT id FROM memory_chunks WHERE corpus = ? AND doc_id = ?')
          .all(corpus, docId) as Array<{ id: number }>
      ).map((row) => row.id);
      this.deleteVecRows(ids);
      this.db.prepare('DELETE FROM memory_chunks WHERE corpus = ? AND doc_id = ?').run(corpus, docId);
      this.db.prepare('DELETE FROM memory_index_state WHERE corpus = ? AND doc_id = ?').run(corpus, docId);
    });
    run();
  }

  purgeAll(): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_chunks').run();
      this.db.prepare('DELETE FROM memory_index_state').run();
      if (this.vecReady) this.db.prepare('DELETE FROM memory_chunks_vec').run();
    });
    run();
  }

  /** Clear the per-session index-state signatures WITHOUT touching the chunks or
   *  their embeddings. The next backfill sweep then re-indexes every session from
   *  its transcript, but `indexSession` only replaces a session's chunks on a
   *  successful parse - a session whose transcript is gone keeps its existing
   *  chunks. This is what makes "Rebuild index" non-destructive: it re-derives
   *  from the transcripts while never dropping a past conversation. */
  resetIndexState(): void {
    this.db.prepare('DELETE FROM memory_index_state').run();
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
    };
  }

  setIndexState(row: IndexStateRow): void {
    this.db
      .prepare(
        `INSERT INTO memory_index_state
          (corpus, doc_id, session_id, source_path, source_mtime_ms, source_size,
           entry_count, chunk_count, status, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(corpus, doc_id) DO UPDATE SET
           session_id = excluded.session_id,
           source_path = excluded.source_path,
           source_mtime_ms = excluded.source_mtime_ms,
           source_size = excluded.source_size,
           entry_count = excluded.entry_count,
           chunk_count = excluded.chunk_count,
           status = excluded.status,
           indexed_at = excluded.indexed_at`,
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

  /** `taskId`, when given, restricts the FTS match itself to that task's chunks
   *  (a JOIN against memory_chunks, not a post-filter) so ranking and `limit`
   *  apply within the task instead of discarding most of a small result set
   *  after the fact. */
  searchLexical(matchQuery: string, limit: number, taskId?: string): LexicalHit[] {
    const taskFilter = taskId ? 'AND memory_chunks.task_id = ?' : '';
    const params = taskId ? [matchQuery, taskId, limit] : [matchQuery, limit];
    const rows = this.db
      .prepare(
        `SELECT memory_chunks_fts.rowid AS id,
                snippet(memory_chunks_fts, 0, '', '', '…', 12) AS snip,
                bm25(memory_chunks_fts) AS score
         FROM memory_chunks_fts
         JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.rowid
         WHERE memory_chunks_fts MATCH ? ${taskFilter}
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

  /** Every chunk id belonging to one task, for scoping a semantic (vec0) search
   *  down to that task after an over-fetched KNN query (vec0 has no per-query
   *  WHERE filter, so this narrows the candidate set after the fact instead). */
  getChunkIdsForTask(taskId: string): Set<number> {
    const rows = this.db
      .prepare('SELECT id FROM memory_chunks WHERE task_id = ?')
      .all(taskId) as Array<{ id: number }>;
    return new Set(rows.map((row) => row.id));
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

  /** Chunks within +/- radius seq of a given chunk, same document, seq order. */
  getNeighbors(chunkId: number, radius: number): StoredChunk[] {
    const anchor = this.db
      .prepare('SELECT corpus, doc_id, seq FROM memory_chunks WHERE id = ?')
      .get(chunkId) as { corpus: string; doc_id: string; seq: number } | undefined;
    if (!anchor) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks
         WHERE corpus = ? AND doc_id = ? AND seq BETWEEN ? AND ?
         ORDER BY seq ASC`,
      )
      .all(anchor.corpus, anchor.doc_id, anchor.seq - radius, anchor.seq + radius) as StoredChunkRow[];
    return rows.map(toStoredChunk);
  }

  // --- Vector path (Phase 2; no-op until ensureVecTable succeeds) -----------

  get hasVec(): boolean {
    return this.vecReady;
  }

  /** Create the vec table at `dimensions` if the extension loaded and it does
   *  not exist yet. Only the embedding path calls this (it alone knows the
   *  selected model's dimension). No-op when sqlite-vec is unavailable. */
  ensureVecTable(dimensions: number): void {
    if (!hasVecSupport(this.db)) return;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(embedding float[${dimensions}])`,
      );
      this.vecReady = true;
    } catch (error) {
      console.warn('[retrieval] vec table create failed, lexical-only:', error);
      this.vecReady = false;
    }
  }

  /** Recreate the vec table at a new dimension (a model switch that changes
   *  vector width) and clear every chunk's embedding marker so they re-embed.
   *  vec0 tables are fixed-width, so a dimension change requires a full reset. */
  resetVec(dimensions: number): void {
    if (!hasVecSupport(this.db)) return;
    const run = this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS memory_chunks_vec');
      this.db.exec(
        `CREATE VIRTUAL TABLE memory_chunks_vec USING vec0(embedding float[${dimensions}])`,
      );
      this.db.prepare('UPDATE memory_chunks SET embedded_model = NULL').run();
    });
    run();
    this.vecReady = true;
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
    if (!this.vecReady || rows.length === 0) return;
    const run = this.db.transaction(() => {
      // vec0 virtual tables do NOT support UPSERT - an
      // `INSERT ... ON CONFLICT DO UPDATE` throws "UPSERT not implemented for
      // virtual table". Re-embedding a chunk (a model switch, or a rowid reused
      // after a content change) is therefore a DELETE followed by a plain
      // INSERT, which is sqlite-vec's documented update path.
      const checkHash = this.db.prepare('SELECT content_hash FROM memory_chunks WHERE id = ?');
      const deleteVec = this.db.prepare('DELETE FROM memory_chunks_vec WHERE rowid = ?');
      const insertVec = this.db.prepare('INSERT INTO memory_chunks_vec(rowid, embedding) VALUES (?, ?)');
      const markChunk = this.db.prepare('UPDATE memory_chunks SET embedded_model = ? WHERE id = ?');
      for (const { chunkId, vector, contentHash } of rows) {
        const current = checkHash.get(chunkId) as { content_hash: string } | undefined;
        if (!current || current.content_hash !== contentHash) continue;
        // vec0 rejects a JS number for its rowid ("Only integers are allowed
        // for primary key values") - it must be bound as a BigInt (verified
        // against sqlite-vec 0.1.9 under Electron).
        const rowid = BigInt(chunkId);
        deleteVec.run(rowid);
        insertVec.run(rowid, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
        markChunk.run(modelTag, chunkId);
      }
    });
    run();
  }

  searchSemantic(query: Float32Array, limit: number): SemanticHit[] {
    if (!this.vecReady) return [];
    const buffer = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
    const rows = this.db
      .prepare(
        `SELECT rowid AS id, distance
         FROM memory_chunks_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(buffer, limit) as Array<{ id: number; distance: number }>;
    return rows.map((row, index) => ({ chunkId: row.id, rank: index + 1, distance: row.distance }));
  }

  chunksNeedingEmbedding(modelTag: string, limit: number): StoredChunk[] {
    if (!this.vecReady) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks
         WHERE embedded_model IS NULL OR embedded_model != ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(modelTag, limit) as StoredChunkRow[];
    return rows.map(toStoredChunk);
  }

  /** Cheap count of chunks still pending embedding for `modelTag` (same WHERE
   *  clause as `chunksNeedingEmbedding`, backed by `idx_memory_chunks_embedded`).
   *  Not yet wired to a caller: exposed for a future embedding status/telemetry
   *  surface that needs a pending count without fetching full rows. */
  countChunksNeedingEmbedding(modelTag: string): number {
    if (!this.vecReady) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_chunks
         WHERE embedded_model IS NULL OR embedded_model != ?`,
      )
      .get(modelTag) as { count: number };
    return row.count;
  }

  /**
   * One page of chunk identities, ascending by id, for the Memory Graph's
   * projection scan. Ordered and cursored by `id` so a pass can resume from
   * `afterChunkId` instead of rescanning the corpus.
   *
   * Paging `memory_chunks` (a real B-tree) and then fetching those rowids from
   * the vec table is deliberate: `memory_chunks_vec` is a vec0 virtual table
   * whose cost is dominated by per-row blob decode, so there is no cheaper
   * ordering to be had on that side.
   */
  listChunkIdentities(afterChunkId: number, limit: number): Array<{
    id: number;
    corpus: string;
    docId: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, corpus, doc_id AS docId FROM memory_chunks
         WHERE id > ? AND embedded_model IS NOT NULL
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(afterChunkId, limit) as Array<{ id: number; corpus: string; docId: string }>;
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
  readVectors(chunkIds: number[]): Map<number, Float32Array> {
    const vectors = new Map<number, Float32Array>();
    if (!this.vecReady || chunkIds.length === 0) return vectors;
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT rowid AS id, embedding FROM memory_chunks_vec WHERE rowid IN (${placeholders})`)
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

  /** Per-document chunk and embedded counts, for the coverage strip and for
   *  detecting a re-indexed document during an incremental projection pass. */
  documentChunkTotals(): Array<{
    corpus: string;
    docId: string;
    chunkCount: number;
    embeddedCount: number;
  }> {
    return this.db
      .prepare(
        `SELECT corpus, doc_id AS docId, COUNT(*) AS chunkCount,
                SUM(CASE WHEN embedded_model IS NOT NULL THEN 1 ELSE 0 END) AS embeddedCount
         FROM memory_chunks
         GROUP BY corpus, doc_id`,
      )
      .all() as Array<{ corpus: string; docId: string; chunkCount: number; embeddedCount: number }>;
  }

  /** Highest chunk id present, used as half the cache signature. */
  maxChunkId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM memory_chunks').get() as {
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
   * Per-document display metadata for the Memory Graph's nodes: what to call
   * it, which conversation to open, and when it last happened.
   *
   * Without this a node is an opaque hash, which is exactly what made the first
   * version unusable - you could see the shape of the index but not what any
   * point in it was. `sessionId` is what lets a click open the real transcript.
   */
  documentMetadata(): Array<{
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
                -- explorations shipped and which were abandoned.
                --
                -- The LANE decides, and archiving does not override it. The
                -- reverse rule shipped first and is wrong on any real board:
                -- finished work gets archived once it leaves Done, so on this
                -- project 485 of 496 tasks are archived AND in a Done lane.
                -- Letting archived_at win reported every one of them as
                -- abandoned, which made "reached Done" match nothing at all and
                -- painted the whole Outcome map one grey. Archiving is board
                -- tidiness; the column is the verdict.
                MAX(CASE
                  WHEN w.role = 'done' THEN 'done'
                  WHEN t.archived_at IS NOT NULL THEN 'abandoned'
                  WHEN t.id IS NULL THEN NULL
                  ELSE 'active'
                END) AS outcome
         FROM memory_chunks c
         LEFT JOIN tasks t ON t.id = c.task_id
         LEFT JOIN swimlanes w ON w.id = t.swimlane_id
         LEFT JOIN sessions s ON s.id = c.session_id
         GROUP BY c.corpus, c.doc_id`,
      )
      .all() as Array<{
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
   * One PAGE of the indexed chunk-text byte total, resuming after `afterChunkId`.
   *
   * Pageable rather than a single `SUM(length(text))` because better-sqlite3 is
   * synchronous and the whole scan measured ~170ms over the real corpus's 52k
   * chunks. Every other block in the projection pass is chunked precisely so no
   * single step exceeds a frame budget, and a 170ms statement is a long task by
   * any definition - it would have been the one unpaced block in a pass whose
   * entire design premise is that it never blocks the main thread.
   *
   * `lastChunkId` is 0 when the page came back empty, which is how the caller
   * knows it has reached the end. Callers must keep this on the pass side, never
   * on `getSnapshot`, which is a cheap read on the IPC path.
   *
   * The vector half needs no query at all: vec0 rows are fixed-width, so it is
   * exactly `embeddedChunks * dimensions * 4` (verified against the live table,
   * which held uniform 4096-byte blobs at 1024 dimensions).
   */
  indexedTextBytesPage(afterChunkId: number, limit: number): { bytes: number; lastChunkId: number } {
    const rows = this.db
      .prepare(
        `SELECT id, length(text) AS bytes
         FROM memory_chunks
         WHERE id > ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(afterChunkId, limit) as Array<{ id: number; bytes: number | null }>;
    let bytes = 0;
    let lastChunkId = 0;
    for (const row of rows) {
      bytes += row.bytes ?? 0;
      lastChunkId = row.id;
    }
    return { bytes, lastChunkId };
  }

  /**
   * What is ACTUALLY stored in the vec table: its width, and the model tag the
   * chunks were embedded under.
   *
   * The Memory Graph reads this rather than the configured model, because the
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

  listIndexState(): Array<{ corpus: string; docId: string; status: string }> {
    return this.db
      .prepare('SELECT corpus, doc_id AS docId, status FROM memory_index_state')
      .all() as Array<{ corpus: string; docId: string; status: string }>;
  }

  /** Startup GC: drop vec rows whose chunk was removed while the extension was
   *  unavailable (triggers cannot touch the vec table). */
  reconcileVecOrphans(): void {
    if (!this.vecReady) return;
    this.db
      .prepare('DELETE FROM memory_chunks_vec WHERE rowid NOT IN (SELECT id FROM memory_chunks)')
      .run();
  }

  private deleteVecRows(ids: number[]): void {
    if (!this.vecReady || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    // vec0 rowids must be bound as BigInt (see writeEmbeddings).
    this.db.prepare(`DELETE FROM memory_chunks_vec WHERE rowid IN (${placeholders})`).run(...ids.map((id) => BigInt(id)));
  }
}
