/**
 * Pure projection math for the knowledge graph's semantic layout.
 *
 * The graph positions each indexed document by the MEAN of its chunk
 * embeddings, then lays those means out in 3D by their nearest neighbours, so
 * on-screen proximity means semantic similarity. Keeping the math here as pure
 * functions over plain typed arrays is deliberate: it is the part of the layout
 * genuinely worth unit-testing. The measures the tests judge it by live in
 * `tests/unit/helpers/layout-measures.ts`, since nothing in the app runs them.
 *
 * Everything here is DIMENSION-AGNOSTIC. The embedding model is user-selectable
 * (384 / 768 / 1024 today) and `retrieval-store` builds the vec table from
 * `embedder.dimensions`, so nothing may assume a width.
 *
 * Matrices are row-major `Float32Array`s of `rowCount * dimensions`, which is
 * the shape the batched vec reader produces.
 */

/** Accumulates a running per-document vector sum without holding every chunk
 *  vector resident. The whole point of mean-pooling at read time: the corpus is
 *  ~200 MiB of chunk vectors but only ~5 MiB of document means. */
export interface MeanPoolAccumulator {
  readonly dimensions: number;
  /** docKey -> running sum. Float64 because a document can carry 1500+ chunks
   *  and Float32 accumulation drifts measurably at that length. */
  readonly sumsByDocKey: Map<string, Float64Array>;
  readonly countsByDocKey: Map<string, number>;
}

/** Mean-pooled, L2-normalized document vectors in a single row-major matrix. */
export interface MeanPooledDocuments {
  /** Row i of `matrix` belongs to `docKeys[i]`. */
  readonly docKeys: string[];
  readonly matrix: Float32Array;
  readonly rowCount: number;
  readonly dimensions: number;
  /** How many chunks contributed to each row, parallel to `docKeys`. */
  readonly chunkCounts: number[];
}

export function createMeanPoolAccumulator(dimensions: number): MeanPoolAccumulator {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`projection-math: dimensions must be a positive integer, got ${dimensions}`);
  }
  return { dimensions, sumsByDocKey: new Map(), countsByDocKey: new Map() };
}

/** Fold one chunk vector into its document's running sum. Vectors whose width
 *  does not match the accumulator are skipped rather than throwing: a corpus
 *  can briefly hold rows from a previous model while a re-embed drains, and one
 *  stale row must not abort a whole projection pass. */
export function accumulateVector(
  accumulator: MeanPoolAccumulator,
  docKey: string,
  vector: Float32Array,
): boolean {
  if (vector.length !== accumulator.dimensions) return false;
  let sum = accumulator.sumsByDocKey.get(docKey);
  if (sum === undefined) {
    sum = new Float64Array(accumulator.dimensions);
    accumulator.sumsByDocKey.set(docKey, sum);
  }
  for (let index = 0; index < vector.length; index += 1) {
    sum[index] += vector[index];
  }
  accumulator.countsByDocKey.set(docKey, (accumulator.countsByDocKey.get(docKey) ?? 0) + 1);
  return true;
}

/** Divide each running sum by its count and L2-normalize the result, so the
 *  mean sits on the same unit sphere the individual embeddings do and cosine
 *  similarity between means stays meaningful.
 *
 *  Document order is sorted by key so a projection is reproducible: the cache
 *  signature would otherwise match while the row order (and every position)
 *  silently changed between passes. */
export function finalizeMeanPool(accumulator: MeanPoolAccumulator): MeanPooledDocuments {
  const docKeys = [...accumulator.sumsByDocKey.keys()].sort();
  const { dimensions } = accumulator;
  const matrix = new Float32Array(docKeys.length * dimensions);
  const chunkCounts: number[] = [];

  for (let row = 0; row < docKeys.length; row += 1) {
    const sum = accumulator.sumsByDocKey.get(docKeys[row]);
    const count = accumulator.countsByDocKey.get(docKeys[row]) ?? 0;
    chunkCounts.push(count);
    if (sum === undefined || count === 0) continue;

    let squaredNorm = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const mean = sum[index] / count;
      matrix[row * dimensions + index] = mean;
      squaredNorm += mean * mean;
    }
    const norm = Math.sqrt(squaredNorm);
    if (norm <= 0) continue;
    for (let index = 0; index < dimensions; index += 1) {
      matrix[row * dimensions + index] /= norm;
    }
  }

  return { docKeys, matrix, rowCount: docKeys.length, dimensions, chunkCounts };
}

/**
 * Serializable form of a partly-built accumulator, so the ~62-second full scan
 * of the vec table is paid ONCE per project.
 *
 * Measured on the real corpus, reading all 51,265 vectors through vec0 takes
 * 62s sequentially and 68s batched - the cost is vec0's per-row blob decode, so
 * there is no faster public read. Persisting the running SUMS (not just the
 * finished means) lets a later pass read only the documents that changed and
 * fold them into what is already there, which drops steady-state cost to near
 * zero.
 *
 * `countsByDocKey` is the correctness guard, and it is not optional.
 * `upsertDocument` re-indexes a changed document by DELETING from the first
 * divergent seq and reinserting, which mints new chunk ids under the SAME doc
 * key, at or below ids already scanned. Comparing each document's live
 * embedded count, and the time it was last indexed, against the cached ones
 * finds the documents that changed; `forgetDocument` then drops the stale sum
 * and the pass reads that document again by doc key (`planScan` in
 * projection-engine.ts).
 */
export interface SerializedMeanPool {
  readonly dimensions: number;
  /** Highest `memory_chunks.id` folded in so far. */
  readonly lastScannedChunkId: number;
  /** Model tag the sums were built under. A model switch changes vector width
   *  and meaning, so a mismatch must discard the whole cache. */
  readonly modelTag: string;
  readonly sumsByDocKey: Record<string, number[]>;
  readonly countsByDocKey: Record<string, number>;
  /**
   * Each document's `memory_index_state.indexed_at` as the pass that folded it
   * in read it. The count alone misses a document rewritten at the same count:
   * a live conversation's tail chunk grows in place, keeps its seq, and is
   * embedded again, often under the same reused rowid. Absent from a blob
   * written before it was recorded, which is read again whole.
   */
  readonly indexedAtByDocKey?: Record<string, string>;
}

export function serializeMeanPool(
  accumulator: MeanPoolAccumulator,
  lastScannedChunkId: number,
  modelTag: string,
  indexedAtByDocKey: ReadonlyMap<string, string>,
): SerializedMeanPool {
  const sumsByDocKey: Record<string, number[]> = {};
  const countsByDocKey: Record<string, number> = {};
  const indexedAt: Record<string, string> = {};
  for (const [docKey, sum] of accumulator.sumsByDocKey) {
    sumsByDocKey[docKey] = Array.from(sum);
    countsByDocKey[docKey] = accumulator.countsByDocKey.get(docKey) ?? 0;
    const stamp = indexedAtByDocKey.get(docKey);
    if (stamp !== undefined) indexedAt[docKey] = stamp;
  }
  return {
    dimensions: accumulator.dimensions,
    lastScannedChunkId,
    modelTag,
    sumsByDocKey,
    countsByDocKey,
    indexedAtByDocKey: indexedAt,
  };
}

/** Rebuild an accumulator from cache. Returns null when the cache was built
 *  under a different model or width, which must force a full rescan rather
 *  than a silent mix of incompatible vectors. */
export function deserializeMeanPool(
  serialized: SerializedMeanPool,
  expectedDimensions: number,
  expectedModelTag: string,
): MeanPoolAccumulator | null {
  if (serialized.dimensions !== expectedDimensions) return null;
  if (serialized.modelTag !== expectedModelTag) return null;

  const accumulator = createMeanPoolAccumulator(serialized.dimensions);
  for (const [docKey, sum] of Object.entries(serialized.sumsByDocKey)) {
    if (sum.length !== serialized.dimensions) continue;
    accumulator.sumsByDocKey.set(docKey, Float64Array.from(sum));
    accumulator.countsByDocKey.set(docKey, serialized.countsByDocKey[docKey] ?? 0);
  }
  return accumulator;
}

/** Drop one document's accumulated sum, so it can be rescanned from scratch.
 *  Call this for any document whose live chunk count no longer matches the
 *  cached one (see `SerializedMeanPool`). */
export function forgetDocument(accumulator: MeanPoolAccumulator, docKey: string): void {
  accumulator.sumsByDocKey.delete(docKey);
  accumulator.countsByDocKey.delete(docKey);
}

/** Deterministic xorshift32. The layout's starting positions and its negative
 *  samples come from it, so a cached projection is reproducible across passes
 *  and the unit tests are stable. */
function createSeededRandom(seed: number): () => number {
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

/**
 * Rescale into the unit box using the 2nd..98th percentile as the extent rather
 * than min/max, then clamp.
 *
 * A handful of semantic outliers otherwise stretch the bounding box and pile
 * every other document into the middle: on the real corpus this alone moved
 * centroid concentration from 64.3% to 28.1% WITHOUT changing the layout's
 * actual fidelity (trust stayed ~7.5%). That is the point worth remembering -
 * it makes the picture legible, it does not make it more truthful.
 */
export function fitLayoutToPercentileBoxN(
  points: Float32Array,
  rowCount: number,
  components: number,
  lowQuantile = 0.02,
  highQuantile = 0.98,
): Float32Array {
  const fitted = new Float32Array(points.length);
  if (rowCount === 0) return fitted;

  // ONE shared extent across every axis, so the layout is never stretched: a
  // stretched axis invents separation the embedding does not claim.
  const lowerBounds: number[] = [];
  let extent = 0;
  for (let axis = 0; axis < components; axis += 1) {
    const values: number[] = [];
    for (let row = 0; row < rowCount; row += 1) values.push(points[row * components + axis]);
    values.sort((first, second) => first - second);
    const low = values[Math.floor(values.length * lowQuantile)];
    const high = values[Math.min(values.length - 1, Math.floor(values.length * highQuantile))];
    lowerBounds.push(low);
    extent = Math.max(extent, high - low);
  }

  if (extent <= 0) {
    fitted.fill(0.5);
    return fitted;
  }

  for (let row = 0; row < rowCount; row += 1) {
    for (let axis = 0; axis < components; axis += 1) {
      const scaled = (points[row * components + axis] - lowerBounds[axis]) / extent;
      fitted[row * components + axis] = Math.min(1, Math.max(0, scaled));
    }
  }
  return fitted;
}

/** Neighbour graph the embedder optimizes against, as produced by
 *  `computeCosineNeighbors` in `neighbor-edges.ts`. Kept structural so this
 *  module stays free of an import cycle. */
export interface EmbedNeighborInput {
  readonly row: number;
  readonly neighbors: ReadonlyArray<{ readonly row: number; readonly similarity: number }>;
}

export interface EmbedOptions {
  readonly epochs?: number;
  readonly negativeSamples?: number;
  readonly seed?: number;
  /** How many output components to lay out. 2 (the default) is the flat map; 3
   *  adds depth for the 3D view. Input dimensionality is unrelated and unbounded. */
  readonly components?: number;
  /**
   * An existing layout to start from, instead of pure noise. Shared axes carry
   * over; extra axes get a small jitter so the optimizer can still open the new
   * dimension up.
   *
   * Nothing uses this today. It existed to seed a 3D run from a finished 2D one
   * while the surface had both views, and what it bought was ORIENTATION, not
   * quality - measured on the real 638-document corpus, correlation between the
   * two layouts' x axes was 0.926 seeded against 0.268 unseeded, while trust
   * (33.1% / 33.3%) and cluster contiguity (75.7% / 74.1%) were unchanged. The
   * optimizer finds an equally good solution either way; the seed only decides
   * WHICH of the equally good solutions it lands on.
   *
   * Kept because that is exactly what a future second layout would need, and
   * because the measurement above is the reason to reach for it. Delete it if a
   * second layout never arrives.
   */
  readonly initial?: { readonly points: Float32Array; readonly components: number };
}

/** UMAP's fitted curve for min_dist ~0.1 / spread 1.0. These two constants
 *  shape how tightly a cluster is allowed to pack. */
const CURVE_A = 1.577;
const CURVE_B = 0.895;
const GRADIENT_CLAMP = 4;
const DEFAULT_EPOCHS = 200;
const DEFAULT_NEGATIVE_SAMPLES = 5;
/** Opening spread of an axis a seeded run is adding. Two orders of magnitude
 *  below the fresh-noise spread (10), so the carried-over axes still dominate
 *  the first epochs and the seeded structure is refined rather than discarded. */
const SEEDED_AXIS_JITTER = 0.1;

/**
 * Lay out the neighbour graph by UMAP-style stochastic gradient descent:
 * attraction along kNN edges, repulsion against randomly sampled non-neighbours.
 *
 * This is the layout the surface ships, chosen on measured evidence rather than
 * taste. On the real corpus (638 documents, 1024 dimensions) it preserves 29.5%
 * of true 10-nearest neighbourhoods, against 7.5% for PCA and 1.4% for a random
 * scatter, and it runs in ~80ms. PCA cannot do better here because the first two
 * principal components carry only 24.7% of the corpus variance - the limit is
 * linear projection itself, not the tuning.
 *
 * Deliberately hand-written rather than pulling in umap-js: the algorithm is
 * ~60 lines at this scale, a dependency would have to join the lazy
 * vendor-chunk config, and the constants above are the only tuning it needs.
 *
 * The RNG is seeded, so a given corpus always produces the same map. That
 * matters for a CACHED projection: an unseeded layout would silently rearrange
 * the user's map on every rebuild.
 */
export function embedNeighborGraph(
  lists: ReadonlyArray<EmbedNeighborInput>,
  rowCount: number,
  options: EmbedOptions = {},
): Float32Array {
  const epochs = options.epochs ?? DEFAULT_EPOCHS;
  const negativeSamples = options.negativeSamples ?? DEFAULT_NEGATIVE_SAMPLES;
  const components = options.components ?? 2;
  const random = createSeededRandom(options.seed ?? 0x5eed1234);

  const positions = new Float32Array(rowCount * components);
  if (rowCount === 0) return positions;
  if (rowCount === 1) {
    for (let axis = 0; axis < components; axis += 1) positions[axis] = 0.5;
    return positions;
  }

  const seed = options.initial;
  if (seed && seed.components > 0 && seed.points.length >= rowCount * seed.components) {
    // Carry the shared axes over verbatim and open each NEW axis with a jitter
    // small relative to the seed's own spread, so the seeded structure survives
    // the first epochs instead of being swamped by the fresh dimension.
    const carried = Math.min(components, seed.components);
    for (let row = 0; row < rowCount; row += 1) {
      for (let axis = 0; axis < carried; axis += 1) {
        positions[row * components + axis] = seed.points[row * seed.components + axis];
      }
      for (let axis = carried; axis < components; axis += 1) {
        positions[row * components + axis] = (random() - 0.5) * SEEDED_AXIS_JITTER;
      }
    }
  } else {
    for (let index = 0; index < positions.length; index += 1) {
      positions[index] = (random() - 0.5) * 10;
    }
  }

  // Symmetrized, weight-normalized edge list. The weight becomes a per-epoch
  // sampling probability, so a document's strongest neighbour is pulled on
  // nearly every epoch and its weakest only occasionally.
  const edgeSources: number[] = [];
  const edgeTargets: number[] = [];
  const edgeWeights: number[] = [];
  const seenEdges = new Set<string>();
  for (const list of lists) {
    if (list.neighbors.length === 0) continue;
    const strongest = list.neighbors[0].similarity;
    const weakest = list.neighbors[list.neighbors.length - 1].similarity;
    const range = Math.max(1e-6, strongest - weakest);
    for (const neighbor of list.neighbors) {
      const source = Math.min(list.row, neighbor.row);
      const target = Math.max(list.row, neighbor.row);
      const key = `${source}:${target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edgeSources.push(source);
      edgeTargets.push(target);
      edgeWeights.push(Math.max(0.05, (neighbor.similarity - weakest) / range));
    }
  }

  // Reused across every edge visit rather than allocated inside the loop: at 200
  // epochs over thousands of edges this runs millions of times.
  const delta = new Float64Array(components);

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const learningRate = 1 - epoch / epochs;
    for (let edge = 0; edge < edgeSources.length; edge += 1) {
      if (random() > edgeWeights[edge]) continue;
      const sourceOffset = edgeSources[edge] * components;
      const targetOffset = edgeTargets[edge] * components;

      let squaredDistance = 0;
      for (let axis = 0; axis < components; axis += 1) {
        const difference = positions[sourceOffset + axis] - positions[targetOffset + axis];
        delta[axis] = difference;
        squaredDistance += difference * difference;
      }

      if (squaredDistance > 0) {
        const gradient = (-2 * CURVE_A * CURVE_B * Math.pow(squaredDistance, CURVE_B - 1))
          / (1 + CURVE_A * Math.pow(squaredDistance, CURVE_B));
        for (let axis = 0; axis < components; axis += 1) {
          const step = clampGradient(gradient * delta[axis]) * learningRate;
          positions[sourceOffset + axis] += step;
          positions[targetOffset + axis] -= step;
        }
      }

      for (let sample = 0; sample < negativeSamples; sample += 1) {
        const other = Math.floor(random() * rowCount);
        if (other === edgeSources[edge]) continue;
        const otherOffset = other * components;
        squaredDistance = 0;
        for (let axis = 0; axis < components; axis += 1) {
          const difference = positions[sourceOffset + axis] - positions[otherOffset + axis];
          delta[axis] = difference;
          squaredDistance += difference * difference;
        }
        const gradient = squaredDistance > 0
          ? (2 * CURVE_B) / ((0.001 + squaredDistance) * (1 + CURVE_A * Math.pow(squaredDistance, CURVE_B)))
          : GRADIENT_CLAMP;
        for (let axis = 0; axis < components; axis += 1) {
          positions[sourceOffset + axis] += clampGradient(gradient * delta[axis]) * learningRate;
        }
      }
    }
  }

  return positions;
}

function clampGradient(value: number): number {
  if (value > GRADIENT_CLAMP) return GRADIENT_CLAMP;
  if (value < -GRADIENT_CLAMP) return -GRADIENT_CLAMP;
  return value;
}
