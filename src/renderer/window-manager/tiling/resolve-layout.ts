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
  /** The split whose ratio this seam adjusts. */
  splitId: string;
  /** 'horizontal' = children side by side, a VERTICAL seam bar (drag left/right).
   *  'vertical'   = children stacked,     a HORIZONTAL seam bar (drag up/down). */
  direction: 'horizontal' | 'vertical';
  /** The draggable seam region, in pixels relative to the container. */
  rect: PixelRect;
  /** The full area this split divides (the split node's rect). The splitter
   *  computes a new ratio from the pointer position relative to these bounds. */
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
    if (node.direction === 'horizontal') {
      // Side by side; split the WIDTH at `ratio`, a vertical seam between.
      const splitX = rect.left + rect.width * node.ratio;
      const aWidth = Math.max(0, splitX - gapHalf - rect.left);
      const bLeft = splitX + gapHalf;
      const bWidth = Math.max(0, rect.left + rect.width - bLeft);
      walk(node.a, { left: rect.left, top: rect.top, width: aWidth, height: rect.height });
      walk(node.b, { left: bLeft, top: rect.top, width: bWidth, height: rect.height });
      seams.push({
        splitId: node.id,
        direction: 'horizontal',
        rect: { left: splitX - seamHalf, top: rect.top, width: seamPx, height: rect.height },
        bounds: rect,
      });
    } else {
      // Stacked; split the HEIGHT at `ratio`, a horizontal seam between.
      const splitY = rect.top + rect.height * node.ratio;
      const aHeight = Math.max(0, splitY - gapHalf - rect.top);
      const bTop = splitY + gapHalf;
      const bHeight = Math.max(0, rect.top + rect.height - bTop);
      walk(node.a, { left: rect.left, top: rect.top, width: rect.width, height: aHeight });
      walk(node.b, { left: rect.left, top: bTop, width: rect.width, height: bHeight });
      seams.push({
        splitId: node.id,
        direction: 'vertical',
        rect: { left: rect.left, top: splitY - seamHalf, width: rect.width, height: seamPx },
        bounds: rect,
      });
    }
  };

  walk(tree, { left: origin.left, top: origin.top, width: container.width, height: container.height });
  return { rects, seams };
}
