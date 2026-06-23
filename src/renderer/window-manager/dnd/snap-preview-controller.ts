/**
 * Imperative controller for a layer's single snap-preview rectangle. Mirrors the
 * board's `updateDropHighlight` pattern (useBoardDragDrop): the preview is driven
 * by direct DOM mutation during a drag, with NO React re-render, so a 60fps drag
 * never re-renders the window tree or reflows a live xterm.
 *
 * One controller per window-manager instance (created by `WindowManagerLayer`,
 * shared through context): each layer has its own preview element, so a board drag
 * never paints into the command-terminal overlay (or vice versa). `SnapPreview.tsx`
 * registers its element on mount; `useWindowDrag` calls show/hide from inside the
 * pointermove loop, reading the controller from context.
 */

import type { PixelRect } from '../store/geometry';

export interface SnapPreviewController {
  /** SnapPreview registers (or clears, on unmount) its DOM element here. */
  register: (element: HTMLDivElement | null) => void;
  /** Position + show the preview rectangle (drag pointermove). */
  show: (rect: PixelRect) => void;
  /** Hide the preview rectangle (no armed zone, or drop). */
  hide: () => void;
}

/** Build a fresh, isolated snap-preview controller for one layer. */
export function createSnapPreviewController(): SnapPreviewController {
  let previewElement: HTMLDivElement | null = null;
  return {
    register: (element) => {
      previewElement = element;
    },
    show: (rect) => {
      const element = previewElement;
      if (!element) return;
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.display = 'block';
    },
    hide: () => {
      const element = previewElement;
      if (!element) return;
      element.style.display = 'none';
    },
  };
}
