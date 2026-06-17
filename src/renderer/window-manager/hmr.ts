/**
 * HMR Pattern D cleanup for the window engine. A Vite Fast Refresh mid-drag
 * fires no pointerup, so the snap preview can be left visible and a frame left
 * with a stale `transform`. `App.tsx`'s `vite:afterUpdate` calls this beside the
 * existing `.drop-highlight` clear.
 */

import { hideSnapPreview } from './dnd/snap-preview-controller';

export function clearSnapPreviewDom(): void {
  hideSnapPreview();
  document.querySelectorAll<HTMLElement>('[data-testid^="window-frame-"]').forEach((frame) => {
    frame.style.transform = '';
  });
}
