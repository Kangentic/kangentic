/**
 * Imperative controller for the single snap-preview rectangle. Mirrors the
 * board's `updateDropHighlight` pattern (useBoardDragDrop): the preview is
 * driven by direct DOM mutation during a drag, with NO React re-render, so a
 * 60fps drag never re-renders the window tree or reflows a live xterm.
 *
 * `SnapPreview.tsx` registers its element on mount; `useWindowDrag` calls
 * show/hide from inside the pointermove loop.
 */

import type { PixelRect } from '../store/geometry';

// hmr-safe: re-registered by SnapPreview on mount; a null reset across HMR is
// harmless (the next mount re-registers before any drag can use it).
let previewElement: HTMLDivElement | null = null;

export function registerSnapPreviewElement(element: HTMLDivElement | null): void {
  previewElement = element;
}

export function showSnapPreview(rect: PixelRect): void {
  const element = previewElement;
  if (!element) return;
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  element.style.display = 'block';
}

export function hideSnapPreview(): void {
  const element = previewElement;
  if (!element) return;
  element.style.display = 'none';
}
