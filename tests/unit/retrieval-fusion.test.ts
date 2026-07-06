import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, RRF_K } from '../../src/main/retrieval/fusion';
import type { LexicalHit, SemanticHit } from '../../src/main/retrieval/types';

/**
 * Reciprocal Rank Fusion: score = sum over lists of 1/(K + rank), K = 60. A
 * chunk in both lists is 'hybrid' and scores higher; output is sorted by score
 * descending. These assert the exact arithmetic (no floating-point slack beyond
 * `toBeCloseTo`) and the dedupe/labeling contract.
 */
function lexical(chunkId: number, rank: number, bm25 = -1): LexicalHit {
  return { chunkId, rank, bm25, snippet: `snip-${chunkId}` };
}
function semantic(chunkId: number, rank: number, distance = 0.5): SemanticHit {
  return { chunkId, rank, distance };
}

describe('reciprocalRankFusion', () => {
  it('exposes the canonical K = 60 from the RRF paper', () => {
    expect(RRF_K).toBe(60);
  });

  it('scores a lexical-only hit as exactly 1/(K + rank)', () => {
    const fused = reciprocalRankFusion([lexical(1, 1)], []);
    expect(fused).toHaveLength(1);
    expect(fused[0].chunkId).toBe(1);
    expect(fused[0].matchKind).toBe('lexical');
    expect(fused[0].score).toBeCloseTo(1 / (60 + 1), 12);
    expect(fused[0].bm25).toBe(-1);
    expect(fused[0].distance).toBeNull();
  });

  it('scores a semantic-only hit as exactly 1/(K + rank) with a null bm25', () => {
    const fused = reciprocalRankFusion([], [semantic(9, 2, 0.25)]);
    expect(fused).toHaveLength(1);
    expect(fused[0].chunkId).toBe(9);
    expect(fused[0].matchKind).toBe('semantic');
    expect(fused[0].score).toBeCloseTo(1 / (60 + 2), 12);
    expect(fused[0].bm25).toBeNull();
    expect(fused[0].distance).toBe(0.25);
  });

  it('sums both contributions and labels a chunk in both lists as hybrid', () => {
    // Chunk 5 is rank 1 lexical and rank 3 semantic.
    const fused = reciprocalRankFusion([lexical(5, 1, -2.5)], [semantic(5, 3, 0.1)]);
    expect(fused).toHaveLength(1);
    const hit = fused[0];
    expect(hit.chunkId).toBe(5);
    expect(hit.matchKind).toBe('hybrid');
    expect(hit.score).toBeCloseTo(1 / 61 + 1 / 63, 12);
    // Both carried-through fields are populated for a hybrid hit.
    expect(hit.bm25).toBe(-2.5);
    expect(hit.distance).toBe(0.1);
  });

  it('sorts by fused score descending', () => {
    // chunk 1: lexical rank 1 -> 1/61 (~0.01639)
    // chunk 2: lexical rank 2 + semantic rank 1 -> 1/62 + 1/61 (~0.03252) [highest]
    // chunk 3: semantic rank 2 -> 1/62 (~0.01613) [lowest]
    const fused = reciprocalRankFusion(
      [lexical(1, 1), lexical(2, 2)],
      [semantic(2, 1), semantic(3, 2)],
    );
    expect(fused.map((hit) => hit.chunkId)).toEqual([2, 1, 3]);
    expect(fused[0].matchKind).toBe('hybrid');
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61, 12);
    expect(fused[2].score).toBeCloseTo(1 / 62, 12);
  });

  it('returns an empty list when both inputs are empty', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it('handles a lexical-only multi-hit list preserving each score', () => {
    const fused = reciprocalRankFusion([lexical(10, 1), lexical(11, 2), lexical(12, 3)], []);
    expect(fused.map((hit) => hit.chunkId)).toEqual([10, 11, 12]);
    expect(fused.every((hit) => hit.matchKind === 'lexical')).toBe(true);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 62, 12);
    expect(fused[2].score).toBeCloseTo(1 / 63, 12);
  });

  it('handles a semantic-only multi-hit list', () => {
    const fused = reciprocalRankFusion([], [semantic(20, 1), semantic(21, 2)]);
    expect(fused.map((hit) => hit.chunkId)).toEqual([20, 21]);
    expect(fused.every((hit) => hit.matchKind === 'semantic')).toBe(true);
    expect(fused.every((hit) => hit.bm25 === null)).toBe(true);
  });

  it('a hybrid chunk outranks two single-list chunks when its summed score is highest', () => {
    // Chunk 1 is only lexical rank 5; chunk 2 only semantic rank 5; chunk 3 is
    // in both at rank 4 -> its summed score beats either singleton.
    const fused = reciprocalRankFusion(
      [lexical(1, 5), lexical(3, 4)],
      [semantic(2, 5), semantic(3, 4)],
    );
    expect(fused[0].chunkId).toBe(3);
    expect(fused[0].matchKind).toBe('hybrid');
    expect(fused[0].score).toBeCloseTo(2 * (1 / 64), 12);
  });
});
