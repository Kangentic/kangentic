/**
 * Unit tests for the Knowledge Graph projection pass
 * (`src/main/retrieval/graph/projection-engine.ts`).
 *
 * The pass is paced and incremental for measured reasons, and both properties
 * have a failure mode that is silent rather than loud:
 *   - Chunking the kNN to avoid ~15 dropped frames must not change the RESULT.
 *   - Incremental scanning must not double-count a document that was
 *     re-indexed, which `upsertDocument` does by minting new chunk ids under
 *     the same doc key.
 * Both are pinned below against a scripted store, so no DB is needed.
 */

import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_GRAPH_GRANULARITIES } from '../../src/shared/types';
import {
  runProjectionPass,
  computeProjectionSleepMs,
  buildSignature,
  isProjectionFresh,
  PROJECTION_SUMS_KEY,
  type GraphProjection,
} from '../../src/main/retrieval/graph/projection-engine';
import { computeCosineNeighbors } from '../../src/main/retrieval/graph/neighbor-edges';
import type { RetrievalStore } from '../../src/main/retrieval/retrieval-store';

const MODEL_TAG = 'bge-base@q8-cls';
const DIMENSIONS = 8;

interface ScriptedChunk {
  id: number;
  corpus: string;
  docId: string;
  vector: Float32Array;
}

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

/** A stand-in for chunk text, so the storage figure is checkable without a
 *  fixture carrying real prose. Per-chunk rather than a lump sum, so the paging
 *  is exercised: a page-sum double that ignored its cursor would over-count. */
const TEXT_BYTES_PER_CHUNK = 512;

/** Chunks per document left unembedded, so `chunkCount` and `embeddedCount`
 *  cannot be confused for each other. */
const UNEMBEDDED_PER_DOC = 1;

/** Minimal store double: only the reads the pass actually performs. */
function scriptedStore(chunks: ScriptedChunk[], meta = new Map<string, string>()) {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  let listCalls = 0;

  // The newest chunk of each document has text but no vector yet - the ordinary
  // state while the embed backfill is still catching up. Modelling it here is
  // what lets the storage assertion tell `chunkCount` and `embeddedCount` apart;
  // a double that embeds everything reports them equal and pins neither. It has
  // to hold across `readVectors` AND `documentChunkTotals` or the two disagree
  // and the resume check reads it as a re-indexed document.
  const unembeddedChunkIds = new Set<number>();
  const newestByDoc = new Map<string, ScriptedChunk>();
  for (const chunk of chunks) {
    const key = `${chunk.corpus}::${chunk.docId}`;
    const current = newestByDoc.get(key);
    if (!current || chunk.id > current.id) newestByDoc.set(key, chunk);
  }
  for (const chunk of newestByDoc.values()) unembeddedChunkIds.add(chunk.id);

  const store = {
    listChunkIdentities(afterChunkId: number, limit: number) {
      listCalls += 1;
      return chunks
        .filter((chunk) => chunk.id > afterChunkId)
        .sort((first, second) => first.id - second.id)
        .slice(0, limit)
        .map((chunk) => ({ id: chunk.id, corpus: chunk.corpus, docId: chunk.docId }));
    },
    readVectors(chunkIds: number[]) {
      const vectors = new Map<number, Float32Array>();
      for (const id of chunkIds) {
        if (unembeddedChunkIds.has(id)) continue;
        const chunk = byId.get(id);
        if (chunk) vectors.set(id, chunk.vector);
      }
      return vectors;
    },
    documentChunkTotals() {
      const totals = new Map<string, { corpus: string; docId: string; chunkCount: number }>();
      for (const chunk of chunks) {
        const key = `${chunk.corpus}::${chunk.docId}`;
        const existing = totals.get(key);
        if (existing) existing.chunkCount += 1;
        else totals.set(key, { corpus: chunk.corpus, docId: chunk.docId, chunkCount: 1 });
      }
      // Lower than chunkCount by exactly the unembedded tail, because only
      // embedded chunks have a row in `memory_chunks_vec` and so only they cost
      // vector bytes. Reporting the two as equal (as this double first did) let
      // the storage assertion pass under either reading and pinned nothing.
      return [...totals.values()].map((row) => ({
        ...row,
        embeddedCount: row.chunkCount - UNEMBEDDED_PER_DOC,
      }));
    },
    maxChunkId() {
      return chunks.reduce((highest, chunk) => Math.max(highest, chunk.id), 0);
    },
    documentMetadata() {
      const byDoc = new Map<string, { corpus: string; docId: string }>();
      for (const chunk of chunks) byDoc.set(`${chunk.corpus}::${chunk.docId}`, chunk);
      return [...byDoc.values()].map((chunk) => ({
        corpus: chunk.corpus,
        docId: chunk.docId,
        sessionId: `session-${chunk.docId}`,
        taskId: `task-${chunk.docId}`,
        title: `Title for ${chunk.docId}`,
        // The RAW session type, as the DB stores it. The pass is expected to
        // resolve it to a display name; a fixture that pre-resolved it could
        // not catch the panel printing `claude_agent` at the user again.
        agent: 'claude_agent',
        model: 'Opus 5',
        effort: 'high',
        lastActivityMs: 1_700_000_000_000,
        outcome: 'done',
      }));
    },
    indexedTextBytesPage(afterChunkId: number, limit: number) {
      const page = chunks
        .filter((chunk) => chunk.id > afterChunkId)
        .sort((first, second) => first.id - second.id)
        .slice(0, limit);
      if (page.length === 0) return { bytes: 0, lastChunkId: 0 };
      return {
        bytes: page.length * TEXT_BYTES_PER_CHUNK,
        lastChunkId: page[page.length - 1].id,
      };
    },
    getMeta(key: string) {
      return meta.get(key);
    },
    setMeta(key: string, value: string) {
      meta.set(key, value);
    },
  };

  return { store: store as unknown as RetrievalStore, meta, listCalls: () => listCalls };
}

function makeChunks(documentCount: number, chunksPerDocument: number): ScriptedChunk[] {
  const chunks: ScriptedChunk[] = [];
  let id = 1;
  for (let document = 0; document < documentCount; document += 1) {
    for (let seq = 0; seq < chunksPerDocument; seq += 1) {
      chunks.push({
        id: id++,
        corpus: 'conversation',
        docId: `doc-${String(document).padStart(3, '0')}`,
        vector: unitVector(document * 10 + seq),
      });
    }
  }
  return chunks;
}

const instantDelay = async (): Promise<void> => undefined;

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

/** The default carve-up. The projection ships every granularity, so a test that
 *  cares about labels has to say which one it means. */
function balancedRegions(projection: { clusterings: Array<{ granularity: string; regions: Array<{ id: number; label: string; size: number }> }> }) {
  return projection.clusterings.find((entry) => entry.granularity === 'balanced')?.regions ?? [];
}

describe('projection pass', () => {
  it('pools chunks per document and lays out one node each', async () => {
    const { store } = scriptedStore(makeChunks(12, 4));
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay, scanBatch: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.projection.nodes).toHaveLength(12);
    for (const node of result!.projection.nodes) {
      // EMBEDDED chunks, not every chunk. A node is pooled from the vectors that
      // exist, so a document still mid-backfill reports what has been embedded
      // so far - which is also what the detail panel's "Indexed" row means.
      expect(node.chunkCount).toBe(4 - UNEMBEDDED_PER_DOC);
      expect(Number.isFinite(node.x)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
    }
  });

  it('carries the metadata that makes a node worth clicking', async () => {
    // Without a title and a session id a node is an opaque hash - which is
    // exactly what made the first version of this surface unusable.
    const { store } = scriptedStore(makeChunks(6, 2));
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });

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

  it('carries every node its own nearest conversations, unpruned', async () => {
    // The detail panel used to read `edges`, which is quantile-pruned so the map
    // stays legible. That pruning is GLOBAL, so a node's true nearest neighbour
    // can be absent from it and the panel listed one neighbour for conversations
    // that genuinely had several. These lists are the same kNN before the cut.
    const { store } = scriptedStore(makeChunks(8, 3));
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });

    const lists = result!.projection.nodeNeighbors;
    expect(lists).toHaveLength(result!.projection.nodes.length);
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0);
      // Most similar first, so the panel can render them in order as given.
      for (let index = 1; index < list.length; index += 1) {
        expect(list[index - 1].similarity).toBeGreaterThanOrEqual(list[index].similarity);
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
    const { store } = scriptedStore(makeChunks(6, 2));
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
    result!.projection.nodeNeighbors.forEach((list, row) => {
      for (const entry of list) expect(entry.index).not.toBe(row);
    });
  });

  it('reports the index size as text plus vectors', async () => {
    // Chunks are what the panel could always show; bytes are the unit a reader
    // who does not know what a chunk is can still act on.
    const documentCount = 6;
    const chunksPerDocument = 2;
    const totalChunks = documentCount * chunksPerDocument;
    // The vector half counts only what is EMBEDDED - an unembedded chunk has no
    // vec0 row and occupies no vector bytes - while the text half counts every
    // chunk, because the text is stored either way.
    const embeddedChunks = documentCount * (chunksPerDocument - UNEMBEDDED_PER_DOC);
    const { store } = scriptedStore(makeChunks(documentCount, chunksPerDocument));
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });

    expect(result!.projection.storageBytes).toBe(
      totalChunks * TEXT_BYTES_PER_CHUNK + embeddedChunks * DIMENSIONS * 4,
    );
  });

  it('splits identifiers so a label is readable', async () => {
    // Task titles are full of identifiers. Lowercasing before splitting turned
    // `pruneOrphanedDirectories` into the single unreadable token
    // "pruneorphaneddirectories", which shipped as a real cluster label.
    const chunks = makeChunks(8, 2);
    const { store } = scriptedStore(chunks);
    const original = store.documentMetadata.bind(store);
    // Two distinct halves: a title every document shares would be excluded by
    // the corpus ceiling (correctly - it distinguishes nothing) and the test
    // would pass vacuously against "unlabelled".
    (store as unknown as { documentMetadata: () => unknown[] }).documentMetadata = () =>
      (original() as Array<{ title: string }>).map((row, index) => ({
        ...row,
        title: index % 2 === 0 ? 'pruneOrphanedDirectories cleanup' : 'spawn_agent routing',
      }));

    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
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
    const chunks = makeChunks(24, 2);
    const { store } = scriptedStore(chunks);
    const original = store.documentMetadata.bind(store);
    (store as unknown as { documentMetadata: () => unknown[] }).documentMetadata = () =>
      (original() as Array<{ title: string; docId: string }>).map((row, index) => ({
        ...row,
        // "agent project" in EVERY title; the distinctive half varies.
        title: `agent project ${index % 2 === 0 ? 'terminal scrollback' : 'sqlite migration'}`,
      }));

    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
    const labels = balancedRegions(result!.projection).map((cluster) => cluster.label).join(' ');
    expect(labels).not.toContain('agent');
    expect(labels).not.toContain('project');
    expect(labels).toMatch(/terminal|scrollback|sqlite|migration/);
  });

  it('groups the map into labelled clusters', async () => {
    const { store } = scriptedStore(makeChunks(30, 2));
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });

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

  it('advances the cursor past gaps in the chunk ids', async () => {
    // Rowids are not contiguous - deleted chunks leave holes. A pass that
    // advanced by "rows returned" rather than by the last id SEEN would stall
    // forever on a sparse page.
    const chunks = makeChunks(6, 3).filter((chunk) => chunk.id % 4 !== 0);
    const { store } = scriptedStore(chunks);
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay, scanBatch: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.sums.lastScannedChunkId).toBe(Math.max(...chunks.map((chunk) => chunk.id)));
  });

  it('produces the SAME neighbours whether kNN is chunked or not', async () => {
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

  it('resumes from the cache instead of rescanning', async () => {
    const chunks = makeChunks(8, 3);
    const shared = new Map<string, string>();

    const first = scriptedStore(chunks, shared);
    const initial = await runProjectionPass({
      store: first.store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay, scanBatch: 4,
    });
    expect(initial).not.toBeNull();
    shared.set(PROJECTION_SUMS_KEY, JSON.stringify(initial!.sums));

    // Second pass over the SAME corpus should find nothing new to scan.
    const second = scriptedStore(chunks, shared);
    const resumed = await runProjectionPass({
      store: second.store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay, scanBatch: 4,
    });
    expect(resumed).not.toBeNull();
    expect(resumed!.projection.nodes).toHaveLength(8);
    // One probe that returns nothing, versus several pages on a cold pass.
    expect(second.listCalls()).toBe(1);
  });

  it('does NOT double-count a re-indexed document', async () => {
    // `upsertDocument` re-indexes by deleting from the first divergent seq and
    // reinserting, minting new ids under the same doc key. Trusting the cursor
    // alone would fold the new chunks on top of the old ones' contribution.
    const original = makeChunks(4, 3);
    const shared = new Map<string, string>();
    const first = scriptedStore(original, shared);
    const initial = await runProjectionPass({
      store: first.store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
    shared.set(PROJECTION_SUMS_KEY, JSON.stringify(initial!.sums));

    // doc-000 re-indexed: its 3 chunks replaced by 2 with fresh, higher ids.
    const reindexed = original
      .filter((chunk) => chunk.docId !== 'doc-000')
      .concat([
        { id: 500, corpus: 'conversation', docId: 'doc-000', vector: unitVector(99) },
        { id: 501, corpus: 'conversation', docId: 'doc-000', vector: unitVector(98) },
      ]);

    const second = scriptedStore(reindexed, shared);
    const after = await runProjectionPass({
      store: second.store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });

    const node = after!.projection.nodes.find((entry) => entry.docKey.endsWith('doc-000'));
    // The re-indexed document's own embedded count, not that plus the stale one.
    // A double-count would report the old 3 on top of the new 2.
    expect(node?.chunkCount).toBe(2 - UNEMBEDDED_PER_DOC);
  });

  it('discards a cache built under a different model', async () => {
    const chunks = makeChunks(5, 2);
    const shared = new Map<string, string>();
    const first = scriptedStore(chunks, shared);
    const initial = await runProjectionPass({
      store: first.store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
    shared.set(PROJECTION_SUMS_KEY, JSON.stringify(initial!.sums));

    const second = scriptedStore(chunks, shared);
    const rebuilt = await runProjectionPass({
      store: second.store, modelTag: 'bge-large@q8-cls', dimensions: DIMENSIONS, delay: instantDelay,
    });
    // Rescanned from scratch: counts are right rather than doubled or empty.
    expect(rebuilt!.projection.nodes).toHaveLength(5);
    for (const node of rebuilt!.projection.nodes) {
      expect(node.chunkCount).toBe(2 - UNEMBEDDED_PER_DOC);
    }
  });

  it('projects nothing when the requested width does not match the stored vectors', async () => {
    // The failure mode this pins, seen for real: a corpus embedded at 1024
    // dimensions read under a 768-dimension config projected ZERO nodes, with
    // no error - every vector was correctly rejected as the wrong width and
    // the map came out empty. `accumulateVector` is what rejects them, and the
    // fix is upstream (graph-service reads the width from the DB, not config),
    // so this test documents WHY that indirection exists.
    const { store } = scriptedStore(makeChunks(10, 3));
    const mismatched = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS * 2, delay: instantDelay,
    });
    expect(mismatched!.projection.nodes).toHaveLength(0);

    const matched = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
    expect(matched!.projection.nodes).toHaveLength(10);
  });

  it('returns null when aborted', async () => {
    const { store } = scriptedStore(makeChunks(20, 3));
    const signal = { aborted: false };
    const pass = runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, scanBatch: 2,
      delay: async () => { signal.aborted = true; },
      signal,
    });
    await expect(pass).resolves.toBeNull();
  });

  it('handles an empty corpus', async () => {
    const { store } = scriptedStore([]);
    const result = await runProjectionPass({
      store, modelTag: MODEL_TAG, dimensions: DIMENSIONS, delay: instantDelay,
    });
    expect(result!.projection.nodes).toHaveLength(0);
    expect(result!.projection.edges).toHaveLength(0);
  });
});
