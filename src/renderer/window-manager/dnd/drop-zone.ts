/**
 * Window-dock drop-zone math: which pane a drag would tile onto, and on which
 * side. Pure - no React, no store, no DOM.
 *
 * EVERYTHING KEYS OFF THE POINTER. Together with `snap.ts` (screen docks) that
 * gives the whole drag one input: wherever the cursor is decides what happens.
 * One rule to learn, and the thing that decides is the thing the user is looking
 * at and steering.
 *
 * This used to key off the dragged window's BODY CENTER, for a defensible reason -
 * it is independent of where on the header you grabbed, and it matches where the
 * window visually sits. It cost more than it bought:
 *
 *  - **The center cannot reach a stack's first or last slot.** A dragged window is
 *    bigger than a pane, so putting its center above the top pane's midline means
 *    pushing the window mostly off-screen. That single gap is what forced a whole
 *    SECOND targeting signal into existence (the window's leading edge reaching the
 *    tile tree's outer boundary, with its own edge-zone constant, extreme-pane
 *    search, root-axis plumbing and an over-the-footprint guard). A cursor points
 *    at the top pane's top band directly, so every slot is reachable from the bands
 *    alone and that entire second path is deleted, not reimplemented.
 *  - **The trigger was invisible.** A user cannot see a body center; they can see
 *    their cursor. "No dead zone" reads as unpredictable when the thing being
 *    hit-tested is imaginary.
 *  - **It made behavior depend on window size**, which is not something the user is
 *    thinking about when they aim.
 *
 * The outcome stays grab-independent in the sense that matters: the same cursor
 * position resolves the same dock regardless of where the header was grabbed. What
 * changes is that the dragged window's body may sit visually offset from the
 * preview - the cursor is the anchor, the way it is when dragging anything else.
 *
 * Within a pane the side is picked by PRIORITY BANDS, not diagonals: the left and
 * right thirds are FULL-HEIGHT (so "the cursor is on the left side" always means
 * dock LEFT, at any height), and only the center third splits top vs bottom at the
 * midline. Diagonals were unpredictable - near the vertical middle a small move
 * flipped left <-> top/bottom. Straight band edges make the choice predictable, and
 * there is deliberately NO positional dead zone inside a pane, because one would
 * reintroduce exactly that flip-flopping.
 *
 * Free movement comes from a TRAVEL BUDGET instead (`resolveDockTarget`): the drag
 * must displace the pointer past `FREE_MOVE_RADIUS_PX` before any window dock arms.
 * Grab a header that happens to sit over another window and the dock condition is
 * already true at pointer-down, so position alone carries no intent; the budget is
 * what separates a nudge from an aim. Screen docks (`snap.ts`) need no such budget -
 * their trigger cannot be true at rest, since a released window is always clamped
 * fully inside the overlay.
 *
 * Pure steps, unit-tested:
 *  - `collectCandidatePanes` projects the windows to pixel rects (tiled panes from
 *    the tree; otherwise each floating window's geometry).
 *  - `detectDropTarget` hit-tests a point against those panes and picks the side.
 *  - `resolveDockTarget` is what a drag calls: the travel budget in front of it.
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

/** How far the pointer must travel before a window dock can arm. Below it the
 *  gesture is a free move, so grabbing a header that overlaps another window and
 *  nudging repositions instead of docking.
 *
 *  A flat distance, deliberately: the trigger is now a cursor position, so nothing
 *  about it scales with the window, and a budget that did would be a leftover from
 *  the body-center model rather than a property of this one. Sits well above
 *  `DRAG_ACTIVATION_PX` (4), the travel that merely turns a press into a drag.
 *
 *  Checked per pointermove and NOT latched: a drag that overshoots and comes back
 *  inside the radius must drop as a plain move, not commit a dock the user backed
 *  out of. Do not "fix" flicker at the boundary by latching. */
export const FREE_MOVE_RADIUS_PX = 120;

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
 * Resolve the drop target for a pointer position, or null when it is over no pane
 * at all. When it IS over a pane, priority bands pick the side deterministically:
 * the left third docks LEFT and the right third docks RIGHT at any height; the
 * center third docks TOP above the midline and BOTTOM below it. Picks the
 * front-most (highest zIndex) pane under the point.
 *
 * Every insertion slot in a tile tree is reachable from this alone: a stack's very
 * top slot is the top band of its topmost pane, its very bottom slot the bottom
 * band of its bottommost, and each interior seam is a band on either side of it.
 */
export function detectDropTarget(pointerX: number, pointerY: number, candidates: CandidatePane[]): DropTarget | null {
  let pane: CandidatePane | null = null;
  for (const candidate of candidates) {
    if (!rectContainsPoint(candidate.rect, pointerX, pointerY)) continue;
    if (!pane || candidate.zIndex > pane.zIndex) pane = candidate;
  }
  if (!pane || pane.rect.width <= 0 || pane.rect.height <= 0) return null;

  // Normalised position within the pane (0..1 on each axis).
  const normalizedX = (pointerX - pane.rect.left) / pane.rect.width;
  const normalizedY = (pointerY - pane.rect.top) / pane.rect.height;
  // Full-height left/right bands take priority over top/bottom, so being on the
  // left side always docks left regardless of vertical position; only the center
  // column resolves top vs bottom by the midline.
  let side: TileInsertSide;
  if (normalizedX < SIDE_BAND_FRACTION) side = 'left';
  else if (normalizedX > 1 - SIDE_BAND_FRACTION) side = 'right';
  else side = normalizedY < 0.5 ? 'top' : 'bottom';

  return { targetWindowId: pane.windowId, side, previewRect: previewRectFor(pane.rect, side) };
}

/** Whether a drag has moved far enough for a window dock to arm. `deltaX` /
 *  `deltaY` are the displacement from the drag's anchor point, NOT cumulative path
 *  length, so jiggling in place never opens the gate. */
export function hasClearedFreeMove(deltaX: number, deltaY: number): boolean {
  return Math.hypot(deltaX, deltaY) > FREE_MOVE_RADIUS_PX;
}

export interface DockResolveInput {
  /** Pointer position in overlay pixels. */
  pointerX: number;
  pointerY: number;
  candidates: CandidatePane[];
  /** Displacement from the drag's anchor point (see `hasClearedFreeMove`). */
  deltaX: number;
  deltaY: number;
}

/**
 * The armed WINDOW dock for a drag, or null: the travel budget in front of the
 * pointer hit-test. Screen docks (half / maximize) are a separate family with
 * their own commitment signal and are NOT gated here - see `snap.ts`.
 */
export function resolveDockTarget(input: DockResolveInput): DropTarget | null {
  if (!hasClearedFreeMove(input.deltaX, input.deltaY)) return null;
  return detectDropTarget(input.pointerX, input.pointerY, input.candidates);
}
