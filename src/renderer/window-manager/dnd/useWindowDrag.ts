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
 *    off-screen), then HARD-snaps back inside the frame on release.
 *  - EVERY dock reads the POINTER, so there is one rule to learn: wherever the
 *    cursor is decides what happens. A SCREEN dock (half / maximize) arms on the
 *    cursor reaching an overlay edge; a WINDOW dock arms on the pane under the
 *    cursor. They differ only in commitment - a screen dock's trigger cannot be
 *    true at rest, a window dock's can, so only the latter is gated by a travel
 *    budget. Layering that budget over both made maximize unreachable for a window
 *    already near the top; see `snap.ts`.
 *  - Dragging a maximized window un-maximizes it under the cursor (Windows-style).
 *  - If focus leaves Kangentic mid-drag (alt-tab, screenshot, popup) the drag is
 *    finished at the last position rather than staying glued to the cursor.
 *  - Escape abandons the drag: the window returns to where the gesture started and
 *    nothing docks. This is also the always-available way to decline a dock.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { clamp, pixelsToFractional } from '../store/geometry';
import type { PixelRect } from '../store/geometry';
import { detectScreenDockEdge, snapEdgeToGeometry } from './snap';
import { collectCandidatePanes, resolveDockTarget } from './drop-zone';
import type { CandidatePane, DropTarget } from './drop-zone';
import { resolveTileLayout } from '../tiling/resolve-layout';
import { insertWindowIntoTree, treeContainsWindow } from '../tiling/tree-ops';
import { useWindowManager } from '../context';
import type { SnapEdge, FractionalRect } from '../store/types';

/** Pointer travel (px) before a press becomes a drag, so a plain click/double
 *  click that only raises or maximizes the window does not nudge its geometry. */
const DRAG_ACTIVATION_PX = 4;

/** A tiled group whose footprint covers (within this fraction of) the whole
 *  overlay has nowhere to move, so dragging a pane pops it OUT instead of moving
 *  the group. */
const FOOTPRINT_FILL_TOLERANCE = 0.02;

function footprintFillsOverlay(rect: FractionalRect): boolean {
  return (
    rect.x <= FOOTPRINT_FILL_TOLERANCE &&
    rect.y <= FOOTPRINT_FILL_TOLERANCE &&
    rect.x + rect.w >= 1 - FOOTPRINT_FILL_TOLERANCE &&
    rect.y + rect.h >= 1 - FOOTPRINT_FILL_TOLERANCE
  );
}

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
  overlay: OverlayBounds;
  activated: boolean;
  snapEdge: SnapEdge | null;
  /** Drag-to-dock target under the cursor, or null. Mutually exclusive with
   *  `snapEdge` by construction: `framePointerMove` tests the SCREEN dock first
   *  and returns early when it arms, so a screen dock wins outright and only one
   *  of the two is ever set. `finishDrag` reads `dropTarget` first, which is
   *  correct only while that exclusivity holds - nothing else pins it. */
  dropTarget: DropTarget | null;
  /** Dockable panes (others' rects), snapshotted once on activation. No store
   *  writes happen during a drag, so these rects stay valid for the whole gesture. */
  candidatePanes: CandidatePane[];
  /** Set when the dragged window is TILED: the header drags the whole docked group
   *  as a unit instead of popping the pane out. Null for a normal float/snap drag. */
  groupMove: GroupMoveSession | null;
}

/** A tiled-group move: every pane's frame element + the group's starting footprint,
 *  snapshotted at activation. The move translates all frames together; the commit
 *  writes the new footprint via setTileTreeRect. */
interface GroupMoveSession {
  frames: HTMLElement[];
  startRect: FractionalRect;
}

interface UseWindowDragArgs {
  windowId: string;
  frameRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
}

/** Clamp a group-move pixel delta so the group's footprint stays inside the overlay. */
function clampGroupDelta(
  startRect: FractionalRect,
  deltaX: number,
  deltaY: number,
  overlay: OverlayBounds,
): { dx: number; dy: number } {
  const minDx = -startRect.x * overlay.width;
  const maxDx = (1 - startRect.w - startRect.x) * overlay.width;
  const minDy = -startRect.y * overlay.height;
  const maxDy = (1 - startRect.h - startRect.y) * overlay.height;
  return { dx: clamp(deltaX, minDx, maxDx), dy: clamp(deltaY, minDy, maxDy) };
}

/** Hard-clamp a proposed top-left so the whole frame stays inside the overlay
 *  (used on release; the drag itself is unclamped). */
function clampToOverlay(left: number, top: number, drag: DragSession): { left: number; top: number } {
  const maxLeft = Math.max(0, drag.overlay.width - drag.startRect.width);
  const maxTop = Math.max(0, drag.overlay.height - drag.startRect.height);
  return { left: clamp(left, 0, maxLeft), top: clamp(top, 0, maxTop) };
}

export function useWindowDrag({ windowId, frameRef, overlayRef }: UseWindowDragArgs) {
  const { manager, snap, layer } = useWindowManager();
  const store = manager.store;
  const dragRef = useRef<DragSession | null>(null);

  /** Finish the active drag using the last observed pointer position. Used by
   *  pointerup, pointercancel/lostpointercapture, and focus-loss interruptions. */
  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    dragRef.current = null;
    snap.hide();
    if (!drag || !frame) return;
    if (frame.hasPointerCapture(drag.pointerId)) frame.releasePointerCapture(drag.pointerId);
    // Clear the imperative transform; the committed geometry re-renders the
    // frame at its final position.
    frame.style.transform = '';
    if (!drag.activated) return; // a click / double-click, not a drag

    // GROUP MOVE commit: clear every pane's transform and write the new footprint.
    // setTileTreeRect re-renders the panes at the new origin (position only, so no
    // terminal refit) and clampGeometry keeps the group in bounds.
    if (drag.groupMove) {
      for (const element of drag.groupMove.frames) element.style.transform = '';
      const moved = clampGroupDelta(
        drag.groupMove.startRect,
        drag.lastClientX - drag.startClientX,
        drag.lastClientY - drag.startClientY,
        drag.overlay,
      );
      store.getState().setTileTreeRect({
        x: drag.groupMove.startRect.x + moved.dx / drag.overlay.width,
        y: drag.groupMove.startRect.y + moved.dy / drag.overlay.height,
        w: drag.groupMove.startRect.w,
        h: drag.groupMove.startRect.h,
      });
      return;
    }

    const container = { width: drag.overlay.width, height: drag.overlay.height };
    const actions = store.getState();

    // After a dock, never leave a pane below the configured min-size: grow the
    // group's footprint so the narrowest pane clears the floor (capped at the
    // overlay). The min-width is the same `layer.minSize` the seam / footprint
    // resizers honour, so the engine never docks a window below it.
    const enforceMin = (): void =>
      store.getState().enforceMinPaneSize(layer.minSize.width, layer.minSize.height, drag.overlay.width, drag.overlay.height);

    if (drag.dropTarget) {
      // Drag-to-dock: tile this window onto a side of the pane under the cursor
      // (insert into the tree if that pane is tiled, else seed a fresh pair).
      actions.dockIntoWindow(windowId, drag.dropTarget.targetWindowId, drag.dropTarget.side);
      enforceMin();
    } else if (drag.snapEdge === 'maximize') {
      actions.maximizeWindow(windowId);
    } else if (drag.snapEdge === 'left' || drag.snapEdge === 'right') {
      // Half-dock. dockWindow joins an opposite-half snapped window into a tile
      // pair (shared seam) if one exists, else a lone snap that remembers the
      // pre-snap size so dragging away restores it.
      actions.dockWindow(windowId, drag.snapEdge);
      enforceMin();
    } else if (drag.snapEdge === 'bottom') {
      // A plain snap, not dockWindow: that only pairs opposite HORIZONTAL halves
      // into a tile group, so a bottom half has no partner to seam with.
      actions.snapWindow(windowId, snapEdgeToGeometry('bottom'));
    } else {
      // HARD clamp: snap the window fully back inside the frame.
      const clamped = clampToOverlay(
        drag.startRect.left + (drag.lastClientX - drag.startClientX),
        drag.startRect.top + (drag.lastClientY - drag.startClientY),
        drag,
      );
      actions.setGeometry(
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
  }, [windowId, frameRef, store, snap, layer.minSize.width, layer.minSize.height]);

  /** Abandon the active drag: drop every transform, commit NOTHING. The window
   *  lands back where the drag started, and no dock or snap is applied.
   *
   *  Nothing to undo on the store side, because a drag writes geometry exactly
   *  once, at drop - the movement itself is transform-only. The one exception is
   *  `undockUnderCursor`, which floats a maximized / snapped / tiled window at
   *  activation: cancelling after that returns the window to where the undock put
   *  it, not back into its group. Cancel undoes the MOVE, not the undock, and
   *  re-entering an arbitrary tile position is not reversible without snapshotting
   *  the whole tree.
   *
   *  Returns whether a drag was actually cancelled, so the key handler knows
   *  whether to swallow the keystroke. */
  const cancelDrag = useCallback((): boolean => {
    const drag = dragRef.current;
    if (!drag || !drag.activated) return false;
    dragRef.current = null;
    snap.hide();
    const frame = frameRef.current;
    if (frame) {
      if (frame.hasPointerCapture(drag.pointerId)) frame.releasePointerCapture(drag.pointerId);
      frame.style.transform = '';
    }
    for (const element of drag.groupMove?.frames ?? []) element.style.transform = '';
    return true;
  }, [frameRef, snap]);

  // Escape abandons an in-flight drag, the way it does in every other drag UI.
  //
  // Hand-written rather than `useKeybinding`, as the structural-Escape exception in
  // `.claude/rules/keybindings-registry.md` allows: same shape as BrowserPane's
  // Esc-cancels-Inspect, a transient in-gesture key that needs capture-phase
  // ordering and `stopImmediatePropagation`. Escape is already in the registry as
  // the non-rebindable `dialog.dismiss`; a second entry would only invent a
  // phantom conflict.
  //
  // CAPTURE phase, and it swallows the event: the focused window closes itself on
  // a BUBBLE-phase document Escape (`TaskDetailWindow`'s structural listener), so
  // without this a mid-drag Escape closed the user's task window instead of
  // cancelling the gesture. Capture on `window` runs strictly before any
  // document-bubble listener, so the ordering does not depend on which component
  // mounted first. Gated on an ACTIVATED drag, so a plain Escape - or one while a
  // press has not yet become a drag - still reaches the window and the terminal.
  //
  // hmr-note: a Fast Refresh mid-drag fires no pointerup, and `clearSnapPreviewDom`
  // (Pattern D, `window-manager/hmr.ts`) clears the DOM but cannot reach this
  // per-instance `dragRef`. So a stale activated drag can survive an update and
  // swallow ONE Escape without closing the window. It self-heals - `cancelDrag`
  // nulls the ref before returning, so the next Escape behaves normally. Dev-only.
  // Do NOT "fix" this with a module-scope registry of live drags: that trades a
  // one-keystroke quirk for new mutable module state that would itself owe Pattern A.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!cancelDrag()) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancelDrag]);

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
      overlay: { left: overlayRect.left, top: overlayRect.top, width: overlayRect.width, height: overlayRect.height },
      activated: false,
      snapEdge: null,
      dropTarget: null,
      candidatePanes: [],
      groupMove: null,
    };
    // NOTE: do NOT setPointerCapture here. Capturing on pointerdown suppresses
    // the native dblclick used for maximize/restore. Capture on activation.
  };

  /** When a maximized, half-snapped, OR tiled window starts dragging, restore it
   *  to its pre-dock size under the cursor and re-anchor the drag to the restored
   *  rect (Windows-style un-dock). A tiled window is pulled out of its group
   *  first (its partner floats in place). */
  const undockUnderCursor = (drag: DragSession, event: React.PointerEvent) => {
    const managedWindow = store.getState().windows[windowId];
    if (
      !managedWindow ||
      (managedWindow.state !== 'maximized' && managedWindow.state !== 'snapped' && managedWindow.state !== 'tiled')
    ) {
      return;
    }
    const restore = managedWindow.restoreGeometry ?? { x: 0.2, y: 0.15, w: 0.5, h: 0.6 };
    // Pull out of tiling whenever this window is in the tree, keyed off TREE
    // MEMBERSHIP rather than state==='tiled'. A window left in the tree while already
    // marked snapped/floating (a stale reference) must still be removed here, or the
    // upcoming drag-dock would insert a SECOND leaf for it - a phantom empty pane
    // that reads as an "invisible wall" blocking the group.
    const liveTree = store.getState().tileTree;
    if (liveTree && treeContainsWindow(liveTree, windowId)) store.getState().untileWindow(windowId);
    // Float back to the held/restore size, but never below the layer min-size (a
    // stale restore point saved before the min was raised must not pop out a
    // sub-min window), and never larger than the overlay.
    const width = clamp(restore.w * drag.overlay.width, Math.min(layer.minSize.width, drag.overlay.width), drag.overlay.width);
    const height = clamp(restore.h * drag.overlay.height, Math.min(layer.minSize.height, drag.overlay.height), drag.overlay.height);
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
    store.getState().setGeometry(
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
    const snapshot = store.getState();
    const tree = snapshot.tileTree;
    if (tree && treeContainsWindow(tree, dropTarget.targetWindowId)) {
      const footprint = snapshot.tileTreeRect;
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
      const activationStore = store.getState();
      // A tiled window's header drags the WHOLE docked group as a unit - UNLESS the
      // group fills the overlay (a full-screen tiling has nowhere to move), where
      // dragging a pane instead POPS IT OUT (undock below), the only useful drag
      // there. Detaching a pane is otherwise the pop-out button / close.
      if (
        activationStore.windows[windowId]?.state === 'tiled' &&
        !footprintFillsOverlay(activationStore.tileTreeRect)
      ) {
        // GROUP MOVE: snapshot every tiled pane's frame + the group's footprint;
        // the move body translates them all together. No undock, no snap/dock.
        drag.groupMove = {
          frames: Object.values(activationStore.windows)
            .filter((candidate) => candidate.state === 'tiled')
            .map((candidate) => document.querySelector<HTMLElement>(`[data-testid="window-frame-${candidate.id}"]`))
            .filter((element): element is HTMLElement => element !== null),
          startRect: activationStore.tileTreeRect,
        };
        // Capture only now, so a stationary double-click is never intercepted.
        frame.setPointerCapture(drag.pointerId);
      } else {
        undockUnderCursor(drag, event);
        // Capture only now, so a stationary double-click is never intercepted.
        frame.setPointerCapture(drag.pointerId);
        // Snapshot the dockable panes ONCE, AFTER any undock (which may have pruned
        // the tree). No store writes happen during the drag, so these rects stay
        // valid for the whole gesture (the dragged window moves only via transform).
        const snapshot = store.getState();
        drag.candidatePanes = collectCandidatePanes(
          windowId,
          snapshot.windows,
          snapshot.tileTree,
          { width: drag.overlay.width, height: drag.overlay.height },
          snapshot.tileTreeRect,
        );
      }
    }

    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;

    // GROUP MOVE: translate every pane in the docked group together (clamped so the
    // footprint stays on-screen). No snap/dock - the group just repositions.
    if (drag.groupMove) {
      const moved = clampGroupDelta(drag.groupMove.startRect, deltaX, deltaY, drag.overlay);
      const groupTransform = `translate3d(${moved.dx}px, ${moved.dy}px, 0)`;
      for (const element of drag.groupMove.frames) element.style.transform = groupTransform;
      return;
    }

    // Unclamped: the window follows the pointer freely (it hard-snaps back inside
    // on release). GPU transform: no store write, no render, no reflow.
    frame.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;

    // EVERY dock reads the POINTER, so the whole gesture has one input: wherever
    // the cursor is decides what happens. Two families, differing only in the
    // commitment each trigger can carry on its own.
    const pointerX = event.clientX - drag.overlay.left;
    const pointerY = event.clientY - drag.overlay.top;

    // 1. SCREEN DOCK - the pointer buried in an overlay edge. Self-committing (you
    //    do not run the cursor into the screen edge by accident) and always
    //    reachable from any window position, so it takes no free-move budget and
    //    wins outright when armed. See `snap.ts`.
    const screenEdge = detectScreenDockEdge(pointerX, pointerY, {
      width: drag.overlay.width,
      height: drag.overlay.height,
    });
    if (screenEdge) {
      drag.dropTarget = null;
      drag.snapEdge = screenEdge;
      const snapGeometry = snapEdgeToGeometry(screenEdge);
      snap.show({
        left: snapGeometry.x * drag.overlay.width,
        top: snapGeometry.y * drag.overlay.height,
        width: snapGeometry.w * drag.overlay.width,
        height: snapGeometry.h * drag.overlay.height,
      });
      return;
    }
    drag.snapEdge = null;

    // 2. WINDOW DOCK - tile onto the pane under the cursor, on the side its
    //    priority bands resolve. Unlike a screen dock this CAN already be true at
    //    pointer-down (grab a header that sits over another window), so position
    //    alone carries no intent and this family, only, is gated by the free-move
    //    budget in `resolveDockTarget`.
    const dropTarget = resolveDockTarget({
      pointerX,
      pointerY,
      candidates: drag.candidatePanes,
      deltaX,
      deltaY,
    });
    drag.dropTarget = dropTarget;
    if (!dropTarget) {
      snap.hide();
      return;
    }
    // Preview the ACTUAL landing rect, not a generic half of the target pane.
    // Docking onto a tiled pane along its container's axis inserts a new EQUAL
    // sibling (e.g. a third row repartitions to thirds), so the new window's real
    // slot is not "half the target" - simulate the insert and show where it lands.
    snap.show(previewLandingRect(dropTarget, drag.overlay));
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
