/**
 * Cascade positioning for multi-window pop-out kinds. Saved pop-out bounds are
 * keyed by KIND (AppConfig.popOutBounds), so the 2nd+ concurrently-open window
 * of a kind would otherwise restore to exactly the same rect and open perfectly
 * stacked on top of the first. Pure module (no Electron imports) so the offset
 * math is unit-testable; PopOutWindowManager supplies the just-constructed
 * window's bounds and the matching display's workArea.
 */

export const CASCADE_STEP_PX = 28;

export interface CascadeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Position for the (liveCountOfKind + 1)-th live window of a pop-out kind: the
 * base position offset down-right by CASCADE_STEP_PX per already-live window.
 * An axis whose offset would push the window past the work-area edge wraps back
 * near the work-area origin (one step in from it) instead of walking off-screen;
 * each axis wraps independently. An axis the window FILLS (a rect as tall or
 * wide as the work area) takes no offset at all - it stays flush with the
 * work-area start rather than hanging off the edge, cascading on the other
 * axis only.
 */
export function cascadePopOutPosition(
  base: CascadeRect,
  liveCountOfKind: number,
  workArea: CascadeRect,
): { x: number; y: number } {
  if (liveCountOfKind <= 0) return { x: base.x, y: base.y };
  const offset = CASCADE_STEP_PX * liveCountOfKind;
  return {
    x: cascadeAxis(base.x, base.width, offset, workArea.x, workArea.width),
    y: cascadeAxis(base.y, base.height, offset, workArea.y, workArea.height),
  };
}

function cascadeAxis(basePosition: number, windowSize: number, offset: number, areaStart: number, areaSize: number): number {
  const areaEnd = areaStart + areaSize;
  const candidate = basePosition + offset;
  if (candidate + windowSize <= areaEnd) return candidate;
  const wrapped = areaStart + CASCADE_STEP_PX;
  if (wrapped + windowSize <= areaEnd) return wrapped;
  return areaStart;
}
