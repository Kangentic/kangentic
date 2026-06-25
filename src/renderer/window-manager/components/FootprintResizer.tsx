/**
 * A draggable resizer on the OUTER edge of a footprint-confined tile group (the
 * boundary between the group and the empty board around it). Unlike `TileSplitter`
 * (which resizes a split between two panes), this resizes the whole group's
 * footprint (`tileTreeRect`): dragging a right-docked group's left edge widens
 * every pane in the group while the group stays docked to the right edge; the
 * vacated space stays empty board.
 *
 * Rendered only on footprint edges that border empty space (an edge flush against
 * the overlay boundary has nothing to expand into and gets no resizer).
 *
 * Performance mirrors `TileSplitter`: the drag is IMPERATIVE - each pointermove
 * re-resolves the layout at the proposed footprint and writes the new rects
 * straight to the cached frame/seam DOM nodes (no store write, no React render,
 * no per-frame terminal fit). The footprint is committed once on release.
 */

import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useLayerStore, useWindowManager } from '../context';
import { clamp } from '../store/geometry';
import type { ContainerSize, PixelRect } from '../store/geometry';
import type { FractionalRect, TileNode } from '../store/types';
import { resolveTileLayout } from '../tiling/resolve-layout';

export type FootprintEdge = 'left' | 'right' | 'top' | 'bottom';

/** Absolute backstop: the group never shrinks below this fraction of the overlay
 *  on an axis (the per-pane min-size floor below usually dominates). */
const MIN_FOOTPRINT = 0.15;

interface FootprintResizerProps {
  edge: FootprintEdge;
  tileTree: TileNode;
  tileTreeRect: FractionalRect;
  containerSize: ContainerSize;
  gapPx: number;
  seamPx: number;
  overlayRef: RefObject<HTMLDivElement | null>;
}

interface FootprintDrag {
  pointerId: number;
  overlayLeft: number;
  overlayTop: number;
  frameNodes: Map<string, HTMLElement>;
  seamNodes: Map<string, HTMLElement>;
  selfNode: HTMLElement;
  footprint: FractionalRect;
  /** Min footprint fraction along the resize axis (so the narrowest pane stays at
   *  or above the layer min-size). Computed once at grab time. */
  minFootprint: number;
}

function applyRect(node: HTMLElement, rect: PixelRect): void {
  node.style.left = `${rect.left}px`;
  node.style.top = `${rect.top}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

/** The seam strip rect for `edge`, given the footprint's pixel box. The strip is
 *  centered on the edge but kept fully INSIDE the overlay, so a strip on an edge
 *  flush against the overlay boundary (a full-screen group) does not fall half
 *  off-screen and stays grabbable. */
function stripRect(
  edge: FootprintEdge,
  origin: { left: number; top: number },
  size: ContainerSize,
  seamPx: number,
  container: ContainerSize,
): PixelRect {
  const seamHalf = seamPx / 2;
  const clamp = (value: number, max: number): number => Math.min(Math.max(0, value), Math.max(0, max - seamPx));
  switch (edge) {
    case 'left':
      return { left: clamp(origin.left - seamHalf, container.width), top: origin.top, width: seamPx, height: size.height };
    case 'right':
      return { left: clamp(origin.left + size.width - seamHalf, container.width), top: origin.top, width: seamPx, height: size.height };
    case 'top':
      return { left: origin.left, top: clamp(origin.top - seamHalf, container.height), width: size.width, height: seamPx };
    case 'bottom':
      return { left: origin.left, top: clamp(origin.top + size.height - seamHalf, container.height), width: size.width, height: seamPx };
  }
}

export function FootprintResizer({ edge, tileTree, tileTreeRect, containerSize, gapPx, seamPx, overlayRef }: FootprintResizerProps) {
  const setTileTreeRect = useLayerStore()((state) => state.setTileTreeRect);
  const { layer } = useWindowManager();
  const dragRef = useRef<FootprintDrag | null>(null);
  const [dragging, setDragging] = useState(false);

  const isVerticalBar = edge === 'left' || edge === 'right';
  const origin = { left: tileTreeRect.x * containerSize.width, top: tileTreeRect.y * containerSize.height };
  const footprintSize = { width: tileTreeRect.w * containerSize.width, height: tileTreeRect.h * containerSize.height };
  const strip = stripRect(edge, origin, footprintSize, seamPx, containerSize);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const overlayRect = overlay.getBoundingClientRect();
    const layout = resolveTileLayout(tileTree, footprintSize, gapPx, seamPx, origin);
    const frameNodes = new Map<string, HTMLElement>();
    for (const windowId of layout.rects.keys()) {
      const node = document.querySelector<HTMLElement>(`[data-testid="window-frame-${windowId}"]`);
      if (node) frameNodes.set(windowId, node);
    }
    const seamNodes = new Map<string, HTMLElement>();
    for (const candidate of layout.seams) {
      const key = `${candidate.splitId}:${candidate.index}`;
      const node = document.querySelector<HTMLElement>(`[data-testid="tile-splitter-${key}"]`);
      if (node) seamNodes.set(key, node);
    }
    // Floor the footprint so the NARROWEST pane along the resize axis can't shrink
    // below the layer min-size. Panes scale proportionally with the footprint, so
    // the smallest pane's share of the footprint is the binding constraint:
    // minFootprintExtent = minPaneSize / smallestPaneShare.
    const footprintExtentPx = isVerticalBar ? footprintSize.width : footprintSize.height;
    const minPanePx = isVerticalBar ? layer.minSize.width : layer.minSize.height;
    const containerExtentPx = isVerticalBar ? containerSize.width : containerSize.height;
    let smallestPaneShare = 1;
    for (const rect of layout.rects.values()) {
      const paneExtentPx = isVerticalBar ? rect.width : rect.height;
      if (footprintExtentPx > 0) smallestPaneShare = Math.min(smallestPaneShare, paneExtentPx / footprintExtentPx);
    }
    const minFootprint = smallestPaneShare > 0 && containerExtentPx > 0
      ? Math.min(1, Math.max(MIN_FOOTPRINT, (minPanePx / smallestPaneShare) / containerExtentPx))
      : MIN_FOOTPRINT;
    dragRef.current = {
      pointerId: event.pointerId,
      overlayLeft: overlayRect.left,
      overlayTop: overlayRect.top,
      frameNodes,
      seamNodes,
      selfNode: event.currentTarget as HTMLElement,
      footprint: tileTreeRect,
      minFootprint,
    };
    setDragging(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.stopPropagation();
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const right = tileTreeRect.x + tileTreeRect.w;
    const bottom = tileTreeRect.y + tileTreeRect.h;
    const minFootprint = drag.minFootprint;
    let next: FractionalRect;
    if (edge === 'left') {
      const fx = clamp((event.clientX - drag.overlayLeft) / containerSize.width, 0, right - minFootprint);
      next = { x: fx, y: tileTreeRect.y, w: right - fx, h: tileTreeRect.h };
    } else if (edge === 'right') {
      const fr = clamp((event.clientX - drag.overlayLeft) / containerSize.width, tileTreeRect.x + minFootprint, 1);
      next = { x: tileTreeRect.x, y: tileTreeRect.y, w: fr - tileTreeRect.x, h: tileTreeRect.h };
    } else if (edge === 'top') {
      const fy = clamp((event.clientY - drag.overlayTop) / containerSize.height, 0, bottom - minFootprint);
      next = { x: tileTreeRect.x, y: fy, w: tileTreeRect.w, h: bottom - fy };
    } else {
      const fb = clamp((event.clientY - drag.overlayTop) / containerSize.height, tileTreeRect.y + minFootprint, 1);
      next = { x: tileTreeRect.x, y: tileTreeRect.y, w: tileTreeRect.w, h: fb - tileTreeRect.y };
    }
    drag.footprint = next;
    const nextOrigin = { left: next.x * containerSize.width, top: next.y * containerSize.height };
    const nextSize = { width: next.w * containerSize.width, height: next.h * containerSize.height };
    const layout = resolveTileLayout(tileTree, nextSize, gapPx, seamPx, nextOrigin);
    for (const [windowId, rect] of layout.rects) {
      const node = drag.frameNodes.get(windowId);
      if (node) applyRect(node, rect);
    }
    for (const candidate of layout.seams) {
      const node = drag.seamNodes.get(`${candidate.splitId}:${candidate.index}`);
      if (node) applyRect(node, candidate.rect);
    }
    applyRect(drag.selfNode, stripRect(edge, nextOrigin, nextSize, seamPx, containerSize));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    setDragging(false);
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
    setTileTreeRect(drag.footprint);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`group pointer-events-auto absolute z-[2000000000] ${isVerticalBar ? 'cursor-col-resize' : 'cursor-row-resize'}`}
      style={{ left: strip.left, top: strip.top, width: strip.width, height: strip.height }}
      data-testid={`footprint-resizer-${edge}`}
    >
      {/* Invisible at rest; a thin accent line on hover/drag (matches TileSplitter). */}
      <div
        className={`absolute transition-colors ${
          isVerticalBar ? 'inset-y-0 left-1/2 -translate-x-1/2 w-0.5' : 'inset-x-0 top-1/2 -translate-y-1/2 h-0.5'
        } ${dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-accent'}`}
      />
    </div>
  );
}
