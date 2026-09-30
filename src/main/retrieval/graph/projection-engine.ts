/**
 * The Knowledge Graph's projection pass: read embeddings, mean-pool per document,
 * lay the documents out, and cache the result.
 *
 * WHY IT IS PACED. `.claude/rules/central-embedding-engine.md` exists because
 * inline embedding work in lifecycle hooks produced felt hardware spikes on
 * project switch. A full projection is new compute of exactly that class, so it
 * follows the same discipline as `embed-engine.ts`: a self-paced drain loop, a
 * duty-cycle sleep derived from each batch's MEASURED wall time, and no work at
 * all from an IPC handler or a lifecycle hook. Callers may only `markDirty`.
 *
 * WHY THERE IS NO UTILITY PROCESS. The plan called for one on the assumption
 * that kNN would cost ~0.5s. Measured on the real corpus (638 documents, 1024
 * dimensions) kNN is 243ms and the layout is 81ms, against a 62-SECOND scan of
 * 51,265 vectors. Moving 330ms off-thread while leaving 62s of DB I/O on it
 * optimizes the wrong end and buys a whole client/worker/crash-cap apparatus to
 * do it. So the math runs inline, chunked, in the same paced loop as the scan.
 * This mirrors `embed-engine`, where the loop is on main and only ONNX
 * inference is off-thread.
 *
 * WHY IT IS INCREMENTAL. That 62s is unavoidable per-vector cost (vec0 decodes
 * each blob; a sequential scan measured 62s against 68s for a batched one, so
 * there is no cheaper read). Paying it on every rebuild would make the surface
 * unusable on an actively-indexed project. Instead each document's vector sum
 * is stored in `memory_doc_sums`, with a prefix no later write can change, so a
 * pass reads only the documents that changed, and of a live conversation only
 * its newest chunks (`readDocument`).
 */

import type { DocSumRow, DocSumWrite, RetrievalStore } from '../retrieval-store';
import { CONVERSATION_CORPUS } from '../corpora';
import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../../shared/types';
import { KNOWLEDGE_GRAPH_GRANULARITIES } from '../../../shared/types';
import {
  addVectorInto,
  createMeanPoolAccumulator,
  finalizeMeanPool,
  embedNeighborGraphSteps,
  fitLayoutToPercentileBoxN,
  setDocumentSum,
} from './projection-math';
import { computeCosineNeighbors, buildSimilarityEdgesByQuantile } from './neighbor-edges';
import { agentRegistry } from '../../agent/agent-registry';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import {
  assignClusters,
  chooseClusterCountSteps,
  labelClusters,
  REGION_SIZE_BANDS,
} from './cluster-labels';
import { runInSlices } from './stepwise';

/** `memory_meta` keys. Versioned so a format change invalidates rather than
 *  mis-parses an old blob.
 *
 *  Bumped for every SHAPE change (v2 added a 3D layout alongside the flat one; v3
 *  dropped the flat one, so a node carries a single `x, y, z`; v4 added the
 *  agent/model/effort a conversation ran at, and the index's size on disk; v5
 *  added the exact per-node neighbour lists the detail panel reads; v6 chose the
 *  region count from the data, which changes the clusters themselves rather than
 *  the payload's shape - a cached blob would otherwise keep serving the old
 *  ten-region carve-up forever, since the freshness signature does not move for
 *  it either; v7 added each conversation's duration, cost and token count, and
 *  changed the region labels to phrases; v8 replaced the region-count score with
 *  a size rule, which again changes the CLUSTERS rather than the shape; v9 ships
 *  all three granularities, which IS a shape change). All
 *  bumps are load-bearing rather than cosmetic: the freshness signature is
 *  `${modelTag}:${chunkCount}:${maxChunkId}`, which a shape change does not move
 *  at all, so an older blob would have matched, been served, and rendered with
 *  coordinates the renderer does not have - the same silent-empty failure the
 *  1024-vs-768 width mismatch caused here once already. Bump on every shape
 *  change; the signature will not do it for you. */
export const PROJECTION_CACHE_KEY = 'graph_projection_v11';

/**
 * Components in the layout. Three, and only three: the surface is spatial-only,
 * so nothing consumes a flat projection and nothing needs to choose.
 */
const LAYOUT_COMPONENTS = 3;

/** Chunk states read per page of a changed document: 3.3 ms at most a page on
 *  the longest real conversation (4,832 chunks), where one read of it all took
 *  58 ms. */
const SCAN_BATCH = 400;
/** Vectors read per page. vec0 decodes each one: a 400-row page took about
 *  450 ms on the real index. */
const VECTOR_PAGE = 100;
/** Stored document sums read per page, each carrying its 8 KB sum at 1,024
 *  dimensions. */
const SUMS_PAGE = 100;
/**
 * How many of a document's newest chunks stay out of its stored prefix. A live
 * conversation is indexed again after every turn, and appending entries
 * rewrites at most its last chunk: `chunkTranscript` never reopens a chunk it
 * closed, and only the open last one grows or splits from the one it was
 * merged into. Two leaves one chunk of slack. This is for speed only. A rewrite
 * that reaches the prefix deletes a chunk in it, and the delete trigger on
 * `memory_chunks` empties the prefix (see `memory_doc_sums` in the schema).
 */
export const PREFIX_TAIL_MARGIN = 2;
/** Rows of kNN computed between yields. kNN is O(n*d) per row; at 1024
 *  dimensions this keeps a slice near a millisecond. */
const NEIGHBOR_CHUNK = 32;
/** Longest a stepwise phase (the layout, a region-count sweep) runs before it
 *  pauses. Under a frame at 60 Hz. */
const SLICE_MS = 12;
/** Conversations per page of the metadata read: at most about 38 ms a page on
 *  1,005 conversations, where the whole read in one statement was 270 ms. */
const METADATA_PAGE_DOCUMENTS = 50;
/** Share of wall time the pass may occupy. Matches `EMBED_DUTY_CYCLE`. */
const DUTY_CYCLE = 0.2;
/** Neighbours per document for the layout and the edge list. Measured: 10
 *  maximizes neighbourhood preservation on the real corpus. */
const NEIGHBOR_COUNT = 10;
/** Fraction of candidate edges kept. A QUANTILE, never an absolute cosine
 *  floor - see `buildSimilarityEdgesByQuantile` for the measurements. */
const EDGE_KEEP_FRACTION = 0.4;
/** Neighbours carried per node for the detail panel. Six is what the panel
 *  shows; the kNN computes ten, so this is a trim rather than a second pass. */
const DETAIL_NEIGHBOR_COUNT = 6;

/**
 * The projection IS the IPC payload - deliberately one definition rather than
 * an internal shape plus a wire shape that have to be kept in step. It is
 * JSON-serialized into `memory_meta` and sent to the renderer unchanged, so a
 * second parallel type would only be an opportunity for the two to drift.
 */
export type GraphNodePosition = KnowledgeGraphNode;
export type GraphProjection = KnowledgeGraphProjection;

/** Identity of the corpus a cached projection was built from. A change here
 *  means the cache is stale. `maxChunkId` alone is not enough: a deletion
 *  leaves it unchanged while the count drops. */
export function buildSignature(modelTag: string, chunkCount: number, maxChunkId: number): string {
  return `${modelTag}:${chunkCount}:${maxChunkId}`;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Pure duty-cycle pacer, same shape as `computeEmbedSleepMs`: driven by the
 *  batch's REAL measured time, so it self-adapts to any machine and throttles
 *  harder under contention rather than making a busy machine busier. */
export function computeProjectionSleepMs(lastBatchMs: number, dutyCycle: number): number {
  if (dutyCycle <= 0) return 0;
  return Math.max(0, lastBatchMs * (1 / dutyCycle - 1));
}

export interface ProjectionPassDeps {
  readonly store: RetrievalStore;
  readonly modelTag: string;
  readonly dimensions: number;
  /** Injected for tests; defaults to a real timer. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly dutyCycle?: number;
  readonly scanBatch?: number;
  /** Aborts a pass in flight (project switch, shutdown, model change). */
  readonly signal?: { readonly aborted: boolean };
}

/** A document's sums as a pass holds them. */
interface DocumentSums {
  /** Vectors folded into `fullSum`. */
  foldedCount: number;
  /** Null when no vector of the document was folded. */
  fullSum: Float64Array | null;
  /** Bytes of the document's chunk text. */
  textBytes: number;
}

/** A document's chunk totals, read at the start of a pass. */
interface LiveDocument {
  docId: string;
  chunkCount: number;
  embeddedCount: number;
}

/**
 * Whether a stored row still describes its document: the same model and width,
 * the same chunk and embedded counts, and the same index time. The counts alone
 * miss a document rewritten at the same count (a live conversation's newest
 * chunk grows in place and is embedded again), which the index time catches.
 * A document with no index time at all has not moved by it: Rebuild index
 * deletes every index-state row and then re-indexes, and a pass in between
 * would otherwise read every vector again.
 */
function storedRowHolds(
  row: DocSumRow,
  live: LiveDocument,
  liveIndexedAt: string | null,
  modelTag: string,
  dimensions: number,
): boolean {
  return row.modelTag === modelTag
    && row.dimensions === dimensions
    && row.chunkCount === live.chunkCount
    && row.embeddedCount === live.embeddedCount
    && (liveIndexedAt === null || row.indexedAt === liveIndexedAt)
    && (row.foldedCount === 0 || row.fullSum?.length === dimensions);
}

/**
 * Read one document again from its stored prefix on, and compute its new sums.
 *
 * The prefix is a run of chunks from seq 0 whose vectors are all folded in, and
 * no later write can change it without the schema's triggers emptying it, so
 * only the chunks after it are read. The new prefix extends over the chunks
 * read, up to the first one with no vector and short of the newest
 * `PREFIX_TAIL_MARGIN`. A live conversation's next turn then reads a few
 * chunks, where it read the whole conversation before.
 *
 * `write` carries the version and index time read here, so the store writes it
 * only if nothing changed the document while this read yielded
 * (`RetrievalStore.writeDocSums`). The sums are used for this pass either way:
 * they are what the chunks held when read.
 */
async function readDocument(
  store: RetrievalStore,
  docId: string,
  modelTag: string,
  dimensions: number,
  scanBatch: number,
  pace: (workedMs: number) => Promise<void>,
  aborted: () => boolean,
): Promise<{ sums: DocumentSums; write: DocSumWrite; vectorsRead: number } | null> {
  const indexedAt = store.getIndexState('conversation', docId)?.indexedAt ?? null;
  const stored = store.docSumPrefix('conversation', docId);
  const prefix = stored
    && stored.modelTag === modelTag
    && stored.dimensions === dimensions
    && stored.prefixThroughSeq >= 0
    && stored.prefixSum?.length === dimensions
    ? stored
    : null;

  const fullSum = new Float64Array(dimensions);
  const prefixSum = new Float64Array(dimensions);
  if (prefix?.prefixSum) {
    fullSum.set(prefix.prefixSum);
    prefixSum.set(prefix.prefixSum);
  }
  let prefixThroughSeq = prefix?.prefixThroughSeq ?? -1;
  let prefixCount = prefix?.prefixCount ?? 0;
  let prefixTextBytes = prefix?.prefixTextBytes ?? 0;
  // Every chunk up to the prefix exists and is folded, so the counts start there.
  let chunkCount = prefixCount;
  let embeddedCount = prefixCount;
  let foldedCount = prefixCount;
  let textBytes = prefixTextBytes;

  // The chunks after the prefix that can still join it: folded, with no chunk
  // lacking a vector before them. The newest `PREFIX_TAIL_MARGIN` wait here
  // until newer ones arrive.
  const waiting: Array<{ seq: number; vector: Float32Array; textBytes: number }> = [];
  let runOpen = true;
  let newestSeq = prefixThroughSeq;
  let vectorsRead = 0;
  const joinPrefix = (chunk: { seq: number; vector: Float32Array; textBytes: number }): void => {
    addVectorInto(prefixSum, chunk.vector);
    prefixThroughSeq = chunk.seq;
    prefixCount += 1;
    prefixTextBytes += chunk.textBytes;
  };

  for (;;) {
    if (aborted()) return null;
    let startedAt = Date.now();
    const states = timeSyncWork('graph:read-chunks', () => store.chunkStatesAfter('conversation', docId, newestSeq, scanBatch));
    await pace(Date.now() - startedAt);
    if (states.length === 0) break;

    const embeddedIds = states.filter((state) => state.embedded).map((state) => state.id);
    vectorsRead += embeddedIds.length;
    const vectors = new Map<number, Float32Array>();
    for (let start = 0; start < embeddedIds.length; start += VECTOR_PAGE) {
      if (aborted()) return null;
      startedAt = Date.now();
      const page = timeSyncWork('graph:read-vectors', () => store.readVectors(embeddedIds.slice(start, start + VECTOR_PAGE), 'conversation'));
      for (const [id, vector] of page) vectors.set(id, vector);
      await pace(Date.now() - startedAt);
    }

    for (const state of states) {
      chunkCount += 1;
      textBytes += state.textBytes;
      newestSeq = state.seq;
      if (state.embedded) embeddedCount += 1;
      const vector = state.embedded ? vectors.get(state.id) : undefined;
      const folded = vector !== undefined && addVectorInto(fullSum, vector);
      if (folded) foldedCount += 1;
      if (!runOpen) continue;
      if (!folded) {
        runOpen = false;
        continue;
      }
      waiting.push({ seq: state.seq, vector, textBytes: state.textBytes });
      if (waiting.length > PREFIX_TAIL_MARGIN) joinPrefix(waiting.shift()!);
    }
  }
  // What still waits joins unless it is among the newest chunks. When the run
  // reached the newest chunk none does; when it stopped at a chunk with no
  // vector, the ones well before it can.
  for (const chunk of waiting) {
    if (chunk.seq > newestSeq - PREFIX_TAIL_MARGIN) break;
    joinPrefix(chunk);
  }

  const sums: DocumentSums = { foldedCount, fullSum: foldedCount > 0 ? fullSum : null, textBytes };
  const write: DocSumWrite = {
    docId,
    expectedVersion: stored?.version ?? null,
    modelTag,
    dimensions,
    chunkCount,
    embeddedCount,
    indexedAt,
    textBytes,
    foldedCount,
    fullSum: sums.fullSum,
    prefixThroughSeq,
    prefixCount,
    prefixTextBytes,
    prefixSum: prefixCount > 0 ? prefixSum : null,
  };
  return { sums, write, vectorsRead };
}

/** What a pass read again, for its log line: the steady state is a few
 *  documents and a few vectors. */
export interface ProjectionReadCounts {
  documents: number;
  documentsRead: number;
  vectorsRead: number;
}

/**
 * Every conversation's sums: the stored ones that still hold, and the changed
 * and new documents read again, each stored as it is read. Stored rows of
 * documents gone from the index are deleted. Paged and paced throughout.
 */
async function readDocumentSums(
  store: RetrievalStore,
  modelTag: string,
  dimensions: number,
  scanBatch: number,
  pace: (workedMs: number) => Promise<void>,
  aborted: () => boolean,
): Promise<{ sums: Map<string, DocumentSums>; embeddedChunks: number; counts: ProjectionReadCounts } | null> {
  // Both are index reads: the counts come off the covering
  // (corpus, doc_id, embedded_model) index, about 10 ms on 94k chunks.
  const live = new Map<string, LiveDocument>();
  let embeddedChunks = 0;
  for (const row of store.documentChunkTotals(CONVERSATION_CORPUS)) {
    live.set(row.docId, row);
    embeddedChunks += row.embeddedCount;
  }
  const liveIndexTimes = store.documentIndexTimes('conversation');

  const sums = new Map<string, DocumentSums>();
  const gone: string[] = [];
  let afterDocId = '';
  for (;;) {
    if (aborted()) return null;
    const startedAt = Date.now();
    const page = timeSyncWork('graph:read-sums', () => store.docSumsPage('conversation', afterDocId, SUMS_PAGE));
    if (page.length === 0) break;
    for (const row of page) {
      const document = live.get(row.docId);
      if (!document) {
        gone.push(row.docId);
      } else if (storedRowHolds(row, document, liveIndexTimes.get(row.docId) ?? null, modelTag, dimensions)) {
        sums.set(row.docId, { foldedCount: row.foldedCount, fullSum: row.fullSum, textBytes: row.textBytes });
      }
    }
    afterDocId = page[page.length - 1].docId;
    await pace(Date.now() - startedAt);
  }

  const counts: ProjectionReadCounts = { documents: live.size, documentsRead: 0, vectorsRead: 0 };
  for (const document of live.values()) {
    if (sums.has(document.docId)) continue;
    const read = await readDocument(store, document.docId, modelTag, dimensions, scanBatch, pace, aborted);
    if (read === null) return null;
    sums.set(document.docId, read.sums);
    counts.documentsRead += 1;
    counts.vectorsRead += read.vectorsRead;
    timeSyncWork('graph:write-sums', () => store.writeDocSums('conversation', [read.write]));
  }
  if (gone.length > 0) timeSyncWork('graph:delete-sums', () => store.deleteDocSums('conversation', gone));
  return { sums, embeddedChunks, counts };
}

/**
 * Run one projection pass. Yields to the event loop between batches so a long
 * scan never blocks the UI, and returns null if aborted.
 */
export async function runProjectionPass(
  deps: ProjectionPassDeps,
): Promise<{ projection: GraphProjection; counts: ProjectionReadCounts } | null> {
  const { store, modelTag, dimensions } = deps;
  const delay = deps.delay ?? defaultDelay;
  const dutyCycle = deps.dutyCycle ?? DUTY_CYCLE;
  const scanBatch = deps.scanBatch ?? SCAN_BATCH;
  const aborted = (): boolean => deps.signal?.aborted === true;
  // No single step may hold main for more than a slice; each is followed by a
  // sleep that keeps the pass to its share of wall time.
  const pace = (workedMs: number): Promise<void> => delay(computeProjectionSleepMs(workedMs, dutyCycle));

  // The map is drawn from conversations. Task records and session changes are
  // searched, never drawn, so they stay out of the scan and out of the
  // signature: a board edit must not rebuild the map.
  const documents = await readDocumentSums(store, modelTag, dimensions, scanBatch, pace, aborted);
  if (documents === null || aborted()) return null;

  const accumulator = createMeanPoolAccumulator(dimensions);
  let textBytes = 0;
  for (const [docId, document] of documents.sums) {
    textBytes += document.textBytes;
    if (document.fullSum) setDocumentSum(accumulator, `conversation::${docId}`, document.fullSum, document.foldedCount);
  }

  const pooled = finalizeMeanPool(accumulator);
  const neighbors = await computeNeighborsChunked(pooled.matrix, pooled.rowCount, dimensions, delay, dutyCycle, aborted);
  if (neighbors === null) return null;

  // ONE layout, in three components. Measured on the real 638-document corpus,
  // the third axis is worth having on its own terms: neighbourhood preservation
  // is 33.1% against 28.1% for the same embedder flattened to two, because some
  // of what flattening loses is simply recoverable with another axis. It costs
  // about 145 ms on 1,005 conversations, so it runs in slices of epochs.
  //
  // There was briefly a second, 2D run seeded into this one, to keep the two
  // views orientated alike. The surface is spatial-only now, so there is no
  // second view to stay aligned with and the seeding has no job left.
  const embedded = await runInSlices(
    embedNeighborGraphSteps(neighbors, pooled.rowCount, { components: LAYOUT_COMPONENTS }),
    SLICE_MS,
    pace,
    aborted,
  );
  if (embedded === null) return null;
  const positions = fitLayoutToPercentileBoxN(embedded, pooled.rowCount, LAYOUT_COMPONENTS);

  // Metadata is what turns a point into something worth clicking: a title to
  // read, a session to open, a timestamp to colour by. Read a page of
  // conversations at a time (see `documentMetadata`).
  const metadataByDocKey = new Map<string, ReturnType<RetrievalStore['documentMetadata']>[number]>();
  let afterDocId = '';
  for (;;) {
    if (aborted()) return null;
    const startedAt = Date.now();
    const page = timeSyncWork('graph:document-metadata', () => store.documentMetadata(afterDocId, METADATA_PAGE_DOCUMENTS));
    if (page.length === 0) break;
    for (const row of page) metadataByDocKey.set(`${row.corpus}::${row.docId}`, row);
    afterDocId = page[page.length - 1].docId;
    await pace(Date.now() - startedAt);
  }

  // Clustered in the SAME space the map is drawn in, so a label always names the
  // blob the eye sees. While a flat view existed this had to be done in 2D and
  // reused in 3D, and the reuse only held to ~76% member contiguity; assigning
  // here removes that compromise rather than managing it.
  //
  // ALL THREE granularities, computed together. How finely to cut the map is a
  // readability preference rather than a fact - every separation score is
  // maximised by the fewest regions on a continuous cloud - so the reader gets
  // the choice. Computing them here rather than storing the choice means
  // switching costs nothing: this is milliseconds of k-means over a layout that
  // already exists, against a full projection rebuild behind a display control.
  const labelSources = pooled.docKeys.map((docKey) => metadataByDocKey.get(docKey)?.title ?? '');
  const clusterings: Array<{
    granularity: typeof KNOWLEDGE_GRAPH_GRANULARITIES[number];
    assignment: ReturnType<typeof assignClusters>;
    regions: ReturnType<typeof labelClusters>;
  }> = [];
  for (const granularity of KNOWLEDGE_GRAPH_GRANULARITIES) {
    // The LAYOUT is handed in so the count is chosen by clustering at each
    // candidate and measuring the regions it actually produces. Without it
    // this can only guess from the size, which is what carved nine regions out
    // of 150 conversations because there were 150 of them. The coarse sweep
    // alone is about 84 ms, so it runs in slices of candidates.
    const clusterCount = await runInSlices(
      chooseClusterCountSteps(pooled.rowCount, positions, LAYOUT_COMPONENTS, REGION_SIZE_BANDS[granularity]),
      SLICE_MS,
      pace,
      aborted,
    );
    if (clusterCount === null) return null;
    const startedAt = Date.now();
    const assignment = assignClusters(positions, pooled.rowCount, clusterCount, LAYOUT_COMPONENTS);
    const regions = labelClusters(assignment, labelSources, positions, LAYOUT_COMPONENTS);
    clusterings.push({ granularity, assignment, regions });
    await pace(Date.now() - startedAt);
  }

  const nodes: GraphNodePosition[] = pooled.docKeys.map((docKey, row) => {
    const metadata = metadataByDocKey.get(docKey);
    return {
      docKey,
      x: positions[row * LAYOUT_COMPONENTS],
      y: positions[row * LAYOUT_COMPONENTS + 1],
      z: positions[row * LAYOUT_COMPONENTS + 2],
      chunkCount: pooled.chunkCounts[row],
      title: metadata?.title ?? null,
      sessionId: metadata?.sessionId ?? null,
      taskId: metadata?.taskId ?? null,
      displayId: metadata?.displayId ?? null,
      // The adapter's DISPLAY name, never the raw `session_type`: the panel was
      // printing "claude_agent" at the user. Resolved through the registry
      // rather than mapped here, per `agent-adapters-boundary`.
      agent: metadata?.agent
        ? agentRegistry.getBySessionType(metadata.agent)?.displayName ?? metadata.agent
        : null,
      model: metadata?.model ?? null,
      effort: metadata?.effort ?? null,
      durationMs: metadata?.durationMs ?? null,
      costUsd: metadata?.costUsd ?? null,
      // Zero means "recorded nothing", which is not the same as "cost nothing" -
      // treat it as absent so the card omits the row instead of claiming 0.
      tokens: metadata?.tokens ? metadata.tokens : null,
      lastActivityMs: metadata?.lastActivityMs ?? null,
      outcome: (metadata?.outcome as GraphNodePosition['outcome']) ?? null,
      clusters: Object.fromEntries(
        clusterings.map((entry) => [entry.granularity, entry.assignment.clusterOf[row] ?? 0]),
      ) as GraphNodePosition['clusters'],
    };
  });

  // EMBEDDED chunks, not every chunk. The distinction is load-bearing for the
  // vector half of the size below - an unembedded chunk has no row in
  // `memory_chunks_vec` and so occupies no vector bytes - and it is what the
  // freshness signature has always counted.
  const { embeddedChunks } = documents;

  const projection: GraphProjection = {
    nodes,
    clusterings: clusterings.map((entry) => ({
      granularity: entry.granularity,
      regions: entry.regions,
    })),
    edges: buildSimilarityEdgesByQuantile(neighbors, EDGE_KEEP_FRACTION),
    // The SAME kNN the edges are pruned from, kept unpruned. Computing it is
    // already paid for; throwing it away is what made the panel's "closest
    // conversations" a subset of whatever survived the mesh quantile.
    nodeNeighbors: buildNodeNeighborLists(neighbors, pooled.docKeys.length, DETAIL_NEIGHBOR_COUNT),
    signature: buildSignature(modelTag, embeddedChunks, store.maxChunkId('conversation')),
    modelTag,
    dimensions,
    // Only the vector half is arithmetic: vec0 rows are fixed-width, so it is
    // exactly embeddedChunks * dims * 4. The text half is the sum of each
    // document's stored size. Both belong here rather than in `getSnapshot`,
    // which must stay a cheap read. The snapshot adds the other corpora's size,
    // which is small enough to read live (`KnowledgeGraphIndexSummary`).
    storageBytes: textBytes + embeddedChunks * dimensions * 4,
    builtAt: new Date().toISOString(),
  };
  return { projection, counts: documents.counts };
}

/**
 * Flatten the kNN lists into one array per node, indexed positionally so the
 * renderer can look a node's neighbours up by its own index with no map.
 *
 * `computeCosineNeighbors` already returns them sorted most-similar-first, so
 * this only trims and reindexes.
 */
export function buildNodeNeighborLists(
  neighbors: ReadonlyArray<{ readonly row: number; readonly neighbors: ReadonlyArray<{ readonly row: number; readonly similarity: number }> }>,
  rowCount: number,
  perNode: number,
): Array<Array<{ index: number; similarity: number }>> {
  const lists: Array<Array<{ index: number; similarity: number }>> = [];
  for (let row = 0; row < rowCount; row += 1) lists.push([]);
  for (const list of neighbors) {
    if (list.row < 0 || list.row >= rowCount) continue;
    lists[list.row] = list.neighbors
      .slice(0, perNode)
      .map((entry) => ({ index: entry.row, similarity: entry.similarity }));
  }
  return lists;
}

/** kNN in slices, yielding between them. 638 documents at 1024 dimensions is
 *  ~243ms uninterrupted, which is ~15 dropped frames if run in one go. */
async function computeNeighborsChunked(
  matrix: Float32Array,
  rowCount: number,
  dimensions: number,
  delay: (ms: number) => Promise<void>,
  dutyCycle: number,
  aborted: () => boolean,
): Promise<ReturnType<typeof computeCosineNeighbors> | null> {
  if (rowCount === 0) return [];
  const lists: ReturnType<typeof computeCosineNeighbors> = [];

  for (let start = 0; start < rowCount; start += NEIGHBOR_CHUNK) {
    if (aborted()) return null;
    const startedAt = Date.now();
    const end = Math.min(rowCount, start + NEIGHBOR_CHUNK);

    // Slice the QUERY side only: every row still compares against the whole
    // corpus, so the result is identical to an unchunked pass.
    const slice = computeCosineNeighbors(matrix, rowCount, dimensions, NEIGHBOR_COUNT, start, end);
    lists.push(...slice);

    await delay(computeProjectionSleepMs(Date.now() - startedAt, dutyCycle));
  }
  return lists;
}

function readJson<T>(store: RetrievalStore, key: string): T | null {
  const raw = store.getMeta(key);
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt or older-format blob is not an error worth surfacing: the pass
    // simply rebuilds from scratch.
    return null;
  }
}

export function readCachedProjection(store: RetrievalStore): GraphProjection | null {
  return readJson<GraphProjection>(store, PROJECTION_CACHE_KEY);
}

/** Store a finished pass's map. Its sums were stored as the pass read them. */
export function writeProjectionCache(store: RetrievalStore, projection: GraphProjection): void {
  timeSyncWork('graph:write-projection', () => store.setMeta(PROJECTION_CACHE_KEY, JSON.stringify(projection)));
}

/** Whether a cached projection still describes the corpus. */
export function isProjectionFresh(
  projection: GraphProjection | null,
  modelTag: string,
  chunkCount: number,
  maxChunkId: number,
): boolean {
  if (!projection) return false;
  return projection.signature === buildSignature(modelTag, chunkCount, maxChunkId);
}
