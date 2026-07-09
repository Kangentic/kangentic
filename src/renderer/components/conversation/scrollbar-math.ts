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
