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
 * unusable on an actively-indexed project. Instead the per-document running
 * SUMS are cached alongside the highest chunk id folded in, so later passes
 * scan only what is new and steady-state cost is ~0.
 */

import type { RetrievalStore } from '../retrieval-store';
import { CONVERSATION_CORPUS } from '../corpora';
import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../../shared/types';
import { KNOWLEDGE_GRAPH_GRANULARITIES } from '../../../shared/types';
import {
  createMeanPoolAccumulator,
  accumulateVector,
  finalizeMeanPool,
  serializeMeanPool,
  deserializeMeanPool,
  forgetDocument,
  embedNeighborGraph,
  fitLayoutToPercentileBoxN,
  type MeanPoolAccumulator,
  type SerializedMeanPool,
} from './projection-math';
import { computeCosineNeighbors, buildSimilarityEdgesByQuantile } from './neighbor-edges';
import { agentRegistry } from '../../agent/agent-registry';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import {
  assignClusters,
  chooseClusterCount,
  labelClusters,
  REGION_SIZE_BANDS,
} from './cluster-labels';

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
 *  change; the signature will not do it for you.
 *
 *  The SUMS key deliberately stays at v1. It carries the per-document vector sums
 *  and `lastScannedChunkId`, which the new layout does not change, so keeping it
 *  makes the rebuild the ~330ms kNN + embed rather than the ~62s full vector scan. */
export const PROJECTION_CACHE_KEY = 'graph_projection_v11';
export const PROJECTION_SUMS_KEY = 'graph_projection_sums_v1';

/**
 * Components in the layout. Three, and only three: the surface is spatial-only,
 * so nothing consumes a flat projection and nothing needs to choose.
 */
const LAYOUT_COMPONENTS = 3;

/** Chunks read per batch. Small enough that one batch's DB work stays well
 *  inside a frame budget, large enough that the per-statement overhead does not
 *  dominate the 51k-row scan. */
const SCAN_BATCH = 400;
/** Rows of kNN computed between yields. kNN is O(n*d) per row; at 1024
 *  dimensions this keeps a slice near a millisecond. */
const NEIGHBOR_CHUNK = 32;
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

/**
 * What a pass starts from: the cached accumulator with every document that
 * changed taken out, and the documents to read again. `documentsToRead` is null
 * when there is no usable cache and the pass reads the whole corpus.
 *
 * A document changed when its live embedded count no longer matches the count
 * the cache folded in. `upsertDocument` re-indexes one by deleting from the
 * first divergent seq and reinserting, which mints NEW chunk ids under the SAME
 * doc key, and a new id can sit below the old scan cursor: the live
 * conversation holds the highest ids, so deleting its tail and reinserting
 * reuses them. A cursor therefore cannot find a re-indexed document's chunks.
 * This used to answer any change with a rescan of every vector in the corpus,
 * which a live conversation causes on every turn. Reading the changed
 * documents by doc key finds every chunk of theirs whatever its id, so the
 * rest keep their cached sums.
 *
 * The count alone misses a document rewritten at the SAME count: the live
 * conversation's tail chunk grows in place and is embedded again, and when no
 * pass runs in between the count reads as unchanged. So a document whose index
 * time moved is read again too. `liveIndexTimes` is read before any vector, so
 * a re-index that lands while this pass yields stamps a later time than the one
 * recorded, and the next pass reads that document again.
 *
 * A document with no index time at all has not moved by it. Rebuild index
 * deletes every index-state row and then re-indexes, so a pass in between
 * would otherwise read every vector again. Once the rebuild has re-stamped
 * them, the next pass does read every document again, once: the stamps say
 * each was indexed, not whether its chunks changed.
 */
function planScan(
  cached: SerializedMeanPool | null,
  dimensions: number,
  modelTag: string,
  liveCounts: Map<string, number>,
  liveIndexTimes: Map<string, string>,
): { accumulator: MeanPoolAccumulator; resumeFrom: number; documentsToRead: string[] | null } {
  const fullScan = { accumulator: createMeanPoolAccumulator(dimensions), resumeFrom: 0, documentsToRead: null };
  if (!cached) return fullScan;
  // Written before index times were recorded, so a same-count rewrite in it is
  // undetectable. Read once from scratch, then incremental again.
  const cachedIndexTimes = cached.indexedAtByDocKey;
  if (!cachedIndexTimes) return fullScan;
  const restored = deserializeMeanPool(cached, dimensions, modelTag);
  // Different model or width: the vectors mean something else entirely.
  if (!restored) return fullScan;

  for (const [docKey, cachedCount] of [...restored.countsByDocKey]) {
    // A document gone from the index, or with nothing embedded any more, is
    // forgotten; one whose count or index time moved is forgotten and read
    // again below.
    const liveIndexTime = liveIndexTimes.get(docKey);
    const indexTimeMoved = liveIndexTime !== undefined && liveIndexTime !== cachedIndexTimes[docKey];
    if (liveCounts.get(docKey) !== cachedCount || indexTimeMoved) forgetDocument(restored, docKey);
  }
  // Every live document the accumulator no longer holds: the changed ones, and
  // any new since the cache was written.
  const documentsToRead = [...liveCounts.keys()].filter((docKey) => !restored.countsByDocKey.has(docKey));
  return { accumulator: restored, resumeFrom: cached.lastScannedChunkId, documentsToRead };
}

/**
 * Run one projection pass. Yields to the event loop between batches so a long
 * scan never blocks the UI, and returns null if aborted.
 */
export async function runProjectionPass(
  deps: ProjectionPassDeps,
): Promise<{ projection: GraphProjection; sums: SerializedMeanPool } | null> {
  const { store, modelTag, dimensions } = deps;
  const delay = deps.delay ?? defaultDelay;
  const dutyCycle = deps.dutyCycle ?? DUTY_CYCLE;
  const scanBatch = deps.scanBatch ?? SCAN_BATCH;
  const aborted = (): boolean => deps.signal?.aborted === true;

  // The map is drawn from conversations. Task records and session changes are
  // searched, never drawn, so they stay out of the scan and out of the
  // signature: a board edit must not rebuild the map.
  const totals = store.documentChunkTotals(CONVERSATION_CORPUS);
  const liveCounts = new Map<string, number>();
  for (const row of totals) {
    if (row.embeddedCount > 0) liveCounts.set(`${row.corpus}::${row.docId}`, row.embeddedCount);
  }
  const liveIndexTimes = new Map<string, string>();
  for (const [docId, indexedAt] of store.documentIndexTimes('conversation')) {
    liveIndexTimes.set(`conversation::${docId}`, indexedAt);
  }

  const cachedSums = readJson<SerializedMeanPool>(store, PROJECTION_SUMS_KEY);
  const { accumulator, resumeFrom, documentsToRead } = planScan(
    cachedSums, dimensions, modelTag, liveCounts, liveIndexTimes,
  );

  /** Fold one page of chunks in, then pace. */
  const foldPage = async (identities: ReadonlyArray<{ id: number; corpus: string; docId: string }>): Promise<void> => {
    const startedAt = Date.now();
    const vectors = store.readVectors(identities.map((row) => row.id), 'conversation');
    for (const identity of identities) {
      const vector = vectors.get(identity.id);
      if (vector === undefined) continue;
      accumulateVector(accumulator, `${identity.corpus}::${identity.docId}`, vector);
    }
    await delay(computeProjectionSleepMs(Date.now() - startedAt, dutyCycle));
  };

  let cursor = resumeFrom;
  if (documentsToRead === null) {
    for (;;) {
      if (aborted()) return null;
      const identities = store.listChunkIdentities(cursor, scanBatch, 'conversation');
      if (identities.length === 0) break;
      await foldPage(identities);
      // Rowids are not contiguous, so advance by the last id SEEN rather than by
      // how many vectors came back - otherwise a page with gaps stalls the cursor.
      cursor = identities[identities.length - 1].id;
    }
  } else if (documentsToRead.length > 0) {
    // In pages of the same size as a full scan, paced and abortable the same
    // way: the live conversation alone can hold thousands of chunks.
    const identities = store.listDocumentChunkIdentities(
      'conversation',
      documentsToRead.map((docKey) => docKey.slice(docKey.indexOf('::') + 2)),
    );
    for (let start = 0; start < identities.length; start += scanBatch) {
      if (aborted()) return null;
      const page = identities.slice(start, start + scanBatch);
      await foldPage(page);
      for (const identity of page) cursor = Math.max(cursor, identity.id);
    }
  }

  if (aborted()) return null;

  const pooled = finalizeMeanPool(accumulator);
  const neighbors = await computeNeighborsChunked(pooled.matrix, pooled.rowCount, dimensions, delay, dutyCycle, aborted);
  if (neighbors === null) return null;

  // ONE layout, in three components. Measured on the real 638-document corpus,
  // the third axis is worth having on its own terms: neighbourhood preservation
  // is 33.1% against 28.1% for the same embedder flattened to two, because some
  // of what flattening loses is simply recoverable with another axis. It costs
  // ~82ms, against a cold pass measured in minutes.
  //
  // There was briefly a second, 2D run seeded into this one, to keep the two
  // views orientated alike. The surface is spatial-only now, so there is no
  // second view to stay aligned with and the seeding has no job left.
  const positions = fitLayoutToPercentileBoxN(
    embedNeighborGraph(neighbors, pooled.rowCount, { components: LAYOUT_COMPONENTS }),
    pooled.rowCount,
    LAYOUT_COMPONENTS,
  );

  // Metadata is what turns a point into something worth clicking: a title to
  // read, a session to open, a timestamp to colour by.
  // One statement that groups every conversation chunk row, so it is timed:
  // about 370 ms on a 94k-chunk index.
  const metadataByDocKey = new Map(
    timeSyncWork('graph:document-metadata', () => store.documentMetadata())
      .map((row) => [`${row.corpus}::${row.docId}`, row]),
  );

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
  const clusterings = KNOWLEDGE_GRAPH_GRANULARITIES.map((granularity) => {
    const assignment = assignClusters(
      positions,
      pooled.rowCount,
      // The LAYOUT is handed in so the count is chosen by clustering at each
      // candidate and measuring the regions it actually produces. Without it
      // this can only guess from the size, which is what carved nine regions out
      // of 150 conversations because there were 150 of them.
      chooseClusterCount(
        pooled.rowCount,
        positions,
        LAYOUT_COMPONENTS,
        REGION_SIZE_BANDS[granularity],
      ),
      LAYOUT_COMPONENTS,
    );
    return {
      granularity,
      assignment,
      regions: labelClusters(assignment, labelSources, positions, LAYOUT_COMPONENTS),
    };
  });

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

  // EMBEDDED chunks, not every chunk: `liveCounts` is populated from
  // `embeddedCount` above. The distinction is load-bearing for the vector half
  // of the size below - an unembedded chunk has no row in `memory_chunks_vec`
  // and so occupies no vector bytes - and it is what the freshness signature has
  // always counted.
  let embeddedChunks = 0;
  for (const count of liveCounts.values()) embeddedChunks += count;

  const textBytes = await sumIndexedTextBytes(store, delay, dutyCycle, scanBatch, aborted);
  if (textBytes === null) return null;

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
    // exactly embeddedChunks * dims * 4. The text half is a real scan, which is
    // why it is paged above rather than summed in one statement. Both belong
    // here rather than in `getSnapshot`, which must stay a cheap read.
    storageBytes: textBytes + embeddedChunks * dimensions * 4,
    builtAt: new Date().toISOString(),
  };

  return { projection, sums: serializeMeanPool(accumulator, cursor, modelTag, liveIndexTimes) };
}

/**
 * Sum the indexed chunk TEXT in paced pages.
 *
 * A single `SUM(length(text))` measured ~170ms over the real corpus, and
 * better-sqlite3 is synchronous - that would have been the one block in this
 * pass capable of exceeding a frame, in a pass whose whole point is that it
 * never does. Paged through the same duty-cycle pacer as the vector scan and
 * the kNN slicer, so it costs wall time instead of responsiveness.
 *
 * Returns null when the pass was aborted mid-scan, matching the caller's
 * existing abort contract.
 */
async function sumIndexedTextBytes(
  store: RetrievalStore,
  delay: (ms: number) => Promise<void>,
  dutyCycle: number,
  scanBatch: number,
  aborted: () => boolean,
): Promise<number | null> {
  let bytes = 0;
  let cursor = 0;
  for (;;) {
    if (aborted()) return null;
    const startedAt = Date.now();
    // The map's own corpus. The snapshot adds the other corpora's size, which
    // is small enough to read live (`KnowledgeGraphIndexSummary`).
    const page = store.indexedTextBytesPage(cursor, scanBatch, 'conversation');
    if (page.lastChunkId === 0) break;
    bytes += page.bytes;
    cursor = page.lastChunkId;
    await delay(computeProjectionSleepMs(Date.now() - startedAt, dutyCycle));
  }
  return bytes;
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

export function writeProjectionCache(
  store: RetrievalStore,
  projection: GraphProjection,
  sums: SerializedMeanPool,
): void {
  store.setMeta(PROJECTION_CACHE_KEY, JSON.stringify(projection));
  store.setMeta(PROJECTION_SUMS_KEY, JSON.stringify(sums));
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
