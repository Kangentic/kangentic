/**
 * Pure, immutable operations on the logical tile tree (`TileNode`). No React, no
 * store, no DOM. Every mutator returns a NEW tree (or null) and leaves the input
 * untouched, so the store can swap references and React re-renders cleanly.
 *
 * Node ids (split ids, leaf ids) are minted by the store, which owns a counter;
 * these helpers never generate ids so they stay deterministic and testable.
 */

import type { TileNode } from '../store/types';

/** Which side of a target pane a newly-docked window lands on. 'left'/'right'
 *  make a horizontal (side-by-side) split; 'top'/'bottom' a vertical (stacked)
 *  one. The new window is child `a` for 'left'/'top', child `b` otherwise. */
export type TileInsertSide = 'left' | 'right' | 'top' | 'bottom';

/** A tiled pane may not shrink below this fraction of its split (each side). */
export const MIN_TILE_RATIO = 0.1;
export const MAX_TILE_RATIO = 0.9;

export function clampTileRatio(ratio: number): number {
  return Math.min(MAX_TILE_RATIO, Math.max(MIN_TILE_RATIO, ratio));
}

/** Does any leaf in `tree` reference `windowId`? */
export function treeContainsWindow(tree: TileNode | null, windowId: string): boolean {
  if (!tree) return false;
  if (tree.kind === 'leaf') return tree.windowId === windowId;
  return treeContainsWindow(tree.a, windowId) || treeContainsWindow(tree.b, windowId);
}

/** All window ids referenced by leaves, in left-to-right / top-to-bottom order. */
export function collectWindowIds(tree: TileNode | null): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.windowId];
  return [...collectWindowIds(tree.a), ...collectWindowIds(tree.b)];
}

/**
 * Remove the leaf for `windowId` and promote its sibling into the removed
 * split's place (the sibling subtree expands to fill the freed space). Returns
 * the new tree, or null if the tree becomes empty (the last window left).
 */
export function removeWindowFromTree(tree: TileNode | null, windowId: string): TileNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.windowId === windowId ? null : tree;
  const nextA = removeWindowFromTree(tree.a, windowId);
  const nextB = removeWindowFromTree(tree.b, windowId);
  // A whole child collapsed to nothing -> promote the other child up a level.
  if (nextA === null) return nextB;
  if (nextB === null) return nextA;
  if (nextA === tree.a && nextB === tree.b) return tree; // untouched subtree
  return { ...tree, a: nextA, b: nextB };
}

/**
 * Insert a new leaf (`newWindowId`) beside the leaf for `targetWindowId`,
 * splitting that pane in two. The target's existing leaf is preserved (id and
 * all) as one child; the new leaf becomes the other, ordered + directed by
 * `side`. Every other node is untouched (same reference where unchanged). The
 * split/leaf ids are supplied by the caller (the store owns the id counter), so
 * this stays pure + deterministic.
 *
 * Returns the input tree unchanged if `targetWindowId` is not present (defensive;
 * the caller only docks onto a window it found in the tree).
 */
export function insertWindowIntoTree(
  tree: TileNode,
  targetWindowId: string,
  newWindowId: string,
  newLeafId: string,
  newSplitId: string,
  side: TileInsertSide,
): TileNode {
  const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
  const newWindowFirst = side === 'left' || side === 'top';
  const replace = (node: TileNode): TileNode => {
    if (node.kind === 'leaf') {
      if (node.windowId !== targetWindowId) return node;
      const newLeaf: TileNode = { kind: 'leaf', id: newLeafId, windowId: newWindowId };
      return {
        kind: 'split',
        id: newSplitId,
        direction,
        ratio: 0.5,
        a: newWindowFirst ? newLeaf : node,
        b: newWindowFirst ? node : newLeaf,
      };
    }
    const nextA = replace(node.a);
    const nextB = replace(node.b);
    if (nextA === node.a && nextB === node.b) return node;
    return { ...node, a: nextA, b: nextB };
  };
  return replace(tree);
}

/** Set the ratio (clamped) of the split with `splitId`. Returns a new tree. */
export function setSplitRatio(tree: TileNode, splitId: string, ratio: number): TileNode {
  if (tree.kind === 'leaf') return tree;
  if (tree.id === splitId) return { ...tree, ratio: clampTileRatio(ratio) };
  const nextA = setSplitRatio(tree.a, splitId, ratio);
  const nextB = setSplitRatio(tree.b, splitId, ratio);
  if (nextA === tree.a && nextB === tree.b) return tree;
  return { ...tree, a: nextA, b: nextB };
}
