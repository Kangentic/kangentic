/**
 * A draggable seam between tiled panes. One per split node. Dragging it adjusts
 * that split's ratio, so BOTH sides resize together (a nested split's seam
 * cascades to every window in its two subtrees). Double-clicking it evens its
 * two panes, 50/50.
 *
 * Performance: the drag is IMPERATIVE (like the window-resize handle). On each
 * pointermove it re-resolves the layout for the proposed ratio and writes the
 * new rects straight to the frame/seam DOM nodes - NO store update, so NO React
 * re-render and NO per-frame terminal `fit()` (the expensive part). The ratio is
 * committed to the store ONCE on release, where each terminal re-fits a single
 * time. Frame nodes are cached on pointerdown so the move loop is pure DOM
 * writes. Sits in the gap BETWEEN panes, so it never overlaps a live terminal.
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useLayerStore, useWindowManager } from '../context';
import type { ContainerSize } from '../store/geometry';
import type { TileNode } from '../store/types';
import { resolveTileLayout } from '../tiling/resolve-layout';
import type { TileSeam } from '../tiling/resolve-layout';
import { clampTileRatio, seamPairRatio, setSeamRatio as resizeSeamInTree } from '../tiling/tree-ops';
import { beginManagerResize, type ManagerResizeGesture } from '../terminal/manager-resize-gate';
import { runTerminalLayoutChange, terminalLayoutScopeOf } from '../../utils/terminal-layout-transition';

interface TileSplitterProps {
  seam: TileSeam;
  tileTree: TileNode;
  /** Pixel size of the tree's footprint (the sub-region it occupies). */
  treeSize: ContainerSize;
  /** Pixel offset of the tree's footprint within the overlay. */
  treeOrigin: { left: number; top: number };
  gapPx: number;
  seamPx: number;
  overlayRef: RefObject<HTMLDivElement | null>;
}

interface SeamDrag {
  pointerId: number;
  overlayLeft: number;
  overlayTop: number;
  /** Frame + seam DOM nodes cached at grab time so the move loop never queries. */
  frameNodes: Map<string, HTMLElement>;
  seamNodes: Map<string, HTMLElement>;
  /** The proposed pair ratio, null until the seam has moved: a press and release in place commits nothing. */
  ratio: number | null;
  gesture: ManagerResizeGesture;
}

function applyRect(node: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  node.style.left = `${rect.left}px`;
  node.style.top = `${rect.top}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

/** A seam is identified by its split AND its adjacent-pair index (a split has
 *  one seam per interior boundary), so multiple seams of one container stay
 *  distinct for DOM caching and React keys. */
function seamKey(seam: Pick<TileSeam, 'splitId' | 'index'>): string {
  return `${seam.splitId}:${seam.index}`;
}

export function TileSplitter({ seam, tileTree, treeSize, treeOrigin, gapPx, seamPx, overlayRef }: TileSplitterProps) {
  const commitSeamRatio = useLayerStore()((state) => state.setSeamRatio);
  // The layer's pixel min-size: a seam can't shrink either pane of the pair below
  // it (so a tiled pane never goes narrower/shorter than a floating one's floor).
  const { layer } = useWindowManager();
  // The panes a host-arranged layer holds at its floor, as WindowLayer lays them out.
  const heldMinimum = layer.hostArranged ? layer.minSize : undefined;
  const dragRef = useRef<SeamDrag | null>(null);
  // Keeps the accent line lit through the whole drag (CSS :hover drops out when
  // the captured pointer travels off the thin overlay).
  const [dragging, setDragging] = useState(false);

  // Close the drag's gesture if this splitter unmounts mid-drag (the overlay is
  // torn down while a pointer is held - e.g. a keyboard shortcut hides the layer
  // or closes the dialog). React removes the pointer handlers on unmount, so
  // onPointerUp never runs; the gate would close it on the next released-button
  // event anyway, but the splitter knows first.
  useEffect(() => () => {
    dragRef.current?.gesture.end();
    dragRef.current = null;
  }, []);

  /** End the drag: commit the ratio it reached, if it moved, and close its gesture. */
  const finishDrag = (drag: SeamDrag): void => {
    if (dragRef.current !== drag) return;
    dragRef.current = null;
    setDragging(false);
    const ratio = drag.ratio;
    if (ratio === null) {
      drag.gesture.end();
      return;
    }
    // Commit once: the re-render sets the same rects React just had imperatively
    // overwritten (identical values -> no jump) and each terminal fits a single
    // time, holding its frame until its agent has repainted.
    runTerminalLayoutChange(terminalLayoutScopeOf(overlayRef.current), () => {
      commitSeamRatio(seam.splitId, seam.index, ratio);
      drag.gesture.end();
    });
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Re-entry guard: a second pointer-down while a drag is live would overwrite
    // dragRef (abandoning the first gesture's capture). Ignore it. A drag whose
    // release went unseen is not live: the gate abandons it in this press's
    // capture phase, before this handler runs.
    if (dragRef.current) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const overlayRect = overlay.getBoundingClientRect();
    // Cache every frame + seam node once so pointermove is pure DOM writes.
    const layout = resolveTileLayout(tileTree, treeSize, gapPx, seamPx, treeOrigin, heldMinimum);
    const frameNodes = new Map<string, HTMLElement>();
    for (const windowId of layout.rects.keys()) {
      const node = document.querySelector<HTMLElement>(`[data-testid="window-frame-${windowId}"]`);
      if (node) frameNodes.set(windowId, node);
    }
    const seamNodes = new Map<string, HTMLElement>();
    for (const candidate of layout.seams) {
      const node = document.querySelector<HTMLElement>(`[data-testid="tile-splitter-${seamKey(candidate)}"]`);
      if (node) seamNodes.set(seamKey(candidate), node);
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    // Open a gesture on the manager-resize gate so window terminals suppress
    // per-frame refits (one SIGWINCH on commit instead of one per drag frame).
    // Closed on release, or by the gate if the release never reaches this seam.
    const drag: SeamDrag = {
      pointerId: event.pointerId,
      overlayLeft: overlayRect.left,
      overlayTop: overlayRect.top,
      frameNodes,
      seamNodes,
      ratio: null,
      gesture: beginManagerResize('tile-seam', event.pointerId, () => finishDrag(drag)),
    };
    dragRef.current = drag;
    setDragging(true);
    // Don't let the pointer-down fall through to focus/raise a window under the seam.
    event.stopPropagation();
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const isHorizontalSeam = seam.direction === 'horizontal';
    const rawRatio = isHorizontalSeam
      ? (event.clientX - drag.overlayLeft - seam.bounds.left) / seam.bounds.width
      : (event.clientY - drag.overlayTop - seam.bounds.top) / seam.bounds.height;
    // Floor each pane of the pair at the layer min-size (width along a col-resize
    // seam, height along a row-resize seam), so a drag can't squeeze a pane below
    // it. Capped at 0.5 so a too-small pair still meets in the middle.
    const boundsExtent = isHorizontalSeam ? seam.bounds.width : seam.bounds.height;
    const minDim = isHorizontalSeam ? layer.minSize.width : layer.minSize.height;
    const minFraction = Math.min(0.5, minDim / boundsExtent);
    const ratio = clampTileRatio(Math.min(Math.max(rawRatio, minFraction), 1 - minFraction));
    drag.ratio = ratio;
    // Re-resolve at the proposed pair ratio and write rects imperatively. No store
    // write -> no React render -> no terminal fit until release.
    const proposed = resizeSeamInTree(tileTree, seam.splitId, seam.index, ratio);
    const layout = resolveTileLayout(proposed, treeSize, gapPx, seamPx, treeOrigin, heldMinimum);
    for (const [windowId, rect] of layout.rects) {
      const node = drag.frameNodes.get(windowId);
      if (node) applyRect(node, rect);
    }
    for (const candidate of layout.seams) {
      const node = drag.seamNodes.get(seamKey(candidate));
      if (node) applyRect(node, candidate.rect);
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
    finishDrag(drag);
  };

  // A double-click evens the seam's pair, 50/50, as a sash does in an editor.
  // Its two clicks commit nothing on their own (a press and release in place),
  // and an already even pair refits nothing.
  const onDoubleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    const current = seamPairRatio(tileTree, seam.splitId, seam.index);
    if (current === null || Math.abs(current - 0.5) < 0.001) return;
    runTerminalLayoutChange(terminalLayoutScopeOf(overlayRef.current), () => {
      commitSeamRatio(seam.splitId, seam.index, 0.5);
    });
  };

  const isHorizontal = seam.direction === 'horizontal';
  // A pair with no room above both panes' floor (a Command Terminal panel at its
  // minimum) has nowhere to move its seam, the same limit the drag clamps to, so
  // the seam does not look or act draggable: no resize cursor, no accent line, no
  // drag and no double-click. It comes back once the pair has room.
  const pairExtent = isHorizontal ? seam.bounds.width : seam.bounds.height;
  const paneFloor = isHorizontal ? layer.minSize.width : layer.minSize.height;
  const movable = pairExtent - 2 * paneFloor > 1;

  return (
    <div
      onPointerDown={movable ? onPointerDown : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={movable ? onDoubleClick : undefined}
      // z above any window: window zIndex grows by 1 per focus and is unbounded,
      // so a fixed-low seam z would slip under the windows after enough focus
      // clicks (and become un-grabbable). Stays below the snap preview (~2.147e9).
      className={`group pointer-events-auto absolute z-[2000000000] ${
        !movable ? '' : isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize'
      }`}
      style={{ left: seam.rect.left, top: seam.rect.top, width: seam.rect.width, height: seam.rect.height }}
      data-testid={`tile-splitter-${seamKey(seam)}`}
      data-movable={movable ? 'true' : 'false'}
    >
      {/* Invisible at rest (panes sit flush); a thin accent line at the boundary
          appears only on hover or while dragging, and never on a seam with no room. */}
      <div
        className={`absolute transition-colors ${
          isHorizontal ? 'inset-y-0 left-1/2 -translate-x-1/2 w-0.5' : 'inset-x-0 top-1/2 -translate-y-1/2 h-0.5'
        } ${dragging ? 'bg-accent' : movable ? 'bg-transparent group-hover:bg-accent' : 'bg-transparent'}`}
      />
    </div>
  );
}
