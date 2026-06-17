/**
 * The single snap-preview rectangle. Rendered once inside the overlay; its DOM
 * element is driven imperatively by `snap-preview-controller` during a drag (no
 * React re-render). Hidden by default; shown when an edge-snap is armed.
 */

import { useEffect, useRef } from 'react';
import { registerSnapPreviewElement } from '../dnd/snap-preview-controller';

// Above any window's zIndex (which grows from 1 per focus) so the snap outline
// is visible even over a large/maximized window being dragged.
const SNAP_PREVIEW_Z = 2147483000;

export function SnapPreview() {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerSnapPreviewElement(elementRef.current);
    return () => registerSnapPreviewElement(null);
  }, []);

  return (
    <div
      ref={elementRef}
      aria-hidden
      // `snap-zone-active` is the Pattern-D cleanup hook (cleared on HMR).
      className="snap-zone-active absolute pointer-events-none rounded-lg border-2 border-accent bg-accent/10"
      style={{ display: 'none', zIndex: SNAP_PREVIEW_Z }}
    />
  );
}
