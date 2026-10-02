/**
 * Measures the Knowledge Graph's layout tests judge the shipped layout with
 * (`knowledge-graph-layout.test.ts`). None of this runs in the app: it is the
 * yardstick, not the map.
 *
 *   - `measureNeighborhoodTrust` is THE quality metric: how many of a document's
 *     true nearest neighbours stay near it in the layout.
 *   - `projectToPlane` is PCA, the baseline the shipped embedder must beat.
 *     Measured on the real 638-document corpus, PCA keeps about 7.5% of true
 *     neighbourhoods against about 28% for the embedder, because the first two
 *     principal components carry only 24.7% of the variance.
 *   - `fitLayoutToUnitBox` is a min/max fit, the control the shipped percentile
 *     fit is compared against.
 *   - `measureLayoutSpread` is a diagnostic only. A RANDOM scatter scores 46.4%
 *     occupancy while keeping 1.4% of true neighbourhoods, beating every real
 *     layout, so spread says a picture is not a blob and nothing more.
 */

import type { EmbedNeighborInput } from '../../../src/main/retrieval/graph/projection-math';

/** A 2D PCA layout plus the share of variance each axis carries. */
export interface PlaneProjection {
  /** Row-major `rowCount * 2`. */
  readonly points: Float32Array;
  readonly rowCount: number;
  readonly explainedVarianceRatio: readonly [number, number];
}

export interface LayoutSpread {
  /** Fraction of a 32x32 grid over the unit box holding at least one point. */
  readonly occupancy: number;
  /** Median nearest-neighbour distance as a fraction of the box diagonal. */
  readonly medianNearestNeighborRatio: number;
  /** Fraction of points within 10% of the diagonal of the centroid. Above
   *  about 0.5 is the signature of a centroid collapse. */
  readonly centroidConcentration: number;
}

const POWER_ITERATION_LIMIT = 128;
const POWER_ITERATION_EPSILON = 1e-7;
const OCCUPANCY_GRID_SIZE = 32;
const CENTROID_CONCENTRATION_RADIUS_RATIO = 0.1;

/** Deterministic xorshift32, so the PCA seed vector and every result repeat. */
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
  for (let index = 0; index < dimensions; index += 1) columnMeans[index] /= rowCount;
  for (let row = 0; row < rowCount; row += 1) {
    for (let index = 0; index < dimensions; index += 1) {
      centered[row * dimensions + index] -= columnMeans[index];
    }
  }
  return centered;
}

/** Leading eigenvector of the centered matrix's covariance, by power iteration
 *  on X^T X without materializing the d x d covariance. */
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
    component = next.slice();
    if (drift < POWER_ITERATION_EPSILON) break;
  }
  return component;
}

function projectOnto(centered: Float32Array, rowCount: number, dimensions: number, component: Float32Array): Float32Array {
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
  for (let index = 0; index < centered.length; index += 1) total += centered[index] * centered[index];
  return total;
}

/** Project `rowCount x dimensions` down to `rowCount x 2` by PCA. */
export function projectToPlane(
  matrix: Float32Array,
  rowCount: number,
  dimensions: number,
  seed = 0x5eed1234,
): PlaneProjection {
  if (rowCount === 0) return { points: new Float32Array(0), rowCount: 0, explainedVarianceRatio: [0, 0] };
  if (rowCount === 1) return { points: new Float32Array([0, 0]), rowCount: 1, explainedVarianceRatio: [0, 0] };

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

/** Rescale a 2D layout into the unit box by its min and max, keeping the
 *  aspect ratio. */
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
  if (extent <= 0) return fitted.fill(0.5);

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

/** Spread of a unit-box 2D layout. Brute-force nearest neighbours, which is
 *  fine at test sizes. */
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
    if (Math.hypot(x - centroidX, y - centroidY) <= concentrationRadius) nearCentroid += 1;
    let nearest = Infinity;
    for (let other = 0; other < rowCount; other += 1) {
      if (other === row) continue;
      nearest = Math.min(nearest, Math.hypot(x - points[other * 2], y - points[other * 2 + 1]));
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
 * The share of each row's true `neighborCount` nearest neighbours (in full
 * dimensionality) that land among its `neighborCount` nearest points in the
 * layout. A random scatter scores neighborCount / (rowCount - 1), about 1.6% at
 * the real corpus size, so anything near that is noise however it looks.
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
