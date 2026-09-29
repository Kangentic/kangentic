/**
 * The conversations an answered turn is about, for the camera to fly to.
 *
 * An answer lights its whole related set, which on a broad question spans most
 * of the map, so framing everything lit left the camera where it was and the
 * answer never looked like it narrowed anything. The rows are the tasks the
 * answer is about; framing them is what makes the map go where the answer
 * points. Null when no row has a conversation on the map, which leaves the
 * camera framing the lit set as before.
 */
export function answerFocusIndices(
  rows: ReadonlyArray<{ docKeys: ReadonlyArray<string> }>,
  indexByDocKey: ReadonlyMap<string, number>,
  /** The map filters' surviving nodes, or null when nothing is filtered. */
  scope: ReadonlySet<number> | null,
): number[] | null {
  const focus: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    for (const docKey of row.docKeys) {
      const index = indexByDocKey.get(docKey);
      if (index === undefined || seen.has(index)) continue;
      if (scope && !scope.has(index)) continue;
      seen.add(index);
      focus.push(index);
    }
  }
  return focus.length > 0 ? focus : null;
}
