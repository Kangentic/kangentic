import { describe, it, expect } from 'vitest';
import { resolveTileLayout } from '../../src/renderer/window-manager/tiling/resolve-layout';
import {
  treeContainsWindow,
  collectWindowIds,
  removeWindowFromTree,
  insertWindowIntoTree,
  setSplitRatio,
  clampTileRatio,
  MIN_TILE_RATIO,
  MAX_TILE_RATIO,
} from '../../src/renderer/window-manager/tiling/tree-ops';
import type { TileNode } from '../../src/renderer/window-manager/store/types';

function leaf(id: string, windowId: string): TileNode {
  return { kind: 'leaf', id, windowId };
}
function hsplit(id: string, a: TileNode, b: TileNode, ratio: number): TileNode {
  return { kind: 'split', id, direction: 'horizontal', a, b, ratio };
}
function vsplit(id: string, a: TileNode, b: TileNode, ratio: number): TileNode {
  return { kind: 'split', id, direction: 'vertical', a, b, ratio };
}

const CONTAINER = { width: 1000, height: 800 };
const SEAM = 6;

describe('resolveTileLayout', () => {
  it('a single leaf fills the whole container with no seams', () => {
    const layout = resolveTileLayout(leaf('l1', 'w1'), CONTAINER, SEAM, SEAM);
    expect(layout.rects.get('w1')).toEqual({ left: 0, top: 0, width: 1000, height: 800 });
    expect(layout.seams).toEqual([]);
  });

  it('splits width evenly for a horizontal 50/50 split, reserving the seam', () => {
    const layout = resolveTileLayout(hsplit('s1', leaf('la', 'wa'), leaf('lb', 'wb'), 0.5), CONTAINER, SEAM, SEAM);
    // splitX = 500, half-seam = 3 -> each pane 497 wide, full height, seam between.
    expect(layout.rects.get('wa')).toEqual({ left: 0, top: 0, width: 497, height: 800 });
    expect(layout.rects.get('wb')).toEqual({ left: 503, top: 0, width: 497, height: 800 });
    expect(layout.seams).toEqual([
      {
        splitId: 's1',
        direction: 'horizontal',
        rect: { left: 497, top: 0, width: 6, height: 800 },
        bounds: { left: 0, top: 0, width: 1000, height: 800 },
      },
    ]);
    // Panes + seam exactly tile the container width.
    const a = layout.rects.get('wa')!;
    const b = layout.rects.get('wb')!;
    expect(a.width + SEAM + b.width).toBe(1000);
  });

  it('honors a non-even ratio (the seam stays centered on the split line)', () => {
    const layout = resolveTileLayout(hsplit('s1', leaf('la', 'wa'), leaf('lb', 'wb'), 0.3), CONTAINER, SEAM, SEAM);
    // splitX = 300 -> left pane 297, right pane 697.
    expect(layout.rects.get('wa')!.width).toBe(297);
    expect(layout.rects.get('wb')).toEqual({ left: 303, top: 0, width: 697, height: 800 });
  });

  it('splits height for a vertical split (stacked, horizontal seam)', () => {
    const layout = resolveTileLayout(vsplit('s1', leaf('la', 'wa'), leaf('lb', 'wb'), 0.5), CONTAINER, SEAM, SEAM);
    expect(layout.rects.get('wa')).toEqual({ left: 0, top: 0, width: 1000, height: 397 });
    expect(layout.rects.get('wb')).toEqual({ left: 0, top: 403, width: 1000, height: 397 });
    expect(layout.seams[0]).toEqual({
      splitId: 's1',
      direction: 'vertical',
      rect: { left: 0, top: 397, width: 1000, height: 6 },
      bounds: { left: 0, top: 0, width: 1000, height: 800 },
    });
  });

  it('cascades nested splits (left column + stacked right column)', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), vsplit('s2', leaf('lb', 'wb'), leaf('lc', 'wc'), 0.5), 0.5);
    const layout = resolveTileLayout(tree, CONTAINER, SEAM, SEAM);
    // wa: full-height left column.
    expect(layout.rects.get('wa')).toEqual({ left: 0, top: 0, width: 497, height: 800 });
    // wb / wc: top / bottom of the right column (left 503, width 497).
    expect(layout.rects.get('wb')).toEqual({ left: 503, top: 0, width: 497, height: 397 });
    expect(layout.rects.get('wc')).toEqual({ left: 503, top: 403, width: 497, height: 397 });
    // One seam per split node.
    expect(layout.seams.map((s) => s.splitId).sort()).toEqual(['s1', 's2']);
  });
});

describe('tile tree-ops', () => {
  it('treeContainsWindow finds leaves at any depth', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), vsplit('s2', leaf('lb', 'wb'), leaf('lc', 'wc'), 0.5), 0.5);
    expect(treeContainsWindow(tree, 'wb')).toBe(true);
    expect(treeContainsWindow(tree, 'wz')).toBe(false);
    expect(treeContainsWindow(null, 'wa')).toBe(false);
  });

  it('collectWindowIds returns leaves in order', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), vsplit('s2', leaf('lb', 'wb'), leaf('lc', 'wc'), 0.5), 0.5);
    expect(collectWindowIds(tree)).toEqual(['wa', 'wb', 'wc']);
  });

  it('removeWindowFromTree promotes the sibling into the split position', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), leaf('lb', 'wb'), 0.5);
    expect(removeWindowFromTree(tree, 'wa')).toEqual(leaf('lb', 'wb'));
  });

  it('removeWindowFromTree collapses a nested split when one leaf goes', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), vsplit('s2', leaf('lb', 'wb'), leaf('lc', 'wc'), 0.5), 0.5);
    // Removing wb collapses the inner split, promoting wc into the right slot.
    expect(removeWindowFromTree(tree, 'wb')).toEqual(hsplit('s1', leaf('la', 'wa'), leaf('lc', 'wc'), 0.5));
  });

  it('removeWindowFromTree returns null when the last window is removed', () => {
    expect(removeWindowFromTree(leaf('l1', 'w1'), 'w1')).toBeNull();
  });

  it('removeWindowFromTree leaves an unrelated tree untouched (same reference)', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), leaf('lb', 'wb'), 0.5);
    expect(removeWindowFromTree(tree, 'wz')).toBe(tree);
  });

  it('setSplitRatio updates the target split, clamped, immutably', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), vsplit('s2', leaf('lb', 'wb'), leaf('lc', 'wc'), 0.5), 0.5);
    const next = setSplitRatio(tree, 's2', 0.7);
    expect((next as Extract<TileNode, { kind: 'split' }>).a).toBe(tree.a); // untouched subtree keeps its reference
    const inner = (next as Extract<TileNode, { kind: 'split' }>).b as Extract<TileNode, { kind: 'split' }>;
    expect(inner.ratio).toBe(0.7);
    // Original is untouched.
    expect(((tree.b as Extract<TileNode, { kind: 'split' }>).ratio)).toBe(0.5);
  });

  it('clampTileRatio keeps ratios inside [MIN, MAX]', () => {
    expect(clampTileRatio(0.5)).toBe(0.5);
    expect(clampTileRatio(0.99)).toBe(MAX_TILE_RATIO);
    expect(clampTileRatio(0.01)).toBe(MIN_TILE_RATIO);
  });

  it('insertWindowIntoTree splits a leaf horizontally, new window on the requested side', () => {
    const tree = leaf('la', 'wa');
    // Dock the new window (wn) onto wa's RIGHT -> horizontal split, wa | wn.
    const next = insertWindowIntoTree(tree, 'wa', 'wn', 'ln', 'sn', 'right');
    expect(next).toEqual(hsplit('sn', leaf('la', 'wa'), leaf('ln', 'wn'), 0.5));
  });

  it('insertWindowIntoTree honors left/top ordering (new window becomes child a)', () => {
    const left = insertWindowIntoTree(leaf('la', 'wa'), 'wa', 'wn', 'ln', 'sn', 'left');
    expect(left).toEqual(hsplit('sn', leaf('ln', 'wn'), leaf('la', 'wa'), 0.5));
    const top = insertWindowIntoTree(leaf('la', 'wa'), 'wa', 'wn', 'ln', 'sn', 'top');
    expect(top).toEqual(vsplit('sn', leaf('ln', 'wn'), leaf('la', 'wa'), 0.5));
    const bottom = insertWindowIntoTree(leaf('la', 'wa'), 'wa', 'wn', 'ln', 'sn', 'bottom');
    expect(bottom).toEqual(vsplit('sn', leaf('la', 'wa'), leaf('ln', 'wn'), 0.5));
  });

  it('insertWindowIntoTree targets a leaf deep in the tree, leaving siblings untouched', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), vsplit('s2', leaf('lb', 'wb'), leaf('lc', 'wc'), 0.5), 0.5);
    const next = insertWindowIntoTree(tree, 'wc', 'wn', 'ln', 'sn', 'bottom') as Extract<TileNode, { kind: 'split' }>;
    // The left column (wa) keeps its exact reference (untouched subtree).
    expect(next.a).toBe(tree.a);
    // wc's leaf became a vertical split wc-over-wn.
    const right = next.b as Extract<TileNode, { kind: 'split' }>;
    expect(right.b).toEqual(vsplit('sn', leaf('lc', 'wc'), leaf('ln', 'wn'), 0.5));
    expect(collectWindowIds(next)).toEqual(['wa', 'wb', 'wc', 'wn']);
  });

  it('insertWindowIntoTree returns the tree unchanged when the target is absent', () => {
    const tree = hsplit('s1', leaf('la', 'wa'), leaf('lb', 'wb'), 0.5);
    expect(insertWindowIntoTree(tree, 'wz', 'wn', 'ln', 'sn', 'left')).toBe(tree);
  });
});
