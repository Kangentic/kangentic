/**
 * The Command Terminal panel's fixed layouts (`tiling/host-arrangement.ts`)
 * and the store action that builds them (`arrangeTiles`): one terminal fills
 * the panel, two sit side by side, three are one tall beside two stacked, and
 * four are a two by two grid split by columns. The layer rebuilds only when
 * `isHostArranged` says the layout is not its preset, so a dragged seam holds,
 * and it reads the old layout in reading order so terminals keep their places.
 */
import { describe, it, expect } from 'vitest';
import { createWindowManagerStore } from '../../src/renderer/window-manager/store/window-store';
import { findWindowTreeViolations } from '../../src/renderer/window-manager/store/tree-invariants';
import { isHostArranged, windowIdsInReadingOrder } from '../../src/renderer/window-manager/tiling/host-arrangement';
import type { TileNode } from '../../src/renderer/window-manager/store/types';
import { MAX_COMMAND_TERMINALS } from '../../src/shared/command-terminal-name';

function makeStore(windowCount: number) {
  const manager = createWindowManagerStore({ idPrefix: 'arrange-test', kind: 'command-terminal' });
  const ids: string[] = [];
  for (let index = 1; index <= windowCount; index += 1) {
    ids.push(manager.store.getState().openWindow({ anchor: `slot-${index}`, sessionId: null, title: `Terminal ${index}`, skipEnterAnimation: true }));
  }
  return { store: manager.store, ids };
}

/** The tree's shape with each leaf named by its window's slot. */
function shapeWithSlots(tree: TileNode | null, slotOf: (windowId: string) => string): string {
  if (!tree) return 'none';
  if (tree.kind === 'leaf') return slotOf(tree.windowId);
  return `${tree.direction === 'horizontal' ? 'h' : 'v'}(${tree.children.map((child) => shapeWithSlots(child, slotOf)).join(',')})`;
}

function arranged(windowCount: number) {
  const { store, ids } = makeStore(windowCount);
  store.getState().arrangeTiles(ids);
  const state = store.getState();
  const slotOf = (windowId: string) => state.windows[windowId]?.anchor ?? '?';
  return { store, ids, state, shape: shapeWithSlots(state.tileTree, slotOf) };
}

describe('arrangeTiles', () => {
  it('floats a lone terminal over the whole panel, with no tree', () => {
    const { state, ids } = arranged(1);
    expect(state.tileTree).toBeNull();
    expect(state.windows[ids[0]]).toMatchObject({ state: 'floating', leafId: null, geometry: { x: 0, y: 0, w: 1, h: 1 } });
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(true);
  });

  it.each([
    [2, 'h(slot-1,slot-2)'],
    [3, 'h(slot-1,v(slot-2,slot-3))'],
    [4, 'h(v(slot-1,slot-3),v(slot-2,slot-4))'],
  ])('builds the %i-terminal preset, every window tiled in a full-panel tree', (count, expectedShape) => {
    const { state, shape, ids } = arranged(count);
    expect(shape).toBe(expectedShape);
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    for (const id of ids) expect(state.windows[id].state).toBe('tiled');
    expect(findWindowTreeViolations(state.windows, state.tileTree)).toEqual([]);
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(true);
    // Reading order is the order the windows were given, whatever the tree's own order.
    expect(windowIdsInReadingOrder(state.tileTree)).toEqual(ids);
  });

  it('has a preset for as many terminals as the cap allows', () => {
    // The presets stop at four; a cap raised past them would float the extra terminals.
    const { state, ids } = arranged(MAX_COMMAND_TERMINALS);
    for (const id of ids) expect(state.windows[id].state).toBe('tiled');
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(true);
  });

  it('floats a fifth window over the grid rather than leaving it pointing into the tree', () => {
    const { store, ids } = makeStore(4);
    const fifth = store.getState().openWindow({ anchor: 'slot-5', sessionId: null, title: 'Terminal 5' });
    store.getState().arrangeTiles([...ids, fifth]);
    const state = store.getState();
    expect(state.windows[fifth]).toMatchObject({ state: 'floating', leafId: null });
    expect(findWindowTreeViolations(state.windows, state.tileTree)).toEqual([]);
  });

  it('skips ids the store does not hold, and clears the tree for none', () => {
    const { store, ids } = makeStore(2);
    store.getState().arrangeTiles([ids[0], 'no-such-window', ids[1]]);
    expect(windowIdsInReadingOrder(store.getState().tileTree)).toEqual(ids);
    store.getState().arrangeTiles([]);
    expect(store.getState().tileTree).toBeNull();
  });
});

describe('isHostArranged', () => {
  it('stays true after a seam drag, so the panel keeps the size the user set', () => {
    const { store } = arranged(3);
    const root = store.getState().tileTree;
    if (!root || root.kind !== 'split') throw new Error('expected a split');
    store.getState().setSeamRatio(root.id, 0, 0.3);
    const state = store.getState();
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(true);
  });

  it('turns false once a terminal starts, so the panel re-tiles for four', () => {
    const { store } = arranged(3);
    store.getState().openWindow({ anchor: 'slot-4', sessionId: null, title: 'Terminal 4' });
    const state = store.getState();
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(false);
  });

  it('turns false for a layout saved before the panel (floating windows)', () => {
    const { store } = makeStore(2);
    const state = store.getState();
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(false);
  });
});

describe('setExpandedWindow', () => {
  it('expands one window and focuses it, and null shows the tiles again', () => {
    const { store, ids } = arranged(3);
    store.getState().setExpandedWindow(ids[1]);
    expect(store.getState()).toMatchObject({ expandedWindowId: ids[1], focusedWindowId: ids[1] });
    // The tiles stay as they were underneath, so nothing behind it refits.
    expect(isHostArranged(store.getState().windows, store.getState().tileTree, store.getState().tileTreeRect)).toBe(true);
    store.getState().setExpandedWindow(null);
    expect(store.getState().expandedWindowId).toBeNull();
  });

  it('ignores a window the store does not hold', () => {
    const { store } = arranged(2);
    store.getState().setExpandedWindow('no-such-window');
    expect(store.getState().expandedWindowId).toBeNull();
  });

  it('lets go when the expanded window closes', () => {
    const { store, ids } = arranged(3);
    store.getState().setExpandedWindow(ids[0]);
    store.getState().closeWindow(ids[0]);
    expect(store.getState().expandedWindowId).toBeNull();
  });

  it('keeps the expanded window when another closes, and lets go once it is the only one left', () => {
    const { store, ids } = arranged(3);
    store.getState().setExpandedWindow(ids[0]);
    store.getState().closeWindow(ids[1]);
    store.getState().arrangeTiles([ids[0], ids[2]]);
    expect(store.getState().expandedWindowId).toBe(ids[0]);
    store.getState().closeWindow(ids[2]);
    store.getState().arrangeTiles([ids[0]]);
    expect(store.getState().expandedWindowId).toBeNull();
  });

  it('a window opened while one is expanded takes its place in front', () => {
    const { store, ids } = arranged(2);
    store.getState().setExpandedWindow(ids[0]);
    const opened = store.getState().openWindow({ anchor: 'slot-3', sessionId: null, title: 'Terminal 3' });
    expect(store.getState().expandedWindowId).toBe(opened);
  });

  it('is never part of a saved layout, and a restore clears it', () => {
    const { store, ids } = arranged(2);
    store.getState().setExpandedWindow(ids[0]);
    const saved = store.getState().serializeWorkspace();
    expect(JSON.stringify(saved)).not.toContain('expanded');
    store.getState().applyWorkspace(saved, () => null, () => true);
    expect(store.getState().expandedWindowId).toBeNull();
  });
});

describe('swapWindows', () => {
  it('swaps two terminals between their tiles, keeping every tile and seam', () => {
    const { store, ids } = arranged(3);
    const root = store.getState().tileTree;
    if (!root || root.kind !== 'split') throw new Error('expected a split');
    store.getState().setSeamRatio(root.id, 0, 0.6);
    const leafOfFirst = store.getState().windows[ids[0]].leafId;
    const leafOfThird = store.getState().windows[ids[2]].leafId;

    store.getState().swapWindows(ids[2], ids[0]);
    const state = store.getState();
    // The tall left tile now holds the third terminal, and the first sits where it was.
    expect(windowIdsInReadingOrder(state.tileTree)).toEqual([ids[2], ids[1], ids[0]]);
    expect(state.windows[ids[2]].leafId).toBe(leafOfFirst);
    expect(state.windows[ids[0]].leafId).toBe(leafOfThird);
    expect(state.tileTree?.kind === 'split' ? state.tileTree.sizes[0] : null).toBeCloseTo(0.6, 6);
    expect(findWindowTreeViolations(state.windows, state.tileTree)).toEqual([]);
    // Still the preset, so the panel does not re-tile and reset the seam.
    expect(isHostArranged(state.windows, state.tileTree, state.tileTreeRect)).toBe(true);
  });

  it('leaves the layout alone for the same window, an unknown one, or a lone window', () => {
    const { store, ids } = arranged(2);
    const before = store.getState();
    store.getState().swapWindows(ids[0], ids[0]);
    store.getState().swapWindows(ids[0], 'no-such-window');
    expect(store.getState().tileTree).toBe(before.tileTree);
    expect(store.getState().windows).toBe(before.windows);

    const lone = arranged(1);
    lone.store.getState().swapWindows(lone.ids[0], 'no-such-window');
    expect(lone.store.getState().tileTree).toBeNull();
  });
});

describe('windowIdsInReadingOrder', () => {
  it('reads a grid by its structure, so seams that cross never reorder it', () => {
    const { store, ids } = arranged(4);
    const root = store.getState().tileTree;
    if (!root || root.kind !== 'split') throw new Error('expected a split');
    const [leftColumn, rightColumn] = root.children;
    // The left column's seam low and the right column's high: by position alone
    // the bottom-left terminal would read after the bottom-right one.
    store.getState().setSeamRatio(leftColumn.id, 0, 0.8);
    store.getState().setSeamRatio(rightColumn.id, 0, 0.2);
    expect(windowIdsInReadingOrder(store.getState().tileTree)).toEqual(ids);
  });

  it('reads any other tree by where its windows sit: top to bottom, then left to right', () => {
    const { store, ids } = arranged(4);
    // Stopping the top-right terminal leaves h(v(1,3), 4): 1 and 4 share the top row.
    store.getState().closeWindow(ids[1]);
    expect(windowIdsInReadingOrder(store.getState().tileTree)).toEqual([ids[0], ids[3], ids[2]]);
  });
});
