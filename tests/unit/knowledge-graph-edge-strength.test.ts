/**
 * Link strength is a RANK, not a raw cosine.
 *
 * This is the same trap the detail panel's "99% similar" rows fell into, one
 * layer down. Phase 1 measured anisotropy putting over 98% of top-10 pairs above
 * 0.8 cosine on the real corpus, so raw similarity arrives compressed into a
 * band far too narrow to see: a strong link and a marginal one would draw within
 * a couple of alpha values of each other and the mesh would read as one flat
 * wash. Ranking spreads whatever range the corpus actually has.
 */

import { describe, it, expect } from 'vitest';
import { buildEdgeStrengths } from '../../src/renderer/components/knowledge-graph/knowledge-graph-scene';

describe('link strength', () => {
  it('spreads a compressed similarity band across the full ramp', () => {
    // The real corpus's shape: every value inside a 0.03-wide band.
    const edges = [
      { similarity: 0.981 },
      { similarity: 0.972 },
      { similarity: 0.995 },
      { similarity: 0.968 },
    ];
    const strengths = buildEdgeStrengths(edges);

    // Raw values span 0.027. Ranked, they span the whole ramp - which is the
    // entire reason this function exists rather than using similarity directly.
    expect(Math.min(...strengths)).toBeCloseTo(0.35, 5);
    expect(Math.max(...strengths)).toBeCloseTo(1, 5);
    expect(Math.max(...strengths) - Math.min(...strengths)).toBeGreaterThan(0.6);
  });

  it('orders strength by similarity, not by position', () => {
    const edges = [
      { similarity: 0.5 },
      { similarity: 0.9 },
      { similarity: 0.7 },
    ];
    const strengths = buildEdgeStrengths(edges);
    expect(strengths[1]).toBeGreaterThan(strengths[2]);
    expect(strengths[2]).toBeGreaterThan(strengths[0]);
  });

  it('never returns zero, so a weak link is faint rather than absent', () => {
    // Zero would silently delete the weakest edge from a mesh the user asked to
    // see, which is a different statement from "this link is weak".
    const edges = Array.from({ length: 40 }, (_value, index) => ({ similarity: index / 40 }));
    for (const strength of buildEdgeStrengths(edges)) {
      expect(strength).toBeGreaterThan(0);
    }
  });

  it('handles the degenerate corpora without dividing by zero', () => {
    expect(buildEdgeStrengths([])).toHaveLength(0);
    // One edge has no rank to spread, so it draws at full strength rather than
    // at the floor - a lone link is not a weak link.
    expect(Array.from(buildEdgeStrengths([{ similarity: 0.4 }]))).toEqual([1]);
  });

  it('gives identical similarities adjacent strengths rather than collapsing them', () => {
    const strengths = buildEdgeStrengths([
      { similarity: 0.8 },
      { similarity: 0.8 },
      { similarity: 0.8 },
    ]);
    expect(Math.min(...strengths)).toBeCloseTo(0.35, 5);
    expect(Math.max(...strengths)).toBeCloseTo(1, 5);
  });
});
