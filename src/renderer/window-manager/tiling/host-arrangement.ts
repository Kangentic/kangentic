/**
 * The fixed layouts of a HOST-ARRANGED layer (the Command Terminal panel): its
 * windows always fill the overlay, in a shape set by how many there are.
 *
 * - 1: the lone window floats over the whole overlay (a tree needs two leaves).
 * - 2: side by side.
 * - 3: one tall window on the left, two stacked on the right.
 * - 4: a two by two grid split by COLUMNS (one seam between the columns, one
 *   inside each), so dragging a column's own seam moves only that column.
 *
 * Pure: the store's `arrangeTiles` builds from `hostArrangementTree`, and the
 * layer asks `isHostArranged` before rebuilding, so a seam the user dragged
 * holds until the count changes.
 */

import { isWindowDormant } from '../store/types';
import type { FractionalRect, ManagedWindow, TileNode } from '../store/types';
import { resolveTileLayout } from './resolve-layout';

type TileIdFactory = (prefix: 'split' | 'leaf') => string;

function leaf(windowId: string, nextId: TileIdFactory): TileNode {
  return { kind: 'leaf', id: nextId('leaf'), windowId };
}

function split(direction: 'horizontal' | 'vertical', children: TileNode[], nextId: TileIdFactory): TileNode {
  return { kind: 'split', id: nextId('split'), direction, children, sizes: children.map(() => 1 / children.length) };
}

/**
 * The preset tree for `windowIds`, given in reading order, or null below two
 * windows. Only the first four are placed.
 */
export function hostArrangementTree(windowIds: readonly string[], nextId: TileIdFactory): TileNode | null {
  const [first, second, third, fourth] = windowIds;
  if (first === undefined || second === undefined) return null;
  if (third === undefined) return split('horizontal', [leaf(first, nextId), leaf(second, nextId)], nextId);
  if (fourth === undefined) {
    return split('horizontal', [
      leaf(first, nextId),
      split('vertical', [leaf(second, nextId), leaf(third, nextId)], nextId),
    ], nextId);
  }
  // Reading order across the grid is 1 2 on top and 3 4 below, so the left
  // column holds the first and third windows.
  return split('horizontal', [
    split('vertical', [leaf(first, nextId), leaf(third, nextId)], nextId),
    split('vertical', [leaf(second, nextId), leaf(fourth, nextId)], nextId),
  ], nextId);
}

/** The tree's shape, without ids or sizes: `h(l,v(l,l))`. */
function shapeOf(node: TileNode): string {
  if (node.kind === 'leaf') return 'l';
  return `${node.direction === 'horizontal' ? 'h' : 'v'}(${node.children.map(shapeOf).join(',')})`;
}

const TOLERANCE = 1e-6;

function fillsOverlay(rect: FractionalRect): boolean {
  return Math.abs(rect.x) < TOLERANCE && Math.abs(rect.y) < TOLERANCE
    && Math.abs(rect.w - 1) < TOLERANCE && Math.abs(rect.h - 1) < TOLERANCE;
}

/**
 * Whether the layout already is the preset for its window count. Seam sizes do
 * not count, so a layout the user resized by its seams is still arranged.
 */
export function isHostArranged(
  windows: Record<string, ManagedWindow>,
  tileTree: TileNode | null,
  tileTreeRect: FractionalRect,
): boolean {
  const live = Object.values(windows).filter((managedWindow) => !isWindowDormant(managedWindow));
  if (live.length === 0) return tileTree === null;
  if (live.length === 1) {
    return tileTree === null && live[0].state === 'floating' && fillsOverlay(live[0].geometry);
  }
  if (!tileTree || !fillsOverlay(tileTreeRect)) return false;
  if (live.some((managedWindow) => managedWindow.state !== 'tiled')) return false;
  const preset = hostArrangementTree(live.map((managedWindow) => managedWindow.id), () => '');
  return preset !== null && shapeOf(preset) === shapeOf(tileTree);
}

/** The window at `path` (child indexes from the root), or null. */
function windowAt(node: TileNode, path: readonly number[]): string | null {
  let current: TileNode | undefined = node;
  for (const index of path) current = current?.kind === 'split' ? current.children[index] : undefined;
  return current?.kind === 'leaf' ? current.windowId : null;
}

/** Where each preset puts its windows, in reading order, as child paths. */
const PRESET_READING_PATHS: Record<string, number[][]> = {
  'h(l,l)': [[0], [1]],
  'h(l,v(l,l))': [[0], [1, 0], [1, 1]],
  'h(v(l,l),v(l,l))': [[0, 0], [1, 0], [0, 1], [1, 1]],
};

/**
 * The windows of a tile tree in READING order: top to bottom, then left to
 * right, as they appear on screen. A column-first grid lists its windows
 * column by column, so the tree's own order is not what a person sees. A
 * rebuild for a new count reads the old layout this way, so the terminals keep
 * their places.
 *
 * A preset is read by its structure, so dragging its seams never reorders it
 * (a grid whose left seam sits low and right seam high still reads 1 2 3 4).
 * Any other tree, such as one a close just pruned, is read by where its
 * windows sit.
 */
export function windowIdsInReadingOrder(tree: TileNode | null): string[] {
  if (!tree) return [];
  const presetPaths = PRESET_READING_PATHS[shapeOf(tree)];
  if (presetPaths) {
    return presetPaths.map((path) => windowAt(tree, path)).filter((windowId): windowId is string => windowId !== null);
  }
  const layout = resolveTileLayout(tree, { width: 1, height: 1 }, 0, 0, { left: 0, top: 0 });
  // Rounded so a seam's floating-point drift never reorders a row.
  const round = (value: number): number => Math.round(value * 1000);
  return [...layout.rects.entries()]
    .sort(([, first], [, second]) => round(first.top) - round(second.top) || round(first.left) - round(second.left))
    .map(([windowId]) => windowId);
}
