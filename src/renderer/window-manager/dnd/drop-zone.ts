/**
 * Pure drag-to-dock drop-zone math (3b). No React, no store, no DOM.
 *
 * While a window is dragged OVER another pane, the pane under the dragged
 * window's CENTER offers four edge drop zones (left/right/top/bottom) plus a dead
 * center. Keying off the window's center (NOT the mouse pointer) matches the
 * screen-edge snap, which keys off the window's own rect: where you grabbed the
 * title bar is irrelevant, and top vs bottom are symmetric. The edge the center
 * is nearest decides where the dragged window docks (and which way the pane
 * splits); the dead center is a no-dock region so a window can be dragged ACROSS
 * a pane and dropped floating on top of it without tiling (the hybrid float+tile
 * model). This is the discovery mechanism for arbitrary N-way tiling.
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

/** Fraction of the pane (each axis) reserved as the dead center: drop here and
 *  the window floats rather than docking. The outer band is the edge zones. */
const CENTER_DEAD_ZONE = 0.4;

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
 * or null when it is over no pane or in a pane's dead center. Picks the
 * front-most (highest zIndex) pane under the point, then the nearest of its four
 * edges.
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
  const lowEdge = (1 - CENTER_DEAD_ZONE) / 2; // 0.3 with a 0.4 dead zone
  const highEdge = 1 - lowEdge; // 0.7
  if (normalizedX > lowEdge && normalizedX < highEdge && normalizedY > lowEdge && normalizedY < highEdge) {
    return null; // dead center: release floats, no dock
  }

  // Nearest edge wins (distance to each pane edge as a fraction).
  const distances: Array<{ side: TileInsertSide; distance: number }> = [
    { side: 'left', distance: normalizedX },
    { side: 'right', distance: 1 - normalizedX },
    { side: 'top', distance: normalizedY },
    { side: 'bottom', distance: 1 - normalizedY },
  ];
  let nearest = distances[0];
  for (const candidate of distances) {
    if (candidate.distance < nearest.distance) nearest = candidate;
  }
  return { targetWindowId: pane.windowId, side: nearest.side, previewRect: previewRectFor(pane.rect, nearest.side) };
}
