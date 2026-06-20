/**
 * Tiling presets: one-shot layouts that arrange the open windows, the keyboard /
 * menu equivalent of Win11 snap layouts.
 *
 * Two kinds:
 *  - HALF presets (`left/right/top/bottom-half`) snap a SINGLE window (the focused
 *    one) to a screen half. They produce a `snapped` geometry, not a tile tree.
 *  - MULTI presets (`columns`, `grid`) arrange ALL the open windows into a tile
 *    tree. They are adaptive: `grid` of 2 windows is a 2-up, of 4 is quadrants, of
 *    9 is a 3x3, and `columns` is an N-wide single row. This subsumes the fixed
 *    2-up / 4-up / quadrants layouts into two that scale to any window count.
 *
 * This module is PURE (no store, no React): it maps a preset + ordered window ids
 * to a `TileNode`, taking the id factory from the caller so the store keeps owning
 * its monotonic, HMR-preserved tile-id sequence.
 */

import type { FractionalRect, TileNode } from '../store/types';
import { equalSizes } from './tree-ops';

export type TilePreset = 'left-half' | 'right-half' | 'top-half' | 'bottom-half' | 'columns' | 'grid';

/** The presets the user can pick, in menu display order. */
export const TILE_PRESETS: readonly TilePreset[] = [
  'left-half',
  'right-half',
  'top-half',
  'bottom-half',
  'columns',
  'grid',
];

/** Half-snap geometries for the single-window presets. */
const HALF_GEOMETRY: Record<'left-half' | 'right-half' | 'top-half' | 'bottom-half', FractionalRect> = {
  'left-half': { x: 0, y: 0, w: 0.5, h: 1 },
  'right-half': { x: 0.5, y: 0, w: 0.5, h: 1 },
  'top-half': { x: 0, y: 0, w: 1, h: 0.5 },
  'bottom-half': { x: 0, y: 0.5, w: 1, h: 0.5 },
};

/** The snap geometry for a half preset, or null for a multi-window preset. */
export function presetHalfGeometry(preset: TilePreset): FractionalRect | null {
  return preset in HALF_GEOMETRY ? HALF_GEOMETRY[preset as keyof typeof HALF_GEOMETRY] : null;
}

/** True for presets that tile ALL open windows (need a tile tree, 2+ windows). */
export function isMultiWindowPreset(preset: TilePreset): boolean {
  return preset === 'columns' || preset === 'grid';
}

/** Source of fresh, unique tile-node ids (the store's HMR-preserved sequence). */
export interface TileIdFactory {
  leaf: () => string;
  split: () => string;
}

/** One leaf per window, accumulating the window-to-leaf mapping the caller needs
 *  to mark each window tiled. */
interface LeafFactory {
  make: (windowId: string) => TileNode;
  leaves: Array<{ windowId: string; leafId: string }>;
}

function leafFactory(ids: TileIdFactory): LeafFactory {
  const leaves: Array<{ windowId: string; leafId: string }> = [];
  return {
    leaves,
    make: (windowId) => {
      const leafId = ids.leaf();
      leaves.push({ windowId, leafId });
      return { kind: 'leaf', id: leafId, windowId };
    },
  };
}

function row(children: TileNode[], ids: TileIdFactory): TileNode {
  if (children.length === 1) return children[0];
  return { kind: 'split', id: ids.split(), direction: 'horizontal', children, sizes: equalSizes(children.length) };
}

/**
 * Build the tile tree for a MULTI-window preset from the windows in the given
 * order (first window lands top-left). Returns the tree plus the window-to-leaf
 * mapping, or null when the preset is single-window or there are fewer than two
 * windows to tile.
 */
export function buildPresetTree(
  preset: TilePreset,
  windowIds: string[],
  ids: TileIdFactory,
): { tree: TileNode; leaves: Array<{ windowId: string; leafId: string }> } | null {
  if (!isMultiWindowPreset(preset) || windowIds.length < 2) return null;

  const factory = leafFactory(ids);

  if (preset === 'columns') {
    const tree = row(windowIds.map(factory.make), ids);
    return { tree, leaves: factory.leaves };
  }

  // grid: a balanced columns-by-rows layout, filled row by row. columns is
  // ceil(sqrt(n)) so a perfect square stays square (4 -> 2x2, 9 -> 3x3) and other
  // counts spread across roughly even rows (the last row may be shorter).
  const columns = Math.ceil(Math.sqrt(windowIds.length));
  const rows: TileNode[] = [];
  for (let start = 0; start < windowIds.length; start += columns) {
    rows.push(row(windowIds.slice(start, start + columns).map(factory.make), ids));
  }
  const tree: TileNode =
    rows.length === 1
      ? rows[0]
      : { kind: 'split', id: ids.split(), direction: 'vertical', children: rows, sizes: equalSizes(rows.length) };
  return { tree, leaves: factory.leaves };
}
