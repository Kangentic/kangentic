/**
 * The single snap-preview rectangle. Rendered once inside the overlay; its DOM
 * element is driven imperatively by `snap-preview-controller` during a drag (no
 * React re-render). Hidden by default; shown when an edge-snap or drag-to-dock
 * zone is armed.
 *
 * The box GLIDES between positions/sizes via a short CSS transition, so fast
 * mouse movement that flips the armed zone (left -> top -> bottom, or pane to
 * pane) reads as a smooth morph instead of a jump. The transition only animates
 * while the box is shown: a CSS transition never fires on a change from
 * `display:none`, so the box still APPEARS instantly at the target (no glide-in
 * from a stale spot) and only animates as the armed zone changes mid-drag. It is
 * a lone overlay element, so this is pure paint - no terminal reflow.
 */

import { useEffect, useRef } from 'react';
import { useWindowManager } from '../context';

// Above any window's zIndex (which grows from 1 per focus) so the snap outline
// is visible even over a large/maximized window being dragged.
const SNAP_PREVIEW_Z = 2147483000;

// Short enough to chase a fast cursor without lagging behind it; long enough to
// read as a glide rather than a jump.
const SNAP_PREVIEW_TRANSITION = 'left 120ms ease-out, top 120ms ease-out, width 120ms ease-out, height 120ms ease-out';

export function SnapPreview() {
  const { snap } = useWindowManager();
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    snap.register(elementRef.current);
    return () => snap.register(null);
  }, [snap]);

  return (
    <div
      ref={elementRef}
      aria-hidden
      // `snap-zone-active` is the Pattern-D cleanup hook (cleared on HMR).
      className="snap-zone-active absolute pointer-events-none rounded-lg border-2 border-accent bg-accent/10"
      style={{ display: 'none', zIndex: SNAP_PREVIEW_Z, transition: SNAP_PREVIEW_TRANSITION }}
    />
  );
}
