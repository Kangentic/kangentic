import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPresetTree,
  presetHalfGeometry,
  isMultiWindowPreset,
  TILE_PRESETS,
  type TilePreset,
  type TileIdFactory,
} from '../../src/renderer/window-manager/tiling/presets';
import type { TileNode } from '../../src/renderer/window-manager/store/types';
import { useWindowStore } from '../../src/renderer/window-manager/store/window-store';

/** Deterministic id source for the pure builder tests. */
function idFactory(): TileIdFactory {
  let leafCount = 0;
  let splitCount = 0;
  return { leaf: () => `leaf-${(leafCount += 1)}`, split: () => `split-${(splitCount += 1)}` };
}

/** Window ids of every leaf, in tree order. */
function leafWindowIds(node: TileNode): string[] {
  return node.kind === 'leaf' ? [node.windowId] : node.children.flatMap(leafWindowIds);
}

describe('tiling presets (pure)', () => {
  it('maps each half preset to its snap geometry and nothing else', () => {
    expect(presetHalfGeometry('left-half')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(presetHalfGeometry('right-half')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(presetHalfGeometry('top-half')).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(presetHalfGeometry('bottom-half')).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(presetHalfGeometry('columns')).toBeNull();
    expect(presetHalfGeometry('grid')).toBeNull();
  });

  it('classifies multi-window presets', () => {
    expect(isMultiWindowPreset('columns')).toBe(true);
    expect(isMultiWindowPreset('grid')).toBe(true);
    expect(isMultiWindowPreset('left-half')).toBe(false);
    expect(isMultiWindowPreset('top-half')).toBe(false);
  });

  it('exposes every preset in menu order', () => {
    expect([...TILE_PRESETS]).toEqual(['left-half', 'right-half', 'top-half', 'bottom-half', 'columns', 'grid']);
  });

  it('columns is one horizontal row of equal leaves', () => {
    const built = buildPresetTree('columns', ['w1', 'w2', 'w3'], idFactory());
    expect(built).not.toBeNull();
    const tree = built!.tree;
    expect(tree.kind).toBe('split');
    if (tree.kind !== 'split') throw new Error('expected split');
    expect(tree.direction).toBe('horizontal');
    expect(tree.children).toHaveLength(3);
    expect(tree.sizes).toHaveLength(3);
    expect(tree.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 6);
    expect(leafWindowIds(tree)).toEqual(['w1', 'w2', 'w3']);
  });

  it('grid of 2 is a 2-up (single horizontal row)', () => {
    const tree = buildPresetTree('grid', ['w1', 'w2'], idFactory())!.tree;
    expect(tree.kind === 'split' && tree.direction).toBe('horizontal');
    expect(leafWindowIds(tree)).toEqual(['w1', 'w2']);
  });

  it('grid of 4 is a 2x2 (two stacked rows of two)', () => {
    const tree = buildPresetTree('grid', ['w1', 'w2', 'w3', 'w4'], idFactory())!.tree;
    expect(tree.kind).toBe('split');
    if (tree.kind !== 'split') throw new Error('expected split');
    expect(tree.direction).toBe('vertical');
    expect(tree.children).toHaveLength(2);
    for (const rowNode of tree.children) {
      expect(rowNode.kind).toBe('split');
      if (rowNode.kind !== 'split') throw new Error('expected row split');
      expect(rowNode.direction).toBe('horizontal');
      expect(rowNode.children).toHaveLength(2);
    }
    expect(leafWindowIds(tree)).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('grid of 3 fills row by row (a row of two over a full-width single)', () => {
    const tree = buildPresetTree('grid', ['w1', 'w2', 'w3'], idFactory())!.tree;
    if (tree.kind !== 'split') throw new Error('expected split');
    expect(tree.direction).toBe('vertical');
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].kind).toBe('split'); // first row: w1 | w2
    expect(tree.children[1].kind).toBe('leaf'); // last row: w3 spans full width
    expect(leafWindowIds(tree)).toEqual(['w1', 'w2', 'w3']);
  });

  it('returns null for fewer than two windows or a single-window preset', () => {
    expect(buildPresetTree('grid', ['only'], idFactory())).toBeNull();
    expect(buildPresetTree('columns', [], idFactory())).toBeNull();
    expect(buildPresetTree('left-half', ['w1', 'w2'], idFactory())).toBeNull();
  });

  it('returns one leaf entry per window for the caller to mark tiled', () => {
    const built = buildPresetTree('grid', ['w1', 'w2', 'w3', 'w4'], idFactory())!;
    expect(built.leaves.map((entry) => entry.windowId)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(new Set(built.leaves.map((entry) => entry.leafId)).size).toBe(4);
  });
});

describe('applyTilePreset (store)', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null, zCounter: 0, tileTree: null, tileTreeRect: { x: 0, y: 0, w: 1, h: 1 } });
  });

  function openWindows(count: number): string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(useWindowStore.getState().openWindow({ taskId: `task-${index}`, sessionId: `sess-${index}`, title: `W${index}` }));
    }
    return ids;
  }

  it('snaps the focused window for a half preset and leaves the rest alone', () => {
    const [first, second] = openWindows(2); // `second` is opened last, so it is focused
    useWindowStore.getState().applyTilePreset('left-half');
    const state = useWindowStore.getState();
    expect(state.windows[second].state).toBe('snapped');
    expect(state.windows[second].geometry).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(state.windows[first].state).toBe('floating');
    expect(state.tileTree).toBeNull();
  });

  it('docks left-then-right into a tiled pair (menu halves pair like the keyboard)', () => {
    const [first, second] = openWindows(2);
    useWindowStore.getState().focusWindow(first);
    useWindowStore.getState().applyTilePreset('left-half');
    expect(useWindowStore.getState().windows[first].state).toBe('snapped'); // lone half so far
    useWindowStore.getState().focusWindow(second);
    useWindowStore.getState().applyTilePreset('right-half');
    const state = useWindowStore.getState();
    expect(state.tileTree).not.toBeNull();
    expect(state.windows[first].state).toBe('tiled');
    expect(state.windows[second].state).toBe('tiled');
  });

  it('tiles every open window into a columns tree', () => {
    const ids = openWindows(3);
    useWindowStore.getState().applyTilePreset('columns');
    const state = useWindowStore.getState();
    expect(state.tileTree).not.toBeNull();
    expect(state.tileTree!.kind === 'split' && state.tileTree!.direction).toBe('horizontal');
    expect(new Set(leafWindowIds(state.tileTree!))).toEqual(new Set(ids));
    for (const id of ids) {
      expect(state.windows[id].state).toBe('tiled');
      expect(state.windows[id].leafId).toBeTruthy();
    }
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('builds a 2x2 grid from four windows', () => {
    const ids = openWindows(4);
    useWindowStore.getState().applyTilePreset('grid');
    const state = useWindowStore.getState();
    const tree = state.tileTree!;
    expect(tree.kind === 'split' && tree.direction).toBe('vertical');
    expect(new Set(leafWindowIds(tree))).toEqual(new Set(ids));
    expect(ids.every((id) => state.windows[id].state === 'tiled')).toBe(true);
  });

  it('is a no-op for a multi-window preset with only one window', () => {
    openWindows(1);
    useWindowStore.getState().applyTilePreset('grid');
    const state = useWindowStore.getState();
    expect(state.tileTree).toBeNull();
    expect(Object.values(state.windows)[0].state).toBe('floating');
  });
});

// Keeps an exhaustive switch honest if a preset is added without test coverage.
const _everyPresetCovered: Record<TilePreset, true> = {
  'left-half': true,
  'right-half': true,
  'top-half': true,
  'bottom-half': true,
  columns: true,
  grid: true,
};
void _everyPresetCovered;
