/**
 * Pure projection math for the knowledge graph's semantic layout.
 *
 * The graph positions each indexed document by the MEAN of its chunk
 * embeddings, then projects those means to 2D so on-screen proximity means
 * semantic similarity. Keeping the math here as pure functions over plain typed
 * arrays is deliberate: it is the only part of the layout that is genuinely
 * worth unit-testing, and it lets the same code run on the main thread (small
 * inputs, tests) or inside the graph utility process (the real corpus) with no
 * changes.
 *
 * Everything here is DIMENSION-AGNOSTIC. The embedding model is user-selectable
 * (384 / 768 / 1024 today) and `retrieval-store` builds the vec table from
 * `embedder.dimensions`, so nothing may assume a width.
 *
 * Matrices are row-major `Float32Array`s of `rowCount * dimensions`, which is
 * the shape the batched vec reader produces and the shape a structured-clone to
 * the worker moves cheaply.
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

/** A 2D layout plus the diagnostics that say whether it is worth rendering. */
export interface PlaneProjection {
  /** Row-major `rowCount * 2`. */
  readonly points: Float32Array;
  readonly rowCount: number;
  /** Share of total variance captured by each of the two axes. Low values mean
   *  a 2D view is a poor summary of this corpus, whatever the picture looks
   *  like. */
  readonly explainedVarianceRatio: readonly [number, number];
}

/**
 * Spread diagnostics. READ THE WARNING: spread is NOT a quality signal.
 *
 * Measured on the real corpus, a RANDOM scatter scores 46.4% occupancy while
 * preserving 1.4% of true neighbourhoods, beating every real layout on this
 * metric. Occupancy only tells you the picture is not a blob; it says nothing
 * about whether the picture means anything. `measureNeighborhoodTrust` is the
 * metric that decides whether a layout is worth rendering.
 */
export interface LayoutSpread {
  /** Fraction of a 32x32 grid over the layout's bounding box that contains at
   *  least one point. A well-spread corpus fills a large share; a collapsed one
   *  lights only the cells around the centroid. */
  readonly occupancy: number;
  /** Median nearest-neighbour distance as a fraction of the bounding box
   *  diagonal. Near zero means points are piled on each other. */
  readonly medianNearestNeighborRatio: number;
  /** Fraction of points within 10% of the diagonal of the centroid. Above ~0.5
   *  is the signature of a centroid collapse. */
  readonly centroidConcentration: number;
}

const POWER_ITERATION_LIMIT = 128;
const POWER_ITERATION_EPSILON = 1e-7;
const OCCUPANCY_GRID_SIZE = 32;
const CENTROID_CONCENTRATION_RADIUS_RATIO = 0.1;

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

/** Deterministic xorshift32. PCA's power iteration needs a starting vector; a
 *  seeded one keeps a cached projection reproducible across passes and makes
 *  the unit tests stable. */
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

function subtractColumnMeans(matrix: Float32Array, rowCount: number, dimensions: number): Float32Array {
  const centered = Float32Array.from(matrix);
  if (rowCount === 0) return centered;
  const columnMeans = new Float64Array(dimensions);
  for (let row = 0; row < rowCount; row += 1) {
    for (let index = 0; index < dimensions; index += 1) {
      columnMeans[index] += centered[row * dimensions + index];
    }
  }
  for (let index = 0; index < dimensions; index += 1) {
    columnMeans[index] /= rowCount;
  }
  for (let row = 0; row < rowCount; row += 1) {
    for (let index = 0; index < dimensions; index += 1) {
      centered[row * dimensions + index] -= columnMeans[index];
    }
  }
  return centered;
}

/** Leading eigenvector of the centered matrix's covariance, by power iteration
 *  on X^T X without ever materializing the d x d covariance (1024 x 1024 would
 *  be 4 MiB and pointless when only two components are wanted). */
function findLeadingComponent(
  centered: Float32Array,
  rowCount: number,
  dimensions: number,
  random: () => number,
): Float32Array {
  let component = new Float32Array(dimensions);
  let seedNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    component[index] = random() * 2 - 1;
    seedNorm += component[index] * component[index];
  }
  seedNorm = Math.sqrt(seedNorm) || 1;
  for (let index = 0; index < dimensions; index += 1) component[index] /= seedNorm;

  const next = new Float32Array(dimensions);
  for (let iteration = 0; iteration < POWER_ITERATION_LIMIT; iteration += 1) {
    next.fill(0);
    for (let row = 0; row < rowCount; row += 1) {
      const offset = row * dimensions;
      let projection = 0;
      for (let index = 0; index < dimensions; index += 1) {
        projection += centered[offset + index] * component[index];
      }
      if (projection === 0) continue;
      for (let index = 0; index < dimensions; index += 1) {
        next[index] += centered[offset + index] * projection;
      }
    }

    let norm = 0;
    for (let index = 0; index < dimensions; index += 1) norm += next[index] * next[index];
    norm = Math.sqrt(norm);
    if (norm === 0) return component;

    let drift = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const normalized = next[index] / norm;
      drift += Math.abs(normalized - component[index]);
      next[index] = normalized;
    }
    const swap = component;
    component = next.slice();
    swap.fill(0);
    if (drift < POWER_ITERATION_EPSILON) break;
  }
  return component;
}

function projectOnto(
  centered: Float32Array,
  rowCount: number,
  dimensions: number,
  component: Float32Array,
): Float32Array {
  const projections = new Float32Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    const offset = row * dimensions;
    let projection = 0;
    for (let index = 0; index < dimensions; index += 1) {
      projection += centered[offset + index] * component[index];
    }
    projections[row] = projection;
  }
  return projections;
}

function deflate(
  centered: Float32Array,
  rowCount: number,
  dimensions: number,
  component: Float32Array,
  projections: Float32Array,
): void {
  for (let row = 0; row < rowCount; row += 1) {
    const offset = row * dimensions;
    const projection = projections[row];
    if (projection === 0) continue;
    for (let index = 0; index < dimensions; index += 1) {
      centered[offset + index] -= projection * component[index];
    }
  }
}

function totalVariance(centered: Float32Array): number {
  let total = 0;
  for (let index = 0; index < centered.length; index += 1) {
    total += centered[index] * centered[index];
  }
  return total;
}

/**
 * Project `rowCount x dimensions` down to `rowCount x 2` by PCA.
 *
 * PCA rather than a neighbour-embedding method (UMAP/t-SNE) on purpose: it is
 * deterministic, has no hyperparameters to tune per corpus, runs in
 * milliseconds at this row count, and preserves GLOBAL structure, which is what
 * a map the user pans around needs. Neighbour embeddings optimize local
 * neighbourhoods at the cost of global distances, so two clusters that land
 * next to each other can be unrelated - actively misleading for a surface whose
 * whole claim is "proximity means similarity".
 */
export function projectToPlane(
  matrix: Float32Array,
  rowCount: number,
  dimensions: number,
  seed = 0x5eed1234,
): PlaneProjection {
  if (rowCount === 0) {
    return { points: new Float32Array(0), rowCount: 0, explainedVarianceRatio: [0, 0] };
  }
  if (rowCount === 1) {
    return { points: new Float32Array([0, 0]), rowCount: 1, explainedVarianceRatio: [0, 0] };
  }

  const centered = subtractColumnMeans(matrix, rowCount, dimensions);
  const varianceBefore = totalVariance(centered);
  const random = createSeededRandom(seed);

  const firstComponent = findLeadingComponent(centered, rowCount, dimensions, random);
  const firstProjections = projectOnto(centered, rowCount, dimensions, firstComponent);
  deflate(centered, rowCount, dimensions, firstComponent, firstProjections);

  const secondComponent = findLeadingComponent(centered, rowCount, dimensions, random);
  const secondProjections = projectOnto(centered, rowCount, dimensions, secondComponent);

  const points = new Float32Array(rowCount * 2);
  let firstEnergy = 0;
  let secondEnergy = 0;
  for (let row = 0; row < rowCount; row += 1) {
    points[row * 2] = firstProjections[row];
    points[row * 2 + 1] = secondProjections[row];
    firstEnergy += firstProjections[row] * firstProjections[row];
    secondEnergy += secondProjections[row] * secondProjections[row];
  }

  const ratio: [number, number] = varianceBefore > 0
    ? [firstEnergy / varianceBefore, secondEnergy / varianceBefore]
    : [0, 0];

  return { points, rowCount, explainedVarianceRatio: ratio };
}

/** Rescale a layout into the unit box, preserving aspect ratio so the picture
 *  is not stretched along whichever axis happened to have less variance. */
export function fitLayoutToUnitBox(points: Float32Array, rowCount: number): Float32Array {
  const fitted = new Float32Array(points.length);
  if (rowCount === 0) return fitted;

  let minimumX = Infinity;
  let maximumX = -Infinity;
  let minimumY = Infinity;
  let maximumY = -Infinity;
  for (let row = 0; row < rowCount; row += 1) {
    minimumX = Math.min(minimumX, points[row * 2]);
    maximumX = Math.max(maximumX, points[row * 2]);
    minimumY = Math.min(minimumY, points[row * 2 + 1]);
    maximumY = Math.max(maximumY, points[row * 2 + 1]);
  }

  const width = maximumX - minimumX;
  const height = maximumY - minimumY;
  const extent = Math.max(width, height);
  if (extent <= 0) {
    for (let row = 0; row < rowCount; row += 1) {
      fitted[row * 2] = 0.5;
      fitted[row * 2 + 1] = 0.5;
    }
    return fitted;
  }

  const offsetX = (extent - width) / 2;
  const offsetY = (extent - height) / 2;
  for (let row = 0; row < rowCount; row += 1) {
    fitted[row * 2] = (points[row * 2] - minimumX + offsetX) / extent;
    fitted[row * 2 + 1] = (points[row * 2 + 1] - minimumY + offsetY) / extent;
  }
  return fitted;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Diagnostics over a unit-box layout. Call this on the REAL corpus before
 * building anything on top of the projection: if mean-pooled documents collapse
 * toward the corpus centroid, the map carries no information and the renderer,
 * the query highlight, and the neighbourhood dimming are all decoration over
 * noise.
 *
 * Nearest-neighbour distance is computed by brute force, which is O(n^2). That
 * is fine at the document level (~637 rows) and this is a diagnostic, not a
 * hot path.
 */
export function measureLayoutSpread(points: Float32Array, rowCount: number): LayoutSpread {
  if (rowCount < 2) {
    return { occupancy: 0, medianNearestNeighborRatio: 0, centroidConcentration: rowCount === 1 ? 1 : 0 };
  }

  const occupiedCells = new Set<number>();
  let centroidX = 0;
  let centroidY = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const x = points[row * 2];
    const y = points[row * 2 + 1];
    centroidX += x;
    centroidY += y;
    const cellX = Math.min(OCCUPANCY_GRID_SIZE - 1, Math.max(0, Math.floor(x * OCCUPANCY_GRID_SIZE)));
    const cellY = Math.min(OCCUPANCY_GRID_SIZE - 1, Math.max(0, Math.floor(y * OCCUPANCY_GRID_SIZE)));
    occupiedCells.add(cellY * OCCUPANCY_GRID_SIZE + cellX);
  }
  centroidX /= rowCount;
  centroidY /= rowCount;

  const diagonal = Math.SQRT2;
  const concentrationRadius = diagonal * CENTROID_CONCENTRATION_RADIUS_RATIO;
  let nearCentroid = 0;
  const nearestDistances: number[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    const x = points[row * 2];
    const y = points[row * 2 + 1];
    const centroidDistance = Math.hypot(x - centroidX, y - centroidY);
    if (centroidDistance <= concentrationRadius) nearCentroid += 1;

    let nearest = Infinity;
    for (let other = 0; other < rowCount; other += 1) {
      if (other === row) continue;
      const distance = Math.hypot(x - points[other * 2], y - points[other * 2 + 1]);
      if (distance < nearest) nearest = distance;
    }
    if (Number.isFinite(nearest)) nearestDistances.push(nearest);
  }

  return {
    occupancy: occupiedCells.size / (OCCUPANCY_GRID_SIZE * OCCUPANCY_GRID_SIZE),
    medianNearestNeighborRatio: median(nearestDistances) / diagonal,
    centroidConcentration: nearCentroid / rowCount,
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

/** The 2D form, kept as the name every existing caller and test already uses. */
export function fitLayoutToPercentileBox(
  points: Float32Array,
  rowCount: number,
  lowQuantile = 0.02,
  highQuantile = 0.98,
): Float32Array {
  return fitLayoutToPercentileBoxN(points, rowCount, 2, lowQuantile, highQuantile);
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

/**
 * THE quality metric: what fraction of each row's true `neighborCount` nearest
 * neighbours (in full dimensionality) land among its `neighborCount` nearest
 * points in the 2D layout.
 *
 * Use this, not `measureLayoutSpread`, to judge a layout. A random scatter
 * scores neighborCount/(rowCount-1) - about 1.6% at the real corpus size - so
 * anything near that is noise no matter how pretty it looks.
 */
export function measureNeighborhoodTrust(
  trueNeighbors: ReadonlyArray<EmbedNeighborInput>,
  points: Float32Array,
  rowCount: number,
  neighborCount: number,
  components = 2,
): number {
  if (rowCount < 2 || neighborCount <= 0) return 0;
  let total = 0;
  let counted = 0;

  for (const list of trueNeighbors) {
    const expected = list.neighbors.slice(0, neighborCount).map((entry) => entry.row);
    if (expected.length === 0) continue;

    const distances: Array<{ row: number; distance: number }> = [];
    for (let other = 0; other < rowCount; other += 1) {
      if (other === list.row) continue;
      let squared = 0;
      for (let axis = 0; axis < components; axis += 1) {
        const difference = points[list.row * components + axis] - points[other * components + axis];
        squared += difference * difference;
      }
      distances.push({ row: other, distance: Math.sqrt(squared) });
    }
    distances.sort((first, second) => first.distance - second.distance);
    const laidOut = new Set(distances.slice(0, neighborCount).map((entry) => entry.row));

    total += expected.filter((row) => laidOut.has(row)).length / expected.length;
    counted += 1;
  }

  return counted === 0 ? 0 : total / counted;
}
