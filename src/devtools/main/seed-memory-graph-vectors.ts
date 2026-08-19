/**
 * Vector generation for the "Seed Memory Graph" test-harness action, split out
 * so it carries NO electron / DB imports and can be unit-tested directly.
 *
 * The split is not cosmetic. The constants below (noise magnitudes, the shared
 * corpus direction weight) are the difference between a seeded corpus with real
 * cluster structure and one that is indistinguishable from noise while still
 * looking plausible. A verification script that re-declares them by hand proves
 * only that the algorithm works, not that the seeder does, and the two drift
 * silently. Everything that needs these numbers imports them from here.
 */

/**
 * How far a document's embedding drifts from its cluster centroid, as a
 * MAGNITUDE relative to the unit centroid - NOT a per-component sigma.
 *
 * This distinction is the trap. Independent gaussian noise of sigma s across d
 * dimensions produces a vector of length s*sqrt(d). At 1024 dimensions a
 * per-component 0.55 would be a perturbation ~17x longer than the centroid it
 * perturbs, erasing every planted cluster while the corpus still looked
 * reasonable. `jitterUnitVector` divides by sqrt(d) so these read as the
 * fraction of the centroid they actually are.
 */
export const CLUSTER_NOISE = 0.55;

/** Extra drift for individual chunks around their document's vector, so
 *  mean-pooling has something real to average out. Same magnitude semantics. */
export const CHUNK_NOISE = 0.35;

/**
 * How much of each cluster centroid is a direction shared by the whole corpus.
 *
 * Real embeddings are strongly ANISOTROPIC: every conversation in one project
 * shares a large "this is software work" component, which is why measured
 * cosine similarity between entirely unrelated real conversations still exceeds
 * 0.8. Independently-random centroids are near-orthogonal in high dimensions,
 * which would hand the preview six artificially clean blobs and hide exactly
 * the crowding the real corpus exhibits.
 */
export const CORPUS_DIRECTION_WEIGHT = 0.7;

/** Deterministic xorshift32, so a re-seed reproduces the same corpus. */
export function createSeededRandom(seed: number): () => number {
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

/** Box-Muller, so noise is gaussian rather than uniform-cube shaped. */
function gaussian(random: () => number): number {
  const first = Math.max(1e-9, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function normalizeInPlace(vector: Float32Array): Float32Array {
  let squaredNorm = 0;
  for (let index = 0; index < vector.length; index += 1) squaredNorm += vector[index] * vector[index];
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

export function randomUnitVector(dimensions: number, random: () => number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) vector[index] = gaussian(random);
  return normalizeInPlace(vector);
}

/** `base` perturbed by gaussian noise of total magnitude ~`scale`, renormalized
 *  onto the unit sphere - the surface real embeddings live on. */
export function jitterUnitVector(base: Float32Array, scale: number, random: () => number): Float32Array {
  const vector = new Float32Array(base.length);
  const perComponent = scale / Math.sqrt(base.length);
  for (let index = 0; index < base.length; index += 1) {
    vector[index] = base[index] + gaussian(random) * perComponent;
  }
  return normalizeInPlace(vector);
}

/** Cluster centroids that share `CORPUS_DIRECTION_WEIGHT` of a common
 *  direction, reproducing real-corpus anisotropy. */
export function buildClusterCentroids(
  clusterCount: number,
  dimensions: number,
  random: () => number,
): Float32Array[] {
  const corpusDirection = randomUnitVector(dimensions, random);
  const centroids: Float32Array[] = [];
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const unique = randomUnitVector(dimensions, random);
    const centroid = new Float32Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      centroid[index] = corpusDirection[index] * CORPUS_DIRECTION_WEIGHT
        + unique[index] * (1 - CORPUS_DIRECTION_WEIGHT);
    }
    centroids.push(normalizeInPlace(centroid));
  }
  return centroids;
}
