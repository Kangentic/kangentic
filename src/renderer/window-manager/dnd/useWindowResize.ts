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

import { useRef } from 'react';
import type { RefObject } from 'react';
import { pixelsToFractional } from '../store/geometry';
import type { PixelRect } from '../store/geometry';
import { useWindowStore } from '../store/window-store';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_WIDTH_PX = 320;
const MIN_HEIGHT_PX = 200;

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Resolve the new frame rect from the active handle and pointer delta, keeping
 *  the anchored (opposite) edge fixed and enforcing the minimum size. */
function resolveRect(resize: ResizeSession, deltaX: number, deltaY: number): PixelRect {
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

  if (width < MIN_WIDTH_PX) {
    if (direction.includes('w')) left = start.left + (start.width - MIN_WIDTH_PX);
    width = MIN_WIDTH_PX;
  }
  if (height < MIN_HEIGHT_PX) {
    if (direction.includes('n')) top = start.top + (start.height - MIN_HEIGHT_PX);
    height = MIN_HEIGHT_PX;
  }
  return { left, top, width, height };
}

export function useWindowResize({ windowId, frameRef, overlayRef }: UseWindowResizeArgs) {
  const resizeRef = useRef<ResizeSession | null>(null);

  const handlePointerDown = (direction: ResizeDirection) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const frame = frameRef.current;
    const overlay = overlayRef.current;
    if (!frame || !overlay) return;
    const frameRect = frame.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    resizeRef.current = {
      pointerId: event.pointerId,
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
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
    }
    const rect = resolveRect(resize, event.clientX - resize.startClientX, event.clientY - resize.startClientY);
    frame.style.left = `${rect.left}px`;
    frame.style.top = `${rect.top}px`;
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${rect.height}px`;
  };

  const endResize = (event: React.PointerEvent) => {
    const resize = resizeRef.current;
    const frame = frameRef.current;
    resizeRef.current = null;
    if (!resize || !frame || event.pointerId !== resize.pointerId) return;
    if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    const rect = resolveRect(resize, event.clientX - resize.startClientX, event.clientY - resize.startClientY);
    // Clamp into the overlay on commit (the live drag was free).
    const width = clamp(rect.width, MIN_WIDTH_PX, resize.overlay.width);
    const height = clamp(rect.height, MIN_HEIGHT_PX, resize.overlay.height);
    const left = clamp(rect.left, 0, resize.overlay.width - width);
    const top = clamp(rect.top, 0, resize.overlay.height - height);
    useWindowStore.getState().setGeometry(
      windowId,
      pixelsToFractional({ left, top, width, height }, { width: resize.overlay.width, height: resize.overlay.height }),
    );
  };

  return { handlePointerDown, handlePointerMove, handlePointerUp: endResize, handlePointerCancel: endResize };
}
