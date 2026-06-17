import { describe, it, expect } from 'vitest';
import { resolveTileLayout } from '../../src/renderer/window-manager/tiling/resolve-layout';
import {
  treeContainsWindow,
  collectWindowIds,
  removeWindowFromTree,
  insertWindowIntoTree,
  wrapTreeWithRoot,
  setSeamRatio,
  clampTileRatio,
  MIN_TILE_RATIO,
  MAX_TILE_RATIO,
} from '../../src/renderer/window-manager/tiling/tree-ops';
import type { TileNode } from '../../src/renderer/window-manager/store/types';

function leaf(id: string, windowId: string): TileNode {
  return { kind: 'leaf', id, windowId };
}
function hsplit(id: string, children: TileNode[], sizes: number[]): TileNode {
  return { kind: 'split', id, direction: 'horizontal', children, sizes };
}
function vsplit(id: string, children: TileNode[], sizes: number[]): TileNode {
  return { kind: 'split', id, direction: 'vertical', children, sizes };
}
type Split = Extract<TileNode, { kind: 'split' }>;

const CONTAINER = { width: 1000, height: 800 };
const SEAM = 6;

describe('resolveTileLayout', () => {
  it('a single leaf fills the whole container with no seams', () => {
    const layout = resolveTileLayout(leaf('l1', 'w1'), CONTAINER, SEAM, SEAM);
    expect(layout.rects.get('w1')).toEqual({ left: 0, top: 0, width: 1000, height: 800 });
    expect(layout.seams).toEqual([]);
  });

  it('splits width evenly for a horizontal 50/50 split, reserving the seam', () => {
    const layout = resolveTileLayout(hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]), CONTAINER, SEAM, SEAM);
    expect(layout.rects.get('wa')).toEqual({ left: 0, top: 0, width: 497, height: 800 });
    expect(layout.rects.get('wb')).toEqual({ left: 503, top: 0, width: 497, height: 800 });
    expect(layout.seams).toEqual([
      {
        splitId: 's1',
        index: 0,
        direction: 'horizontal',
        rect: { left: 497, top: 0, width: 6, height: 800 },
        bounds: { left: 0, top: 0, width: 1000, height: 800 },
      },
    ]);
    expect(layout.rects.get('wa')!.width + SEAM + layout.rects.get('wb')!.width).toBe(1000);
  });

  it('tiles three children as equal thirds with two seams (the N-ary case)', () => {
    const tree = vsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb'), leaf('lc', 'wc')], [1 / 3, 1 / 3, 1 / 3]);
    const layout = resolveTileLayout(tree, CONTAINER, 0, 0);
    // Three equal rows: 800 / 3 each, stacked, full width.
    const wa = layout.rects.get('wa')!;
    expect([wa.left, wa.top, wa.width]).toEqual([0, 0, 1000]);
    expect(wa.height).toBeCloseTo(800 / 3, 6);
    expect(layout.rects.get('wb')!.top).toBeCloseTo(800 / 3, 6);
    expect(layout.rects.get('wc')!.top).toBeCloseTo((800 * 2) / 3, 6);
    // Two seams, one per adjacent pair, each bounding only its pair.
    expect(layout.seams).toHaveLength(2);
    expect(layout.seams.map((seam) => seam.index)).toEqual([0, 1]);
    expect(layout.seams[0].bounds.height).toBeCloseTo((800 * 2) / 3, 6); // wa + wb span
  });

  it('honors a non-even split (the seam stays centered on the boundary)', () => {
    const layout = resolveTileLayout(hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.3, 0.7]), CONTAINER, SEAM, SEAM);
    expect(layout.rects.get('wa')!.width).toBe(297);
    expect(layout.rects.get('wb')).toEqual({ left: 303, top: 0, width: 697, height: 800 });
  });

  it('cascades nested splits (left column + stacked right column)', () => {
    const tree = hsplit(
      's1',
      [leaf('la', 'wa'), vsplit('s2', [leaf('lb', 'wb'), leaf('lc', 'wc')], [0.5, 0.5])],
      [0.5, 0.5],
    );
    const layout = resolveTileLayout(tree, CONTAINER, SEAM, SEAM);
    expect(layout.rects.get('wa')).toEqual({ left: 0, top: 0, width: 497, height: 800 });
    expect(layout.rects.get('wb')).toEqual({ left: 503, top: 0, width: 497, height: 397 });
    expect(layout.rects.get('wc')).toEqual({ left: 503, top: 403, width: 497, height: 397 });
    expect(layout.seams.map((seam) => seam.splitId).sort()).toEqual(['s1', 's2']);
  });
});

describe('tile tree-ops', () => {
  it('treeContainsWindow finds leaves at any depth', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), vsplit('s2', [leaf('lb', 'wb'), leaf('lc', 'wc')], [0.5, 0.5])], [0.5, 0.5]);
    expect(treeContainsWindow(tree, 'wb')).toBe(true);
    expect(treeContainsWindow(tree, 'wz')).toBe(false);
    expect(treeContainsWindow(null, 'wa')).toBe(false);
  });

  it('collectWindowIds returns leaves in order', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), vsplit('s2', [leaf('lb', 'wb'), leaf('lc', 'wc')], [0.5, 0.5])], [0.5, 0.5]);
    expect(collectWindowIds(tree)).toEqual(['wa', 'wb', 'wc']);
  });

  it('removeWindowFromTree collapses a 2-child container into its sole survivor', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]);
    expect(removeWindowFromTree(tree, 'wa')).toEqual(leaf('lb', 'wb'));
  });

  it('removeWindowFromTree drops one child of a 3-way container and renormalises', () => {
    const tree = vsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb'), leaf('lc', 'wc')], [0.25, 0.25, 0.5]);
    const next = removeWindowFromTree(tree, 'wb') as Split;
    expect(collectWindowIds(next)).toEqual(['wa', 'wc']);
    // Remaining 0.25 / 0.5 renormalise to sum 1 (1/3, 2/3).
    expect(next.sizes[0]).toBeCloseTo(1 / 3, 6);
    expect(next.sizes[1]).toBeCloseTo(2 / 3, 6);
  });

  it('removeWindowFromTree collapses a nested container when one leaf goes', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), vsplit('s2', [leaf('lb', 'wb'), leaf('lc', 'wc')], [0.5, 0.5])], [0.5, 0.5]);
    expect(removeWindowFromTree(tree, 'wb')).toEqual(hsplit('s1', [leaf('la', 'wa'), leaf('lc', 'wc')], [0.5, 0.5]));
  });

  it('removeWindowFromTree returns null when the last window is removed', () => {
    expect(removeWindowFromTree(leaf('l1', 'w1'), 'w1')).toBeNull();
  });

  it('removeWindowFromTree leaves an unrelated tree untouched (same reference)', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]);
    expect(removeWindowFromTree(tree, 'wz')).toBe(tree);
  });

  it('setSeamRatio resizes the target pair, clamped, immutably', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), vsplit('s2', [leaf('lb', 'wb'), leaf('lc', 'wc')], [0.5, 0.5])], [0.5, 0.5]);
    const next = setSeamRatio(tree, 's2', 0, 0.7) as Split;
    expect(next.children[0]).toBe(tree.children[0]); // untouched subtree keeps its reference
    const inner = next.children[1] as Split;
    expect(inner.sizes[0]).toBeCloseTo(0.7, 6);
    expect(inner.sizes[1]).toBeCloseTo(0.3, 6);
    // Original is untouched.
    expect((tree.children[1] as Split).sizes).toEqual([0.5, 0.5]);
  });

  it('clampTileRatio keeps ratios inside [MIN, MAX]', () => {
    expect(clampTileRatio(0.5)).toBe(0.5);
    expect(clampTileRatio(0.99)).toBe(MAX_TILE_RATIO);
    expect(clampTileRatio(0.01)).toBe(MIN_TILE_RATIO);
  });

  it('insertWindowIntoTree wraps a lone leaf, new window on the requested side', () => {
    expect(insertWindowIntoTree(leaf('la', 'wa'), 'wa', 'wn', 'ln', 'sn', 'right')).toEqual(
      hsplit('sn', [leaf('la', 'wa'), leaf('ln', 'wn')], [0.5, 0.5]),
    );
    expect(insertWindowIntoTree(leaf('la', 'wa'), 'wa', 'wn', 'ln', 'sn', 'left')).toEqual(
      hsplit('sn', [leaf('ln', 'wn'), leaf('la', 'wa')], [0.5, 0.5]),
    );
    expect(insertWindowIntoTree(leaf('la', 'wa'), 'wa', 'wn', 'ln', 'sn', 'bottom')).toEqual(
      vsplit('sn', [leaf('la', 'wa'), leaf('ln', 'wn')], [0.5, 0.5]),
    );
  });

  it('insertWindowIntoTree APPENDS a sibling (equal shares) when the target container shares the axis', () => {
    // A vertical column wa over wb; dock wn below wb (vertical matches) -> 3 equal rows in s1.
    const tree = vsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]);
    const next = insertWindowIntoTree(tree, 'wb', 'wn', 'ln', 'sn', 'bottom') as Split;
    expect(next.id).toBe('s1'); // appended in place, not nested
    expect(collectWindowIds(next)).toEqual(['wa', 'wb', 'wn']);
    expect(next.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('insertWindowIntoTree nests a fresh split when the drop axis differs from the container', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]);
    // Dock wn BELOW wb (vertical differs from the horizontal row) -> wb's cell stacks wb over wn.
    const next = insertWindowIntoTree(tree, 'wb', 'wn', 'ln', 'sn', 'bottom') as Split;
    expect(next.children[0]).toBe(tree.children[0]); // wa untouched ref
    expect(next.children[1]).toEqual(vsplit('sn', [leaf('lb', 'wb'), leaf('ln', 'wn')], [0.5, 0.5]));
    expect(next.sizes).toEqual([0.5, 0.5]); // parent shares unchanged
    expect(collectWindowIds(next)).toEqual(['wa', 'wb', 'wn']);
  });

  it('insertWindowIntoTree reaches a deep target, appending into its matching-axis container', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), vsplit('s2', [leaf('lb', 'wb'), leaf('lc', 'wc')], [0.5, 0.5])], [0.5, 0.5]);
    const next = insertWindowIntoTree(tree, 'wc', 'wn', 'ln', 'sn', 'bottom') as Split;
    expect(next.children[0]).toBe(tree.children[0]); // left column untouched
    const right = next.children[1] as Split;
    expect(right.id).toBe('s2');
    expect(collectWindowIds(next)).toEqual(['wa', 'wb', 'wc', 'wn']);
    expect(right.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('insertWindowIntoTree returns the tree unchanged when the target is absent', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]);
    expect(insertWindowIntoTree(tree, 'wz', 'wn', 'ln', 'sn', 'left')).toBe(tree);
  });

  it('wrapTreeWithRoot wraps under a new 2-child root when the axis differs', () => {
    const tree = vsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]); // a column
    const newLeaf = leaf('ln', 'wn');
    expect(wrapTreeWithRoot(tree, newLeaf, 'left', 'sr')).toEqual(hsplit('sr', [leaf('ln', 'wn'), tree], [0.5, 0.5]));
    expect(wrapTreeWithRoot(tree, newLeaf, 'right', 'sr')).toEqual(hsplit('sr', [tree, leaf('ln', 'wn')], [0.5, 0.5]));
    const wrapped = wrapTreeWithRoot(tree, newLeaf, 'left', 'sr') as Split;
    expect(wrapped.children[1]).toBe(tree); // existing tree kept by reference
  });

  it('wrapTreeWithRoot APPENDS to the root (equal shares) when the axis matches', () => {
    const tree = hsplit('s1', [leaf('la', 'wa'), leaf('lb', 'wb')], [0.5, 0.5]); // a row
    const newLeaf = leaf('ln', 'wn');
    const right = wrapTreeWithRoot(tree, newLeaf, 'right', 'sr') as Split;
    expect(right.id).toBe('s1'); // appended, not nested
    expect(collectWindowIds(right)).toEqual(['wa', 'wb', 'wn']);
    expect(right.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const left = wrapTreeWithRoot(tree, newLeaf, 'left', 'sr') as Split;
    expect(collectWindowIds(left)).toEqual(['wn', 'wa', 'wb']);
  });
});
