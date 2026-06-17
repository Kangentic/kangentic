/**
 * Pure drag-to-dock drop-zone math (3b). No React, no store, no DOM.
 *
 * Whenever the dragged window's CENTER is over another pane, that pane ALWAYS
 * offers a dock zone (no dead area). The pane is carved into PRIORITY BANDS, not
 * diagonals: the left and right thirds are FULL-HEIGHT (so "the center is on the
 * left side" always means dock LEFT, at any height), and only the center column
 * splits top vs bottom at the horizontal midline. Diagonals were unpredictable -
 * near the vertical middle a small move flipped left <-> top/bottom along the
 * diagonal. Straight band edges (one vertical line at each third, one horizontal
 * line down the middle) make the left/right vs top/bottom choice predictable.
 *
 * Keying off the window's center (NOT the mouse pointer) matches the screen-edge
 * snap, which keys off the window's own rect: where you grabbed the title bar is
 * irrelevant. To drop a window FLOATING over another (no tile), keep its center
 * off the other window (less than half over). This is the discovery mechanism for
 * arbitrary N-way tiling.
 *
 * Two pure steps, both unit-tested:
 *  - `collectCandidatePanes` projects the current windows to their pixel rects
 *    (tiled panes from the tile tree; otherwise each floating window's geometry).
 *  - `detectDropTarget` hit-tests a reference point (the dragged window's center)
 *    against those panes and resolves the armed zone + the preview rect (the
 *    half/area the dragged window would take).
 */

import type { FractionalRect, ManagedWindow, TileNode } from '../store/types';
import type { ContainerSize, PixelRect } from '../store/geometry';
import { fractionalToPixels } from '../store/geometry';
import { resolveTileLayout } from '../tiling/resolve-layout';
import type { TileInsertSide } from '../tiling/tree-ops';

/** Width of the left/right priority bands as a fraction of the pane. The outer
 *  third on each side docks left/right at any height; the center third splits
 *  top vs bottom. Tunable: larger = easier left/right, smaller center column. */
const SIDE_BAND_FRACTION = 1 / 3;

export interface CandidatePane {
  windowId: string;
  /** Stacking order; the front-most pane under the cursor wins ties. */
  zIndex: number;
  rect: PixelRect;
}

export interface DropTarget {
  targetWindowId: string;
  side: TileInsertSide;
  /** Overlay-pixel rect the dragged window would occupy (the drop preview). */
  previewRect: PixelRect;
}

/**
 * Project every dockable window (except `draggedWindowId`) to its current pixel
 * rect. When a tile tree exists, the candidates are exactly its tiled panes
 * (resolved edge-to-edge within the tree's footprint, so the whole pane is a hit
 * target); otherwise every visible floating/snapped window is a candidate, so
 * dropping onto one seeds a fresh tile pair. Minimized windows are never
 * candidates.
 */
export function collectCandidatePanes(
  draggedWindowId: string,
  windows: Record<string, ManagedWindow>,
  tileTree: TileNode | null,
  container: ContainerSize,
  tileTreeRect: FractionalRect,
): CandidatePane[] {
  const candidates: CandidatePane[] = [];
  if (tileTree) {
    const layout = resolveTileLayout(
      tileTree,
      { width: tileTreeRect.w * container.width, height: tileTreeRect.h * container.height },
      0,
      0,
      { left: tileTreeRect.x * container.width, top: tileTreeRect.y * container.height },
    );
    for (const [windowId, rect] of layout.rects) {
      if (windowId === draggedWindowId) continue;
      candidates.push({ windowId, zIndex: windows[windowId]?.zIndex ?? 0, rect });
    }
    return candidates;
  }
  for (const managedWindow of Object.values(windows)) {
    if (managedWindow.id === draggedWindowId) continue;
    if (managedWindow.state === 'minimized') continue;
    const geometry = managedWindow.state === 'maximized' ? { x: 0, y: 0, w: 1, h: 1 } : managedWindow.geometry;
    candidates.push({ windowId: managedWindow.id, zIndex: managedWindow.zIndex, rect: fractionalToPixels(geometry, container) });
  }
  return candidates;
}

function rectContainsPoint(rect: PixelRect, pointX: number, pointY: number): boolean {
  return (
    pointX >= rect.left &&
    pointX <= rect.left + rect.width &&
    pointY >= rect.top &&
    pointY <= rect.top + rect.height
  );
}

/** The half/area of `pane` a window docked on `side` occupies (the preview). */
function previewRectFor(pane: PixelRect, side: TileInsertSide): PixelRect {
  const halfWidth = pane.width / 2;
  const halfHeight = pane.height / 2;
  switch (side) {
    case 'left':
      return { left: pane.left, top: pane.top, width: halfWidth, height: pane.height };
    case 'right':
      return { left: pane.left + halfWidth, top: pane.top, width: halfWidth, height: pane.height };
    case 'top':
      return { left: pane.left, top: pane.top, width: pane.width, height: halfHeight };
    case 'bottom':
      return { left: pane.left, top: pane.top + halfHeight, width: pane.width, height: halfHeight };
  }
}

/**
 * Resolve the drop target for a reference point (the dragged window's center),
 * or null only when it is over no pane at all. When it IS over a pane, priority
 * bands pick the side deterministically (no dead zone, no diagonals): the left
 * third docks LEFT and the right third docks RIGHT at any height; the center
 * third docks TOP above the midline and BOTTOM below it. Picks the front-most
 * (highest zIndex) pane under the point.
 */
export function detectDropTarget(referenceX: number, referenceY: number, candidates: CandidatePane[]): DropTarget | null {
  let pane: CandidatePane | null = null;
  for (const candidate of candidates) {
    if (!rectContainsPoint(candidate.rect, referenceX, referenceY)) continue;
    if (!pane || candidate.zIndex > pane.zIndex) pane = candidate;
  }
  if (!pane || pane.rect.width <= 0 || pane.rect.height <= 0) return null;

  // Normalised position within the pane (0..1 on each axis).
  const normalizedX = (referenceX - pane.rect.left) / pane.rect.width;
  const normalizedY = (referenceY - pane.rect.top) / pane.rect.height;
  // Full-height left/right bands take priority over top/bottom, so being on the
  // left side always docks left regardless of vertical position; only the center
  // column resolves top vs bottom by the midline.
  let side: TileInsertSide;
  if (normalizedX < SIDE_BAND_FRACTION) side = 'left';
  else if (normalizedX > 1 - SIDE_BAND_FRACTION) side = 'right';
  else side = normalizedY < 0.5 ? 'top' : 'bottom';

  return { targetWindowId: pane.windowId, side, previewRect: previewRectFor(pane.rect, side) };
}
