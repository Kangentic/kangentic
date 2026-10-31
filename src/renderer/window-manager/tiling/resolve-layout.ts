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

/** Panes sit FLUSH (zero reserved gap), so nothing shows through behind a tiled layout. */
export const TILE_GAP_PX = 0;

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
 * A subtree's smallest extent along `axis` ('horizontal' = width): its panes at
 * `minPane`, added up along a split that runs that way, the widest one across.
 */
function minimumExtent(node: TileNode, axis: 'horizontal' | 'vertical', minPane: ContainerSize): number {
  if (node.kind === 'leaf') return axis === 'horizontal' ? minPane.width : minPane.height;
  const childMinimums = node.children.map((child) => minimumExtent(child, axis, minPane));
  return node.direction === axis
    ? childMinimums.reduce((sum, value) => sum + value, 0)
    : Math.max(...childMinimums);
}

/**
 * Child extents from their fractions, each lifted to its minimum when the
 * split has room for every minimum, the room taken from the children with the
 * most to spare. A split too small for the minimums scales them down together,
 * so the layout is continuous across the edge: a host a pixel short of the
 * minimum (a panel shrinking a frame ahead of what sits beside it) moves each
 * pane a pixel, never back to the seam's own fractions and then forward again.
 */
function holdMinimums(desired: number[], minimums: number[], extent: number): number[] {
  const totalMinimum = minimums.reduce((sum, value) => sum + value, 0);
  if (totalMinimum > extent) return minimums.map((value) => (value * extent) / totalMinimum);
  const extents = desired.slice();
  let deficit = 0;
  extents.forEach((value, index) => {
    if (value < minimums[index]) {
      deficit += minimums[index] - value;
      extents[index] = minimums[index];
    }
  });
  if (deficit <= 0) return extents;
  const spare = extents.map((value, index) => Math.max(0, value - minimums[index]));
  const totalSpare = spare.reduce((sum, value) => sum + value, 0);
  return extents.map((value, index) => value - (totalSpare > 0 ? (deficit * spare[index]) / totalSpare : 0));
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
 *  - `minPane`: a host-arranged layer's pane floor (the Command Terminal's). A
 *    split holds each child at its minimum while it has room for all of them, so
 *    a seam dragged toward one side does not leave a pane under the floor when
 *    the host shrinks to the grid's minimum, and shares a host too small for
 *    them in the minimums' proportions. The seam's own ratio is kept until the
 *    host adopts what the hold shows (`heldSplitSizes`), which the Command
 *    Terminal panel does as a resize begins.
 */
export function resolveTileLayout(
  tree: TileNode,
  container: ContainerSize,
  gapPx: number,
  seamPx: number,
  origin: { left: number; top: number } = { left: 0, top: 0 },
  minPane?: ContainerSize,
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
    const desired = node.sizes.map((size) => (extent * size) / total);
    const extents = minPane
      ? holdMinimums(desired, node.children.map((child) => minimumExtent(child, node.direction, minPane)), extent)
      : desired;

    // Boundaries[i] is the position of the start of child i along the axis;
    // boundaries[N] is the container's far edge. A seam sits on each interior
    // boundary (between child i and i+1).
    const boundaries: number[] = [start];
    for (let childIndex = 0; childIndex < node.children.length; childIndex += 1) {
      boundaries.push(boundaries[childIndex] + extents[childIndex]);
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

/** A split's sizes, as fractions summing to 1, that match what the floor hold shows. */
export interface HeldSplitSizes {
  splitId: string;
  sizes: number[];
}

/**
 * The sizes that make `tree` match the layout `resolveTileLayout` shows in
 * `container` under the `minPane` hold: one entry per split the hold moves off
 * its stored fractions, and none where it moves nothing. A host adopts them
 * before it resizes, so the panes grow or shrink from the proportions on screen
 * rather than from a seam an earlier, wider layout left: two panes the floor
 * shows even at a panel's minimum grow evenly.
 */
export function heldSplitSizes(tree: TileNode, container: ContainerSize, gapPx: number, minPane: ContainerSize): HeldSplitSizes[] {
  const held: HeldSplitSizes[] = [];
  const gapHalf = gapPx / 2;
  const visit = (node: TileNode, width: number, height: number): void => {
    if (node.kind === 'leaf') return;
    const horizontal = node.direction === 'horizontal';
    const extent = horizontal ? width : height;
    if (extent <= 0) return;
    const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;
    const desired = node.sizes.map((size) => (extent * size) / total);
    const extents = holdMinimums(desired, node.children.map((child) => minimumExtent(child, node.direction, minPane)), extent);
    if (extents.some((value, index) => Math.abs(value - desired[index]) > 0.5)) {
      held.push({ splitId: node.id, sizes: extents.map((value) => value / extent) });
    }
    const lastChild = node.children.length - 1;
    node.children.forEach((child, index) => {
      const inset = (index > 0 ? gapHalf : 0) + (index < lastChild ? gapHalf : 0);
      const childExtent = Math.max(0, extents[index] - inset);
      visit(child, horizontal ? childExtent : width, horizontal ? height : childExtent);
    });
  };
  visit(tree, container.width, container.height);
  return held;
}
