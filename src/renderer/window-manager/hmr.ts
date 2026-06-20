/**
 * HMR Pattern D cleanup for the window engine. A Vite Fast Refresh mid-drag
 * fires no pointerup, so the snap preview can be left visible, a frame left
 * with a stale `transform`, and the body left with the resize-time
 * `userSelect: none` suppression. `App.tsx`'s `vite:afterUpdate` calls this
 * beside the existing `.drop-highlight` clear.
 */

import { hideSnapPreview } from './dnd/snap-preview-controller';

export function clearSnapPreviewDom(): void {
  hideSnapPreview();
  document.querySelectorAll<HTMLElement>('[data-testid^="window-frame-"]').forEach((frame) => {
    frame.style.transform = '';
  });
  // A mid-resize Fast Refresh never fires pointerup, so `endResize` never runs
  // and the body keeps `userSelect: none`, freezing all text selection until a
  // full restart. Clearing it here restores selection after a Fast Refresh.
  document.body.style.userSelect = '';
}
