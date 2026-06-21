/**
 * P1 edge-snap detection: a plain geometry check, no @dnd-kit. The full
 * snap-zone droppable system (snap-assist, tiling) lands in P3.
 *
 * Every dock is driven by the CONTAINER'S own edge (not the grab point or the
 * pointer): it must not matter whether the user grabbed the header on the left,
 * center, or right. A dock arms only when that edge is dragged at least
 * DOCK_PAST_BOUNDARY_PX PAST the overlay boundary (into the off-screen region
 * the unlimited overshoot allows), so casually moving the window near an edge
 * does not accidentally dock or resize it. Because the trigger requires the edge
 * well past the boundary, a full-height / left-snapped window (top edge at 0)
 * dragged sideways never auto-maximizes.
 */

import type { FractionalRect, SnapEdge } from '../store/types';

/** How far PAST the boundary the container's edge must be dragged to arm a dock.
 *  A buffer that distinguishes an intentful dock from casual movement near an
 *  edge. Reachable because the drag is unclamped (the window may go off-screen). */
const DOCK_PAST_BOUNDARY_PX = 40;

interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OverlaySize {
  width: number;
  height: number;
}

/**
 * Returns the armed snap edge, or null.
 * @param frame   the window's rect in overlay coordinates (unclamped during drag)
 * @param overlay the overlay size
 */
export function detectSnapEdge(frame: FrameRect, overlay: OverlaySize): SnapEdge | null {
  // Top edge dragged past the top boundary maximizes (checked first so an upward
  // throw wins over a left/right dock at a corner).
  if (frame.top <= -DOCK_PAST_BOUNDARY_PX) return 'maximize';
  if (frame.left <= -DOCK_PAST_BOUNDARY_PX) return 'left';
  if (overlay.width - (frame.left + frame.width) <= -DOCK_PAST_BOUNDARY_PX) return 'right';
  return null;
}

/** The fractional geometry a given snap edge resolves to. */
export function snapEdgeToGeometry(edge: SnapEdge): FractionalRect {
  switch (edge) {
    case 'left':
      return { x: 0, y: 0, w: 0.5, h: 1 };
    case 'right':
      return { x: 0.5, y: 0, w: 0.5, h: 1 };
    case 'maximize':
      return { x: 0, y: 0, w: 1, h: 1 };
  }
}
