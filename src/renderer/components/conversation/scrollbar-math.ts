/**
 * Pure geometry helpers for the conversation viewer's custom scrollbar rail
 * (`ConversationScrollbar.tsx`). Kept separate from the component so the
 * offset<->thumb-position mapping is unit-testable without mounting React or
 * touching the DOM.
 */

export interface ThumbGeometry {
  /** Distance from the top of the rail to the top of the thumb, in px. */
  thumbTop: number;
  /** Thumb height, in px - never below `MIN_THUMB_SIZE_PX`. */
  thumbSize: number;
}

/** Below this, a purely proportional thumb becomes an ungrabbable sliver on a
 *  very long transcript - the whole reason this custom rail exists. */
export const MIN_THUMB_SIZE_PX = 48;

/** Beyond this distance (px) from the tail, a "Jump to latest" snaps instantly
 *  instead of smooth-scrolling, which would otherwise take uncomfortably long to
 *  visually cross a very long transcript. Shared by `ConversationView` (which
 *  decides the scroll behavior) and `ConversationScrollbar` (which labels the
 *  jump pill's `data-far`) so the two can never disagree. */
export const FAR_FROM_BOTTOM_PX = 4000;

/** Within this distance (px) of the tail, the user counts as "at the bottom" -
 *  small enough to absorb sub-pixel rounding, not so large that a user reading
 *  the last couple of rows gets treated as still following live. Shared by
 *  `ConversationScrollbar` (which pill visibility keys on it) and
 *  `ConversationView` (which auto-follow-on-new-message keys on it), so both
 *  answer the same "is the user at the bottom?" question identically - the
 *  pill hides exactly when auto-follow would fire on the next append. */
export const BOTTOM_EPSILON_PX = 4;

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Whether `geometry` is within `epsilonPx` of its scrollable tail. */
export function isScrolledToBottom(geometry: ScrollGeometry, epsilonPx: number = BOTTOM_EPSILON_PX): boolean {
  const distanceFromBottom = geometry.scrollHeight - (geometry.scrollTop + geometry.clientHeight);
  return distanceFromBottom <= epsilonPx;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Maps a scroll offset to where the thumb should sit on the rail. When the
 *  proportional size (`viewportSize / totalSize * railSize`) would fall below
 *  the floor, the thumb is pinned to `MIN_THUMB_SIZE_PX` and its travel range
 *  is correspondingly reduced, so it still reaches both rail ends exactly at
 *  the scroll extremes. */
export function computeThumbGeometry(params: {
  scrollOffset: number;
  totalSize: number;
  viewportSize: number;
  railSize: number;
}): ThumbGeometry {
  const { scrollOffset, totalSize, viewportSize, railSize } = params;
  if (totalSize <= 0 || viewportSize <= 0 || railSize <= 0) {
    return { thumbTop: 0, thumbSize: Math.max(0, railSize) };
  }
  const proportionalSize = (viewportSize / totalSize) * railSize;
  const thumbSize = Math.min(railSize, Math.max(MIN_THUMB_SIZE_PX, proportionalSize));
  const scrollableDistance = Math.max(0, totalSize - viewportSize);
  const progress = scrollableDistance > 0 ? clamp01(scrollOffset / scrollableDistance) : 0;
  const thumbTravel = Math.max(0, railSize - thumbSize);
  return { thumbTop: progress * thumbTravel, thumbSize };
}

/** Where the virtualizer placed one row, in pixels of the scroll content. */
export interface MeasuredRow {
  index: number;
  start: number;
  size: number;
}

/**
 * A paged window's logical position at a pixel offset: the logical position
 * of the row the offset lands in, interpolated toward the next row's. The
 * scrollbar of a paged window measures the whole transcript in this unit
 * (`conversation-paging.ts`), while the scroll container only holds the rows
 * loaded. `rowLogical` is non-decreasing, one value per row.
 */
export function logicalAtOffset(params: {
  offset: number;
  rowLogical: ReadonlyArray<number>;
  itemAt: (index: number) => MeasuredRow | undefined;
  itemForOffset: (offset: number) => MeasuredRow | undefined;
  logicalEnd: number;
}): number {
  const { offset, rowLogical, itemAt, itemForOffset, logicalEnd } = params;
  if (rowLogical.length === 0) return logicalEnd;
  const first = itemAt(0);
  if (!first || offset <= first.start) return rowLogical[0];
  const item = itemForOffset(offset);
  if (!item) return logicalEnd;
  const from = rowLogical[item.index] ?? logicalEnd;
  const to = item.index + 1 < rowLogical.length ? rowLogical[item.index + 1] : logicalEnd;
  const fraction = item.size > 0 ? clamp01((offset - item.start) / item.size) : 1;
  return from + fraction * (to - from);
}

/**
 * The pixel offset of a logical position, the inverse of `logicalAtOffset`, or
 * null when the position is outside the rows loaded: a drag there is a far
 * drag, which loads a page. Past an edge with nothing left to load it clamps.
 */
export function offsetAtLogical(params: {
  logical: number;
  rowLogical: ReadonlyArray<number>;
  itemAt: (index: number) => MeasuredRow | undefined;
  logicalEnd: number;
  startLoaded: boolean;
  endLoaded: boolean;
  maxOffset: number;
}): number | null {
  const { logical, rowLogical, itemAt, logicalEnd, startLoaded, endLoaded, maxOffset } = params;
  if (rowLogical.length === 0) return null;
  if (logical < rowLogical[0]) return startLoaded ? 0 : null;
  if (logical > logicalEnd) return endLoaded ? maxOffset : null;
  let low = 0;
  let high = rowLogical.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (rowLogical[middle] <= logical) low = middle;
    else high = middle - 1;
  }
  const item = itemAt(low);
  if (!item) return null;
  const from = rowLogical[low];
  const to = low + 1 < rowLogical.length ? rowLogical[low + 1] : logicalEnd;
  const fraction = to > from ? clamp01((logical - from) / (to - from)) : 0;
  return Math.min(maxOffset, item.start + fraction * item.size);
}

/** Inverse of `computeThumbGeometry`'s position half: given where the user
 *  dragged the thumb to, returns the scroll offset that should produce it. */
export function thumbPositionToOffset(params: {
  thumbTop: number;
  thumbSize: number;
  totalSize: number;
  viewportSize: number;
  railSize: number;
}): number {
  const { thumbTop, thumbSize, totalSize, viewportSize, railSize } = params;
  const thumbTravel = Math.max(0, railSize - thumbSize);
  const progress = thumbTravel > 0 ? clamp01(thumbTop / thumbTravel) : 0;
  const scrollableDistance = Math.max(0, totalSize - viewportSize);
  return progress * scrollableDistance;
}
