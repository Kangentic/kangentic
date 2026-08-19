/**
 * Which conversations stand alone: nothing else in the index came close to them.
 *
 * This replaces a filter that answered a different question than it asked. It
 * used to mean "no link survived the drawn mesh", where the mesh is quantile
 * pruned so it stays legible - a conversation whose ten nearest neighbours all
 * fell below the global cut lost every edge and was reported as unconnected. On
 * the real corpus that was 37 of 150, a quarter of the index, every one of which
 * had up to six exact neighbours the detail panel would happily list. A filter
 * matching a quarter of everything, and meaning "the renderer dropped these
 * lines", is not a question anyone asks.
 *
 * The useful question is about the WORK: a one-off exploration nothing since has
 * built on, which a dense map hides and which is the easiest to forget you did.
 * That is answerable from `nodeNeighbors`, which carries every node's nearest
 * conversations in full embedding dimensionality, unpruned - so this is
 * renderer-side arithmetic over data the projection already ships.
 */

/**
 * How far below the corpus median a conversation's best match must fall.
 *
 * Measured, not chosen. The best-match similarities on the real 150-conversation
 * corpus are extraordinarily concentrated, which is the anisotropy Phase 1 found
 * showing up again:
 *
 *     min    p01    p05    p25    median   p75    max
 *     0.714  0.767  0.964  0.983  0.9875   0.990  0.994
 *
 * Two conversations sit at 0.714 and 0.767, then the next is 0.936 - a gap of
 * 0.17 with nothing in it. Those two are the answer, and every candidate rule
 * was measured against that:
 *
 *     median - 3 MAD (0.978)   flags 14     MAD is 0.0032, so three of them is
 *     p25 - 1.5 IQR  (0.972)   flags 10     a hundredth below the median and
 *     p25 - 3 IQR    (0.962)   flags  7     catches the middle of the pack
 *     median x 0.95  (0.938)   flags  3
 *     median x 0.90  (0.889)   flags  2  <- the natural break
 *     median x 0.85  (0.839)   flags  2
 *     median x 0.80  (0.790)   flags  2
 *     median x 0.70  (0.691)   flags  0
 *
 * A spread-based rule cannot work on a distribution this tight: MAD and IQR both
 * collapse toward zero, so a fixed multiple of them lands inside the pack. A
 * RELATIVE gap from the median does, and 0.10 through ~0.27 all return the same
 * two conversations, so this sits in the middle of a wide plateau rather than on
 * a cliff.
 *
 * An ABSOLUTE threshold is the one thing that certainly does not work, and that
 * is measured too: Phase 1 found anisotropy putting over 98% of top-10 pairs
 * above 0.8 cosine, so the same constant is a no-op on one corpus and a wipe on
 * the next. A share of the median is scale-free and travels.
 */
const STANDALONE_GAP = 0.15;

/** Below this many measurable nodes there is no corpus to be an outlier from. */
const MIN_SAMPLE = 4;

function medianOf(sorted: Float64Array): number {
  if (sorted.length === 0) return 0;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function findStandalone(
  nodeNeighbors: ReadonlyArray<ReadonlyArray<{ index: number; similarity: number }>> | undefined,
  nodeCount: number,
): Set<number> {
  const standalone = new Set<number>();
  if (!nodeNeighbors || nodeCount === 0) return standalone;

  // A node with NO neighbour list at all stands alone by definition, and is set
  // aside rather than fed in as a zero, which would drag the median down and
  // change everyone else's verdict.
  const bestOf = new Float64Array(nodeCount).fill(Number.NaN);
  const measured: number[] = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const list = nodeNeighbors[index];
    if (!list || list.length === 0) {
      standalone.add(index);
      continue;
    }
    // Strongest first by construction, but a max costs one pass and does not
    // depend on that staying true.
    let strongest = -Infinity;
    for (const entry of list) if (entry.similarity > strongest) strongest = entry.similarity;
    bestOf[index] = strongest;
    measured.push(strongest);
  }
  if (measured.length < MIN_SAMPLE) return standalone;

  const median = medianOf(Float64Array.from(measured).sort());
  if (median <= 0) return standalone;

  // Nothing qualifies on an index where everything is related, and that is the
  // point: the control hides itself when it would do nothing, so when it does
  // appear it is a finding rather than background.
  const floor = median * (1 - STANDALONE_GAP);
  for (let index = 0; index < nodeCount; index += 1) {
    if (!Number.isNaN(bestOf[index]) && bestOf[index] < floor) standalone.add(index);
  }
  return standalone;
}
