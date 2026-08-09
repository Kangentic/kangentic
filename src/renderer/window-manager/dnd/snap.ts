/**
 * Screen-dock detection: which half (or maximize) a drag is proposing, read from
 * the POINTER's position within the overlay. No @dnd-kit, no DOM, no store.
 *
 * The pointer, not the dragged window's own edge. This used to key off the
 * CONTAINER's edge dragged a fixed distance PAST the overlay boundary, on the
 * reasoning that the window's geometry is grab-independent where the cursor is
 * not. Two measured facts retired that:
 *
 *  - **It needs almost no travel when the window already RESTS near a boundary**,
 *    which is exactly where a default-size window sits. A drag commits through
 *    `clampToOverlay`, so every released window is fully inside the overlay with
 *    its edges just shy of the boundary - and a small shove flipped the trigger.
 *    That dependency is load-bearing: it is why the window-over-window dock needs
 *    a free-move budget and a screen dock does not.
 *  - **It could not be made stricter.** To push the TOP edge past the boundary the
 *    pointer has to climb, and the pointer stops at the screen top. Measured on a
 *    real window, the maximize trigger had ~27px of headroom between reachable and
 *    unreachable. Any extra requirement laid over it - a travel budget, a deeper
 *    overshoot - makes maximize physically impossible for a window already near
 *    the top, which is the state a user is in precisely when they want to maximize.
 *
 * The pointer has neither problem. It is unbounded in the sense that matters (the
 * user can always run it into the screen edge, from any window position), and the
 * RESULT is grab-independent even though the window's transient offset is not:
 * cursor to the right edge docks right no matter where on the header you grabbed.
 * It is also self-committing - burying the cursor in the edge is not something a
 * drag does by accident - which is why screen docks need no free-move budget while
 * window-over-window docks, whose trigger can already be true before the drag
 * starts, do. One mechanism, one reason.
 *
 * That asymmetry rests on the edge band being no wider than the resize handles, so
 * a grab can never START inside it. See `SCREEN_DOCK_EDGE_PX` before retuning it.
 */

import type { FractionalRect, SnapEdge } from '../store/types';

/** How close to the overlay's edge the pointer must be to arm that edge's dock.
 *  Small on purpose: the gesture is "run the cursor into the edge", and a wide
 *  band would arm while the user is still steering.
 *
 *  DO NOT RAISE THIS without re-checking `WindowResizeHandles`. The value is
 *  silently coupled to the 6px (`h-1.5` / `w-1.5`) resize handles that overlay
 *  every frame edge at `z-20`. A window can legitimately rest flush against a
 *  boundary (`clampToOverlay` clamps to 0; `Mod+Shift+Up` from maximized snaps a
 *  top half at `y: 0`), so if the band were WIDER than the handle, the top of its
 *  title bar would sit inside the band AT REST and a sideways nudge past
 *  `DRAG_ACTIVATION_PX` (4) would arm maximize outright. While the two match, a
 *  pointer-down in that strip hits the resize handle and starts a resize, not a
 *  drag, so no drag can BEGIN with the trigger already true.
 *
 *  KNOWN GAP, deliberately not gated here. That protects the start of the gesture
 *  only. Nothing gates the trigger DURING one: for a window at `y: 0`, a title bar
 *  grabbed at `y ~ 20` needs just ~14px of upward drift to arm maximize mid-drag,
 *  where the retired container-edge model demanded a full `DOCK_PAST_BOUNDARY_PX`
 *  (40) of travel and had a unit test pinning it ("does NOT maximize a full-height
 *  window dragged sideways"), deleted with this rewrite. Tightening it is a
 *  drag-FEEL decision, not a mechanical fix: any vertical-travel budget laid over
 *  the top edge trades directly against the maximize reachability that
 *  `tests/ui/window-drag-free-move.spec.ts` pins, which is the whole reason the
 *  pointer model replaced the container-edge one. Decide the two together. */
export const SCREEN_DOCK_EDGE_PX = 6;

interface OverlaySize {
  width: number;
  height: number;
}

/**
 * The armed screen dock, or null.
 *
 * @param pointerX pointer position relative to the overlay's left edge
 * @param pointerY pointer position relative to the overlay's top edge; NEGATIVE
 *                 while the pointer is above the overlay (over the app toolbar),
 *                 which still counts as the top edge
 * @param overlay  the overlay's size
 */
export function detectScreenDockEdge(pointerX: number, pointerY: number, overlay: OverlaySize): SnapEdge | null {
  // PRECEDENCE AT A CORNER, in this order: top, then the sides, then bottom. The
  // pointer can satisfy two edges at once, so this is a property of this function
  // rather than something to inherit - an upward drag into a corner maximizes, and
  // a downward one into a corner takes the side half (the commoner intent) over
  // the bottom half. Pinned by unit tests.
  if (pointerY <= SCREEN_DOCK_EDGE_PX) return 'maximize';
  if (pointerX <= SCREEN_DOCK_EDGE_PX) return 'left';
  if (pointerX >= overlay.width - SCREEN_DOCK_EDGE_PX) return 'right';
  if (pointerY >= overlay.height - SCREEN_DOCK_EDGE_PX) return 'bottom';
  return null;
}

/** The fractional geometry a given snap edge resolves to. */
export function snapEdgeToGeometry(edge: SnapEdge): FractionalRect {
  switch (edge) {
    case 'left':
      return { x: 0, y: 0, w: 0.5, h: 1 };
    case 'right':
      return { x: 0.5, y: 0, w: 0.5, h: 1 };
    case 'bottom':
      return { x: 0, y: 0.5, w: 1, h: 0.5 };
    case 'maximize':
      return { x: 0, y: 0, w: 1, h: 1 };
  }
}
