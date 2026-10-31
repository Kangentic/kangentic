/**
 * Pure, immutable operations on the logical N-ary tile tree (`TileNode`). No
 * React, no store, no DOM. Every mutator returns a NEW tree (or null) and leaves
 * the input untouched, so the store can swap references and React re-renders
 * cleanly.
 *
 * A split is a row/column CONTAINER of two-or-more children (golden-layout / i3
 * model). Inserting a window into a container whose axis matches just appends a
 * child and re-distributes to equal shares (true 1/N tiling); the other axis
 * nests a fresh 2-child container at the target's cell. Removing a window drops
 * its child and renormalises the siblings; a container that drops to one child
 * collapses into that child.
 *
 * Node ids (split ids, leaf ids) are minted by the store, which owns a counter;
 * these helpers never generate ids so they stay deterministic and testable.
 */

import type { TileNode } from '../store/types';

/** Which side of a target pane a newly-docked window lands on. 'left'/'right'
 *  make a horizontal (side-by-side) split; 'top'/'bottom' a vertical (stacked)
 *  one. The new window goes BEFORE the target for 'left'/'top', after otherwise. */
export type TileInsertSide = 'left' | 'right' | 'top' | 'bottom';

/** A tiled pane may not shrink below this fraction of a resized PAIR (each side). */
export const MIN_TILE_RATIO = 0.1;
export const MAX_TILE_RATIO = 0.9;

export function clampTileRatio(ratio: number): number {
  return Math.min(MAX_TILE_RATIO, Math.max(MIN_TILE_RATIO, ratio));
}

/** N equal sizes summing to 1. */
export function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** Rescale sizes to sum to 1 (used after dropping a child). */
function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return sizes.map((size) => size / total);
}

function directionFor(side: TileInsertSide): 'horizontal' | 'vertical' {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
}

/** Does any leaf in `tree` reference `windowId`? */
export function treeContainsWindow(tree: TileNode | null, windowId: string): boolean {
  if (!tree) return false;
  if (tree.kind === 'leaf') return tree.windowId === windowId;
  return tree.children.some((child) => treeContainsWindow(child, windowId));
}

/** All window ids referenced by leaves, in left-to-right / top-to-bottom order. */
export function collectWindowIds(tree: TileNode | null): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.windowId];
  return tree.children.flatMap((child) => collectWindowIds(child));
}

/**
 * Swap two windows between their leaves: each takes the other's place, and the
 * leaves, splits and sizes stay exactly as they were. Returns the same tree when
 * either window is not in it, or they are the same window.
 */
export function swapWindowsInTree(tree: TileNode, firstWindowId: string, secondWindowId: string): TileNode {
  if (firstWindowId === secondWindowId) return tree;
  if (!treeContainsWindow(tree, firstWindowId) || !treeContainsWindow(tree, secondWindowId)) return tree;
  const swap = (node: TileNode): TileNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(swap) };
    if (node.windowId === firstWindowId) return { ...node, windowId: secondWindowId };
    if (node.windowId === secondWindowId) return { ...node, windowId: firstWindowId };
    return node;
  };
  return swap(tree);
}

/**
 * Remove the leaf for `windowId`. Its container drops that child and renormalises
 * the remaining siblings to fill the freed space; a container left with a single
 * child collapses into that child. Returns the new tree, or null if the tree
 * becomes empty (the last window left).
 */
export function removeWindowFromTree(tree: TileNode | null, windowId: string): TileNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.windowId === windowId ? null : tree;

  const nextChildren: TileNode[] = [];
  const nextSizes: number[] = [];
  let changed = false;
  tree.children.forEach((child, childIndex) => {
    const result = removeWindowFromTree(child, windowId);
    if (result === null) {
      changed = true; // child dropped
      return;
    }
    if (result !== child) changed = true;
    nextChildren.push(result);
    nextSizes.push(tree.sizes[childIndex]);
  });

  if (!changed) return tree;
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0]; // container collapses to its sole child
  return { ...tree, children: nextChildren, sizes: normalizeSizes(nextSizes) };
}

/**
 * Insert a new leaf (`newWindowId`) next to the leaf for `targetWindowId`.
 *  - Same axis as the target's container: APPEND as a sibling and re-distribute
 *    that container to equal shares (so three same-axis panes are true thirds).
 *  - Other axis: replace the target's cell with a fresh 2-child split.
 * Every untouched node keeps its reference. Returns the tree unchanged if the
 * target is absent (defensive).
 */
export function insertWindowIntoTree(
  tree: TileNode,
  targetWindowId: string,
  newWindowId: string,
  newLeafId: string,
  newSplitId: string,
  side: TileInsertSide,
): TileNode {
  const direction = directionFor(side);
  const newWindowFirst = side === 'left' || side === 'top';
  const newLeaf: TileNode = { kind: 'leaf', id: newLeafId, windowId: newWindowId };

  const insert = (node: TileNode): TileNode => {
    if (node.kind === 'leaf') {
      // Target is the whole tree (a lone leaf, no container): wrap in a 2-child split.
      if (node.windowId !== targetWindowId) return node;
      return {
        kind: 'split',
        id: newSplitId,
        direction,
        children: newWindowFirst ? [newLeaf, node] : [node, newLeaf],
        sizes: [0.5, 0.5],
      };
    }

    const targetChildIndex = node.children.findIndex(
      (child) => child.kind === 'leaf' && child.windowId === targetWindowId,
    );
    if (targetChildIndex >= 0) {
      if (node.direction === direction) {
        // Same axis: append the new leaf beside the target, equal shares.
        const insertAt = newWindowFirst ? targetChildIndex : targetChildIndex + 1;
        const children = [...node.children];
        children.splice(insertAt, 0, newLeaf);
        return { ...node, children, sizes: equalSizes(children.length) };
      }
      // Cross axis: nest a 2-child split in the target's cell (keeps the cell's size).
      const targetLeaf = node.children[targetChildIndex];
      const nested: TileNode = {
        kind: 'split',
        id: newSplitId,
        direction,
        children: newWindowFirst ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf],
        sizes: [0.5, 0.5],
      };
      const children = [...node.children];
      children[targetChildIndex] = nested;
      return { ...node, children };
    }

    // Target is deeper: recurse, replacing only the changed child.
    let changed = false;
    const children = node.children.map((child) => {
      const result = insert(child);
      if (result !== child) changed = true;
      return result;
    });
    return changed ? { ...node, children } : node;
  };

  return insert(tree);
}

/**
 * Grow the ONE tree to span a larger region by adding `newSubtree` on `side`.
 *  - If the existing root is a split of the SAME axis, APPEND `newSubtree` as a
 *    root-level child (equal shares) so the tree stays flat (N-ary).
 *  - Otherwise wrap the whole tree under a new 2-child root split.
 * This is how an edge-snapped window (a leaf) or a merged lone-window pair (a
 * 2-leaf split) joins the tiling as a full root pane with its own seam.
 */
export function wrapTreeWithRoot(
  existingTree: TileNode,
  newSubtree: TileNode,
  side: TileInsertSide,
  newSplitId: string,
): TileNode {
  const direction = directionFor(side);
  const newSubtreeFirst = side === 'left' || side === 'top';

  if (existingTree.kind === 'split' && existingTree.direction === direction) {
    const children = newSubtreeFirst
      ? [newSubtree, ...existingTree.children]
      : [...existingTree.children, newSubtree];
    return { ...existingTree, children, sizes: equalSizes(children.length) };
  }
  return {
    kind: 'split',
    id: newSplitId,
    direction,
    children: newSubtreeFirst ? [newSubtree, existingTree] : [existingTree, newSubtree],
    sizes: [0.5, 0.5],
  };
}

/**
 * Resize one seam: the boundary between `children[index]` and `children[index+1]`
 * of the split with `splitId`. `pairRatio` (clamped) is the fraction of the
 * PAIR's combined size given to the first of the two; the rest of the container
 * is untouched. Returns a new tree.
 */
export function setSeamRatio(tree: TileNode, splitId: string, index: number, pairRatio: number): TileNode {
  if (tree.kind === 'leaf') return tree;
  if (tree.id === splitId) {
    if (index < 0 || index + 1 >= tree.sizes.length) return tree;
    const pairSum = tree.sizes[index] + tree.sizes[index + 1];
    const clamped = clampTileRatio(pairRatio);
    const sizes = [...tree.sizes];
    sizes[index] = pairSum * clamped;
    sizes[index + 1] = pairSum * (1 - clamped);
    return { ...tree, sizes };
  }
  let changed = false;
  const children = tree.children.map((child) => {
    const result = setSeamRatio(child, splitId, index, pairRatio);
    if (result !== child) changed = true;
    return result;
  });
  return changed ? { ...tree, children } : tree;
}

/**
 * Set every child size of the split with `splitId` at once (normalized to sum
 * to 1). For adopting a layout the pane floor holds (`heldSplitSizes`), which
 * may move room between panes no single seam's pair could. Returns the same tree
 * when there is no such split, the count does not match, or a size is not positive.
 */
export function setSplitSizes(tree: TileNode, splitId: string, sizes: readonly number[]): TileNode {
  if (tree.kind === 'leaf') return tree;
  if (tree.id === splitId) {
    if (sizes.length !== tree.children.length || sizes.some((size) => !(size > 0))) return tree;
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return { ...tree, sizes: sizes.map((size) => size / total) };
  }
  let changed = false;
  const children = tree.children.map((child) => {
    const result = setSplitSizes(child, splitId, sizes);
    if (result !== child) changed = true;
    return result;
  });
  return changed ? { ...tree, children } : tree;
}

/**
 * The share of its PAIR a seam gives the first of the two panes, as
 * `setSeamRatio` takes it. Null when the tree holds no such seam.
 */
export function seamPairRatio(tree: TileNode, splitId: string, index: number): number | null {
  if (tree.kind === 'leaf') return null;
  if (tree.id === splitId) {
    if (index < 0 || index + 1 >= tree.sizes.length) return null;
    const pairSum = tree.sizes[index] + tree.sizes[index + 1];
    return pairSum > 0 ? tree.sizes[index] / pairSum : null;
  }
  for (const child of tree.children) {
    const ratio = seamPairRatio(child, splitId, index);
    if (ratio !== null) return ratio;
  }
  return null;
}
