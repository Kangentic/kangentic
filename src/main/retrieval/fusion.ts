import type { LexicalHit, SemanticHit } from './types';

/** Reciprocal Rank Fusion constant. 60 is the value from the original RRF
 *  paper (Cormack et al.) and the de-facto default; it dampens the influence
 *  of exact rank position so a hit ranked 1 in one list and 3 in the other
 *  still fuses sensibly. */
export const RRF_K = 60;

export interface FusedHit {
  chunkId: number;
  score: number;
  matchKind: 'lexical' | 'semantic' | 'hybrid';
  /** Carried through for snippet/anchoring; whichever list supplied it. */
  bm25: number | null;
  distance: number | null;
}

/**
 * Fuse a lexical and a semantic ranked list with Reciprocal Rank Fusion. No
 * tuned weights: score = sum over lists of 1/(K + rank). A chunk appearing in
 * both lists is 'hybrid' and naturally scores higher. Output is sorted by score
 * descending. Either list may be empty (lexical-only or semantic-only).
 */
export function reciprocalRankFusion(
  lexical: LexicalHit[],
  semantic: SemanticHit[],
): FusedHit[] {
  const byChunk = new Map<number, FusedHit>();

  const bump = (
    chunkId: number,
    rank: number,
    source: 'lexical' | 'semantic',
    bm25: number | null,
    distance: number | null,
  ): void => {
    const contribution = 1 / (RRF_K + rank);
    const existing = byChunk.get(chunkId);
    if (existing) {
      existing.score += contribution;
      existing.matchKind = 'hybrid';
      if (bm25 !== null) existing.bm25 = bm25;
      if (distance !== null) existing.distance = distance;
      return;
    }
    byChunk.set(chunkId, {
      chunkId,
      score: contribution,
      matchKind: source,
      bm25,
      distance,
    });
  };

  for (const hit of lexical) bump(hit.chunkId, hit.rank, 'lexical', hit.bm25, null);
  for (const hit of semantic) bump(hit.chunkId, hit.rank, 'semantic', null, hit.distance);

  return [...byChunk.values()].sort((a, b) => b.score - a.score);
}
