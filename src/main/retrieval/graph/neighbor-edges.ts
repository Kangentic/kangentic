/**
 * Cosine k-nearest-neighbour search over mean-pooled document vectors, and the
 * symmetric edge list the layout and the similarity overlay both consume.
 *
 * These edges are the graph's SEMANTIC TRUTH. They are computed in the
 * embedding's full dimensionality (1024 today), so two documents joined by an
 * edge really are among each other's nearest. The 2D positions derived from
 * them are only ~30% faithful (measured: of a document's 10 true nearest, about
 * 3 land among its 10 nearest on screen), because 1024 dimensions do not fit in
 * a plane. That asymmetry is why the surface draws similarity edges rather than
 * asking the user to read meaning out of distance alone.
 *
 * Brute force is deliberate. The document level is ~640 rows, so an exact
 * O(n^2 * d) pass costs ~330ms and needs no index, no approximation, and no
 * tuning. The chunk level is expanded one document at a time (at most ~1500
 * rows), which is the same order.
 */

/** One document's nearest neighbours, best first. */
export interface NeighborList {
  readonly row: number;
  readonly neighbors: ReadonlyArray<{ readonly row: number; readonly similarity: number }>;
}

/** An undirected similarity edge between two rows of the pooled matrix. */
export interface SimilarityEdge {
  readonly source: number;
  readonly target: number;
  /** Cosine similarity in full dimensionality, 0..1 after clamping. */
  readonly similarity: number;
}

/**
 * Exact cosine kNN. Rows are expected L2-normalized (`finalizeMeanPool`
 * guarantees it), so the dot product IS the cosine and no per-pair norm is
 * needed.
 */
export function computeCosineNeighbors(
  matrix: Float32Array,
  rowCount: number,
  dimensions: number,
  neighborCount: number,
  /** Optional QUERY-side row range, for computing the search in slices without
   *  blocking the event loop. Every row in the range still compares against the
   *  whole corpus, so slicing produces exactly the same lists as one pass. */
  fromRow = 0,
  toRow = rowCount,
): NeighborList[] {
  const lists: NeighborList[] = [];
  if (rowCount === 0 || neighborCount <= 0) return lists;

  const limit = Math.min(neighborCount, Math.max(0, rowCount - 1));
  const start = Math.max(0, fromRow);
  const end = Math.min(rowCount, toRow);
  for (let row = start; row < end; row += 1) {
    // Insertion into a fixed-size descending buffer beats sorting all n-1
    // candidates: k is ~10 and n is ~640, so this is O(n*k) not O(n log n).
    const bestRows = new Int32Array(limit).fill(-1);
    const bestScores = new Float64Array(limit).fill(-Infinity);
    const rowOffset = row * dimensions;

    for (let other = 0; other < rowCount; other += 1) {
      if (other === row) continue;
      const otherOffset = other * dimensions;
      let similarity = 0;
      for (let index = 0; index < dimensions; index += 1) {
        similarity += matrix[rowOffset + index] * matrix[otherOffset + index];
      }
      if (limit === 0 || similarity <= bestScores[limit - 1]) continue;

      let slot = limit - 1;
      while (slot > 0 && bestScores[slot - 1] < similarity) {
        bestScores[slot] = bestScores[slot - 1];
        bestRows[slot] = bestRows[slot - 1];
        slot -= 1;
      }
      bestScores[slot] = similarity;
      bestRows[slot] = other;
    }

    const neighbors: Array<{ row: number; similarity: number }> = [];
    for (let index = 0; index < limit; index += 1) {
      if (bestRows[index] < 0) continue;
      neighbors.push({ row: bestRows[index], similarity: bestScores[index] });
    }
    lists.push({ row, neighbors });
  }
  return lists;
}

/**
 * Collapse the directed kNN lists into a deduped undirected edge list.
 *
 * kNN is not symmetric (A can be in B's top-k without B being in A's), so an
 * undirected graph must dedupe. Keeping the union rather than the intersection
 * is deliberate: an intersection drops the edges that connect a dense cluster
 * to an outlying document, which are exactly the ones worth traversing.
 */
function buildUndirectedEdges(lists: ReadonlyArray<NeighborList>): SimilarityEdge[] {
  const edges: SimilarityEdge[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const neighbor of list.neighbors) {
      const source = Math.min(list.row, neighbor.row);
      const target = Math.max(list.row, neighbor.row);
      const key = `${source}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target, similarity: neighbor.similarity });
    }
  }
  return edges;
}

/**
 * Build the edge list keeping the strongest `keepFraction` of candidate edges,
 * with the cut expressed as a QUANTILE of the observed similarity distribution
 * rather than an absolute cosine value.
 *
 * This is the control the UI should expose, and the reason is measured, not
 * aesthetic. An absolute floor is unusable because the similarity distribution
 * shifts wildly between corpora:
 *   - On the real 638-document corpus, embeddings are strongly anisotropic and
 *     over 98% of top-10 neighbour pairs exceed 0.8 cosine. Sweeping an absolute
 *     floor from 0.5 to 0.8 moved the edge count only 5406 -> 5340, so the knob
 *     did essentially nothing.
 *   - On a well-separated synthetic corpus the same 0.5 floor removed EVERY
 *     edge, because near-orthogonal clusters put all pair similarities below it.
 * The same number is therefore both a no-op and a total wipe depending on the
 * corpus. A quantile adapts to whatever distribution it is handed.
 */
export function buildSimilarityEdgesByQuantile(
  lists: ReadonlyArray<NeighborList>,
  keepFraction: number,
): SimilarityEdge[] {
  const clamped = Math.min(1, Math.max(0, keepFraction));
  if (clamped <= 0) return [];

  const candidates = buildUndirectedEdges(lists);
  if (clamped >= 1 || candidates.length === 0) return candidates;

  const sorted = [...candidates].sort((first, second) => second.similarity - first.similarity);
  const keep = Math.max(1, Math.round(sorted.length * clamped));
  return sorted.slice(0, keep);
}
