/**
 * Unit tests for the Knowledge Graph's layout math (`src/main/retrieval/graph/`).
 *
 * These carry the real coverage for the surface, because WebGL-free canvas
 * rendering is not reliably assertable in the UI tier on CI. The load-bearing
 * test is `recovers planted clusters`: synthetic documents are drawn from known
 * topic centroids, and the layout is required to put same-cluster documents
 * near each other far more often than chance. That is a genuine red-green
 * check - it fails outright if the embedder regresses to a linear projection.
 *
 * Two numbers here come from measurement against the real 638-document corpus
 * and are worth keeping in mind while reading:
 *   - PCA preserves ~7.5% of true neighbourhoods; the shipped embedder ~28%.
 *   - A RANDOM scatter scores 46% "occupancy", beating every real layout, which
 *     is why occupancy is only ever a diagnostic and trust is the metric.
 */

import { describe, it, expect } from 'vitest';
import {
  createMeanPoolAccumulator,
  accumulateVector,
  finalizeMeanPool,
  fitLayoutToPercentileBoxN,
  embedNeighborGraph,
  serializeMeanPool,
  deserializeMeanPool,
  forgetDocument,
  type MeanPoolAccumulator,
} from '../../src/main/retrieval/graph/projection-math';
import {
  computeCosineNeighbors,
  buildSimilarityEdgesByQuantile,
} from '../../src/main/retrieval/graph/neighbor-edges';
import {
  projectToPlane,
  fitLayoutToUnitBox,
  measureLayoutSpread,
  measureNeighborhoodTrust,
} from './helpers/layout-measures';

/** Deterministic xorshift32, so every assertion below is reproducible. */
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

function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
}

function normalize(vector: Float32Array): Float32Array {
  let squaredNorm = 0;
  for (let index = 0; index < vector.length; index += 1) squaredNorm += vector[index] * vector[index];
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

/**
 * Build `rowCount` unit vectors drawn from `clusterCount` planted centroids.
 *
 * `noise` is a MAGNITUDE relative to the unit centroid, not a per-component
 * sigma, so it is divided by sqrt(dimensions). This is the same trap the
 * seeder hits: independent gaussian noise of sigma s across d dimensions has
 * length s*sqrt(d), so a per-component 0.45 at 48 dimensions is a perturbation
 * three times longer than the centroid, and the "clustered" fixture is really
 * pure noise. A layout test built on that fixture fails while blaming the
 * layout.
 */
function makeClusteredCorpus(
  rowCount: number,
  clusterCount: number,
  dimensions: number,
  noise: number,
  seed = 0xc0ffee,
): { matrix: Float32Array; clusterOf: number[] } {
  const random = createSeededRandom(seed);
  const perComponent = noise / Math.sqrt(dimensions);
  const centroids: Float32Array[] = [];
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const centroid = new Float32Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) centroid[index] = gaussian(random);
    centroids.push(normalize(centroid));
  }

  const matrix = new Float32Array(rowCount * dimensions);
  const clusterOf: number[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cluster = row % clusterCount;
    clusterOf.push(cluster);
    const vector = new Float32Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      vector[index] = centroids[cluster][index] + gaussian(random) * perComponent;
    }
    normalize(vector);
    matrix.set(vector, row * dimensions);
  }
  return { matrix, clusterOf };
}

/** Mean cosine similarity within a cluster vs across clusters. Used to prove
 *  the FIXTURE is clustered before any layout is blamed for losing it. */
function clusterContrast(
  matrix: Float32Array,
  clusterOf: number[],
  dimensions: number,
): { within: number; across: number } {
  let withinTotal = 0;
  let withinCount = 0;
  let acrossTotal = 0;
  let acrossCount = 0;
  for (let a = 0; a < clusterOf.length; a += 1) {
    for (let b = a + 1; b < clusterOf.length; b += 1) {
      let similarity = 0;
      for (let index = 0; index < dimensions; index += 1) {
        similarity += matrix[a * dimensions + index] * matrix[b * dimensions + index];
      }
      if (clusterOf[a] === clusterOf[b]) {
        withinTotal += similarity;
        withinCount += 1;
      } else {
        acrossTotal += similarity;
        acrossCount += 1;
      }
    }
  }
  return { within: withinTotal / withinCount, across: acrossTotal / acrossCount };
}

describe('mean pooling', () => {
  it('averages and L2-normalizes each document', () => {
    const accumulator = createMeanPoolAccumulator(3);
    accumulateVector(accumulator, 'doc-a', new Float32Array([2, 0, 0]));
    accumulateVector(accumulator, 'doc-a', new Float32Array([0, 2, 0]));

    const pooled = finalizeMeanPool(accumulator);
    expect(pooled.rowCount).toBe(1);
    expect(pooled.chunkCounts).toEqual([2]);

    // mean is (1,1,0); normalized that is (0.707, 0.707, 0).
    expect(pooled.matrix[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(pooled.matrix[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(pooled.matrix[2]).toBeCloseTo(0, 6);
  });

  it('skips vectors whose width does not match, rather than throwing', () => {
    // A corpus can briefly hold rows from a previous model while a re-embed
    // drains. One stale row must not abort a whole projection pass.
    const accumulator = createMeanPoolAccumulator(4);
    expect(accumulateVector(accumulator, 'doc', new Float32Array([1, 0, 0, 0]))).toBe(true);
    expect(accumulateVector(accumulator, 'doc', new Float32Array([1, 0, 0]))).toBe(false);
    expect(finalizeMeanPool(accumulator).chunkCounts).toEqual([1]);
  });

  it('orders documents by key so a cached projection is reproducible', () => {
    const build = (keys: string[]): string[] => {
      const accumulator = createMeanPoolAccumulator(2);
      for (const key of keys) accumulateVector(accumulator, key, new Float32Array([1, 0]));
      return finalizeMeanPool(accumulator).docKeys;
    };
    // Insertion order differs; output order must not, or every cached position
    // would silently shift between rebuilds.
    expect(build(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
    expect(build(['b', 'c', 'a'])).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty accumulator', () => {
    const pooled = finalizeMeanPool(createMeanPoolAccumulator(8));
    expect(pooled.rowCount).toBe(0);
    expect(pooled.matrix.length).toBe(0);
  });
});

describe('incremental accumulation', () => {
  // The full vec-table scan costs ~62s on the real corpus, so it must be paid
  // once and then extended. These pin the round-trip and, more importantly, the
  // guard against double-counting a re-indexed document.
  const dimensions = 4;
  const modelTag = 'bge-base@q8-cls';

  function build(): MeanPoolAccumulator {
    const accumulator = createMeanPoolAccumulator(dimensions);
    accumulateVector(accumulator, 'doc-a', new Float32Array([1, 0, 0, 0]));
    accumulateVector(accumulator, 'doc-a', new Float32Array([0, 1, 0, 0]));
    accumulateVector(accumulator, 'doc-b', new Float32Array([0, 0, 1, 0]));
    return accumulator;
  }

  it('round-trips sums and counts so a later pass can extend them', () => {
    const indexedAt = new Map([['doc-a', '2026-09-01T00:00:00.000Z']]);
    const serialized = serializeMeanPool(build(), 42, modelTag, indexedAt);
    // Only the documents the accumulator holds, and only those with a time.
    expect(serialized.indexedAtByDocKey).toEqual({ 'doc-a': '2026-09-01T00:00:00.000Z' });
    const restored = deserializeMeanPool(serialized, dimensions, modelTag);
    expect(restored).not.toBeNull();
    expect(restored?.countsByDocKey.get('doc-a')).toBe(2);
    expect(Array.from(restored!.sumsByDocKey.get('doc-a')!)).toEqual([1, 1, 0, 0]);

    // Extending the restored accumulator must match a single uninterrupted pass.
    accumulateVector(restored!, 'doc-a', new Float32Array([0, 0, 0, 2]));
    const oneShot = build();
    accumulateVector(oneShot, 'doc-a', new Float32Array([0, 0, 0, 2]));
    expect(Array.from(finalizeMeanPool(restored!).matrix))
      .toEqual(Array.from(finalizeMeanPool(oneShot).matrix));
  });

  it('refuses a cache built under a different model or width', () => {
    // A model switch changes vector width AND meaning. Silently mixing them
    // would produce a map that is wrong in a way nothing else would catch.
    const serialized = serializeMeanPool(build(), 42, modelTag, new Map());
    expect(deserializeMeanPool(serialized, dimensions, 'bge-large@q8-cls')).toBeNull();
    expect(deserializeMeanPool(serialized, 768, modelTag)).toBeNull();
    expect(deserializeMeanPool(serialized, dimensions, modelTag)).not.toBeNull();
  });

  it('forgetDocument drops a re-indexed doc so it cannot be double-counted', () => {
    // `upsertDocument` re-indexes by deleting from the first divergent seq and
    // reinserting, minting NEW chunk ids under the SAME doc key. An incremental
    // pass keyed only on lastScannedChunkId would add the new chunks on top of
    // the old ones' contribution. This is the escape hatch for that case.
    const accumulator = build();
    expect(accumulator.countsByDocKey.get('doc-a')).toBe(2);

    forgetDocument(accumulator, 'doc-a');
    expect(accumulator.countsByDocKey.has('doc-a')).toBe(false);
    expect(accumulator.sumsByDocKey.has('doc-a')).toBe(false);

    // Rescanned from scratch, doc-a reflects only its current chunks.
    accumulateVector(accumulator, 'doc-a', new Float32Array([5, 0, 0, 0]));
    const pooled = finalizeMeanPool(accumulator);
    const rowIndex = pooled.docKeys.indexOf('doc-a');
    expect(pooled.chunkCounts[rowIndex]).toBe(1);
    expect(pooled.matrix[rowIndex * dimensions]).toBeCloseTo(1, 6);
  });
});

describe('cosine neighbours', () => {
  const dimensions = 4;
  // Rows 0 and 1 are near-identical; row 2 is orthogonal to both.
  const matrix = new Float32Array([
    1, 0, 0, 0,
    0.99, 0.141, 0, 0,
    0, 0, 1, 0,
  ]);

  it('ranks the genuinely nearest row first', () => {
    const lists = computeCosineNeighbors(matrix, 3, dimensions, 2);
    expect(lists[0].neighbors[0].row).toBe(1);
    expect(lists[1].neighbors[0].row).toBe(0);
    expect(lists[0].neighbors[0].similarity).toBeGreaterThan(lists[0].neighbors[1].similarity);
  });

  it('clamps k to the number of other rows', () => {
    const lists = computeCosineNeighbors(matrix, 3, dimensions, 50);
    expect(lists[0].neighbors).toHaveLength(2);
  });

  it('returns nothing for a single-row corpus', () => {
    const lists = computeCosineNeighbors(new Float32Array([1, 0, 0, 0]), 1, dimensions, 5);
    expect(lists[0].neighbors).toHaveLength(0);
  });

  it('dedupes the undirected edge list and keeps the strongest edge first', () => {
    const lists = computeCosineNeighbors(matrix, 3, dimensions, 2);
    const all = buildSimilarityEdgesByQuantile(lists, 1);
    for (const edge of all) expect(edge.source).toBeLessThan(edge.target);
    // Three rows naming both others name every pair twice: three edges, not six.
    expect(all).toHaveLength(3);
    expect(new Set(all.map((edge) => `${edge.source}:${edge.target}`)).size).toBe(all.length);

    // 0 and 1 are near-identical, so the strongest third is that pair alone.
    const strongest = buildSimilarityEdgesByQuantile(lists, 1 / 3);
    expect(strongest).toHaveLength(1);
    expect(strongest[0]).toMatchObject({ source: 0, target: 1 });
  });
});

describe('quantile edge floor', () => {
  // The absolute floor is unusable as a UI control: measured, the SAME 0.5
  // value is a no-op on the real corpus (5406 -> 5340 edges sweeping 0.5..0.8,
  // because anisotropy puts 98% of pairs above 0.8) and a total wipe on a
  // well-separated synthetic corpus (every pair below 0.5). A quantile adapts.
  const rowCount = 60;
  const dimensions = 24;
  const { matrix } = makeClusteredCorpus(rowCount, 5, dimensions, 0.4);
  const lists = computeCosineNeighbors(matrix, rowCount, dimensions, 6);

  it('keeps roughly the requested fraction regardless of absolute scale', () => {
    const all = buildSimilarityEdgesByQuantile(lists, 1);
    const half = buildSimilarityEdgesByQuantile(lists, 0.5);
    expect(all.length).toBeGreaterThan(0);
    expect(half.length).toBe(Math.round(all.length * 0.5));
  });

  it('keeps the STRONGEST edges, not an arbitrary slice', () => {
    const all = buildSimilarityEdgesByQuantile(lists, 1);
    const kept = buildSimilarityEdgesByQuantile(lists, 0.25);
    // Compare by key: each call rebuilds its own edge objects, so identity
    // comparison would silently mark every edge as dropped and pass vacuously.
    const keptKeys = new Set(kept.map((edge) => `${edge.source}:${edge.target}`));
    const weakestKept = Math.min(...kept.map((edge) => edge.similarity));
    const dropped = all.filter((edge) => !keptKeys.has(`${edge.source}:${edge.target}`));

    expect(dropped.length).toBeGreaterThan(0);
    for (const edge of dropped) expect(edge.similarity).toBeLessThanOrEqual(weakestKept);
  });

  it('survives a corpus whose absolute similarities are all low', () => {
    // Near-orthogonal rows: an absolute 0.5 floor removes every edge, which is
    // the exact failure the quantile form exists to avoid.
    const sparse = new Float32Array(3 * 3);
    sparse[0] = 1;
    sparse[4] = 1;
    sparse[8] = 1;
    const orthogonal = computeCosineNeighbors(sparse, 3, 3, 2);
    for (const list of orthogonal) {
      for (const neighbor of list.neighbors) expect(neighbor.similarity).toBeLessThan(0.5);
    }
    expect(buildSimilarityEdgesByQuantile(orthogonal, 0.5).length).toBeGreaterThan(0);
  });

  it('clamps out-of-range fractions', () => {
    expect(buildSimilarityEdgesByQuantile(lists, 0)).toHaveLength(0);
    expect(buildSimilarityEdgesByQuantile(lists, -1)).toHaveLength(0);
    expect(buildSimilarityEdgesByQuantile(lists, 5).length)
      .toBe(buildSimilarityEdgesByQuantile(lists, 1).length);
  });
});

describe('layout fitting', () => {
  it('percentile fitting stops outliers from crushing everything else', () => {
    // Points packed in [0,1] plus a few 1000 away. Min/max fitting squashes the
    // cluster into a corner; percentile fitting clips the outliers.
    //
    // Two sizing constraints, both of which silently defeat this test if
    // ignored. The sample must be big enough that the 98th percentile is not
    // the last index (with 21 points floor(21*0.98) IS the last index, so both
    // fits are identical), AND the outliers must be fewer than the trimmed 2%
    // (5 outliers in 205 rows is 2.4%, so the 98th percentile still lands on an
    // outlier and nothing is clipped). 3 in 303 is 1%.
    const bulk = 300;
    const outliers = 3;
    const rowCount = bulk + outliers;
    const points = new Float32Array(rowCount * 2);
    for (let row = 0; row < bulk; row += 1) {
      points[row * 2] = row / (bulk - 1);
      points[row * 2 + 1] = row / (bulk - 1);
    }
    for (let index = 0; index < outliers; index += 1) {
      points[(bulk + index) * 2] = 1000;
      points[(bulk + index) * 2 + 1] = 1000;
    }

    const minMax = fitLayoutToUnitBox(points, rowCount);
    const percentile = fitLayoutToPercentileBoxN(points, rowCount, 2);

    expect(measureLayoutSpread(minMax, rowCount).occupancy)
      .toBeLessThan(measureLayoutSpread(percentile, rowCount).occupancy);
    for (let index = 0; index < percentile.length; index += 1) {
      expect(percentile[index]).toBeGreaterThanOrEqual(0);
      expect(percentile[index]).toBeLessThanOrEqual(1);
    }
  });

  it('places a single point in the middle instead of dividing by zero', () => {
    expect(Array.from(fitLayoutToPercentileBoxN(new Float32Array([7, 7, 7]), 1, 3))).toEqual([0.5, 0.5, 0.5]);
  });

  it('collapses identical points to the middle rather than producing NaN', () => {
    const points = new Float32Array([3, 3, 3, 3, 3, 3, 3, 3, 3]);
    for (const value of fitLayoutToPercentileBoxN(points, 3, 3)) expect(value).toBe(0.5);
  });
});

describe('trust metric', () => {
  it('scores a layout that reproduces the neighbour list exactly at 1', () => {
    // Feed the metric an EXPLICIT neighbour list rather than one derived from
    // cosine, so this tests the metric alone. Points sit on a line at their own
    // index, so row r's nearest are r-1 and r+1.
    const rowCount = 10;
    const points = new Float32Array(rowCount * 2);
    for (let row = 0; row < rowCount; row += 1) points[row * 2] = row;

    const trueNeighbors = [];
    for (let row = 0; row < rowCount; row += 1) {
      const candidates = [row - 1, row + 1]
        .filter((candidate) => candidate >= 0 && candidate < rowCount)
        .map((candidate) => ({ row: candidate, similarity: 1 }));
      trueNeighbors.push({ row, neighbors: candidates });
    }
    expect(measureNeighborhoodTrust(trueNeighbors, points, rowCount, 2)).toBeCloseTo(1, 6);
  });

  it('scores a scrambled layout near chance', () => {
    const rowCount = 60;
    const dimensions = 16;
    const { matrix } = makeClusteredCorpus(rowCount, 6, dimensions, 0.25);
    const truth = computeCosineNeighbors(matrix, rowCount, dimensions, 5);

    const random = createSeededRandom(7);
    const scattered = new Float32Array(rowCount * 2);
    for (let index = 0; index < scattered.length; index += 1) scattered[index] = random();
    expect(measureNeighborhoodTrust(truth, scattered, rowCount, 5)).toBeLessThan(0.2);
  });
});

describe('neighbour-graph embedding', () => {
  const rowCount = 120;
  const clusterCount = 6;
  const dimensions = 48;
  const { matrix, clusterOf } = makeClusteredCorpus(rowCount, clusterCount, dimensions, 0.45);
  const truth = computeCosineNeighbors(matrix, rowCount, dimensions, 10);

  it('the fixture itself is genuinely clustered', () => {
    // Guards the guard. If the noise scaling regresses, the fixture becomes
    // noise and every layout assertion below fails while blaming the layout.
    const { within, across } = clusterContrast(matrix, clusterOf, dimensions);
    expect(within).toBeGreaterThan(across + 0.3);
  });

  it('is deterministic, so a cached map never silently rearranges', () => {
    const first = embedNeighborGraph(truth, rowCount);
    const second = embedNeighborGraph(truth, rowCount);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('a different seed produces a different map', () => {
    const first = embedNeighborGraph(truth, rowCount, { seed: 1 });
    const second = embedNeighborGraph(truth, rowCount, { seed: 2 });
    expect(Array.from(first)).not.toEqual(Array.from(second));
  });

  it('produces finite coordinates for every row', () => {
    for (const value of embedNeighborGraph(truth, rowCount)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('recovers planted clusters far better than chance', () => {
    // THE load-bearing assertion. Same-cluster documents must end up near each
    // other; if the layout regresses to something linear or random this fails.
    const points = fitLayoutToUnitBox(embedNeighborGraph(truth, rowCount), rowCount);

    const perCluster = rowCount / clusterCount;
    let sameClusterShare = 0;
    for (let row = 0; row < rowCount; row += 1) {
      const distances: Array<{ row: number; distance: number }> = [];
      for (let other = 0; other < rowCount; other += 1) {
        if (other === row) continue;
        distances.push({
          row: other,
          distance: Math.hypot(points[row * 2] - points[other * 2], points[row * 2 + 1] - points[other * 2 + 1]),
        });
      }
      distances.sort((first, second) => first.distance - second.distance);
      const nearest = distances.slice(0, perCluster - 1);
      sameClusterShare += nearest.filter((entry) => clusterOf[entry.row] === clusterOf[row]).length / nearest.length;
    }
    sameClusterShare /= rowCount;

    // Chance is 1/clusterCount (~17%). Require a decisive margin.
    expect(sameClusterShare).toBeGreaterThan(0.75);
  });

  it('beats PCA on neighbourhood preservation', () => {
    // The reason the surface does not simply ship PCA. Measured on the real
    // corpus the gap is 28% vs 7.5%; this pins the ordering on synthetic data.
    const embedded = fitLayoutToUnitBox(embedNeighborGraph(truth, rowCount), rowCount);
    const pca = fitLayoutToPercentileBoxN(projectToPlane(matrix, rowCount, dimensions).points, rowCount, 2);

    const embeddedTrust = measureNeighborhoodTrust(truth, embedded, rowCount, 10);
    const pcaTrust = measureNeighborhoodTrust(truth, pca, rowCount, 10);

    expect(embeddedTrust).toBeGreaterThan(pcaTrust);
    expect(embeddedTrust).toBeGreaterThan(0.25);
  });

  it('handles degenerate corpora', () => {
    expect(embedNeighborGraph([], 0)).toHaveLength(0);
    expect(Array.from(embedNeighborGraph([{ row: 0, neighbors: [] }], 1))).toEqual([0.5, 0.5]);
  });
});

/**
 * The 3D layout that backs the spatial view.
 *
 * Numbers below come from the real 638-document corpus, measured through these
 * same shipped functions, and two of them corrected an assumption made while
 * building this:
 *
 *   - A third dimension genuinely helps: trust 33.1% against 2D's 28.1%.
 *   - Seeding the 3D run from the 2D solution buys ORIENTATION, not quality.
 *     Correlation between the 2D and 3D x axes is 0.926 seeded / 0.268 unseeded,
 *     so an unseeded toggle jumps to an unrecognisable picture. But trust
 *     (33.1% / 33.3%) and cluster contiguity (75.7% / 74.1%) are the same either
 *     way - the optimizer finds an equally good solution regardless, and the seed
 *     only picks WHICH one.
 *   - Cluster contiguity DOES fall in 3D (89.2% in 2D to 75.7%), and seeding does
 *     not prevent it. Both views still share one cluster assignment, which stays
 *     defensible only because 75.7% is far above the 10% chance level - so that
 *     floor is asserted rather than assumed.
 */
describe('3D neighbour embedding', () => {
  const rowCount = 120;
  const clusterCount = 6;
  const dimensions = 48;
  const { matrix, clusterOf } = makeClusteredCorpus(rowCount, clusterCount, dimensions, 0.45);
  const truth = computeCosineNeighbors(matrix, rowCount, dimensions, 10);

  const plane = embedNeighborGraph(truth, rowCount);
  const spatial = embedNeighborGraph(truth, rowCount, {
    components: 3,
    initial: { points: plane, components: 2 },
  });

  /** Pearson correlation, for comparing one layout's axis against another's. */
  function correlation(first: number[], second: number[]): number {
    const count = first.length;
    const meanFirst = first.reduce((sum, value) => sum + value, 0) / count;
    const meanSecond = second.reduce((sum, value) => sum + value, 0) / count;
    let covariance = 0;
    let varianceFirst = 0;
    let varianceSecond = 0;
    for (let index = 0; index < count; index += 1) {
      const deltaFirst = first[index] - meanFirst;
      const deltaSecond = second[index] - meanSecond;
      covariance += deltaFirst * deltaSecond;
      varianceFirst += deltaFirst * deltaFirst;
      varianceSecond += deltaSecond * deltaSecond;
    }
    return covariance / Math.sqrt(varianceFirst * varianceSecond);
  }

  /** Mean share of a row's nearest `count` neighbours that share its cluster. */
  function sameClusterShare(points: Float32Array, components: number, count: number): number {
    let total = 0;
    for (let row = 0; row < rowCount; row += 1) {
      const distances: Array<{ row: number; distance: number }> = [];
      for (let other = 0; other < rowCount; other += 1) {
        if (other === row) continue;
        let squared = 0;
        for (let axis = 0; axis < components; axis += 1) {
          const difference = points[row * components + axis] - points[other * components + axis];
          squared += difference * difference;
        }
        distances.push({ row: other, distance: Math.sqrt(squared) });
      }
      distances.sort((first, second) => first.distance - second.distance);
      const nearest = distances.slice(0, count);
      total += nearest.filter((entry) => clusterOf[entry.row] === clusterOf[row]).length / nearest.length;
    }
    return total / rowCount;
  }

  it('emits three components per row', () => {
    expect(spatial).toHaveLength(rowCount * 3);
    for (const value of spatial) expect(Number.isFinite(value)).toBe(true);
  });

  it('is deterministic, so a cached map never silently rearranges', () => {
    const again = embedNeighborGraph(truth, rowCount, {
      components: 3,
      initial: { points: plane, components: 2 },
    });
    expect(Array.from(spatial)).toEqual(Array.from(again));
  });

  it('keeps 2D-assigned clusters coherent enough to share their labels', () => {
    // Both views share ONE cluster assignment, computed on the 2D positions so the
    // labels name the blob the eye sees. That reuse is only honest while a
    // cluster's members stay together in 3D as well. They do, but by less: 89.2%
    // in 2D falls to 75.7% in 3D on the real corpus, against a 1/clusterCount
    // (~17% here) chance level. This is the floor, not a claim of parity - and
    // note seeding does NOT move it (the unseeded control measured 74.1%).
    const perCluster = rowCount / clusterCount;
    expect(sameClusterShare(spatial, 3, perCluster - 1)).toBeGreaterThan(0.6);
  });

  it('lands the 3D map in the same orientation as the flat one', () => {
    // THE assertion the seeding exists for, and the one that took a real-corpus
    // measurement to identify: an unseeded run reaches an equally good
    // arrangement that is rotated and mirrored relative to the flat map, so the
    // view toggle jumps to a picture the user cannot recognise. Correlation of
    // the shared axes is what sees that; contiguity and trust cannot.
    const flatX: number[] = [];
    const seededX: number[] = [];
    const unseededX: number[] = [];
    const unseeded = embedNeighborGraph(truth, rowCount, { components: 3 });
    for (let row = 0; row < rowCount; row += 1) {
      flatX.push(plane[row * 2]);
      seededX.push(spatial[row * 3]);
      unseededX.push(unseeded[row * 3]);
    }
    expect(Math.abs(correlation(flatX, seededX))).toBeGreaterThan(0.8);
    // The control is what stops this passing vacuously: without it, a build in
    // which `initial` was silently ignored would still satisfy the line above if
    // the RNG happened to land somewhere aligned.
    expect(Math.abs(correlation(flatX, seededX)))
      .toBeGreaterThan(Math.abs(correlation(flatX, unseededX)));
  });

  it('preserves neighbourhoods at least as well as the flat layout', () => {
    // A third dimension relieves some of the flattening loss that caps 2D, so
    // this should improve rather than merely hold. Asserted as "no worse" plus a
    // floor, plainly: the exact margin is corpus-dependent and pinning it would
    // make the test a tuning tripwire rather than a regression guard.
    const flatTrust = measureNeighborhoodTrust(truth, plane, rowCount, 10, 2);
    const spatialTrust = measureNeighborhoodTrust(truth, spatial, rowCount, 10, 3);
    expect(spatialTrust).toBeGreaterThanOrEqual(flatTrust);
    expect(spatialTrust).toBeGreaterThan(0.25);
  });

  it('an unseeded 3D run is a different map, so the seed is doing something', () => {
    // Guards the guard: if `initial` were silently ignored, every assertion above
    // would still pass while the two views drifted apart in production.
    const unseeded = embedNeighborGraph(truth, rowCount, { components: 3 });
    expect(Array.from(unseeded)).not.toEqual(Array.from(spatial));
  });

  it('carries the seeded axes through rather than starting from noise', () => {
    // The first epochs must refine the 2D structure, not overwrite it. Compared
    // against the fresh-noise spread (+/-5 per axis), a seeded run starts orders
    // of magnitude closer to its seed.
    const seededStart = embedNeighborGraph(truth, rowCount, {
      components: 3,
      epochs: 0,
      initial: { points: plane, components: 2 },
    });
    for (let row = 0; row < rowCount; row += 1) {
      expect(seededStart[row * 3]).toBeCloseTo(plane[row * 2], 5);
      expect(seededStart[row * 3 + 1]).toBeCloseTo(plane[row * 2 + 1], 5);
      expect(Math.abs(seededStart[row * 3 + 2])).toBeLessThan(0.1);
    }
  });

  it('fits every axis into the unit box on one shared extent', () => {
    // A per-axis fit would stretch whichever axis had least variance, inventing
    // separation the embedding never claimed.
    const fitted = fitLayoutToPercentileBoxN(spatial, rowCount, 3);
    for (const value of fitted) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // At least one axis must actually reach the box, or the "shared extent" is
    // really just a shrink.
    let widest = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      let low = Infinity;
      let high = -Infinity;
      for (let row = 0; row < rowCount; row += 1) {
        low = Math.min(low, fitted[row * 3 + axis]);
        high = Math.max(high, fitted[row * 3 + axis]);
      }
      widest = Math.max(widest, high - low);
    }
    expect(widest).toBeGreaterThan(0.9);
  });

  it('handles degenerate corpora', () => {
    expect(embedNeighborGraph([], 0, { components: 3 })).toHaveLength(0);
    expect(Array.from(embedNeighborGraph([{ row: 0, neighbors: [] }], 1, { components: 3 })))
      .toEqual([0.5, 0.5, 0.5]);
  });
});
