/**
 * A window-manager LAYER: a body-level portal overlay that floats a content-
 * agnostic set of managed windows. The engine is mounted three times - the board
 * task-detail layer (modeless, gaps fall through to the live board), the
 * command-terminal layer (modal-ish, a slight backdrop blur over the board), and
 * the Agent Monitor's detail layer (which can be hosted in the main window or in
 * the monitor's own pop-out renderer) - each with its own instance via
 * `WindowManagerProvider`.
 *
 * The generic `WindowManagerLayer` renders the provider + the overlay surface
 * (frames, tile seams, footprint resizers, snap preview) and mounts the layer's
 * bridges. `WindowLayer` is the board wrapper kept for back-compat (its import
 * path and behavior are unchanged); the command layer composes its own wrapper.
 *
 * The portal host is a `document.body` sibling of `#root` (not a child) so the
 * overlay escapes the layout column's `overflow-hidden` wrappers. It is looked
 * up or created once per host id and never removed, so StrictMode double-invoke
 * and HMR remounts reuse the same node.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBoardStore } from '../../stores/board-store';
import { BoardTaskDetailHost } from '../../components/dialogs/task-detail';
import { boardWindowManager } from '../store/window-store';
import type { WindowManager } from '../store/window-store';
import { WindowManagerProvider, useWindowManager, useSnapPreviewController } from '../context';
import { markLayerMounted } from '../store/layer-mount-registry';
import type { WindowManagerLayerOptions } from '../context';
import { DEFAULT_MIN_WIDTH_PX, DEFAULT_MIN_HEIGHT_PX } from '../dnd/useWindowResize';
import { useTaskDetailWindowBridge } from '../bridge/useTaskDetailWindowBridge';
import { useConversationWindowBridge } from '../bridge/useConversationWindowBridge';
import { useWindowSessionClaims } from '../bridge/useWindowSessionClaims';
import { useDetailOwnershipSync } from '../bridge/useDetailOwnershipSync';
import { useBrowserPaneRequestBridge } from '../bridge/useBrowserPaneRequestBridge';
import { useBrowserDownloadToast } from '../bridge/useBrowserDownloadToast';
import { useProjectStore } from '../../stores/project-store';
import { useWindowAutoCloseOnDone } from '../bridge/useWindowAutoCloseOnDone';
import { useWindowFocusReconcile } from '../bridge/useWindowFocusReconcile';
import { useWorkspacePersistence } from '../bridge/useWorkspacePersistence';
import { useClickOutsideToClose } from '../bridge/useClickOutsideToClose';
import type { ContainerSize } from '../store/geometry';
import { resolveTileLayout } from '../tiling/resolve-layout';
import { WindowFrame } from './WindowFrame';
import { TileSplitter } from './TileSplitter';
import { FootprintResizer } from './FootprintResizer';
import type { FootprintEdge } from './FootprintResizer';
import { SnapPreview } from './SnapPreview';

/** Panes sit FLUSH (zero reserved gap) so nothing shows through behind a tiled
 *  layout. The draggable seam is an invisible OVERLAY of this width, centered on
 *  the boundary, that only paints a thin accent line on hover/drag. */
const TILE_GAP_PX = 0;
const TILE_SEAM_PX = 10;

/** Every footprint edge gets an outer resizer, so a tiled group can be resized
 *  from any side - including shrunk INWARD from an edge that is flush against the
 *  overlay boundary (a full-screen group, e.g. the Columns/Grid preset, must still
 *  be height/width-resizable). The resizer's own min-footprint clamp prevents
 *  dragging a flush edge OUTWARD past the boundary, so a flush edge is simply
 *  shrink-only; `FootprintResizer` keeps each strip inside the overlay so the
 *  screen-edge ones stay grabbable. */
const ALL_FOOTPRINT_EDGES: FootprintEdge[] = ['left', 'right', 'top', 'bottom'];

function getPortalHost(hostId: string): HTMLElement {
  const existing = document.getElementById(hostId);
  // Stamped on BOTH paths, not just creation: the host is created once and reused
  // forever (StrictMode double-invoke, HMR remounts), so marking only the creation
  // path would leave a pre-existing host unmarked after a Fast Refresh and silently
  // turn every window frame back into light-dismiss dead space.
  if (existing) {
    existing.setAttribute('data-window-layer-root', '');
    return existing;
  }
  const host = document.createElement('div');
  host.id = hostId;
  // Layer-agnostic marker: light dismiss must never treat ANY layer's window frame
  // as dead space, and matching a marker rather than a list of host ids means a new
  // layer is covered the moment it mounts.
  host.setAttribute('data-window-layer-root', '');
  document.body.appendChild(host);
  return host;
}

interface WindowManagerLayerProps {
  manager: WindowManager;
  layer: WindowManagerLayerOptions;
  /** The body-level portal host id (distinct per layer). */
  portalHostId: string;
  /** Stable `data-testid` for the overlay root (board: `window-overlay`). */
  overlayTestId: string;
  /** Full overlay className (positioning, z-index, `pointer-events-none`). */
  overlayClassName: string;
  /** Layer-specific bridges (open/close, session, persistence), mounted inside
   *  the provider so their context reads target this instance. */
  bridges?: ReactNode;
  /** Optional backdrop element rendered BEHIND the frames (command layer). */
  backdrop?: ReactNode;
}

/** Generic overlay surface: measures the overlay, projects fractional geometry to
 *  pixels, and renders the frames + tile seams + footprint resizers + snap preview.
 *  Reads the layer's store from context. Mounted inside `WindowManagerProvider`. */
function WindowManagerSurface({
  portalHostId,
  overlayTestId,
  overlayClassName,
  bridges,
  backdrop,
}: Pick<WindowManagerLayerProps, 'portalHostId' | 'overlayTestId' | 'overlayClassName' | 'bridges' | 'backdrop'>) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  if (!hostRef.current) hostRef.current = getPortalHost(portalHostId);

  const { manager } = useWindowManager();
  const useStore = manager.store;

  // Publish this layer's mount state. Renderer-global state derived from windows
  // (`dialogSessionIds`) must not count a layer whose surface is gone: the store
  // outlives the subtree by design, but the xterms do not. The monitor's layer is
  // the one that actually unmounts (it lives inside MonitorPage).
  useEffect(() => markLayerMounted(manager), [manager]);
  const [containerSize, setContainerSize] = useState<ContainerSize>({ width: 0, height: 0 });
  const windows = useStore((state) => state.windows);
  const tileTree = useStore((state) => state.tileTree);
  const tileTreeRect = useStore((state) => state.tileTreeRect);

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
    <>
      {bridges}
      <div ref={overlayRef} data-testid={overlayTestId} className={overlayClassName}>
        {backdrop}
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
        {tileTree && containerSize.width > 0 && ALL_FOOTPRINT_EDGES.map((edge) => (
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
      </div>
    </>,
    hostRef.current,
  );
}

/** The generic, instantiable window-manager layer. */
export function WindowManagerLayer(props: WindowManagerLayerProps) {
  const snap = useSnapPreviewController();
  return (
    <WindowManagerProvider manager={props.manager} layer={props.layer} snap={snap}>
      <WindowManagerSurface
        portalHostId={props.portalHostId}
        overlayTestId={props.overlayTestId}
        overlayClassName={props.overlayClassName}
        bridges={props.bridges}
        backdrop={props.backdrop}
      />
    </WindowManagerProvider>
  );
}

/** The board layer's bridges (open/close, session claims, auto-close, focus
 *  reconcile, per-project persistence, light-dismiss). Operate on the board
 *  instance (the exported singleton), so they are independent of the provider. */
function BoardBridges(): null {
  useTaskDetailWindowBridge();
  useBrowserPaneRequestBridge();
  useBrowserDownloadToast();
  useConversationWindowBridge();
  useWindowSessionClaims();
  useBoardDetailOwnership();
  useWindowAutoCloseOnDone();
  useWindowFocusReconcile();
  useWorkspacePersistence();
  useClickOutsideToClose('board');
  return null;
}

/**
 * Report the board layer's task-detail ownership to main, derived from its windows.
 *
 * The board's anchor is a bare taskId, so the project comes from the open project -
 * which is sound because this layer only ever hosts the open project's tasks
 * (`openWindowFor` parks and switches rather than mounting a foreign task). Two
 * guards make that safe rather than merely usually-right:
 *
 * - **Abstain when there is no project.** Reporting an empty set would tell main to
 *   drop every board claim; sending nothing leaves main's last-known state, which the
 *   next report corrects.
 * - **Only report anchors the board store actually holds.** During a project switch
 *   `currentProject` flips before the new tasks land, so an unfiltered report could
 *   pair project B with a window for a task in A. Triggering on the BOARD store (not
 *   the project store) means both have already moved together, and the filter drops
 *   anything left over.
 */
function useBoardDetailOwnership(): void {
  useDetailOwnershipSync({
    manager: boardWindowManager,
    host: 'board',
    ready: () => useProjectStore.getState().currentProject?.id != null,
    anchorToDetail: (anchor) => {
      const projectId = useProjectStore.getState().currentProject?.id;
      if (!projectId) return null;
      const board = useBoardStore.getState();
      const known = board.tasks.some((task) => task.id === anchor)
        || board.archivedTasks.some((task) => task.id === anchor);
      return known ? { projectId, taskId: anchor } : null;
    },
    extraTriggers: [useBoardStore],
  });
}

const BOARD_LAYER_OPTIONS: WindowManagerLayerOptions = {
  minSize: { width: DEFAULT_MIN_WIDTH_PX, height: DEFAULT_MIN_HEIGHT_PX },
};

const BOARD_OVERLAY_BASE_CLASS = 'fixed left-0 right-0 top-10 bottom-9 z-40 pointer-events-none';

/**
 * The board task-detail window layer. Modeless: `pointer-events:none` so clicks
 * in the gaps fall through to the live board; each `WindowFrame` is
 * `pointer-events:auto`. Sits between the app chrome (title bar h-10, status bar
 * h-9) at `z-40`, BELOW true modal dialogs (`BaseDialog` is `z-50`). Mounted once
 * in `AppLayout`.
 *
 * Stays mounted even when the Backlog view is active (so live agent sessions and
 * the board bridges never tear down) but the overlay goes `invisible` off the
 * board, so windows don't bleed over the backlog. `visibility:hidden` (not
 * `display:none`) keeps the overlay's measured size and each frame's layout
 * intact, so returning to the board needs no re-fit and replays no entrance
 * animation.
 */
export function WindowLayer() {
  const activeView = useBoardStore((state) => state.activeView);
  const overlayClassName =
    activeView === 'board' ? BOARD_OVERLAY_BASE_CLASS : `${BOARD_OVERLAY_BASE_CLASS} invisible`;
  return (
    // The task-detail surface reads every project-scoped value from this host
    // rather than from ambient `currentProject` / board state, so a second layer
    // can host the same surface for a task in a DIFFERENT project. Wrapping out
    // here (not inside the generic layer) is what keeps that per-layer: React
    // context propagates through `createPortal`, so the portaled frames below
    // still see it.
    <BoardTaskDetailHost>
      <WindowManagerLayer
        manager={boardWindowManager}
        layer={BOARD_LAYER_OPTIONS}
        portalHostId="window-layer-root"
        overlayTestId="window-overlay"
        overlayClassName={overlayClassName}
        bridges={<BoardBridges />}
      />
    </BoardTaskDetailHost>
  );
}
