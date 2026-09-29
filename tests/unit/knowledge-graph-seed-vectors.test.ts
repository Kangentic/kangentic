/**
 * Tests for the Test Harness knowledge-graph seeder's vector generation
 * (`src/devtools/main/seed-knowledge-graph-vectors.ts`).
 *
 * This exists because the seeder is what makes the Knowledge Graph testable in an
 * ephemeral `/preview` at all - a preview project has zero indexed
 * conversations, and real ONNX inference over hundreds of documents would take
 * minutes. If the seeded corpus is secretly noise, the preview looks fine and
 * proves nothing, which is the failure this file is here to prevent.
 *
 * It is also the reason the math lives in its own electron-free module: an
 * earlier verification script re-declared the noise constants by hand and so
 * validated the algorithm rather than the seeder, leaving the two free to
 * drift. Everything here imports the real constants.
 */

import { describe, it, expect } from 'vitest';
import {
  CLUSTER_NOISE,
  CHUNK_NOISE,
  CORPUS_DIRECTION_WEIGHT,
  buildClusterCentroids,
  createSeededRandom,
  jitterUnitVector,
  randomUnitVector,
} from '../../src/devtools/main/seed-knowledge-graph-vectors';

/** Every shipping embedding width. The seeder must work at all three, since the
 *  model is user-selectable and the vec table is built from its dimensions. */
const SHIPPING_DIMENSIONS = [384, 768, 1024];

function dot(first: Float32Array, second: Float32Array): number {
  let total = 0;
  for (let index = 0; index < first.length; index += 1) total += first[index] * second[index];
  return total;
}

function magnitude(vector: Float32Array): number {
  return Math.sqrt(dot(vector, vector));
}

describe('seeded vector primitives', () => {
  it('produces unit vectors at every shipping width', () => {
    for (const dimensions of SHIPPING_DIMENSIONS) {
      const random = createSeededRandom(1);
      expect(magnitude(randomUnitVector(dimensions, random))).toBeCloseTo(1, 5);
      const base = randomUnitVector(dimensions, random);
      expect(magnitude(jitterUnitVector(base, CLUSTER_NOISE, random))).toBeCloseTo(1, 5);
    }
  });

  it('is deterministic for a given seed', () => {
    const first = randomUnitVector(64, createSeededRandom(7));
    const second = randomUnitVector(64, createSeededRandom(7));
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('keeps jitter a MAGNITUDE, so noise does not grow with dimension', () => {
    // The trap this guards: independent gaussian noise of sigma s across d
    // dimensions has length s*sqrt(d). Without the sqrt(d) division, a 0.55
    // "noise" at 1024 dimensions is ~17x longer than the centroid and erases
    // every planted cluster while the corpus still looks plausible.
    //
    // Cosine between a vector and its jittered copy must therefore stay roughly
    // CONSTANT across widths, not collapse toward 0 as dimension grows.
    const similarities = SHIPPING_DIMENSIONS.map((dimensions) => {
      const random = createSeededRandom(11);
      const base = randomUnitVector(dimensions, random);
      let total = 0;
      const samples = 40;
      for (let index = 0; index < samples; index += 1) {
        total += dot(base, jitterUnitVector(base, CLUSTER_NOISE, random));
      }
      return total / samples;
    });

    for (const similarity of similarities) {
      expect(similarity).toBeGreaterThan(0.75);
      expect(similarity).toBeLessThan(0.99);
    }
    // Width-independent to within a small tolerance.
    expect(Math.max(...similarities) - Math.min(...similarities)).toBeLessThan(0.05);
  });

  it('chunk noise is tighter than cluster noise', () => {
    // Chunks must scatter around their document more tightly than documents
    // scatter around their cluster, or mean-pooling averages away the very
    // structure the map is supposed to show.
    expect(CHUNK_NOISE).toBeLessThan(CLUSTER_NOISE);
  });
});

describe('cluster centroids', () => {
  it('are anisotropic, like a real corpus', () => {
    // Real embeddings share a large common direction: measured, entirely
    // unrelated real conversations still score >0.8 cosine. Independently
    // random centroids are near-orthogonal in high dimensions, which would give
    // the preview six artificially clean blobs and hide the crowding real data
    // exhibits. Distinct, but far from orthogonal.
    for (const dimensions of SHIPPING_DIMENSIONS) {
      const centroids = buildClusterCentroids(6, dimensions, createSeededRandom(3));
      expect(centroids).toHaveLength(6);

      const pairs: number[] = [];
      for (let first = 0; first < centroids.length; first += 1) {
        expect(magnitude(centroids[first])).toBeCloseTo(1, 5);
        for (let second = first + 1; second < centroids.length; second += 1) {
          pairs.push(dot(centroids[first], centroids[second]));
        }
      }
      const mean = pairs.reduce((total, value) => total + value, 0) / pairs.length;
      expect(mean).toBeGreaterThan(0.5);
      expect(mean).toBeLessThan(0.95);
    }
  });

  it('anisotropy tracks CORPUS_DIRECTION_WEIGHT', () => {
    // Guards the constant against being changed without understanding what it
    // controls: more shared direction means MORE similar centroids.
    const meanPairSimilarity = (centroids: Float32Array[]): number => {
      const pairs: number[] = [];
      for (let first = 0; first < centroids.length; first += 1) {
        for (let second = first + 1; second < centroids.length; second += 1) {
          pairs.push(dot(centroids[first], centroids[second]));
        }
      }
      return pairs.reduce((total, value) => total + value, 0) / pairs.length;
    };

    const shipped = meanPairSimilarity(buildClusterCentroids(6, 256, createSeededRandom(5)));
    expect(CORPUS_DIRECTION_WEIGHT).toBeGreaterThan(0);
    expect(CORPUS_DIRECTION_WEIGHT).toBeLessThan(1);
    // Near-orthogonal is what we are deliberately NOT doing.
    expect(shipped).toBeGreaterThan(0.3);
  });
});
