/**
 * The one implementation of "insertion-ordered Map as an LRU, bounded by BOTH a
 * record count and a byte budget".
 *
 * This exists because the idiom was hand-copied instead of shared, and BOTH
 * copies silently dropped half of it. `transcript-cache.ts` bounds its cache by
 * count AND bytes, and its comment explains why: "a handful of 50MB transcripts
 * would otherwise dwarf everything else". `incrementalStateByPath` in the Claude
 * transcript parser named that cache as its model, copied the count cap, and
 * left the byte budget behind - while retaining a strictly LARGER payload (a
 * full UNTRUNCATED entries array per file). `stitchMemoByTaskId` in
 * `transcript-service.ts` had the same defect, and it is the worse of the two:
 * a memo is an INDEPENDENT retention root designed to outlive file-cache
 * eviction, so nothing else bounded it at all.
 *
 * So: never re-implement this loop. Add a call site.
 *
 * BYTE BUDGETS HERE COUNT SOURCE BYTES, NOT RETAINED HEAP, and the proxy is
 * CONSERVATIVE rather than optimistic. Measured on a real 137.9MB Claude
 * transcript, the parsed `TranscriptEntry[]` retained 12.7MB - 0.09x source,
 * because a parser keeps conversation content and discards the surrounding
 * JSON. A budget of N source bytes therefore corresponds to well under N bytes
 * of heap for the entries themselves.
 *
 * Do not read that as "these budgets were unnecessary". They bound the number
 * of large parses that can be resident, which is a real ceiling. But the thing
 * that actually OOM'd the main process was the PEAK of each parse (a 137.9MB
 * file becomes a 275.9MB UTF-16 string just to be read), and no eviction policy
 * can bound a peak that occurs before eviction runs. That is bounded separately,
 * by `MAX_PARSE_SOURCE_BYTES`.
 */

export interface BoundedLruOptions<V> {
  /** Maximum records retained, whatever their size. */
  limit: number;
  /** Maximum summed `sizeOf` across retained records. */
  byteBudget: number;
  /** Size of one record, in the same unit as `byteBudget`. */
  sizeOf: (value: V) => number;
  /**
   * Records retained even when they alone exceed `byteBudget`. Deliberately
   * EXPLICIT rather than the implicit `size > 1` floor the original loop
   * carried, because the floor is a real behavioral choice and it is not
   * obviously right at every call site: with a floor, a lone oversized record is
   * RETAINED (sustained retention); without one, it is evicted immediately and
   * the next read re-parses it (thrash). Callers that independently cap how
   * large any single record may be make this moot, which is the preferred way
   * to resolve it - bound the record, and the floor stops being load-bearing.
   */
  minRetained: number;
}

/** Summed `sizeOf` across every record currently in `map`. */
export function heldBytes<K, V>(map: Map<K, V>, sizeOf: (value: V) => number): number {
  let total = 0;
  for (const held of map.values()) total += sizeOf(held);
  return total;
}

/**
 * Move `key` to the most-recently-used end of `map` and evict from the
 * least-recently-used end until both bounds hold.
 *
 * Map iteration order is insertion order, so a delete-then-set is enough to
 * implement LRU without a separate linked list, and `map.keys().next().value`
 * is the least-recently-used key.
 *
 * Whichever bound binds first evicts. Both are expected to be reachable in
 * normal operation: the count binds on a working set of many small records, the
 * byte budget on a few large ones. A bound that can never be reached is worse
 * than no bound, because it reads as protection that is not there - which is
 * exactly the failure this module exists to prevent.
 */
export function touchBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  options: BoundedLruOptions<V>,
): void {
  const { limit, byteBudget, sizeOf, minRetained } = options;

  map.delete(key);
  map.set(key, value);

  let retainedBytes = heldBytes(map, sizeOf);
  while (map.size > limit || (retainedBytes > byteBudget && map.size > minRetained)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = map.get(oldestKey);
    map.delete(oldestKey);
    if (evicted !== undefined) retainedBytes -= sizeOf(evicted);
  }
}
