/**
 * Pure scrollTop computation behind ConversationView's `useScrollSettle` loop
 * (open-at-position, search/palette navigation). Extracted from
 * ConversationView.tsx so the "prefer the virtualizer's own real measurement
 * over the static per-row estimate" correction - the fix for the
 * open-at-position centering bug - is unit-testable without mounting React or
 * a `@tanstack/react-virtual` instance (mirrors `scrollbar-math.ts`,
 * `display-rows.ts`, and `tui-anchor.ts`, which extract this component's
 * other DOM-adjacent pure logic for the same reason).
 */

import type { DisplayRow } from './display-rows';

/** Row height fallback when a row is missing from `rows` (should not happen
 *  in practice) or has no estimate of its own yet. */
export const ESTIMATED_ROW_HEIGHT = 96;

/** The subset of `@tanstack/react-virtual`'s `VirtualItem` the settle loop
 *  needs - narrowed so callers do not have to import the virtualizer's full
 *  generic type. */
export interface SettleVirtualItem {
  index: number;
  start: number;
  size: number;
}

/** Sum of `rows[0..index)`'s estimated heights - the row's approximate
 *  offset from the top of the virtual content, independent of the
 *  virtualizer's own (asynchronous, reconcile-driven) internal scroll state.
 *  Used only as a bootstrap guess before the target row has ever been
 *  rendered (see `computeSettleScrollTop`'s doc comment) - the per-row
 *  heuristic in `display-rows.ts` is a rough line-count estimate, so a
 *  target many rows deep can accumulate a large enough error that this alone
 *  is not a reliable final position. */
export function estimatedOffsetForIndex(rows: DisplayRow[], index: number): number {
  let offset = 0;
  for (let rowIndex = 0; rowIndex < index && rowIndex < rows.length; rowIndex += 1) {
    offset += rows[rowIndex]?.estimatedHeight ?? ESTIMATED_ROW_HEIGHT;
  }
  return offset;
}

/**
 * Computes the `scrollTop` to write for one settle-loop tick with
 * `align: 'center' | 'start'` (see `useScrollSettle` in ConversationView.tsx
 * for the `'end'` case, which just clamps to `scrollHeight` and needs no
 * per-row math).
 *
 * Prefers the virtualizer's OWN rendered item for this index when one is
 * passed in (`virtualItem`) - its `start`/`size` are REAL, measured values,
 * accurate regardless of how far off the row's static `estimatedHeight`
 * heuristic was. Only when the target isn't currently rendered (`virtualItem`
 * is `undefined` - not yet within the virtualizer's own render range) does
 * this fall back to the static per-row estimate, purely to land the
 * container CLOSE to the target - close enough that the browser's own
 * scrollTop clamping settles near the target's real rows, which the
 * virtualizer then renders, which the caller's NEXT tick can pick up via a
 * fresh `virtualItem`. This is what actually fulfills convergence: the
 * static heuristic alone never improves across retries (it is a pure
 * function of `rows`, unaffected by anything the virtualizer has since
 * measured), so a settle loop that never reads the real `virtualItem` would
 * just recompute the identical wrong value every tick and call it "stable" -
 * this was the open-at-position centering bug this function's callers fix.
 */
export function computeSettleScrollTop(params: {
  align: 'center' | 'start';
  index: number;
  rows: DisplayRow[];
  virtualItem: SettleVirtualItem | undefined;
  clientHeight: number;
}): number {
  const { align, index, rows, virtualItem, clientHeight } = params;
  const rowOffset = virtualItem ? virtualItem.start : estimatedOffsetForIndex(rows, index);
  const rowHeight = virtualItem ? virtualItem.size : (rows[index]?.estimatedHeight ?? ESTIMATED_ROW_HEIGHT);
  const targetOffset = align === 'center'
    ? rowOffset - Math.max(0, (clientHeight - rowHeight) / 2)
    : rowOffset;
  return Math.max(0, Math.round(targetOffset));
}
