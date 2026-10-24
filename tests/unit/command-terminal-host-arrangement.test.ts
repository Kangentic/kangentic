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
