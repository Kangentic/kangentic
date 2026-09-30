import type Database from 'better-sqlite3';
import { timeSyncWork } from '../diagnostics/event-loop-lag';

/**
 * Indexes over the index's own large tables, built by the retrieval worker at
 * a project's open sweep, never by main's migrations. `CREATE INDEX` over an
 * existing table reads the whole table inside one write transaction: about
 * 800 ms for these four together on 93k chunks, which as a migration froze
 * main at the first open after an upgrade. Migrations still create tables,
 * triggers and drops, which cost nothing whatever a table holds.
 *
 * Until one is built its queries still answer, only slower. Each is built once
 * and never again (`IF NOT EXISTS`, checked first so a present index costs one
 * catalog read).
 */
export const RETRIEVAL_INDEXES: ReadonlyArray<{ name: string; sql: string }> = [
  // A covering index for the per-document chunk and embedded totals the
  // graph's coverage groups by: with embedded_model in the index the count
  // never reads the table, 266 ms to 10 ms on 93k chunks.
  { name: 'idx_memory_chunks_doc_embedded', sql: 'CREATE INDEX IF NOT EXISTS idx_memory_chunks_doc_embedded ON memory_chunks(corpus, doc_id, embedded_model)' },
  // A search scoped to one task narrows its semantic hits to that task's chunk
  // ids: 184 ms to 0.5 ms on 99k chunks.
  { name: 'idx_memory_chunks_task', sql: 'CREATE INDEX IF NOT EXISTS idx_memory_chunks_task ON memory_chunks(task_id)' },
  // Per-corpus reads. SQLite appends rowid to every index, so `(corpus)`
  // answers MAX(id) and an id-range page within one corpus as a seek, and
  // `(embedded_model, corpus)` hands the embedding drain its next
  // never-embedded chunks of one corpus in id order: a projection page 142 ms
  // to 0.2 ms, and the drain's "anything pending?" read 214 ms to 0.01 ms.
  { name: 'idx_memory_chunks_corpus', sql: 'CREATE INDEX IF NOT EXISTS idx_memory_chunks_corpus ON memory_chunks(corpus)' },
  { name: 'idx_memory_chunks_pending', sql: 'CREATE INDEX IF NOT EXISTS idx_memory_chunks_pending ON memory_chunks(embedded_model, corpus)' },
];

/** Build whichever of `RETRIEVAL_INDEXES` a database lacks; what was built,
 *  with how long each took. */
export function ensureRetrievalIndexes(db: Database.Database): Array<{ name: string; ms: number }> {
  const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_chunks'")
    .all() as Array<{ name: string }>).map((row) => row.name));
  const built: Array<{ name: string; ms: number }> = [];
  for (const index of RETRIEVAL_INDEXES) {
    if (present.has(index.name)) continue;
    const startedAt = performance.now();
    timeSyncWork('index:build', () => db.exec(index.sql));
    built.push({ name: index.name, ms: Math.round(performance.now() - startedAt) });
  }
  return built;
}
