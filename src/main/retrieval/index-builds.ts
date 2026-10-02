import type Database from 'better-sqlite3';
import { timeSyncWork } from '../diagnostics/event-loop-lag';

/**
 * Indexes over the index's own large tables, built by the retrieval worker,
 * never by main's migrations. `CREATE INDEX` over an existing table reads the
 * whole table inside one write transaction: 180 to 245 ms each for these four
 * on the real install (97k conversation chunks), which as a migration froze
 * main at the first open after an upgrade. Migrations still create tables,
 * triggers and drops, which cost nothing whatever a table holds.
 *
 * Out of main is not enough on its own: main and the pty host write the same
 * database and wait for the lock a build holds. Built at the open sweep, the
 * four held it for about 800 ms exactly while main made its own startup
 * writes, and main's automation-run sweep sat in SQLite's busy wait for 542 ms
 * (stall profiler, upgrade dry run on a copy of the real install). So they are
 * built last in the storage upkeep, one at a time, each once the database has
 * gone `QUIET_MS` with no other connection committing (`waitForQuietDatabase`).
 *
 * Until one is built its queries still answer, only slower, and every query
 * that writes is keyed by id or by the table's own UNIQUE index, so none of
 * them depends on these. Each is built once and never again (`IF NOT EXISTS`,
 * checked first so a present index costs one catalog read).
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

/** How long no other connection may have committed before a build starts. */
export const QUIET_MS = 2_000;
/** How often the gate looks. */
export const QUIET_POLL_MS = 250;
/** The longest a build waits for quiet before it runs anyway, so a database
 *  that is never quiet (a sustained terminal flood) still gets its indexes. */
export const QUIET_CAP_MS = 10 * 60_000;

export interface QuietGateDeps {
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds from any fixed origin. */
  now: () => number;
  shouldContinue: () => boolean;
}

export interface QuietGateTiming {
  quietMs: number;
  pollMs: number;
  capMs: number;
}

const DEFAULT_TIMING: QuietGateTiming = { quietMs: QUIET_MS, pollMs: QUIET_POLL_MS, capMs: QUIET_CAP_MS };

/** The indexes this database does not have yet. */
export function missingRetrievalIndexes(db: Database.Database): Array<{ name: string; sql: string }> {
  const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_chunks'")
    .all() as Array<{ name: string }>).map((row) => row.name));
  return RETRIEVAL_INDEXES.filter((index) => !present.has(index.name));
}

/** Build one index; how long it took. */
export function buildRetrievalIndex(db: Database.Database, index: { sql: string }): number {
  const startedAt = performance.now();
  timeSyncWork('index:build', () => db.exec(index.sql));
  return Math.round(performance.now() - startedAt);
}

/**
 * Wait until no other connection has committed for `quietMs`. `data_version`
 * moves exactly when another connection commits, never for this one's own
 * writes, so main's board writes and the pty host's transcript flushes hold
 * the gate shut and the worker's own work does not. Returns which way it
 * ended: quiet, the cap, or stopped (the job was cancelled).
 */
export async function waitForQuietDatabase(
  db: Database.Database,
  deps: QuietGateDeps,
  timing: QuietGateTiming = DEFAULT_TIMING,
): Promise<'quiet' | 'cap' | 'stopped'> {
  const dataVersion = (): number => Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  const startedAt = deps.now();
  let version = dataVersion();
  let quietSince = startedAt;
  for (;;) {
    if (!deps.shouldContinue()) return 'stopped';
    const current = deps.now();
    if (current - quietSince >= timing.quietMs) return 'quiet';
    if (current - startedAt >= timing.capMs) return 'cap';
    await deps.sleep(timing.pollMs);
    const next = dataVersion();
    if (next !== version) {
      version = next;
      quietSince = deps.now();
    }
  }
}

/** Build every missing index, each after its own quiet wait. Stops, building
 *  nothing more, when the job is cancelled. */
export async function buildMissingIndexesWhenQuiet(
  db: Database.Database,
  deps: QuietGateDeps,
  timing: QuietGateTiming = DEFAULT_TIMING,
): Promise<Array<{ name: string; ms: number; after: 'quiet' | 'cap' }>> {
  const built: Array<{ name: string; ms: number; after: 'quiet' | 'cap' }> = [];
  for (const index of missingRetrievalIndexes(db)) {
    const after = await waitForQuietDatabase(db, deps, timing);
    if (after === 'stopped') break;
    built.push({ name: index.name, ms: buildRetrievalIndex(db, index), after });
  }
  return built;
}
