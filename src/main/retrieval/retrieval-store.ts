import type Database from 'better-sqlite3';
import { hasVecSupport } from './vec-support';
import { BOARD_TASK_FACTS_SQL, type BoardTaskFactsRow } from './board-task-facts';
import { EMBEDDED_CORPORA, isMemoryCorpus, MEMORY_CORPORA, vecTableName, type MemoryCorpus } from './corpora';
import type {
  ChunkInput,
  ChunkPlacement,
  CorpusDocumentRef,
  IndexStateRow,
  LexicalHit,
  SemanticHit,
  StoredChunk,
} from './types';

/** Ids per `IN (...)` in `getChunkPlacements`. */
const PLACEMENT_BATCH = 500;

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
            .get(vecTableName(corpus));
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
        this.deleteVecRows(deletedIds, ref.corpus);
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
      this.deleteVecRows(ids, corpus);
      this.db.prepare('DELETE FROM memory_chunks WHERE corpus = ? AND doc_id = ?').run(corpus, docId);
      this.db.prepare('DELETE FROM memory_index_state WHERE corpus = ? AND doc_id = ?').run(corpus, docId);
    });
    run();
  }

  /** Every corpus, and the task summaries written from it, gone: the Privacy
   *  "clear index". */
  purgeAll(): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_chunks').run();
      this.db.prepare('DELETE FROM memory_index_state').run();
      this.db.prepare('DELETE FROM memory_task_summaries').run();
      for (const corpus of this.vecTables) this.db.prepare(`DELETE FROM ${vecTableName(corpus)}`).run();
    });
    run();
  }

  /**
   * Some corpora gone, the rest untouched. A chunker change invalidates the
   * conversation chunks (and what is derived from them), not the task records.
   */
  purgeCorpora(corpora: ReadonlyArray<MemoryCorpus>): void {
    if (corpora.length === 0) return;
    const placeholders = corpusPlaceholders(corpora);
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_chunks WHERE corpus IN (${placeholders})`).run(...corpora);
      this.db.prepare(`DELETE FROM memory_index_state WHERE corpus IN (${placeholders})`).run(...corpora);
      for (const corpus of corpora) {
        if (this.vecTables.has(corpus)) this.db.prepare(`DELETE FROM ${vecTableName(corpus)}`).run();
      }
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
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName(corpus)} USING vec0(embedding float[${dimensions}])`,
        );
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
    const run = this.db.transaction(() => {
      for (const corpus of MEMORY_CORPORA) this.db.exec(`DROP TABLE IF EXISTS ${vecTableName(corpus)}`);
      for (const corpus of EMBEDDED_CORPORA) {
        this.db.exec(`CREATE VIRTUAL TABLE ${vecTableName(corpus)} USING vec0(embedding float[${dimensions}])`);
      }
      this.db.prepare('UPDATE memory_chunks SET embedded_model = NULL').run();
    });
    run();
    this.vecTables.clear();
    for (const corpus of EMBEDDED_CORPORA) this.vecTables.add(corpus);
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
    const run = this.db.transaction(() => {
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
      for (const { chunkId, vector, contentHash } of rows) {
        const current = checkHash.get(chunkId) as { content_hash: string; corpus: string } | undefined;
        if (!current || current.content_hash !== contentHash) continue;
        // A corpus with no table on this connection stays pending.
        if (!isMemoryCorpus(current.corpus) || !this.vecTables.has(current.corpus)) continue;
        const table = vecTableName(current.corpus);
        // vec0 rejects a JS number for its rowid ("Only integers are allowed
        // for primary key values") - it must be bound as a BigInt (verified
        // against sqlite-vec 0.1.9 under Electron).
        const rowid = BigInt(chunkId);
        this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowid);
        this.db
          .prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`)
          .run(rowid, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
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
           FROM ${vecTableName(corpus)}
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
   * One page of chunk identities, ascending by id, for the Knowledge Graph's
   * projection scan. Ordered and cursored by `id` so a pass can resume from
   * `afterChunkId` instead of rescanning the corpus.
   *
   * Paging `memory_chunks` (a real B-tree) and then fetching those rowids from
   * the vec table is deliberate: `memory_chunks_vec` is a vec0 virtual table
   * whose cost is dominated by per-row blob decode, so there is no cheaper
   * ordering to be had on that side.
   *
   * One corpus at a time, through `idx_memory_chunks_corpus (corpus)`, which
   * carries rowid, so the page is a range seek in id order. Filtering by corpus
   * any other way let the planner pick the (corpus, doc_id, seq) index and sort
   * the whole corpus for every page: 142 ms against 0.2 ms, measured.
   */
  listChunkIdentities(afterChunkId: number, limit: number, corpus: MemoryCorpus): Array<{
    id: number;
    corpus: string;
    docId: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, corpus, doc_id AS docId FROM memory_chunks
         WHERE corpus = ? AND id > ? AND embedded_model IS NOT NULL
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(corpus, afterChunkId, limit) as Array<{ id: number; corpus: string; docId: string }>;
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
      .prepare(`SELECT rowid AS id, embedding FROM ${vecTableName(corpus)} WHERE rowid IN (${placeholders})`)
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
         WHERE c.corpus = 'conversation'
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

  /** Characters of text held in some corpora. For the small ones: the
   *  conversation total is a paged scan in the projection pass (see
   *  `indexedTextBytesPage`). */
  corpusTextBytes(corpora: ReadonlyArray<MemoryCorpus>): number {
    if (corpora.length === 0) return 0;
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(length(text)), 0) AS bytes FROM memory_chunks WHERE corpus IN (${corpusPlaceholders(corpora)})`)
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
  indexedTextBytesPage(afterChunkId: number, limit: number, corpus: MemoryCorpus): { bytes: number; lastChunkId: number } {
    const rows = this.db
      .prepare(
        `SELECT id, length(text) AS bytes
         FROM memory_chunks
         WHERE corpus = ? AND id > ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(corpus, afterChunkId, limit) as Array<{ id: number; bytes: number | null }>;
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
      this.db
        .prepare(`DELETE FROM ${vecTableName(corpus)} WHERE rowid NOT IN (SELECT id FROM memory_chunks WHERE corpus = ?)`)
        .run(corpus);
    }
  }

  /** Delete vec rows by chunk id: from `corpus`'s table when it is known, from
   *  every table when it is not. */
  private deleteVecRows(ids: number[], corpus: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const tables = isMemoryCorpus(corpus) ? [corpus] : [...MEMORY_CORPORA];
    for (const table of tables) {
      if (!this.vecTables.has(table)) continue;
      // vec0 rowids must be bound as BigInt (see writeEmbeddings).
      this.db.prepare(`DELETE FROM ${vecTableName(table)} WHERE rowid IN (${placeholders})`).run(...ids.map((id) => BigInt(id)));
    }
  }
}
