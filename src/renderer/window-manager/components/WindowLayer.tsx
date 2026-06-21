/**
 * The window layer: a body-level portal overlay that floats windows over the
 * live, clickable board. The overlay is `pointer-events:none` so clicks in the
 * gaps fall through to the board; each `WindowFrame` is `pointer-events:auto`.
 * Mounted once in `AppLayout`.
 *
 * The portal host is a `document.body` sibling of `#root` (not a child) so the
 * overlay escapes the layout column's `overflow-hidden` wrappers. It is looked
 * up or created once and never removed, so StrictMode double-invoke and HMR
 * remounts reuse the same node.
 *
 * The overlay sits between the app chrome (title bar h-10, status bar h-9),
 * matching the maximize convention in `dialog-maximize.tsx`. It renders at
 * `z-40`, BELOW true modal dialogs (`BaseDialog` is `z-50`): while the
 * task-detail surface is still a modal, the modal must sit on top of floating
 * windows. When that surface becomes a window (the end state), there is no
 * competing modal.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWindowStore } from '../store/window-store';
import { useTaskDetailWindowBridge } from '../bridge/useTaskDetailWindowBridge';
import { useWindowSessionClaims } from '../bridge/useWindowSessionClaims';
import { useWindowAutoCloseOnDone } from '../bridge/useWindowAutoCloseOnDone';
import { useWindowFocusReconcile } from '../bridge/useWindowFocusReconcile';
import { useWorkspacePersistence } from '../bridge/useWorkspacePersistence';
import { useClickOutsideToClose } from '../bridge/useClickOutsideToClose';
import type { ContainerSize } from '../store/geometry';
import type { FractionalRect } from '../store/types';
import { resolveTileLayout } from '../tiling/resolve-layout';
import { WindowFrame } from './WindowFrame';
import { TileSplitter } from './TileSplitter';
import { FootprintResizer } from './FootprintResizer';
import type { FootprintEdge } from './FootprintResizer';
import { SnapPreview } from './SnapPreview';

const PORTAL_HOST_ID = 'window-layer-root';

/** Panes sit FLUSH (zero reserved gap) so nothing shows through behind a tiled
 *  layout. The draggable seam is an invisible OVERLAY of this width, centered on
 *  the boundary, that only paints a thin accent line on hover/drag. */
const TILE_GAP_PX = 0;
const TILE_SEAM_PX = 10;

/** A footprint edge gets an outer resizer only if it borders empty board (it is
 *  not flush against the overlay boundary). */
const FOOTPRINT_EDGE_EPSILON = 0.001;
function footprintEdges(rect: FractionalRect): FootprintEdge[] {
  const edges: FootprintEdge[] = [];
  if (rect.x > FOOTPRINT_EDGE_EPSILON) edges.push('left');
  if (rect.x + rect.w < 1 - FOOTPRINT_EDGE_EPSILON) edges.push('right');
  if (rect.y > FOOTPRINT_EDGE_EPSILON) edges.push('top');
  if (rect.y + rect.h < 1 - FOOTPRINT_EDGE_EPSILON) edges.push('bottom');
  return edges;
}

function getPortalHost(): HTMLElement {
  const existing = document.getElementById(PORTAL_HOST_ID);
  if (existing) return existing;
  const host = document.createElement('div');
  host.id = PORTAL_HOST_ID;
  document.body.appendChild(host);
  return host;
}

export function WindowLayer() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  if (!hostRef.current) hostRef.current = getPortalHost();

  // Open/close task-detail windows in response to the renderer's `detailTaskId`
  // signal (the single open path every entry point already drives).
  useTaskDetailWindowBridge();
  // Keep the window-owned session claim set (`dialogSessionIds`) reconciled to
  // the open windows, so an HMR re-sync (or any external reset) that clobbers it
  // self-heals instead of leaving a window's terminal suppressed.
  useWindowSessionClaims();
  // Close a window the instant its task leaves the board (Done / delete / backlog),
  // so it never lingers on the "no longer available" placeholder.
  useWindowAutoCloseOnDone();
  // When closing a window orphans keyboard focus, move it to a remaining window's
  // terminal so the group keeps an active pane.
  useWindowFocusReconcile();
  // Persist the layout (debounced) to the open project's config so it survives a
  // project switch + app restart. Restore is wired into the project-switch effect.
  useWorkspacePersistence();
  // Light-dismiss: a clean click on the empty board closes open windows per the
  // user's `windowLightDismiss` policy (off / single / focused / all).
  useClickOutsideToClose();

  const [containerSize, setContainerSize] = useState<ContainerSize>({ width: 0, height: 0 });
  const windows = useWindowStore((state) => state.windows);
  const tileTree = useWindowStore((state) => state.tileTree);
  const tileTreeRect = useWindowStore((state) => state.tileTreeRect);

  // The tile tree lives inside this pixel sub-region of the overlay (the whole
  // overlay for edge-snap pairs; a half-snapped window's footprint for a group
  // seeded by docking onto it). Size + origin both derive from `tileTreeRect`.
  const treeBounds = useMemo(
    () => ({
      size: { width: tileTreeRect.w * containerSize.width, height: tileTreeRect.h * containerSize.height },
      origin: { left: tileTreeRect.x * containerSize.width, top: tileTreeRect.y * containerSize.height },
    }),
    [tileTreeRect, containerSize],
  );

  // Flatten the logical tile tree into absolute pixel rects (one per tiled
  // window) + seam regions, WITHIN the tree's footprint. Windows stay flat
  // overlay children; only their position/size change, so a tiled terminal never
  // reparents.
  const tileLayout = useMemo(
    () =>
      tileTree && containerSize.width > 0
        ? resolveTileLayout(tileTree, treeBounds.size, TILE_GAP_PX, TILE_SEAM_PX, treeBounds.origin)
        : null,
    [tileTree, containerSize, treeBounds],
  );

  // Measure the overlay so fractional geometry projects to pixels, and reproject
  // on viewport/overlay resize (the geometry value itself is unchanged).
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const measure = () => {
      const width = overlay.clientWidth;
      const height = overlay.clientHeight;
      // Skip a no-delta resize callback: ResizeObserver can fire with identical
      // dimensions, and a fresh {width,height} object would invalidate the
      // treeBounds / tileLayout memos (ref-compared deps) and re-run the full
      // tile-layout resolve for nothing.
      setContainerSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, []);

  // Render in a STABLE dom order (object insertion order) and stack purely via
  // each window's `zIndex`. The old z-order DOM mapping moved a window's node to
  // the front on focus, and moving a node mid-click cancels the click in
  // Chromium - so a button on a BACKGROUND window only focused it (a second
  // click was needed to actually act). Stable DOM + zIndex stacking lets one
  // click both raise the window AND trigger the button under the cursor.
  const renderedWindows = Object.values(windows);

  return createPortal(
    <div ref={overlayRef} data-testid="window-overlay" className="fixed left-0 right-0 top-10 bottom-9 z-40 pointer-events-none">
      {renderedWindows.map((managedWindow) => (
        <WindowFrame
          key={managedWindow.id}
          managedWindow={managedWindow}
          containerSize={containerSize}
          overlayRef={overlayRef}
          tiledRect={tileLayout?.rects.get(managedWindow.id) ?? null}
        />
      ))}
      {tileTree && tileLayout?.seams.map((seam) => (
        <TileSplitter
          key={`${seam.splitId}:${seam.index}`}
          seam={seam}
          tileTree={tileTree}
          treeSize={treeBounds.size}
          treeOrigin={treeBounds.origin}
          gapPx={TILE_GAP_PX}
          seamPx={TILE_SEAM_PX}
          overlayRef={overlayRef}
        />
      ))}
      {/* Outer-edge resizers: one per footprint edge that borders empty board, so
          a docked group can be widened/heightened while staying docked. */}
      {tileTree && containerSize.width > 0 && footprintEdges(tileTreeRect).map((edge) => (
        <FootprintResizer
          key={`footprint-${edge}`}
          edge={edge}
          tileTree={tileTree}
          tileTreeRect={tileTreeRect}
          containerSize={containerSize}
          gapPx={TILE_GAP_PX}
          seamPx={TILE_SEAM_PX}
          overlayRef={overlayRef}
        />
      ))}
      <SnapPreview />
    </div>,
    hostRef.current,
  );
}
