import { describe, it, expect, beforeEach } from 'vitest';
import {
  fractionalToPixels,
  pixelsToFractional,
  clampGeometry,
  defaultWindowGeometry,
} from '../../src/renderer/window-manager/store/geometry';
import { detectSnapEdge, snapEdgeToGeometry } from '../../src/renderer/window-manager/dnd/snap';
import { useWindowStore } from '../../src/renderer/window-manager/store/window-store';

describe('window-manager geometry', () => {
  it('projects fractional geometry to pixels against the container', () => {
    const rect = fractionalToPixels({ x: 0.5, y: 0.25, w: 0.5, h: 0.5 }, { width: 1000, height: 800 });
    expect(rect).toEqual({ left: 500, top: 200, width: 500, height: 400 });
  });

  it('round-trips pixels <-> fractional', () => {
    const container = { width: 1280, height: 720 };
    const original = { x: 0.3, y: 0.4, w: 0.4, h: 0.5 };
    const back = pixelsToFractional(fractionalToPixels(original, container), container);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
    expect(back.w).toBeCloseTo(original.w, 6);
    expect(back.h).toBeCloseTo(original.h, 6);
  });

  it('guards against divide-by-zero in an unmeasured container', () => {
    const back = pixelsToFractional({ left: 100, top: 50, width: 200, height: 100 }, { width: 0, height: 0 });
    expect(Number.isFinite(back.x)).toBe(true);
    expect(Number.isFinite(back.w)).toBe(true);
  });

  it('clamps size to a minimum and keeps the window inside the overlay', () => {
    const tiny = clampGeometry({ x: 1.5, y: -0.2, w: 0.01, h: 0.01 });
    expect(tiny.w).toBeGreaterThanOrEqual(0.12);
    expect(tiny.h).toBeGreaterThanOrEqual(0.12);
    expect(tiny.x).toBeGreaterThanOrEqual(0);
    expect(tiny.x + tiny.w).toBeLessThanOrEqual(1.0000001);
    expect(tiny.y).toBeGreaterThanOrEqual(0);
    expect(tiny.y + tiny.h).toBeLessThanOrEqual(1.0000001);
  });

  it('cascades default placement and stays in bounds', () => {
    const first = defaultWindowGeometry(0);
    const second = defaultWindowGeometry(1);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
    for (const geometry of [defaultWindowGeometry(0), defaultWindowGeometry(5), defaultWindowGeometry(11)]) {
      expect(geometry.x + geometry.w).toBeLessThanOrEqual(1.0000001);
      expect(geometry.y + geometry.h).toBeLessThanOrEqual(1.0000001);
    }
  });
});

const OVERLAY_SIZE = { width: 1000, height: 800 };

describe('window-manager snap', () => {
  it('arms left only when the container left edge is dragged past the boundary (grab point irrelevant)', () => {
    expect(detectSnapEdge({ left: -60, top: 300, width: 400, height: 300 }, OVERLAY_SIZE)).toBe('left');
  });

  it('does NOT arm a dock at the edge or only slightly past it (casual movement)', () => {
    // Flush at the edge: no dock.
    expect(detectSnapEdge({ left: 0, top: 300, width: 400, height: 300 }, OVERLAY_SIZE)).toBeNull();
    // 20px past: still within the buffer, no dock.
    expect(detectSnapEdge({ left: -20, top: 300, width: 400, height: 300 }, OVERLAY_SIZE)).toBeNull();
  });

  it('arms right when the container right edge is dragged past the boundary', () => {
    // left + width = 660 + 400 = 1060, overlay 1000 -> right edge 60px past.
    expect(detectSnapEdge({ left: 660, top: 300, width: 400, height: 300 }, OVERLAY_SIZE)).toBe('right');
  });

  it('arms maximize when the container top edge is dragged past the top boundary', () => {
    expect(detectSnapEdge({ left: 300, top: -60, width: 400, height: 300 }, OVERLAY_SIZE)).toBe('maximize');
  });

  it('does NOT maximize a full-height window dragged sideways (top edge at 0, not past)', () => {
    // A left-snapped window: top edge at 0, full height, left edge 60px past.
    expect(detectSnapEdge({ left: -60, top: 0, width: 500, height: 800 }, OVERLAY_SIZE)).toBe('left');
  });

  it('returns null in the interior', () => {
    expect(detectSnapEdge({ left: 300, top: 300, width: 400, height: 200 }, OVERLAY_SIZE)).toBeNull();
  });

  it('maps each edge to the expected half / full geometry', () => {
    expect(snapEdgeToGeometry('left')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(snapEdgeToGeometry('right')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(snapEdgeToGeometry('maximize')).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('window-store actions', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null, zCounter: 0, tileTree: null, tileTreeRect: { x: 0, y: 0, w: 1, h: 1 } });
  });

  it('opens, focuses, and returns the new window id', () => {
    const id = useWindowStore.getState().openWindow({ taskId: 'task-a', sessionId: 'sess-a', title: 'A' });
    const state = useWindowStore.getState();
    expect(state.windows[id]).toBeTruthy();
    expect(state.windows[id].sessionStatus).toBe('live');
    expect(state.focusedWindowId).toBe(id);
    expect(state.order).toEqual([id]);
  });

  it('focuses the existing window when re-opening the same task (one window per task)', () => {
    const first = useWindowStore.getState().openWindow({ taskId: 'task-a', sessionId: 'sess-a', title: 'A' });
    const second = useWindowStore.getState().openWindow({ taskId: 'task-a', sessionId: 'sess-a', title: 'A again' });
    expect(second).toBe(first);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(1);
  });

  it('raises zIndex and moves a window to the front of the order on focus', () => {
    const first = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const second = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().focusWindow(first);
    const state = useWindowStore.getState();
    expect(state.focusedWindowId).toBe(first);
    expect(state.order[state.order.length - 1]).toBe(first);
    expect(state.windows[first].zIndex).toBeGreaterThan(state.windows[second].zIndex);
  });

  it('maximizes then restores to the prior geometry', () => {
    const id = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const original = useWindowStore.getState().windows[id].geometry;
    useWindowStore.getState().maximizeWindow(id);
    expect(useWindowStore.getState().windows[id].state).toBe('maximized');
    useWindowStore.getState().toggleMaximizeWindow(id);
    const restored = useWindowStore.getState().windows[id];
    expect(restored.state).toBe('floating');
    expect(restored.geometry).toEqual(original);
  });

  it('snaps to a half and remembers the pre-snap geometry for restore', () => {
    const id = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const original = useWindowStore.getState().windows[id].geometry;
    useWindowStore.getState().snapWindow(id, { x: 0, y: 0, w: 0.5, h: 1 });
    const snapped = useWindowStore.getState().windows[id];
    expect(snapped.state).toBe('snapped');
    expect(snapped.geometry).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(snapped.restoreGeometry).toEqual(original);
  });

  it('preserves the original restore point when snapping a second time', () => {
    const id = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const original = useWindowStore.getState().windows[id].geometry;
    useWindowStore.getState().snapWindow(id, { x: 0, y: 0, w: 0.5, h: 1 });
    useWindowStore.getState().snapWindow(id, { x: 0.5, y: 0, w: 0.5, h: 1 });
    // Snapping left then right keeps the pre-snap size, not the left-half size.
    expect(useWindowStore.getState().windows[id].restoreGeometry).toEqual(original);
  });

  it('clamps committed geometry and marks the window floating', () => {
    const id = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().maximizeWindow(id);
    useWindowStore.getState().setGeometry(id, { x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    const target = useWindowStore.getState().windows[id];
    expect(target.state).toBe('floating');
    expect(target.geometry.x + target.geometry.w).toBeLessThanOrEqual(1.0000001);
  });

  it('removes a window and refocuses the next front-most on close', () => {
    const first = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const second = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().closeWindow(second);
    const state = useWindowStore.getState();
    expect(state.windows[second]).toBeUndefined();
    expect(state.focusedWindowId).toBe(first);
  });
});

describe('window-store tiling', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null, zCounter: 0, tileTree: null, tileTreeRect: { x: 0, y: 0, w: 1, h: 1 } });
  });

  /** Open A snapped to the left half + B docked right -> a tiled pair. */
  function makeTiledPair(): { a: string; b: string } {
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockWindow(b, 'right');
    return { a, b };
  }

  it('dockWindow joins an opposite-half snapped window into a horizontal tile pair', () => {
    const { a, b } = makeTiledPair();
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
    expect(state.tileTree?.kind).toBe('split');
    expect((state.tileTree as Extract<typeof state.tileTree, { kind: 'split' }>).direction).toBe('horizontal');
  });

  it('does NOT auto-tile when docking next to a merely floating window', () => {
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    // B stays floating (default geometry); docking A left must leave B untouched.
    useWindowStore.getState().dockWindow(a, 'left');
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('snapped');
    expect(state.windows[b].state).toBe('floating');
    expect(state.tileTree).toBeNull();
  });

  it('auto-tiles 50/50 when docking next to a full-height window flush to the opposite edge (docked then resized)', () => {
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    // B was docked then resized wider: full-height, flush to the right edge, non-half width.
    useWindowStore.getState().setGeometry(b, { x: 0.35, y: 0, w: 0.65, h: 1 });
    useWindowStore.getState().dockWindow(a, 'left');
    const state = useWindowStore.getState();
    expect(state.tileTree?.kind).toBe('split');
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
  });

  it('re-tiles after un-tile + re-dock (un-tile leaves the partner snapped, so re-docking re-pairs)', () => {
    const { a, b } = makeTiledPair();
    useWindowStore.getState().untileWindow(a);
    // Un-tiling leaves BOTH snapped on their halves (deliberately docked).
    expect(useWindowStore.getState().windows[b].state).toBe('snapped');
    // Re-docking A to the opposite half re-pairs with the snapped B.
    useWindowStore.getState().dockWindow(a, 'left');
    const state = useWindowStore.getState();
    expect(state.tileTree?.kind).toBe('split');
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
  });

  it('dockWindow falls back to a lone snap when no opposite-half window exists', () => {
    const id = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().dockWindow(id, 'left');
    const state = useWindowStore.getState();
    expect(state.windows[id].state).toBe('snapped');
    expect(state.tileTree).toBeNull();
  });

  it('setSeamRatio resizes the active pair, clamped', () => {
    makeTiledPair();
    type Split = Extract<ReturnType<typeof useWindowStore.getState>['tileTree'], { kind: 'split' }>;
    const splitId = (useWindowStore.getState().tileTree as Split).id;
    useWindowStore.getState().setSeamRatio(splitId, 0, 0.7);
    expect((useWindowStore.getState().tileTree as Split).sizes[0]).toBeCloseTo(0.7, 6);
    useWindowStore.getState().setSeamRatio(splitId, 0, 0.99);
    expect((useWindowStore.getState().tileTree as Split).sizes[0]).toBeCloseTo(0.9, 6); // clamped
  });

  it('untileWindow evicts the window (floats it) and snaps the lone remaining partner', () => {
    const { a, b } = makeTiledPair();
    useWindowStore.getState().untileWindow(a);
    const state = useWindowStore.getState();
    expect(state.tileTree).toBeNull();
    // The evicted window floats (undo tiling); the partner snaps to its half so
    // re-docking re-pairs.
    expect(state.windows[a].state).toBe('floating');
    expect(state.windows[a].leafId).toBeNull();
    expect(state.windows[b].state).toBe('snapped');
  });

  it('closing a tiled window dissolves the tree and leaves its partner snapped on its half', () => {
    const { a, b } = makeTiledPair();
    useWindowStore.getState().closeWindow(a);
    const state = useWindowStore.getState();
    expect(state.windows[a]).toBeUndefined();
    expect(state.tileTree).toBeNull();
    expect(state.windows[b].state).toBe('snapped');
    // B was the right pane, so it stays snapped on the right half.
    expect(state.windows[b].geometry.x).toBeCloseTo(0.5, 5);
  });

  /** A | B (via dockWindow), then C dropped onto B's right edge -> a three-leaf tree. */
  function makeThreeTiled(): { a: string; b: string; c: string } {
    const { a, b } = makeTiledPair();
    const c = useWindowStore.getState().openWindow({ taskId: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().dockIntoWindow(c, b, 'right');
    return { a, b, c };
  }

  it('dockIntoWindow seeds a fresh split between two floating windows (side sets direction + order)', () => {
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    // Drop A onto B's TOP edge -> a vertical (stacked) split with A above B.
    useWindowStore.getState().dockIntoWindow(a, b, 'top');
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
    const split = state.tileTree as Extract<typeof state.tileTree, { kind: 'split' }>;
    expect(split.kind).toBe('split');
    expect(split.direction).toBe('vertical');
    // 'top' => the dragged window (A) is the first child (rendered above).
    expect(split.children[0]).toMatchObject({ kind: 'leaf', windowId: a });
    expect(split.children[1]).toMatchObject({ kind: 'leaf', windowId: b });
  });

  it('dockIntoWindow inserts a third window into the existing tree (arbitrary N-way)', () => {
    const { a, b, c } = makeThreeTiled();
    const state = useWindowStore.getState();
    expect(state.windows[c].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b, c].sort());
  });

  it('partial eviction: closing one of three tiled windows keeps the other two tiled', () => {
    const { a, b, c } = makeThreeTiled();
    useWindowStore.getState().closeWindow(c);
    const state = useWindowStore.getState();
    expect(state.windows[c]).toBeUndefined();
    expect(state.tileTree).not.toBeNull();
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b].sort());
  });

  it('partial eviction: untiling one of three floats it and keeps the other two tiled', () => {
    const { a, b, c } = makeThreeTiled();
    useWindowStore.getState().untileWindow(c);
    const state = useWindowStore.getState();
    expect(state.windows[c].state).toBe('floating');
    expect(state.windows[c].leafId).toBeNull();
    expect(state.tileTree).not.toBeNull();
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
  });

  it('evicting down to a single pane collapses the tree to a snapped window', () => {
    const { a, b, c } = makeThreeTiled();
    useWindowStore.getState().untileWindow(b);
    useWindowStore.getState().untileWindow(c);
    const state = useWindowStore.getState();
    expect(state.tileTree).toBeNull();
    expect(state.windows[a].state).toBe('snapped');
  });

  it('docking onto a half-snapped window confines the tile group to that footprint (not full width)', () => {
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 }); // left half
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    // Drop B onto A's bottom edge -> a vertical split CONFINED to the left half.
    useWindowStore.getState().dockIntoWindow(b, a, 'bottom');
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
    // The footprint stays the left 50%, not the whole overlay (the reported bug).
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('edge-snap pairing fills the whole overlay (footprint = full)', () => {
    makeTiledPair();
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('dockWindow joins an existing tree as a new root pane (cohesive full-overlay tiling)', () => {
    const { a, b } = makeTiledPair(); // A | B, full overlay
    const c = useWindowStore.getState().openWindow({ taskId: 'c', sessionId: 's3', title: 'C' });
    // Edge-snap C to the right while a tree exists -> it JOINS the tree (not a lone snap).
    useWindowStore.getState().dockWindow(c, 'right');
    const state = useWindowStore.getState();
    expect(state.windows[c].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b, c].sort());
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('dockIntoWindow merges a lone snapped window (outside the tree) into the single tree', () => {
    // A tree confined to the right half.
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockIntoWindow(b, a, 'bottom'); // seed pair in the right half
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    // A lone snapped window parked on the LEFT, outside the tree (the orphan case).
    const c = useWindowStore.getState().openWindow({ taskId: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().snapWindow(c, { x: 0, y: 0, w: 0.5, h: 1 });
    expect(useWindowStore.getState().windows[c].state).toBe('snapped');
    // Drag a 4th window onto the orphan -> merges the orphan + dragged into the ONE tree.
    const d = useWindowStore.getState().openWindow({ taskId: 'd', sessionId: 's4', title: 'D' });
    useWindowStore.getState().dockIntoWindow(d, c, 'bottom');
    const state = useWindowStore.getState();
    expect(state.windows[c].state).toBe('tiled');
    expect(state.windows[d].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b, c, d].sort());
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('collapsing a footprint-confined group resets the footprint to the full overlay', () => {
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockIntoWindow(b, a, 'bottom');
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    useWindowStore.getState().untileWindow(b); // 2-up -> collapse -> footprint resets
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('evicting a top-level pane keeps the surviving group in its region (no full-width expansion)', () => {
    // Root = [ left window | right column of two ], filling the overlay.
    const a = useWindowStore.getState().openWindow({ taskId: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ taskId: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockWindow(b, 'right'); // A | B across the overlay
    const c = useWindowStore.getState().openWindow({ taskId: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().dockIntoWindow(c, b, 'bottom'); // B's cell -> column(B, C)
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    // Pull the LEFT pane out: the right column must KEEP its right-half width
    // (the freed left half becomes empty board), not stretch to full screen.
    useWindowStore.getState().untileWindow(a);
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('floating');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([b, c].sort());
    expect(state.tileTreeRect.x).toBeCloseTo(0.5, 6);
    expect(state.tileTreeRect.w).toBeCloseTo(0.5, 6);
    expect(state.tileTreeRect.h).toBeCloseTo(1, 6);
  });

  it('setTileTreeRect resizes the group footprint when tiled, and no-ops without a tree', () => {
    makeTiledPair(); // full-overlay tree
    useWindowStore.getState().setTileTreeRect({ x: 0.3, y: 0, w: 0.7, h: 1 });
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0.3, y: 0, w: 0.7, h: 1 });
    // With no tree it is a no-op (nothing to resize).
    useWindowStore.setState({ tileTree: null, tileTreeRect: { x: 0, y: 0, w: 1, h: 1 } });
    useWindowStore.getState().setTileTreeRect({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

/** Walk a tile tree and collect every leaf's windowId (test-local helper). */
function collectLeafWindowIds(tree: ReturnType<typeof useWindowStore.getState>['tileTree']): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.windowId];
  return tree.children.flatMap((child) => collectLeafWindowIds(child));
}
