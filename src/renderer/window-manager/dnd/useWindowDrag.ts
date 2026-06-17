/**
 * Title-bar drag for a single window. Raw pointer-capture, NOT @dnd-kit.
 *
 * The crux: never reparent or re-render the live xterm during a drag. We move
 * the frame by writing `transform: translate3d(...)` directly via a ref on every
 * pointermove (GPU compositor, no React, no terminal reflow), run live edge-snap
 * detection against the overlay, and commit the new fractional geometry to the
 * store exactly ONCE on drop. A single `terminal-panel-resize` event then refits
 * the terminal. This mirrors the board's no-re-render `updateDropHighlight`.
 *
 * Feel:
 *  - Pointer capture is deferred until the drag actually activates, so a
 *    stationary double-click on the title bar still fires (maximize/restore).
 *  - The window follows the pointer FREELY during the drag (it may go fully
 *    off-screen), then HARD-snaps back inside the frame on release. Snap reads
 *    the container's own edges, so going off-screen still arms the dock.
 *  - Dragging a maximized window un-maximizes it under the cursor (Windows-style).
 *  - If focus leaves Kangentic mid-drag (alt-tab, screenshot, popup) the drag is
 *    finished at the last position rather than staying glued to the cursor.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { pixelsToFractional } from '../store/geometry';
import type { PixelRect } from '../store/geometry';
import { detectSnapEdge, snapEdgeToGeometry } from './snap';
import { hideSnapPreview, showSnapPreview } from './snap-preview-controller';
import { collectCandidatePanes, detectDropTarget, detectTiledDropTarget } from './drop-zone';
import type { CandidatePane, DropTarget, TreeBounds } from './drop-zone';
import { resolveTileLayout } from '../tiling/resolve-layout';
import { insertWindowIntoTree, treeContainsWindow } from '../tiling/tree-ops';
import { useWindowStore } from '../store/window-store';
import type { SnapEdge } from '../store/types';

/** Pointer travel (px) before a press becomes a drag, so a plain click/double
 *  click that only raises or maximizes the window does not nudge its geometry. */
const DRAG_ACTIVATION_PX = 4;

/** When the cursor is within this many px of the overlay's left/right edge it is
 *  treated as "shoved against the screen edge" - the user has run out of monitor
 *  room to drag the window's reference further, so that edge's dock is armed
 *  directly (Aero-Snap feel). The overlay spans the full window width, so its edge
 *  is the monitor edge when maximized. */
const EDGE_PIN_PX = 6;

/** Cached overlay geometry (client coords + size). The overlay does not resize
 *  mid-drag, so caching it at pointerdown means zero layout reads per move. */
interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  /** Last observed pointer position (client coords), so the drag can be
   *  finished without a fresh event (focus-loss interruption). */
  lastClientX: number;
  lastClientY: number;
  /** Frame rect relative to the overlay's top-left at drag start. */
  startRect: PixelRect;
  /** The pruned tile tree's pixel footprint + root split axis, snapshotted at
   *  activation (after un-dock removes the dragged window). Drives the outer-slot
   *  edge zones. Both null when there is no multi-pane tree to dock into. */
  treeBounds: TreeBounds | null;
  rootDirection: 'horizontal' | 'vertical' | null;
  overlay: OverlayBounds;
  activated: boolean;
  snapEdge: SnapEdge | null;
  /** Drag-to-dock target under the cursor (3b), or null. Takes precedence over
   *  `snapEdge` when armed (the cursor is over a pane, not flung to a screen edge). */
  dropTarget: DropTarget | null;
  /** Dockable panes (others' rects), snapshotted once on activation. No store
   *  writes happen during a drag, so these rects stay valid for the whole gesture. */
  candidatePanes: CandidatePane[];
}

interface UseWindowDragArgs {
  windowId: string;
  frameRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Hard-clamp a proposed top-left so the whole frame stays inside the overlay
 *  (used on release; the drag itself is unclamped). */
function clampToOverlay(left: number, top: number, drag: DragSession): { left: number; top: number } {
  const maxLeft = Math.max(0, drag.overlay.width - drag.startRect.width);
  const maxTop = Math.max(0, drag.overlay.height - drag.startRect.height);
  return { left: clamp(left, 0, maxLeft), top: clamp(top, 0, maxTop) };
}

export function useWindowDrag({ windowId, frameRef, overlayRef }: UseWindowDragArgs) {
  const dragRef = useRef<DragSession | null>(null);

  /** Finish the active drag using the last observed pointer position. Used by
   *  pointerup, pointercancel/lostpointercapture, and focus-loss interruptions. */
  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    dragRef.current = null;
    hideSnapPreview();
    if (!drag || !frame) return;
    if (frame.hasPointerCapture(drag.pointerId)) frame.releasePointerCapture(drag.pointerId);
    // Clear the imperative transform; the committed geometry re-renders the
    // frame at its final position.
    frame.style.transform = '';
    if (!drag.activated) return; // a click / double-click, not a drag

    const container = { width: drag.overlay.width, height: drag.overlay.height };
    const store = useWindowStore.getState();

    if (drag.dropTarget) {
      // Drag-to-dock: tile this window onto a side of the pane under the cursor
      // (insert into the tree if that pane is tiled, else seed a fresh pair).
      store.dockIntoWindow(windowId, drag.dropTarget.targetWindowId, drag.dropTarget.side);
    } else if (drag.snapEdge === 'maximize') {
      store.maximizeWindow(windowId);
    } else if (drag.snapEdge === 'left' || drag.snapEdge === 'right') {
      // Half-dock. dockWindow joins an opposite-half snapped window into a tile
      // pair (shared seam) if one exists, else a lone snap that remembers the
      // pre-snap size so dragging away restores it.
      store.dockWindow(windowId, drag.snapEdge);
    } else {
      // HARD clamp: snap the window fully back inside the frame.
      const clamped = clampToOverlay(
        drag.startRect.left + (drag.lastClientX - drag.startClientX),
        drag.startRect.top + (drag.lastClientY - drag.startClientY),
        drag,
      );
      store.setGeometry(
        windowId,
        pixelsToFractional(
          { left: clamped.left, top: clamped.top, width: drag.startRect.width, height: drag.startRect.height },
          container,
        ),
      );
    }
    // A size change (snap/maximize) re-renders the frame; WindowFrame's size
    // effect schedules the single coalesced terminal resize. A pure move does
    // not change size, so no resize is needed.
  }, [windowId, frameRef]);

  // End the drag if focus leaves Kangentic (alt-tab, screenshot, popup) or the
  // tab is hidden, so the window is dropped where it was rather than staying
  // glued to the cursor when the user returns.
  useEffect(() => {
    const onInterrupt = () => {
      if (dragRef.current) finishDrag();
    };
    const onVisibility = () => {
      if (document.hidden && dragRef.current) finishDrag();
    };
    window.addEventListener('blur', onInterrupt);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onInterrupt);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [finishDrag]);

  const titleBarPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const frame = frameRef.current;
    const overlay = overlayRef.current;
    if (!frame || !overlay) return;
    const frameRect = frame.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      startRect: {
        left: frameRect.left - overlayRect.left,
        top: frameRect.top - overlayRect.top,
        width: frameRect.width,
        height: frameRect.height,
      },
      treeBounds: null,
      rootDirection: null,
      overlay: { left: overlayRect.left, top: overlayRect.top, width: overlayRect.width, height: overlayRect.height },
      activated: false,
      snapEdge: null,
      dropTarget: null,
      candidatePanes: [],
    };
    // NOTE: do NOT setPointerCapture here. Capturing on pointerdown suppresses
    // the native dblclick used for maximize/restore. Capture on activation.
  };

  /** When a maximized, half-snapped, OR tiled window starts dragging, restore it
   *  to its pre-dock size under the cursor and re-anchor the drag to the restored
   *  rect (Windows-style un-dock). A tiled window is pulled out of its group
   *  first (its partner floats in place). */
  const undockUnderCursor = (drag: DragSession, event: React.PointerEvent) => {
    const managedWindow = useWindowStore.getState().windows[windowId];
    if (
      !managedWindow ||
      (managedWindow.state !== 'maximized' && managedWindow.state !== 'snapped' && managedWindow.state !== 'tiled')
    ) {
      return;
    }
    const restore = managedWindow.restoreGeometry ?? { x: 0.2, y: 0.15, w: 0.5, h: 0.6 };
    if (managedWindow.state === 'tiled') useWindowStore.getState().untileWindow(windowId);
    const width = restore.w * drag.overlay.width;
    const height = restore.h * drag.overlay.height;
    // Shrink the window AROUND the grab point so it does not jump to re-center
    // under the cursor (the jarring ~50px hop). Keep the cursor at the spot it
    // grabbed: the same FRACTION across the title bar horizontally, and the same
    // PIXEL offset down it vertically (the title bar is a fixed-height strip, so a
    // fraction would drift off it when the restore size differs from the pane).
    // Vertically this leaves the window's top ~where it was; horizontally it
    // contracts toward the grab. (Windows un-maximize feel.)
    const pointerOverlayX = event.clientX - drag.overlay.left;
    const pointerOverlayY = event.clientY - drag.overlay.top;
    const grabFractionX =
      drag.startRect.width > 0 ? clamp((pointerOverlayX - drag.startRect.left) / drag.startRect.width, 0, 1) : 0.5;
    const grabOffsetY = clamp(pointerOverlayY - drag.startRect.top, 0, height);
    const left = clamp(pointerOverlayX - grabFractionX * width, 0, Math.max(0, drag.overlay.width - width));
    const top = clamp(pointerOverlayY - grabOffsetY, 0, Math.max(0, drag.overlay.height - height));
    useWindowStore.getState().setGeometry(
      windowId,
      pixelsToFractional({ left, top, width, height }, { width: drag.overlay.width, height: drag.overlay.height }),
    );
    // Re-anchor: subsequent transform deltas are relative to the restored rect
    // and the current pointer position.
    drag.startRect = { left, top, width, height };
    drag.startClientX = event.clientX;
    drag.startClientY = event.clientY;
  };

  /** Where the dragged window would actually land for `dropTarget`. When the
   *  target is a tiled pane, simulate the insert against the live tree and
   *  resolve the new leaf's rect (an equal sibling slot for a same-axis dock, or
   *  half the cell for a perpendicular one). Falls back to the detector's
   *  half-of-pane rect for the seed/merge cases (a fresh 2-up, where half is
   *  exact). */
  const previewLandingRect = (dropTarget: DropTarget, overlay: OverlayBounds): PixelRect => {
    const store = useWindowStore.getState();
    const tree = store.tileTree;
    if (tree && treeContainsWindow(tree, dropTarget.targetWindowId)) {
      const footprint = store.tileTreeRect;
      const previewTree = insertWindowIntoTree(
        tree,
        dropTarget.targetWindowId,
        windowId,
        '__preview_leaf__',
        '__preview_split__',
        dropTarget.side,
      );
      const layout = resolveTileLayout(
        previewTree,
        { width: footprint.w * overlay.width, height: footprint.h * overlay.height },
        0,
        0,
        { left: footprint.x * overlay.width, top: footprint.y * overlay.height },
      );
      const landed = layout.rects.get(windowId);
      if (landed) return landed;
    }
    return dropTarget.previewRect;
  };

  const framePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame || event.pointerId !== drag.pointerId) return;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;

    if (!drag.activated) {
      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;
      if (Math.abs(deltaX) < DRAG_ACTIVATION_PX && Math.abs(deltaY) < DRAG_ACTIVATION_PX) return;
      drag.activated = true;
      undockUnderCursor(drag, event);
      // Capture only now, so a stationary double-click is never intercepted.
      frame.setPointerCapture(drag.pointerId);
      // Snapshot the dockable panes ONCE, AFTER any undock (which may have pruned
      // the tree). No store writes happen during the drag, so these rects stay
      // valid for the whole gesture (the dragged window moves only via transform).
      const store = useWindowStore.getState();
      drag.candidatePanes = collectCandidatePanes(
        windowId,
        store.windows,
        store.tileTree,
        { width: drag.overlay.width, height: drag.overlay.height },
        store.tileTreeRect,
      );
      // Snapshot the pruned tree's footprint + root axis for the outer-slot edge
      // zones (only a multi-pane split root has extremes to push into).
      const tree = store.tileTree;
      drag.rootDirection = tree && tree.kind === 'split' ? tree.direction : null;
      drag.treeBounds = tree
        ? {
            left: store.tileTreeRect.x * drag.overlay.width,
            top: store.tileTreeRect.y * drag.overlay.height,
            right: (store.tileTreeRect.x + store.tileTreeRect.w) * drag.overlay.width,
            bottom: (store.tileTreeRect.y + store.tileTreeRect.h) * drag.overlay.height,
          }
        : null;
    }

    // Unclamped: the window follows the pointer freely (it hard-snaps back
    // inside on release). GPU transform: no store write, no render, no reflow.
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    frame.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;

    // Cursor shoved against the overlay's left/right edge: the user has run out of
    // monitor room to drag the window's reference further (the maximized edge case).
    // Arm that edge's half-snap directly, taking precedence over the body-center
    // tiling - which a wide window cannot push to the side third when the cursor is
    // bounded by the screen. The cursor always reaches the screen edge regardless of
    // window size or grab, so this is the reliable way to dock left/right there.
    const pointerOverlayX = event.clientX - drag.overlay.left;
    const pinnedEdge: SnapEdge | null =
      pointerOverlayX <= EDGE_PIN_PX ? 'left' : pointerOverlayX >= drag.overlay.width - EDGE_PIN_PX ? 'right' : null;

    // Drag-to-dock (3b) takes precedence over the screen-edge fling (unless the
    // cursor is pinned at an edge, above). Two-signal targeting (drop-zone.ts), all
    // keyed off the window itself so it is grab-INDEPENDENT - where on the header you
    // grabbed never changes the result:
    //  - INTERIOR slots use the window's BODY CENTER, so the trigger fires when the
    //    body looks centered over the gap (matches what the user sees).
    //  - The tree's OUTER slots (a stack's very top/bottom, a row's far left/right)
    //    are armed when the window's LEADING EDGE reaches the tree boundary, since
    //    the body center alone cannot reach them (the window is bigger than a pane).
    // With no tree (floating candidates) the body center is enough on its own.
    const draggedRect = {
      left: drag.startRect.left + deltaX,
      top: drag.startRect.top + deltaY,
      width: drag.startRect.width,
      height: drag.startRect.height,
    };
    const dropTarget = pinnedEdge
      ? null
      : drag.treeBounds && drag.rootDirection
        ? detectTiledDropTarget(draggedRect, drag.candidatePanes, drag.rootDirection, drag.treeBounds)
        : detectDropTarget(
            draggedRect.left + draggedRect.width / 2,
            draggedRect.top + draggedRect.height / 2,
            drag.candidatePanes,
          );
    if (dropTarget) {
      drag.dropTarget = dropTarget;
      drag.snapEdge = null;
      // Preview the ACTUAL landing rect, not a generic half of the target pane.
      // Docking onto a tiled pane along its container's axis inserts a new EQUAL
      // sibling (e.g. a third row repartitions to thirds), so the new window's
      // real slot is not "half the target" - simulate the insert and show where
      // it actually lands.
      showSnapPreview(previewLandingRect(dropTarget, drag.overlay));
      return;
    }
    drag.dropTarget = null;

    // A cursor pinned at the edge wins outright; otherwise the screen-edge fling
    // keys off the CONTAINER'S own edge dragged past the boundary (not the pointer).
    const edge =
      pinnedEdge ??
      detectSnapEdge(
        {
          left: drag.startRect.left + deltaX,
          top: drag.startRect.top + deltaY,
          width: drag.startRect.width,
          height: drag.startRect.height,
        },
        { width: drag.overlay.width, height: drag.overlay.height },
      );
    drag.snapEdge = edge;
    if (edge) {
      const snap = snapEdgeToGeometry(edge);
      showSnapPreview({
        left: snap.x * drag.overlay.width,
        top: snap.y * drag.overlay.height,
        width: snap.w * drag.overlay.width,
        height: snap.h * drag.overlay.height,
      });
    } else {
      hideSnapPreview();
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag && event.pointerId === drag.pointerId) {
      drag.lastClientX = event.clientX;
      drag.lastClientY = event.clientY;
    }
    finishDrag();
  };

  return {
    titleBarPointerDown,
    framePointerMove,
    framePointerUp: endDrag,
    framePointerCancel: endDrag,
    framePointerLostCapture: finishDrag,
  };
}
