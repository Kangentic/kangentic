/**
 * Pure drag-to-dock drop-zone math (3b). No React, no store, no DOM.
 *
 * INTERIOR slots use the dragged window's BODY CENTER: whenever it is over another
 * pane, that pane offers a dock zone (no dead area), carved into PRIORITY BANDS, not
 * diagonals - the left and right thirds are FULL-HEIGHT (so "the center is on the
 * left side" always means dock LEFT, at any height), and only the center column
 * splits top vs bottom at the horizontal midline. Diagonals were unpredictable: near
 * the vertical middle a small move flipped left <-> top/bottom. Straight band edges
 * make the choice predictable. Keying off the window's BODY CENTER (not the grab
 * point, not the header) is grab-INDEPENDENT and matches where the window visually
 * sits, so the trigger fires when the body looks centered over the target.
 *
 * The body center alone cannot reach a stack's FIRST or LAST slot: the dragged window
 * is taller (or wider) than a pane, so its center would have to leave the screen. So
 * the tree's OUTER slots get a second signal - the dragged window's LEADING EDGE
 * reaching the tree's outer boundary (see `detectTiledDropTarget`): push the window's
 * top edge to the stack top to insert at the very top, etc. Reachable, and the body
 * keeps driving every interior slot. To drop a window FLOATING over another (no
 * tile), keep its center off the other panes. Discovery mechanism for N-way tiling.
 *
 * Pure steps, unit-tested:
 *  - `collectCandidatePanes` projects the windows to pixel rects (tiled panes from
 *    the tree; otherwise each floating window's geometry).
 *  - `detectDropTarget` hit-tests the body-center point against those panes (interior
 *    bands). `detectTiledDropTarget` wraps it with the outer-slot edge zones for a
 *    drag over an existing tree.
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
 * rect. Tiled panes come from the tree (resolved edge-to-edge within its
 * footprint, so the whole pane is a hit target). EVERY other visible window
 * (lone snapped / floating / maximized) is ALSO a candidate, whether or not a
 * tree exists: dropping onto a non-tree window merges it into the single tree
 * (or seeds the first pair). This is what lets a window left beside a tree be
 * docked into, instead of being a dead zone.
 */
export function collectCandidatePanes(
  draggedWindowId: string,
  windows: Record<string, ManagedWindow>,
  tileTree: TileNode | null,
  container: ContainerSize,
  tileTreeRect: FractionalRect,
): CandidatePane[] {
  const candidates: CandidatePane[] = [];
  const tiledWindowIds = new Set<string>();
  if (tileTree) {
    const layout = resolveTileLayout(
      tileTree,
      { width: tileTreeRect.w * container.width, height: tileTreeRect.h * container.height },
      0,
      0,
      { left: tileTreeRect.x * container.width, top: tileTreeRect.y * container.height },
    );
    for (const [windowId, rect] of layout.rects) {
      tiledWindowIds.add(windowId);
      if (windowId === draggedWindowId) continue;
      candidates.push({ windowId, zIndex: windows[windowId]?.zIndex ?? 0, rect });
    }
  }
  for (const managedWindow of Object.values(windows)) {
    if (managedWindow.id === draggedWindowId) continue;
    if (tiledWindowIds.has(managedWindow.id)) continue; // already added as a tiled pane
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
 * Resolve the INTERIOR drop target for a reference point (the dragged window's body
 * center), or null only when it is over no pane at all. When it IS over a pane,
 * priority bands pick the side deterministically (no dead zone, no diagonals): the
 * left third docks LEFT and the right third docks RIGHT at any height; the center
 * third docks TOP above the midline and BOTTOM below it. Picks the front-most
 * (highest zIndex) pane under the point. Outer-slot reachability is added by
 * `detectTiledDropTarget`.
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

/** The tile tree's outer pixel boundary (its footprint), for the edge zones. */
export interface TreeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Within this distance (px) of the tree's outer boundary, the dragged window's
 *  leading edge counts as "pushed to the edge", arming an outer-slot insert.
 *  Tunable: larger = the extreme slots arm sooner / are easier to hit. */
const EDGE_ZONE_PX = 28;

/** The extreme pane along an axis: topmost / bottommost / leftmost / rightmost. */
function extremePane(candidates: CandidatePane[], edge: TileInsertSide): CandidatePane | null {
  let chosen: CandidatePane | null = null;
  for (const candidate of candidates) {
    if (!chosen) {
      chosen = candidate;
      continue;
    }
    const next = candidate.rect;
    const best = chosen.rect;
    if (edge === 'top' && next.top < best.top) chosen = candidate;
    else if (edge === 'bottom' && next.top + next.height > best.top + best.height) chosen = candidate;
    else if (edge === 'left' && next.left < best.left) chosen = candidate;
    else if (edge === 'right' && next.left + next.width > best.left + best.width) chosen = candidate;
  }
  return chosen;
}

/**
 * Drop target for a dragged window over an EXISTING tile tree. Two-signal model:
 *  - The tree's OUTER slots (the stack's extremes) are armed when the dragged
 *    window's LEADING EDGE reaches the tree's outer boundary on the root axis -
 *    reachable by pushing the window's edge to the edge. `rootDirection` picks the
 *    axis: a vertical root (stack) owns top/bottom; a horizontal root (row) owns
 *    left/right. The window's body center must be over the tree on the cross axis
 *    (and in the matching half, so a window taller than the whole tree resolves to
 *    one extreme, not both) before an edge zone arms - a window flung to an empty
 *    corner never falsely grabs an extreme.
 *  - Every INTERIOR slot falls through to `detectDropTarget`'s body-center bands,
 *    so the trigger matches where the window visually sits.
 */
export function detectTiledDropTarget(
  draggedRect: PixelRect,
  candidates: CandidatePane[],
  rootDirection: 'horizontal' | 'vertical',
  treeBounds: TreeBounds,
): DropTarget | null {
  const centerX = draggedRect.left + draggedRect.width / 2;
  const centerY = draggedRect.top + draggedRect.height / 2;
  // The window's body center must be OVER the tree's footprint (both axes) for an
  // outer slot to arm. Without the main-axis bound, a CONFINED tree (footprint
  // shrunk to mid-screen after a pop-out) armed its extreme insert for a large
  // window dragged well past it - its leading edge trivially clears the now
  // mid-screen boundary. Requiring the center inside the footprint means dragging
  // the window away from a confined group no longer re-docks it.
  const overTree =
    centerX >= treeBounds.left && centerX <= treeBounds.right &&
    centerY >= treeBounds.top && centerY <= treeBounds.bottom;
  if (rootDirection === 'vertical') {
    const midY = (treeBounds.top + treeBounds.bottom) / 2;
    if (overTree && centerY < midY && draggedRect.top <= treeBounds.top + EDGE_ZONE_PX) {
      const pane = extremePane(candidates, 'top');
      if (pane) return { targetWindowId: pane.windowId, side: 'top', previewRect: previewRectFor(pane.rect, 'top') };
    }
    if (overTree && centerY >= midY && draggedRect.top + draggedRect.height >= treeBounds.bottom - EDGE_ZONE_PX) {
      const pane = extremePane(candidates, 'bottom');
      if (pane) return { targetWindowId: pane.windowId, side: 'bottom', previewRect: previewRectFor(pane.rect, 'bottom') };
    }
  } else {
    const midX = (treeBounds.left + treeBounds.right) / 2;
    if (overTree && centerX < midX && draggedRect.left <= treeBounds.left + EDGE_ZONE_PX) {
      const pane = extremePane(candidates, 'left');
      if (pane) return { targetWindowId: pane.windowId, side: 'left', previewRect: previewRectFor(pane.rect, 'left') };
    }
    if (overTree && centerX >= midX && draggedRect.left + draggedRect.width >= treeBounds.right - EDGE_ZONE_PX) {
      const pane = extremePane(candidates, 'right');
      if (pane) return { targetWindowId: pane.windowId, side: 'right', previewRect: previewRectFor(pane.rect, 'right') };
    }
  }
  return detectDropTarget(centerX, centerY, candidates);
}
