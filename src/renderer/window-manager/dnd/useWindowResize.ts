/**
 * 8-handle window resize. Raw pointer-capture, same no-re-render principle as
 * the drag: mutate the frame's box (left/top/width/height) directly via a ref
 * during the gesture (no store write, no React render, no xterm reflow), and
 * commit the geometry ONCE on release. The committed size change re-renders the
 * frame, which triggers the coalesced terminal resize + post-settle clean replay
 * (WindowFrame's size effect). The terminal letterboxes during the live drag and
 * fits on release, mirroring the move drag.
 *
 * Capture is taken on the FRAME (not the small handle) and the move/up handlers
 * live on the frame too, so pointermove is reliably delivered even when the
 * cursor leaves the thin handle. A handle only starts the gesture (pointerdown);
 * WindowFrame wires the frame's move/up to call back here.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { clamp, pixelsToFractional } from '../store/geometry';
import type { PixelRect } from '../store/geometry';
import { useWindowManager } from '../context';
import { beginManagerResize, endManagerResize } from '../terminal/manager-resize-gate';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

// Default floor for a MANUALLY resized window: the comfortable minimum where the
// task-detail header shows a typical full title plus the trailing controls
// (overflow / expand / close), with the quick-access pills folded into the
// overflow. Set from a user-picked reference width (Task #1 at ~633px). Tiling
// presets may still drive a pane narrower than this on a small screen - the header
// degrades gracefully there (title truncates toward its smaller CSS min). Each
// layer passes its own floor through `layer.minSize` (see `WindowManagerLayer`);
// these are the shared defaults both layers use today.
export const DEFAULT_MIN_WIDTH_PX = 650;
// Default floor for height: enough for the header + a usable slice of the task body
// / terminal below it, so a manually resized window never collapses to a sliver.
export const DEFAULT_MIN_HEIGHT_PX = 500;

interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ResizeSession {
  pointerId: number;
  direction: ResizeDirection;
  startClientX: number;
  startClientY: number;
  /** Last observed pointer position. The commit uses THIS, not the end event's
   *  coords, because a captured-pointer pointerup/pointercancel can arrive with
   *  (0,0) - which would compute a huge bogus delta and collapse the window. */
  lastClientX: number;
  lastClientY: number;
  startRect: PixelRect;
  overlay: OverlayBounds;
  /** Pointer capture is taken on the first move (deferred), not on pointerdown,
   *  so it is reliably honored (matches the drag). */
  captured: boolean;
}

interface UseWindowResizeArgs {
  windowId: string;
  frameRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
}

/** Resolve the new frame rect from the active handle and pointer delta, keeping
 *  the anchored (opposite) edge fixed and enforcing the minimum size. */
function resolveRect(
  resize: ResizeSession,
  deltaX: number,
  deltaY: number,
  minWidth: number,
  minHeight: number,
): PixelRect {
  const start = resize.startRect;
  const direction = resize.direction;
  let left = start.left;
  let top = start.top;
  let width = start.width;
  let height = start.height;

  if (direction.includes('e')) width = start.width + deltaX;
  if (direction.includes('s')) height = start.height + deltaY;
  if (direction.includes('w')) {
    width = start.width - deltaX;
    left = start.left + deltaX;
  }
  if (direction.includes('n')) {
    height = start.height - deltaY;
    top = start.top + deltaY;
  }

  if (width < minWidth) {
    if (direction.includes('w')) left = start.left + (start.width - minWidth);
    width = minWidth;
  }
  if (height < minHeight) {
    if (direction.includes('n')) top = start.top + (start.height - minHeight);
    height = minHeight;
  }
  return { left, top, width, height };
}

export function useWindowResize({ windowId, frameRef, overlayRef }: UseWindowResizeArgs) {
  const { manager, layer } = useWindowManager();
  const store = manager.store;
  const minWidth = layer.minSize.width;
  const minHeight = layer.minSize.height;
  const resizeRef = useRef<ResizeSession | null>(null);

  // Balance the manager-resize gate if the frame unmounts mid-drag (the window or
  // its overlay is torn down while a pointer is held - e.g. a keyboard shortcut
  // closes the window). React removes the move/up handlers on unmount, so endResize's
  // endManagerResize() would never fire; without this the module-level gate stays
  // open and suppresses refits in terminals on OTHER layers until a reload. Gated on
  // `captured`, the same condition that opened the gate.
  useEffect(() => () => {
    if (resizeRef.current?.captured) endManagerResize();
  }, []);

  const handlePointerDown = (direction: ResizeDirection) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const frame = frameRef.current;
    const overlay = overlayRef.current;
    if (!frame || !overlay) return;
    // Suppress the browser's default press behavior + text selection for the whole
    // gesture. Without this, dragging the cursor inward over selectable content (the
    // terminal text) starts a selection, which Chromium resolves by firing a
    // spurious `pointercancel` (zeroed coords) that ends the resize mid-drag - so it
    // "moves a few px then stops". Restored in endResize.
    event.preventDefault();
    document.body.style.userSelect = 'none';
    const frameRect = frame.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    resizeRef.current = {
      pointerId: event.pointerId,
      direction,
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
      captured: false,
    };
    // NOTE: capture is deferred to the first move (handlePointerMove), where it
    // is reliably honored; capturing on pointerdown is dropped by synthetic
    // pointers and some real fast grabs.
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const resize = resizeRef.current;
    const frame = frameRef.current;
    if (!resize || !frame || event.pointerId !== resize.pointerId) return;
    if (!resize.captured) {
      // Capture on the FRAME so pointermove is delivered even off the thin
      // handle and outside the frame (resize-to-grow). Defensive: a failed
      // capture must not abort the resize.
      try {
        frame.setPointerCapture(event.pointerId);
      } catch {
        // ignore: capture not available for this pointer
      }
      resize.captured = true;
      // Open the manager-resize gate now that a real drag has started (gated on
      // `captured`, so a no-move click never opens it). Window terminals suppress
      // their per-frame refit until endResize closes the gate, so the PTY resizes
      // once on commit instead of once per drag frame. Closed in endResize.
      beginManagerResize();
    }
    // Remember the last good pointer position; the commit reads it instead of the
    // pointerup/cancel coords (which can be a bogus (0,0) on a captured release).
    resize.lastClientX = event.clientX;
    resize.lastClientY = event.clientY;
    const rect = resolveRect(resize, event.clientX - resize.startClientX, event.clientY - resize.startClientY, minWidth, minHeight);
    frame.style.left = `${rect.left}px`;
    frame.style.top = `${rect.top}px`;
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${rect.height}px`;
  };

  const endResize = (event: React.PointerEvent) => {
    const resize = resizeRef.current;
    const frame = frameRef.current;
    resizeRef.current = null;
    // Always restore text selection, even on the guard return below.
    document.body.style.userSelect = '';
    // Close the gate this gesture opened. Gated on `captured` (the same condition
    // that opened it) and independent of the frame/pointerId guards below, so a
    // captured drag always closes its gate and never leaves it stuck open.
    if (resize?.captured) endManagerResize();
    if (!resize || !frame || event.pointerId !== resize.pointerId) return;
    if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    // Commit from the LAST tracked move position, never the end event's coords: a
    // captured-pointer pointerup/cancel can report (0,0), and that bogus delta is
    // what collapsed the window to its minimum on release.
    const rect = resolveRect(resize, resize.lastClientX - resize.startClientX, resize.lastClientY - resize.startClientY, minWidth, minHeight);
    // Clamp into the overlay on commit (the live drag was free).
    const width = clamp(rect.width, minWidth, resize.overlay.width);
    const height = clamp(rect.height, minHeight, resize.overlay.height);
    const left = clamp(rect.left, 0, resize.overlay.width - width);
    const top = clamp(rect.top, 0, resize.overlay.height - height);
    store.getState().setGeometry(
      windowId,
      pixelsToFractional({ left, top, width, height }, { width: resize.overlay.width, height: resize.overlay.height }),
    );
  };

  return { handlePointerDown, handlePointerMove, handlePointerUp: endResize, handlePointerCancel: endResize };
}
