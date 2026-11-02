// The pure rules behind the task-detail split divider (useTaskSplitResize), kept
// apart from the hook so the unit tier can run the real code.

export const MIN_SPLIT_RATIO = 0.25;
export const MAX_SPLIT_RATIO = 0.75;
export const DEFAULT_SPLIT_RATIO = 0.5;

export function clampSplitRatio(value: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, value));
}

/**
 * The clamped ratio for a pointer at `pointerX` over a container that starts at
 * `containerLeft` and is `containerWidth` wide. Null for a zero-width container,
 * where there is nothing to divide and the drag should ignore the move.
 */
export function splitRatioFromPointer(pointerX: number, containerLeft: number, containerWidth: number): number | null {
  if (containerWidth === 0) return null;
  return clampSplitRatio((pointerX - containerLeft) / containerWidth);
}

/**
 * The ratio the divider draws. While a drag is in flight the live ratio wins,
 * so a store write (or a switch to another task) never snaps the divider back
 * mid-drag; otherwise the stored ratio shows at once.
 */
export function displayedSplitRatio(isResizing: boolean, liveRatio: number, storedRatio: number): number {
  return isResizing ? liveRatio : storedRatio;
}
