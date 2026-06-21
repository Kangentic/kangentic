/**
 * Flatten a LOGICAL tile tree into a flat list of absolute pixel rects, one per
 * leaf (window), plus the seam regions between split children.
 *
 * This is the crux of the no-reparent tiling architecture: the `TileNode` tree
 * is purely logical. Windows always render as flat, absolutely-positioned
 * siblings of the overlay - tiling only changes each window's left/top/width/
 * height, never its DOM parent. A live xterm/WebGL terminal therefore never gets
 * torn out of the DOM when the layout changes (the reason we build our own
 * tiling instead of reparenting like golden-layout/dockview).
 *
 * Pure + unit-tested: no React, no store, no DOM.
 */

import type { TileNode } from '../store/types';
import type { ContainerSize, PixelRect } from '../store/geometry';

export interface TileSeam {
  /** The split whose sizes this seam adjusts. */
  splitId: string;
  /** Index of the FIRST child of the adjacent pair this seam divides; the seam
   *  resizes `children[index]` vs `children[index + 1]` only. */
  index: number;
  /** 'horizontal' = children side by side, a VERTICAL seam bar (drag left/right).
   *  'vertical'   = children stacked,     a HORIZONTAL seam bar (drag up/down). */
  direction: 'horizontal' | 'vertical';
  /** The draggable seam region, in pixels relative to the container. */
  rect: PixelRect;
  /** The COMBINED region of the two adjacent children this seam divides. The
   *  splitter maps a pointer position within these bounds to the pair's new
   *  split ratio (the rest of the container is untouched). */
  bounds: PixelRect;
}

export interface TileLayout {
  /** windowId -> its resolved pixel rect. */
  rects: Map<string, PixelRect>;
  /** One per split node, front-to-back order irrelevant. */
  seams: TileSeam[];
}

/**
 * Resolve `tree` against a region `container` pixels in size, placed at `origin`
 * (default the top-left, so the tree fills the whole container). A non-zero
 * `origin` plus a reduced `container` confines the tree to a SUB-REGION of the
 * overlay - this is how a tile group seeded by docking onto a half-snapped window
 * stays inside that window's footprint instead of taking over the full overlay.
 *
 *  - `gapPx`: reserved gap BETWEEN panes (centered on the split line). 0 makes
 *    panes flush (touching), so nothing shows through behind a tiled layout.
 *  - `seamPx`: width/height of the draggable seam OVERLAY (also centered on the
 *    split line). Decoupled from the gap so the seam can be a comfortable hit
 *    target that sits ON TOP of flush panes, rather than a visible gutter.
 */
export function resolveTileLayout(
  tree: TileNode,
  container: ContainerSize,
  gapPx: number,
  seamPx: number,
  origin: { left: number; top: number } = { left: 0, top: 0 },
): TileLayout {
  const rects = new Map<string, PixelRect>();
  const seams: TileSeam[] = [];
  const gapHalf = gapPx / 2;
  const seamHalf = seamPx / 2;

  const walk = (node: TileNode, rect: PixelRect): void => {
    if (node.kind === 'leaf') {
      rects.set(node.windowId, rect);
      return;
    }
    const horizontal = node.direction === 'horizontal';
    const extent = horizontal ? rect.width : rect.height;
    const start = horizontal ? rect.left : rect.top;
    const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;

    // Boundaries[i] is the position of the start of child i along the axis;
    // boundaries[N] is the container's far edge. A seam sits on each interior
    // boundary (between child i and i+1).
    const boundaries: number[] = [start];
    for (let childIndex = 0; childIndex < node.children.length; childIndex += 1) {
      boundaries.push(boundaries[childIndex] + (extent * node.sizes[childIndex]) / total);
    }
    const lastChild = node.children.length - 1;

    node.children.forEach((child, childIndex) => {
      // Inset each child by half the gap on every side that abuts a seam.
      const childStart = boundaries[childIndex] + (childIndex > 0 ? gapHalf : 0);
      const childEnd = boundaries[childIndex + 1] - (childIndex < lastChild ? gapHalf : 0);
      const childExtent = Math.max(0, childEnd - childStart);
      walk(
        child,
        horizontal
          ? { left: childStart, top: rect.top, width: childExtent, height: rect.height }
          : { left: rect.left, top: childStart, width: rect.width, height: childExtent },
      );
    });

    for (let pairIndex = 0; pairIndex < lastChild; pairIndex += 1) {
      const seamPosition = boundaries[pairIndex + 1];
      const pairStart = boundaries[pairIndex];
      const pairExtent = boundaries[pairIndex + 2] - pairStart;
      seams.push({
        splitId: node.id,
        index: pairIndex,
        direction: node.direction,
        rect: horizontal
          ? { left: seamPosition - seamHalf, top: rect.top, width: seamPx, height: rect.height }
          : { left: rect.left, top: seamPosition - seamHalf, width: rect.width, height: seamPx },
        bounds: horizontal
          ? { left: pairStart, top: rect.top, width: pairExtent, height: rect.height }
          : { left: rect.left, top: pairStart, width: rect.width, height: pairExtent },
      });
    }
  };

  walk(tree, { left: origin.left, top: origin.top, width: container.width, height: container.height });
  return { rects, seams };
}
