/**
 * Unit tests for the Knowledge Graph projection pass
 * (`src/main/retrieval/graph/projection-engine.ts`).
 *
 * The pass is paced and incremental for measured reasons, and both properties
 * have a failure mode that is silent rather than loud:
 *   - Chunking the kNN to avoid ~15 dropped frames must not change the RESULT.
 *   - Reading only what changed must end with the sums a pass from scratch
 *     finds, whatever re-indexed a document in between.
 *
 * The pass runs against the REAL store, schema and triggers on node:sqlite, so
 * `memory_doc_sums`, the triggers that empty a prefix and the store's write
 * guard are the shipped SQL. Two reads are stubbed: vectors, since vec0 does
 * not load under node:sqlite (each embedded chunk's vector is derived from its
 * text and the model it was embedded under, so changed text or a new model
 * means a new vector), and the node metadata, which joins tables these tests
 * have no reason to fill.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_GRAPH_GRANULARITIES } from '../../src/shared/types';
import type { TranscriptEntry } from '../../src/shared/types';
import {
  runProjectionPass,
  computeProjectionSleepMs,
  buildSignature,
  isProjectionFresh,
  PREFIX_TAIL_MARGIN,
  type GraphProjection,
  type ProjectionProgress,
} from '../../src/main/retrieval/graph/projection-engine';
import { computeCosineNeighbors } from '../../src/main/retrieval/graph/neighbor-edges';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { chunkTranscript } from '../../src/main/retrieval/conversation/transcript-chunker';
import type { ChunkInput } from '../../src/main/retrieval/types';
import { adaptDatabase } from './helpers/node-sqlite-database';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

const MODEL_TAG = 'bge-base@q8-cls';
const OTHER_MODEL_TAG = 'bge-large@q8-cls';
const DIMENSIONS = 8;
const FIRST_INDEXED_AT = '2026-09-01T00:00:00.000Z';
const REINDEXED_AT = '2026-09-02T00:00:00.000Z';

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** A chunk's vector: a unit vector from its text and the model that embedded it. */
function vectorFor(text: string, modelTag: string): Float32Array {
  const digest = crypto.createHash('sha256').update(`${modelTag}\n${text}`).digest();
  const vector = new Float32Array(DIMENSIONS);
  let squaredNorm = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) {
    vector[index] = digest[index] / 255 - 0.5;
    squaredNorm += vector[index] * vector[index];
  }
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let index = 0; index < DIMENSIONS; index += 1) vector[index] /= norm;
  return vector;
}

/** A document's chunk texts. The accented letter makes bytes and characters differ. */
function textsOf(docId: string, count: number, variant = ''): string[] {
  return Array.from({ length: count }, (_, seq) => `Chunk ${seq} of ${docId}${variant}: café`);
}

function docIdOf(document: number): string {
  return `doc-${String(document).padStart(3, '0')}`;
}

interface StoredSumRow {
  docId: string;
  chunkCount: number;
  embeddedCount: number;
  foldedCount: number;
  textBytes: number;
  prefixThroughSeq: number;
  prefixCount: number;
  prefixTextBytes: number;
  fullSum: number[] | null;
  prefixSum: number[] | null;
  version: number;
}

/**
 * A project database with the real schema, and the real store over it.
 * `indexDocument` writes a document the way the indexer does (a diff upsert,
 * then its index state), and the `embed*` helpers mark chunks embedded the way
 * the drain does.
 */
function testIndex() {
  const database = new sqlite!.DatabaseSync(':memory:');
  const db = adaptDatabase(database);
  runProjectMigrations(db);
  const store = new RetrievalStore(db);
  let vectorReads = 0;
  let chunkPages = 0;
  let metadataPages = 0;
  /** Chunk ids marked embedded whose vector is not in the vector table. */
  const missingVectors = new Set<number>();
  let afterChunkStates: ((docId: string) => void) | null = null;

  const readChunkStates = store.chunkStatesAfter.bind(store);
  Object.assign(store, {
    readVectors(chunkIds: number[]) {
      vectorReads += chunkIds.length;
      const vectors = new Map<number, Float32Array>();
      if (chunkIds.length === 0) return vectors;
      const rows = database
        .prepare(
          `SELECT id, text, embedded_model AS modelTag FROM memory_chunks
           WHERE embedded_model IS NOT NULL AND id IN (${chunkIds.map(() => '?').join(',')})`,
        )
        .all(...chunkIds) as Array<{ id: number; text: string; modelTag: string }>;
      for (const row of rows) {
        if (!missingVectors.has(row.id)) vectors.set(row.id, vectorFor(row.text, row.modelTag));
      }
      return vectors;
    },
    chunkStatesAfter(corpus: 'conversation', docId: string, afterSeq: number, limit: number) {
      chunkPages += 1;
      const states = readChunkStates(corpus, docId, afterSeq, limit);
      afterChunkStates?.(docId);
      return states;
    },
    // Paged the way the real query is: the documents after `afterDocId`, in doc
    // id order, at most `limit` of them (all when negative).
    documentMetadata(afterDocId = '', limit = -1) {
      metadataPages += 1;
      const docIds = (database
        .prepare(
          `SELECT DISTINCT doc_id AS docId FROM memory_chunks
           WHERE corpus = 'conversation' AND doc_id > ? ORDER BY doc_id LIMIT ?`,
        )
        .all(afterDocId, limit) as Array<{ docId: string }>).map((row) => row.docId);
      return docIds.map((docId) => ({
        corpus: 'conversation',
        docId,
        sessionId: `session-${docId}`,
        taskId: `task-${docId}`,
        title: `Title for ${docId}`,
        displayId: null,
        // The RAW session type, as the DB stores it. The pass is expected to
        // resolve it to a display name; a fixture that pre-resolved it could
        // not catch the panel printing `claude_agent` at the user again.
        agent: 'claude_agent',
        model: 'Opus 5',
        effort: 'high',
        durationMs: null,
        costUsd: null,
        tokens: null,
        lastActivityMs: 1_700_000_000_000,
        outcome: 'done',
      }));
    },
  });

  const index = {
    store,
    database,
    missingVectors,
    vectorReads: () => vectorReads,
    chunkPages: () => chunkPages,
    metadataPages: () => metadataPages,
    resetCounts(): void {
      vectorReads = 0;
      chunkPages = 0;
      metadataPages = 0;
    },
    /** Runs right after each page of chunk states is read, inside the pass. */
    onChunkStates(hook: ((docId: string) => void) | null): void {
      afterChunkStates = hook;
    },
    indexDocument(docId: string, texts: string[], indexedAt = FIRST_INDEXED_AT): void {
      const chunks: ChunkInput[] = texts.map((text, seq) => ({
        seq,
        text,
        contentHash: sha1(text),
        tokenEstimate: 10,
        role: 'user',
        tsStart: seq,
        tsEnd: seq,
        turnUuidStart: null,
        turnUuidEnd: null,
      }));
      store.upsertDocument({
        corpus: 'conversation',
        docId,
        sessionId: `session-${docId}`,
        taskId: `task-${docId}`,
        agentSessionId: docId,
        metaJson: null,
      }, chunks);
      store.setIndexState({
        corpus: 'conversation',
        docId,
        sessionId: `session-${docId}`,
        sourcePath: null,
        sourceMtimeMs: null,
        sourceSize: null,
        entryCount: texts.length,
        chunkCount: texts.length,
        status: 'ok',
        indexedAt,
      });
    },
    /** Every chunk still waiting, embedded under `modelTag`. */
    embedAll(modelTag = MODEL_TAG): void {
      database.prepare('UPDATE memory_chunks SET embedded_model = ? WHERE embedded_model IS NULL').run(modelTag);
    },
    /** Every waiting chunk but each document's newest: the ordinary state while
     *  the drain catches up with a live conversation. */
    embedAllButNewest(modelTag = MODEL_TAG): void {
      database.prepare(
        `UPDATE memory_chunks SET embedded_model = ? WHERE embedded_model IS NULL
           AND seq < (SELECT MAX(seq) FROM memory_chunks newest
                      WHERE newest.corpus = memory_chunks.corpus AND newest.doc_id = memory_chunks.doc_id)`,
      ).run(modelTag);
    },
    /** One document's chunks at `seqs`, embedded under `modelTag`. */
    embedSeqs(docId: string, seqs: number[], modelTag = MODEL_TAG): void {
      const update = database.prepare(
        "UPDATE memory_chunks SET embedded_model = ? WHERE corpus = 'conversation' AND doc_id = ? AND seq = ?",
      );
      for (const seq of seqs) update.run(modelTag, docId, seq);
    },
    /** Every embedded chunk embedded again under another model, as a model
     *  switch at the same width does it. */
    reembedAll(modelTag: string): void {
      database.prepare('UPDATE memory_chunks SET embedded_model = ? WHERE embedded_model IS NOT NULL').run(modelTag);
    },
    chunkId(docId: string, seq: number): number {
      return (database
        .prepare("SELECT id FROM memory_chunks WHERE corpus = 'conversation' AND doc_id = ? AND seq = ?")
        .get(docId, seq) as { id: number }).id;
    },
    storedSums(): StoredSumRow[] {
      const rows = database
        .prepare(
          `SELECT doc_id AS docId, chunk_count AS chunkCount, embedded_count AS embeddedCount,
                  folded_count AS foldedCount, text_bytes AS textBytes, prefix_through_seq AS prefixThroughSeq,
                  prefix_count AS prefixCount, prefix_text_bytes AS prefixTextBytes, full_sum AS fullSum,
                  prefix_sum AS prefixSum, version
           FROM memory_doc_sums ORDER BY doc_id`,
        )
        .all() as Array<Omit<StoredSumRow, 'fullSum' | 'prefixSum'> & { fullSum: Uint8Array | null; prefixSum: Uint8Array | null }>;
      const numbers = (blob: Uint8Array | null): number[] | null => {
        if (!blob) return null;
        const copy = new Uint8Array(blob);
        return Array.from(new Float64Array(copy.buffer));
      };
      return rows.map((row) => ({ ...row, fullSum: numbers(row.fullSum), prefixSum: numbers(row.prefixSum) }));
    },
  };
  return index;
}

type TestIndex = ReturnType<typeof testIndex>;

/** `documentCount` documents of `chunksPerDocument` chunks, each document's
 *  newest chunk not embedded yet unless `embedEvery`. */
function corpus(documentCount: number, chunksPerDocument: number, embedEvery = false): TestIndex {
  const index = testIndex();
  for (let document = 0; document < documentCount; document += 1) {
    index.indexDocument(docIdOf(document), textsOf(docIdOf(document), chunksPerDocument));
  }
  if (embedEvery) index.embedAll();
  else index.embedAllButNewest();
  return index;
}

const instantDelay = async (): Promise<void> => undefined;

function pass(index: TestIndex, overrides: Partial<Parameters<typeof runProjectionPass>[0]> = {}) {
  return runProjectionPass({
    store: index.store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay, scanBatch: 4, ...overrides,
  });
}

/** What a pass stores, without the row version and index time, which record
 *  history rather than content. */
function comparable(rows: StoredSumRow[]) {
  return rows.map(({ version: _version, ...row }) => row);
}

/** The stored sums match a pass over the same index from scratch. Summed in
 *  the same order, so they match exactly, not only to a tolerance. */
async function expectSameAsFromScratch(index: TestIndex, build: (fresh: TestIndex) => void, modelTag = MODEL_TAG): Promise<void> {
  const fresh = testIndex();
  build(fresh);
  await pass(fresh, { modelTag });
  expect(comparable(index.storedSums())).toEqual(comparable(fresh.storedSums()));
}

describe('duty-cycle pacer', () => {
  it('sleeps so work occupies at most the duty cycle', () => {
    // 20% duty cycle: 10ms of work earns 40ms of sleep (10 of every 50ms).
    expect(computeProjectionSleepMs(10, 0.2)).toBeCloseTo(40, 6);
    expect(computeProjectionSleepMs(10, 1)).toBe(0);
    expect(computeProjectionSleepMs(10, 0)).toBe(0);
    expect(computeProjectionSleepMs(0, 0.2)).toBe(0);
  });

  it('throttles harder as batches get slower', () => {
    // Driven by MEASURED time, so a contended machine self-throttles rather
    // than being made busier.
    expect(computeProjectionSleepMs(50, 0.2)).toBeGreaterThan(computeProjectionSleepMs(10, 0.2));
  });
});

describe('cache signature', () => {
  it('changes when chunks are DELETED, not just added', () => {
    // maxChunkId alone is not enough: a deletion leaves it unchanged while the
    // count drops, so a maxId-only signature would serve a stale map forever.
    const before = buildSignature(MODEL_TAG, 100, 100);
    expect(buildSignature(MODEL_TAG, 99, 100)).not.toBe(before);
    expect(buildSignature(MODEL_TAG, 101, 101)).not.toBe(before);
    expect(buildSignature('other@tag', 100, 100)).not.toBe(before);
  });

  it('isProjectionFresh compares the whole signature', () => {
    const projection = { signature: buildSignature(MODEL_TAG, 10, 10) } as GraphProjection;
    expect(isProjectionFresh(projection, MODEL_TAG, 10, 10)).toBe(true);
    expect(isProjectionFresh(projection, MODEL_TAG, 9, 10)).toBe(false);
    expect(isProjectionFresh(null, MODEL_TAG, 10, 10)).toBe(false);
  });
});

describe('neighbour slicing', () => {
  function unitVector(seed: number): Float32Array {
    const vector = new Float32Array(DIMENSIONS);
    let squaredNorm = 0;
    for (let index = 0; index < DIMENSIONS; index += 1) {
      vector[index] = Math.sin(seed * (index + 1) * 0.7) + 1.5;
      squaredNorm += vector[index] * vector[index];
    }
    const norm = Math.sqrt(squaredNorm) || 1;
    for (let index = 0; index < DIMENSIONS; index += 1) vector[index] /= norm;
    return vector;
  }

  it('produces the SAME neighbours whether kNN is chunked or not', () => {
    // The pass slices kNN to avoid ~15 dropped frames. Slicing the QUERY side
    // must not change the result. Use a real, varied matrix: an all-zeros one
    // makes every pair identical and the comparison passes vacuously.
    const rowCount = 40;
    const matrix = new Float32Array(rowCount * DIMENSIONS);
    for (let row = 0; row < rowCount; row += 1) {
      matrix.set(unitVector(row * 3 + 1), row * DIMENSIONS);
    }

    // Sanity: the fixture actually distinguishes rows, or the test is vacuous.
    const whole = computeCosineNeighbors(matrix, rowCount, DIMENSIONS, 5);
    expect(new Set(whole[0].neighbors.map((entry) => entry.row)).size).toBe(5);
    expect(whole[0].neighbors[0].row).not.toBe(whole[1].neighbors[0].row);

    // Reassemble from slices of varying width, mirroring the engine's loop.
    const reassembled: typeof whole = [];
    for (const width of [7, 13, 20]) {
      reassembled.length = 0;
      for (let start = 0; start < rowCount; start += width) {
        reassembled.push(
          ...computeCosineNeighbors(matrix, rowCount, DIMENSIONS, 5, start, Math.min(rowCount, start + width)),
        );
      }
      expect(reassembled).toEqual(whole);
    }
  });
});

/** The default carve-up. The projection ships every granularity, so a test that
 *  cares about labels has to say which one it means. */
function balancedRegions(projection: { clusterings: Array<{ granularity: string; regions: Array<{ id: number; label: string; size: number }> }> }) {
  return projection.clusterings.find((entry) => entry.granularity === 'balanced')?.regions ?? [];
}

/** Replace every node's title, keeping the metadata paging. */
function retitle(index: TestIndex, titleFor: (row: number) => string): void {
  const original = index.store.documentMetadata.bind(index.store);
  Object.assign(index.store, {
    documentMetadata: (afterDocId?: string, limit?: number) =>
      original(afterDocId, limit).map((row, rowIndex) => ({ ...row, title: titleFor(rowIndex) })),
  });
}

describeWithSqlite('projection pass', () => {
  it('pools chunks per document and lays out one node each', async () => {
    const index = corpus(12, 4);
    const result = await pass(index);

    expect(result).not.toBeNull();
    expect(result!.projection.nodes).toHaveLength(12);
    for (const node of result!.projection.nodes) {
      // EMBEDDED chunks, not every chunk. A node is pooled from the vectors that
      // exist, so a document still mid-backfill reports what has been embedded
      // so far - which is also what the detail panel's "Indexed" row means.
      expect(node.chunkCount).toBe(3);
      expect(Number.isFinite(node.x)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
    }
  });

  it('carries the metadata that makes a node worth clicking', async () => {
    // Without a title and a session id a node is an opaque hash - which is
    // exactly what made the first version of this surface unusable.
    const result = await pass(corpus(6, 2));

    for (const node of result!.projection.nodes) {
      const docId = node.docKey.split('::')[1];
      expect(node.title).toBe(`Title for ${docId}`);
      expect(node.sessionId).toBe(`session-${docId}`);
      // RESOLVED through the adapter registry, not passed through. The detail
      // panel printed the raw `claude_agent` at the user until this was added,
      // and a session type is an internal key that names nothing to a reader.
      expect(node.agent).toBe('Claude Code');
      expect(node.model).toBe('Opus 5');
      expect(node.effort).toBe('high');
      expect(node.lastActivityMs).toBe(1_700_000_000_000);
      expect(node.outcome).toBe('done');
      // Every granularity places every node somewhere.
      for (const granularity of KNOWLEDGE_GRAPH_GRANULARITIES) {
        expect(node.clusters[granularity]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reads the node metadata a page at a time, and names every node', async () => {
    // One statement that grouped every chunk row held main for about 270 ms on
    // 1,005 real conversations. Read in pages, no page is more than a slice.
    const index = corpus(120, 2);
    const result = await pass(index);
    expect(result!.projection.nodes).toHaveLength(120);
    for (const node of result!.projection.nodes) {
      expect(node.title).toBe(`Title for ${node.docKey.slice('conversation::'.length)}`);
    }
    // More than a single read and its empty follow-up.
    expect(index.metadataPages()).toBeGreaterThanOrEqual(3);
  });

  it('carries every node its own nearest conversations, unpruned', async () => {
    // The detail panel used to read `edges`, which is quantile-pruned so the map
    // stays legible. That pruning is GLOBAL, so a node's true nearest neighbour
    // can be absent from it and the panel listed one neighbour for conversations
    // that genuinely had several. These lists are the same kNN before the cut.
    const result = await pass(corpus(8, 3));

    const lists = result!.projection.nodeNeighbors;
    expect(lists).toHaveLength(result!.projection.nodes.length);
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0);
      // Most similar first, so the panel can render them in order as given.
      for (let position = 1; position < list.length; position += 1) {
        expect(list[position - 1].similarity).toBeGreaterThanOrEqual(list[position].similarity);
      }
    }

    // The load-bearing property: a neighbour list is NOT limited to what the
    // pruned mesh kept. Asserting the totals differ is what would have caught
    // the panel reading the wrong source.
    const drawn = new Set(
      result!.projection.edges.flatMap((edge) => [`${edge.source}:${edge.target}`, `${edge.target}:${edge.source}`]),
    );
    const claimed = lists.flatMap((list, row) => list.map((entry) => `${row}:${entry.index}`));
    expect(claimed.some((pair) => !drawn.has(pair))).toBe(true);
  });

  it('never points a node at itself as its own closest conversation', async () => {
    const result = await pass(corpus(6, 2));
    result!.projection.nodeNeighbors.forEach((list, row) => {
      for (const entry of list) expect(entry.index).not.toBe(row);
    });
  });

  it('reports the index size as text bytes plus vectors', async () => {
    // Chunks are what the panel could always show; bytes are the unit a reader
    // who does not know what a chunk is can still act on. The text half counts
    // every chunk, and in BYTES (each text carries a two-byte letter); the
    // vector half only what is embedded, since an unembedded chunk has no vec0
    // row.
    const documentCount = 6;
    const chunksPerDocument = 3;
    const index = corpus(documentCount, chunksPerDocument);
    const result = await pass(index);

    let textBytes = 0;
    for (let document = 0; document < documentCount; document += 1) {
      for (const text of textsOf(docIdOf(document), chunksPerDocument)) textBytes += Buffer.byteLength(text, 'utf8');
    }
    const embeddedChunks = documentCount * (chunksPerDocument - 1);
    expect(result!.projection.storageBytes).toBe(textBytes + embeddedChunks * DIMENSIONS * 4);
  });

  it('keeps the size of a document with nothing embedded, and draws no node for it', async () => {
    const index = corpus(4, 3);
    index.indexDocument('doc-900', textsOf('doc-900', 2));
    const result = await pass(index);
    expect(result!.projection.nodes.map((node) => node.docKey)).not.toContain('conversation::doc-900');
    const stored = index.storedSums().find((row) => row.docId === 'doc-900');
    expect(stored).toMatchObject({ foldedCount: 0, fullSum: null, chunkCount: 2, embeddedCount: 0 });
    expect(stored!.textBytes).toBe(textsOf('doc-900', 2).reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0));
  });

  it('splits identifiers so a label is readable', async () => {
    // Task titles are full of identifiers. Lowercasing before splitting turned
    // `pruneOrphanedDirectories` into the single unreadable token
    // "pruneorphaneddirectories", which shipped as a real cluster label.
    const index = corpus(8, 2);
    // Two distinct halves: a title every document shares would be excluded by
    // the corpus ceiling (correctly - it distinguishes nothing) and the test
    // would pass vacuously against "unlabelled".
    retitle(index, (row) => (row % 2 === 0 ? 'pruneOrphanedDirectories cleanup' : 'spawn_agent routing'));

    const result = await pass(index);
    const labels = balancedRegions(result!.projection).map((cluster) => cluster.label).join(' ');
    expect(labels).not.toContain('pruneorphaneddirectories');
    expect(labels).toMatch(/prune|orphaned|directories|spawn|agent/);
  });

  it('does not label a region with a word that is everywhere', async () => {
    // Every corpus has words that appear in most titles and mean nothing in it
    // (here, "agent" and "project"). They float to the top of every cluster and
    // label them all the same thing, so a corpus-wide document-frequency
    // ceiling excludes them - measured per corpus, since a hand-written
    // stopword list cannot know they are noise HERE and signal elsewhere.
    const index = corpus(24, 2);
    retitle(index, (row) => `agent project ${row % 2 === 0 ? 'terminal scrollback' : 'sqlite migration'}`);

    const result = await pass(index);
    const labels = balancedRegions(result!.projection).map((cluster) => cluster.label).join(' ');
    expect(labels).not.toContain('agent');
    expect(labels).not.toContain('project');
    expect(labels).toMatch(/terminal|scrollback|sqlite|migration/);
  });

  it('groups the map into labelled clusters', async () => {
    const result = await pass(corpus(30, 2));

    const { nodes } = result!.projection;
    const clusters = balancedRegions(result!.projection);
    expect(clusters.length).toBeGreaterThan(1);
    // Every node belongs to a cluster that exists, and sizes account for all
    // of them - a node in a phantom cluster would render under no label.
    const clusterIds = new Set(clusters.map((cluster) => cluster.id));
    for (const node of nodes) expect(clusterIds.has(node.clusters.balanced)).toBe(true);
    expect(clusters.reduce((total, cluster) => total + cluster.size, 0)).toBe(nodes.length);
    for (const cluster of clusters) {
      expect(cluster.label.length).toBeGreaterThan(0);
      expect(cluster.x).toBeGreaterThanOrEqual(0);
      expect(cluster.x).toBeLessThanOrEqual(1);
    }
  });

  it('projects nothing when the requested width does not match the stored vectors', async () => {
    // The failure mode this pins, seen for real: a corpus embedded at 1024
    // dimensions read under a 768-dimension config projected ZERO nodes, with
    // no error - every vector was correctly rejected as the wrong width and
    // the map came out empty. `addVectorInto` is what rejects them, and the
    // fix is upstream (graph-service reads the width from the DB, not config),
    // so this test documents WHY that indirection exists.
    const index = corpus(10, 3);
    const mismatched = await pass(index, { dimensions: DIMENSIONS * 2 });
    expect(mismatched!.projection.nodes).toHaveLength(0);

    const matched = await pass(index);
    expect(matched!.projection.nodes).toHaveLength(10);
  });

  it('returns null when aborted', async () => {
    const signal = { aborted: false };
    const result = await pass(corpus(20, 3), {
      scanBatch: 2,
      delay: async () => { signal.aborted = true; },
      signal,
    });
    expect(result).toBeNull();
  });

  it('handles an empty corpus', async () => {
    const result = await pass(testIndex());
    expect(result!.projection.nodes).toHaveLength(0);
    expect(result!.projection.edges).toHaveLength(0);
  });

  it('reports how far it has got: reading by vectors, then placing, never backwards', async () => {
    const index = testIndex();
    // One long conversation and three short ones, so the long one is most of
    // the vectors: a count of conversations would call it a quarter.
    index.indexDocument(docIdOf(0), textsOf(docIdOf(0), 12));
    for (let document = 1; document < 4; document += 1) index.indexDocument(docIdOf(document), textsOf(docIdOf(document), 2));
    index.embedAll();
    const reports: ProjectionProgress[] = [];
    await pass(index, { onProgress: (progress) => reports.push(progress) });

    const reading = reports.filter((report) => report.stage === 'reading').map((report) => report.fraction);
    const placing = reports.filter((report) => report.stage === 'placing').map((report) => report.fraction);
    expect(reading[0]).toBe(0);
    expect(reading).toContain(12 / 18);
    expect(reading.at(-1)).toBe(1);
    expect(placing.at(-1)).toBe(1);
    const firstPlacing = reports.findIndex((report) => report.stage === 'placing');
    expect(reports.slice(firstPlacing).every((report) => report.stage === 'placing')).toBe(true);
    for (const series of [reading, placing]) {
      for (let step = 1; step < series.length; step += 1) expect(series[step]).toBeGreaterThanOrEqual(series[step - 1]);
    }
  });

  it('starts a pass at the share its stored sums already cover', async () => {
    // A first build cut short and started again begins where it stopped.
    const index = corpus(4, 3, true);
    await pass(index);
    index.indexDocument(docIdOf(4), textsOf(docIdOf(4), 4));
    index.embedAll();
    const reports: ProjectionProgress[] = [];
    await pass(index, { onProgress: (progress) => reports.push(progress) });
    expect(reports[0]).toEqual({ stage: 'reading', fraction: 12 / 16 });
  });

  it('stores each document with a prefix short of its newest chunks', async () => {
    const index = corpus(1, 10, true);
    await pass(index);
    const [row] = index.storedSums();
    // Seqs 0 to 9, the newest two held back.
    expect(row).toMatchObject({ prefixThroughSeq: 9 - PREFIX_TAIL_MARGIN, prefixCount: 10 - PREFIX_TAIL_MARGIN, foldedCount: 10 });
  });

  it('ends a prefix below the first chunk with no vector yet', async () => {
    const index = testIndex();
    index.indexDocument('doc-000', textsOf('doc-000', 10));
    index.embedSeqs('doc-000', [0, 1, 2, 3, 4]);
    await pass(index);
    expect(index.storedSums()[0]).toMatchObject({ prefixThroughSeq: 4, prefixCount: 5, foldedCount: 5 });
  });

  it('ends a prefix below an embedded chunk whose vector is missing', async () => {
    const index = corpus(1, 10, true);
    index.missingVectors.add(index.chunkId('doc-000', 5));
    await pass(index);
    expect(index.storedSums()[0]).toMatchObject({ prefixThroughSeq: 4, foldedCount: 9, embeddedCount: 10 });
  });

  describe('once the sums are stored', () => {
    it('reads nothing on a pass over an unchanged index', async () => {
      const index = corpus(8, 3);
      await pass(index);
      index.resetCounts();
      const resumed = await pass(index);
      expect(resumed!.projection.nodes).toHaveLength(8);
      expect(index.chunkPages()).toBe(0);
      expect(index.vectorReads()).toBe(0);
    });

    it('reads only the newest chunks of a conversation whose tail grew', async () => {
      const index = corpus(4, 10, true);
      await pass(index);
      index.indexDocument('doc-003', textsOf('doc-003', 13), REINDEXED_AT);
      index.embedAll();
      index.resetCounts();
      const result = await pass(index);
      // Seqs 8 to 12: the two held back from the prefix, and the three new.
      expect(index.vectorReads()).toBe(5);
      // What the service's log line reports.
      expect(result!.counts).toEqual({ documents: 4, documentsRead: 1, vectorsRead: 5 });
      await expectSameAsFromScratch(index, (fresh) => {
        for (const docId of ['doc-000', 'doc-001', 'doc-002']) fresh.indexDocument(docId, textsOf(docId, 10));
        fresh.indexDocument('doc-003', textsOf('doc-003', 13), REINDEXED_AT);
        fresh.embedAll();
      });
    });

    it('reads again the newest chunk rewritten at the same count', async () => {
      // A live conversation's newest chunk grows in place: same seq, same
      // count, a new vector once embedded again. Only the index time moves.
      const index = corpus(4, 10, true);
      await pass(index);
      const rewritten = textsOf('doc-003', 10);
      rewritten[9] = `${rewritten[9]} and more`;
      index.indexDocument('doc-003', rewritten, REINDEXED_AT);
      index.embedAll();
      index.resetCounts();
      await pass(index);
      expect(index.vectorReads()).toBe(PREFIX_TAIL_MARGIN);
      await expectSameAsFromScratch(index, (fresh) => {
        for (const docId of ['doc-000', 'doc-001', 'doc-002']) fresh.indexDocument(docId, textsOf(docId, 10));
        fresh.indexDocument('doc-003', rewritten, REINDEXED_AT);
        fresh.embedAll();
      });
    });

    it('reads a document whole, once, when a re-index reaches into its prefix', async () => {
      // `upsertDocument` deletes from the first divergent seq, and the delete
      // trigger empties the prefix. Folding the new chunks onto the old sum
      // would count the replaced chunks twice.
      const index = corpus(4, 10, true);
      await pass(index);
      const rewritten = textsOf('doc-003', 10);
      rewritten[2] = 'A different second turn';
      index.indexDocument('doc-003', rewritten, REINDEXED_AT);
      index.embedAll();
      index.resetCounts();
      const result = await pass(index);
      expect(index.vectorReads()).toBe(10);
      expect(result!.projection.nodes.find((node) => node.docKey === 'conversation::doc-003')?.chunkCount).toBe(10);
      await expectSameAsFromScratch(index, (fresh) => {
        for (const docId of ['doc-000', 'doc-001', 'doc-002']) fresh.indexDocument(docId, textsOf(docId, 10));
        fresh.indexDocument('doc-003', rewritten, REINDEXED_AT);
        fresh.embedAll();
      });
    });

    it('reads a new document and no other, and drops a deleted one', async () => {
      const index = corpus(4, 3, true);
      await pass(index);
      index.store.deleteDocument('conversation', 'doc-000');
      index.indexDocument('doc-004', textsOf('doc-004', 3));
      index.embedAll();
      index.resetCounts();
      const result = await pass(index);
      expect(index.vectorReads()).toBe(3);
      expect(result!.projection.nodes.map((node) => node.docKey)).not.toContain('conversation::doc-000');
      expect(index.storedSums().map((row) => row.docId)).toEqual(['doc-001', 'doc-002', 'doc-003', 'doc-004']);
    });

    // Deleting many conversations at once leaves a stored sums row for each, and
    // the pass drops them a few rows a transaction, taking a turn of the worker's
    // write budget (`awaitWriteTurn`) between the batches. Nine gone documents are
    // three batches of four, so two turns. No surviving document changed, so none
    // is read, and the only turns taken are the ones between those batches.
    //
    // Red-green: the pass used to hand the whole list to a delete that took no
    // turn (`timeSyncWork(..., () => store.deleteDocSums('conversation', gone))`),
    // so `turns` reads 0 here.
    it('takes a write turn between the batches that drop the sums of deleted documents', async () => {
      const index = corpus(12, 3, true);
      await pass(index);
      for (let document = 0; document < 9; document += 1) index.store.deleteDocument('conversation', docIdOf(document));
      // The rows outlive their documents until a pass drops them.
      expect(index.storedSums()).toHaveLength(12);
      index.resetCounts();
      let turns = 0;

      const result = await pass(index, { awaitWriteTurn: async () => { turns += 1; } });

      expect(index.vectorReads()).toBe(0);
      expect(turns).toBe(2);
      expect(result!.projection.nodes).toHaveLength(3);
      expect(index.storedSums().map((row) => row.docId)).toEqual(['doc-009', 'doc-010', 'doc-011']);
    });

    // A pass that is told to stop (a project switch, a shutdown, a model change)
    // while its deletes are waiting for a turn stops deleting, and returns nothing
    // for the map. The stop is raised from the first turn, between batch one and
    // batch two.
    //
    // Red-green: do not hand `() => !aborted()` to `deleteDocSums`. The second
    // turn is then taken (turns is 2) and every gone row is dropped, where it
    // should stop with the first four removed and the other five still stored.
    it('stops dropping the sums of deleted documents when aborted between batches, and returns nothing', async () => {
      const index = corpus(12, 3, true);
      await pass(index);
      for (let document = 0; document < 9; document += 1) index.store.deleteDocument('conversation', docIdOf(document));
      expect(index.storedSums()).toHaveLength(12);
      const signal = { aborted: false };
      let turns = 0;

      const result = await pass(index, {
        signal,
        awaitWriteTurn: async () => {
          turns += 1;
          signal.aborted = true;
        },
      });

      expect(result).toBeNull();
      expect(turns).toBe(1);
      // The first batch (doc-000 to doc-003) went; the five after it and the
      // three live documents are as they were.
      expect(index.storedSums().map((row) => row.docId)).toEqual(
        Array.from({ length: 8 }, (_, offset) => docIdOf(offset + 4)),
      );
    });

    it('reads nothing while Rebuild index has cleared the index times, and the newest chunks once they return', async () => {
      // Rebuild deletes every index-state row, then re-indexes. A pass in
      // between finds no index time for any document, which says nothing
      // changed. Re-stamped, each document is read from its prefix on.
      const index = corpus(4, 10, true);
      await pass(index);
      index.store.resetIndexState();
      index.resetCounts();
      await pass(index);
      expect(index.vectorReads()).toBe(0);

      for (let document = 0; document < 4; document += 1) {
        index.indexDocument(docIdOf(document), textsOf(docIdOf(document), 10), REINDEXED_AT);
      }
      await pass(index);
      expect(index.vectorReads()).toBe(4 * PREFIX_TAIL_MARGIN);
    });

    it('reads a document again when a vector is replaced without its counts or index time moving', async () => {
      // The drain re-embeds a chunk under a new model of the same width: one
      // UPDATE of `embedded_model`, no count and no index time moves. Above the
      // prefix only the newest chunks are read; inside it the whole document.
      const index = corpus(2, 10, true);
      await pass(index);
      const replace = (target: TestIndex, seq: number) => target.database
        .prepare("UPDATE memory_chunks SET embedded_model = ? WHERE doc_id = 'doc-001' AND seq = ?")
        .run(OTHER_MODEL_TAG, seq);
      const fromScratch = (seqs: number[]) => (fresh: TestIndex) => {
        for (const docId of ['doc-000', 'doc-001']) fresh.indexDocument(docId, textsOf(docId, 10));
        fresh.embedAll();
        for (const seq of seqs) replace(fresh, seq);
      };

      replace(index, 9);
      index.resetCounts();
      await pass(index);
      expect(index.vectorReads()).toBe(PREFIX_TAIL_MARGIN);
      await expectSameAsFromScratch(index, fromScratch([9]));

      replace(index, 3);
      index.resetCounts();
      await pass(index);
      expect(index.vectorReads()).toBe(10);
      await expectSameAsFromScratch(index, fromScratch([9, 3]));
    });

    it('reads every document again after a model switch, and ends where a pass from scratch does', async () => {
      const index = corpus(4, 6, true);
      await pass(index);
      // Each chunk embedded again: the update trigger empties every prefix.
      index.reembedAll(OTHER_MODEL_TAG);
      index.resetCounts();
      const result = await pass(index, { modelTag: OTHER_MODEL_TAG });
      expect(index.vectorReads()).toBe(24);
      expect(result!.projection.nodes).toHaveLength(4);
      await expectSameAsFromScratch(index, (fresh) => {
        for (let document = 0; document < 4; document += 1) fresh.indexDocument(docIdOf(document), textsOf(docIdOf(document), 6));
        fresh.embedAll(OTHER_MODEL_TAG);
      }, OTHER_MODEL_TAG);
    });

    it('stores nothing for a document that changed while it was read, and reads it again next pass', async () => {
      const index = corpus(2, 6);
      await pass(index);
      index.indexDocument('doc-001', textsOf('doc-001', 8), REINDEXED_AT);
      const before = index.storedSums().find((row) => row.docId === 'doc-001');

      // The drain embeds doc-001's waiting chunks while the pass yields between
      // reading its chunk states and storing its sums.
      index.onChunkStates((docId) => {
        if (docId === 'doc-001') index.embedSeqs('doc-001', [5, 6, 7]);
      });
      const result = await pass(index);
      index.onChunkStates(null);

      // The map uses what was read: five of the six chunks it saw had vectors.
      expect(result!.projection.nodes.find((node) => node.docKey === 'conversation::doc-001')?.chunkCount).toBe(5);
      // The live counts no longer match what was read, so the row is untouched.
      expect(index.storedSums().find((row) => row.docId === 'doc-001')).toEqual(before);

      await pass(index);
      await expectSameAsFromScratch(index, (fresh) => {
        fresh.indexDocument('doc-000', textsOf('doc-000', 6));
        fresh.embedAllButNewest();
        fresh.indexDocument('doc-001', textsOf('doc-001', 8), REINDEXED_AT);
        fresh.embedSeqs('doc-001', [0, 1, 2, 3, 4, 5, 6, 7]);
      });
    });

    it('stops between pages when aborted', async () => {
      const index = corpus(6, 3);
      await pass(index);
      index.indexDocument('doc-005', textsOf('doc-005', 9), REINDEXED_AT);
      index.embedAll();
      const signal = { aborted: false };
      const result = await pass(index, {
        scanBatch: 2,
        delay: async () => { signal.aborted = true; },
        signal,
      });
      expect(result).toBeNull();
    });
  });
});

describe('the prefix margin', () => {
  /** Deterministic xorshift32, so the transcripts below are reproducible. */
  function seededRandom(seed: number): () => number {
    let state = seed >>> 0 || 0x9e3779b9;
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x100000000;
    };
  }

  function transcript(seed: number, entryCount: number): TranscriptEntry[] {
    const random = seededRandom(seed);
    const words = (count: number): string =>
      Array.from({ length: count }, () => ['terminal', 'session', 'index', 'graph', 'chunk', 'fix'][Math.floor(random() * 6)]).join(' ');
    // Lengths from a few words to several chunks' worth, so short tails merge
    // backward and long entries split.
    const length = (): number => [2, 8, 40, 150, 700][Math.floor(random() * 5)];
    const entries: TranscriptEntry[] = [];
    for (let position = 0; position < entryCount; position += 1) {
      const uuid = `entry-${seed}-${position}`;
      const kind = random();
      if (kind < 0.3) {
        entries.push({ kind: 'user', uuid, ts: position, text: words(length()) });
      } else if (kind < 0.8) {
        entries.push({ kind: 'assistant', uuid, ts: position, blocks: [{ type: 'text', text: words(length()) }] });
      } else {
        entries.push({ kind: 'tool_result', uuid, ts: position, toolUseId: `tool-${position}`, content: words(length()) });
      }
    }
    return entries;
  }

  it('covers every chunk that appending entries rewrites', () => {
    // A live conversation is indexed again after each turn, with new entries
    // appended. The chunks that change must all fall within the margin, or
    // every turn would empty the prefix and read the conversation whole.
    let appends = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const entries = transcript(seed, 30);
      const chunkedAt = entries.map((_, position) => chunkTranscript(entries.slice(0, position + 1)));
      for (let before = 1; before < entries.length; before += 1) {
        const earlier = chunkedAt[before - 1];
        for (let after = before + 1; after <= Math.min(entries.length, before + 4); after += 1) {
          const later = chunkedAt[after - 1];
          let firstChanged = 0;
          while (firstChanged < earlier.length && earlier[firstChanged].contentHash === later[firstChanged]?.contentHash) {
            firstChanged += 1;
          }
          // At most the last chunk changes, and the margin holds one more.
          expect(firstChanged).toBeGreaterThanOrEqual(earlier.length - 1);
          expect(firstChanged).toBeGreaterThanOrEqual(earlier.length - PREFIX_TAIL_MARGIN);
          appends += 1;
        }
      }
    }
    expect(appends).toBeGreaterThan(4000);
  });
});
