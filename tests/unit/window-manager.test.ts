import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fractionalToPixels,
  pixelsToFractional,
  clampGeometry,
  defaultWindowGeometry,
} from '../../src/renderer/window-manager/store/geometry';
import { detectSnapEdge, snapEdgeToGeometry } from '../../src/renderer/window-manager/dnd/snap';
import { useWindowStore } from '../../src/renderer/window-manager/store/window-store';
import { findWindowTreeViolations } from '../../src/renderer/window-manager/store/tree-invariants';
import type { ManagedWindow, TileNode } from '../../src/renderer/window-manager/store/types';

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
    const id = useWindowStore.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A' });
    const state = useWindowStore.getState();
    expect(state.windows[id]).toBeTruthy();
    expect(state.windows[id].sessionStatus).toBe('live');
    expect(state.focusedWindowId).toBe(id);
    expect(state.order).toEqual([id]);
  });

  it('leaves a freshly opened window without the skip-enter flag, so it plays the entrance animation', () => {
    // Only a workspace restore (deserializeWorkspace) sets skipEnterAnimation; a user-opened
    // window must keep the normal entrance, so the flag stays unset here.
    const id = useWindowStore.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A' });
    expect(useWindowStore.getState().windows[id].skipEnterAnimation).toBeUndefined();
  });

  it('stamps skipEnterAnimation when opened with the restore hint, so a programmatic restore paints flat', () => {
    // A per-project reconcile (reconcileCommandTerminalWindows) opens windows with this hint so
    // they match the flat presentation of a workspace-restored window instead of animating in.
    const id = useWindowStore
      .getState()
      .openWindow({ anchor: 'slot-2', sessionId: null, title: 'Command Terminal', skipEnterAnimation: true });
    expect(useWindowStore.getState().windows[id].skipEnterAnimation).toBe(true);
  });

  it('focuses the existing window when re-opening the same task (one window per task)', () => {
    const first = useWindowStore.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A' });
    const second = useWindowStore.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A again' });
    expect(second).toBe(first);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(1);
  });

  it('raises zIndex and moves a window to the front of the order on focus', () => {
    const first = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const second = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().focusWindow(first);
    const state = useWindowStore.getState();
    expect(state.focusedWindowId).toBe(first);
    expect(state.order[state.order.length - 1]).toBe(first);
    expect(state.windows[first].zIndex).toBeGreaterThan(state.windows[second].zIndex);
  });

  it('maximizes then restores to the prior geometry', () => {
    const id = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const original = useWindowStore.getState().windows[id].geometry;
    useWindowStore.getState().maximizeWindow(id);
    expect(useWindowStore.getState().windows[id].state).toBe('maximized');
    useWindowStore.getState().toggleMaximizeWindow(id);
    const restored = useWindowStore.getState().windows[id];
    expect(restored.state).toBe('floating');
    expect(restored.geometry).toEqual(original);
  });

  it('snaps to a half and remembers the pre-snap geometry for restore', () => {
    const id = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const original = useWindowStore.getState().windows[id].geometry;
    useWindowStore.getState().snapWindow(id, { x: 0, y: 0, w: 0.5, h: 1 });
    const snapped = useWindowStore.getState().windows[id];
    expect(snapped.state).toBe('snapped');
    expect(snapped.geometry).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(snapped.restoreGeometry).toEqual(original);
  });

  it('preserves the original restore point when snapping a second time', () => {
    const id = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const original = useWindowStore.getState().windows[id].geometry;
    useWindowStore.getState().snapWindow(id, { x: 0, y: 0, w: 0.5, h: 1 });
    useWindowStore.getState().snapWindow(id, { x: 0.5, y: 0, w: 0.5, h: 1 });
    // Snapping left then right keeps the pre-snap size, not the left-half size.
    expect(useWindowStore.getState().windows[id].restoreGeometry).toEqual(original);
  });

  it('clamps committed geometry and marks the window floating', () => {
    const id = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().maximizeWindow(id);
    useWindowStore.getState().setGeometry(id, { x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    const target = useWindowStore.getState().windows[id];
    expect(target.state).toBe('floating');
    expect(target.geometry.x + target.geometry.w).toBeLessThanOrEqual(1.0000001);
  });

  it('removes a window and refocuses the next front-most on close', () => {
    const first = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const second = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
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
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
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
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    // B stays floating (default geometry); docking A left must leave B untouched.
    useWindowStore.getState().dockWindow(a, 'left');
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('snapped');
    expect(state.windows[b].state).toBe('floating');
    expect(state.tileTree).toBeNull();
  });

  it('auto-tiles 50/50 when docking next to a full-height window flush to the opposite edge (docked then resized)', () => {
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    // B was docked then resized wider: full-height, flush to the right edge, non-half width.
    useWindowStore.getState().setGeometry(b, { x: 0.35, y: 0, w: 0.65, h: 1 });
    useWindowStore.getState().dockWindow(a, 'left');
    const state = useWindowStore.getState();
    expect(state.tileTree?.kind).toBe('split');
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
  });

  it('re-tiles after un-tile + re-dock (pop-out leaves the partner floating full-height, so re-docking re-pairs)', () => {
    const { a, b } = makeTiledPair();
    useWindowStore.getState().untileWindow(a);
    // Pop-out leaves BOTH floating on their halves (full-height, edge-flush), so a
    // re-dock to the opposite half still re-pairs them.
    expect(useWindowStore.getState().windows[b].state).toBe('floating');
    // Re-docking A to the opposite half re-pairs with the full-height floating B.
    useWindowStore.getState().dockWindow(a, 'left');
    const state = useWindowStore.getState();
    expect(state.tileTree?.kind).toBe('split');
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
  });

  it('dockWindow falls back to a lone snap when no opposite-half window exists', () => {
    const id = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
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

  it('untileWindow (pop-out) floats the window AND the lone remaining partner at their current rects', () => {
    const { a, b } = makeTiledPair();
    useWindowStore.getState().untileWindow(a);
    const state = useWindowStore.getState();
    expect(state.tileTree).toBeNull();
    // Pop-out dissolves the 2-pane group: BOTH windows float (independently
    // resizable) at the rects they held, rather than the partner snapping.
    expect(state.windows[a].state).toBe('floating');
    expect(state.windows[a].leafId).toBeNull();
    expect(state.windows[b].state).toBe('floating');
    expect(state.windows[b].leafId).toBeNull();
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
    const c = useWindowStore.getState().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().dockIntoWindow(c, b, 'right');
    return { a, b, c };
  }

  it('dockIntoWindow seeds a fresh split between two floating windows (side sets direction + order)', () => {
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
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

  it('untiling one of three pops only that pane; the other two stay docked at their widths', () => {
    const { a, b, c } = makeThreeTiled(); // flat horizontal thirds, full overlay
    useWindowStore.getState().untileWindow(c);
    const state = useWindowStore.getState();
    // Only C pops out (floats at its current rect); A and B remain DOCKED.
    expect(state.windows[c].state).toBe('floating');
    expect(state.windows[c].leafId).toBeNull();
    expect(state.tileTree).not.toBeNull();
    expect(state.windows[a].state).toBe('tiled');
    expect(state.windows[b].state).toBe('tiled');
    // A and B keep their absolute 1/3 widths: the footprint shrinks to 2/3 (no
    // rescale to fill C's freed slot).
    expect(state.tileTreeRect.x).toBeCloseTo(0, 6);
    expect(state.tileTreeRect.w).toBeCloseTo(2 / 3, 5);
  });

  it('evicting down to a single pane via pop-out floats the lone remaining window', () => {
    const { a, b, c } = makeThreeTiled();
    useWindowStore.getState().untileWindow(b);
    useWindowStore.getState().untileWindow(c);
    const state = useWindowStore.getState();
    expect(state.tileTree).toBeNull();
    // Pop-out floats the lone survivor (does not snap it to a half).
    expect(state.windows[a].state).toBe('floating');
  });

  it('docking onto a half-snapped window confines the tile group to that footprint (not full width)', () => {
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 }); // left half
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
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
    const c = useWindowStore.getState().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    // Edge-snap C to the right while a tree exists -> it JOINS the tree (not a lone snap).
    useWindowStore.getState().dockWindow(c, 'right');
    const state = useWindowStore.getState();
    expect(state.windows[c].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b, c].sort());
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('dockIntoWindow merges a lone snapped window (outside the tree) into the single tree', () => {
    // A tree confined to the right half.
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockIntoWindow(b, a, 'bottom'); // seed pair in the right half
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    // A lone snapped window parked on the LEFT, outside the tree (the orphan case).
    const c = useWindowStore.getState().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().snapWindow(c, { x: 0, y: 0, w: 0.5, h: 1 });
    expect(useWindowStore.getState().windows[c].state).toBe('snapped');
    // Drag a 4th window onto the orphan -> merges the orphan + dragged into the ONE tree.
    const d = useWindowStore.getState().openWindow({ anchor: 'd', sessionId: 's4', title: 'D' });
    useWindowStore.getState().dockIntoWindow(d, c, 'bottom');
    const state = useWindowStore.getState();
    expect(state.windows[c].state).toBe('tiled');
    expect(state.windows[d].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b, c, d].sort());
    expect(state.tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('collapsing a footprint-confined group resets the footprint to the full overlay', () => {
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockIntoWindow(b, a, 'bottom');
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    useWindowStore.getState().untileWindow(b); // 2-up -> collapse -> footprint resets
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('evicting a top-level pane keeps the surviving group docked in its region (no rescale)', () => {
    // Root = [ left window | right column of two ], filling the overlay.
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockWindow(b, 'right'); // A | B across the overlay
    const c = useWindowStore.getState().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().dockIntoWindow(c, b, 'bottom'); // B's cell -> column(B, C)
    expect(useWindowStore.getState().tileTreeRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    // Pop the LEFT pane: ONLY A floats; the right column (B, C) STAYS DOCKED and
    // keeps its right-half width (the freed left half becomes empty board), not
    // stretching to full screen.
    useWindowStore.getState().untileWindow(a);
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('floating');
    expect(state.windows[b].state).toBe('tiled');
    expect(state.windows[c].state).toBe('tiled');
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

  it('enforceMinPaneSize grows a confined group so the narrowest pane clears the min width', () => {
    // A 2-pane group confined to a NARROW 20% footprint (each pane 10% of the overlay).
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().snapWindow(a, { x: 0.4, y: 0, w: 0.2, h: 1 });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    useWindowStore.getState().dockIntoWindow(b, a, 'right'); // pair confined to the 20% footprint
    expect(useWindowStore.getState().tileTreeRect.w).toBeCloseTo(0.2, 6);
    // On a 2000px overlay each pane is 200px; a 650px min needs the footprint to grow
    // to 0.65 (1300px) so each pane is exactly 650px, centred on the old footprint.
    useWindowStore.getState().enforceMinPaneSize(650, 400, 2000, 2000);
    expect(useWindowStore.getState().tileTreeRect.w).toBeCloseTo(0.65, 5);
    expect(useWindowStore.getState().tileTreeRect.x).toBeCloseTo(0.175, 5);
  });

  it('enforceMinPaneSize is a no-op when every pane already clears the floor', () => {
    makeTiledPair(); // full overlay, each pane 50% (1000px on a 2000px overlay)
    const before = useWindowStore.getState().tileTreeRect;
    useWindowStore.getState().enforceMinPaneSize(650, 400, 2000, 2000);
    expect(useWindowStore.getState().tileTreeRect).toEqual(before);
  });

  it('snapWindow evicts the window from its tile group (no stale tree reference)', () => {
    const { a, b } = makeTiledPair(); // A | B, full overlay
    useWindowStore.getState().snapWindow(a, { x: 0, y: 0, w: 1, h: 0.5 }); // snap A to top half
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('snapped');
    expect(state.windows[a].geometry).toMatchObject({ x: 0, y: 0, w: 1, h: 0.5 });
    // The pair dissolved: A is gone from the tree (here the 2-up collapses entirely).
    expect(state.tileTree === null || !collectLeafWindowIds(state.tileTree).includes(a)).toBe(true);
    expect(state.windows[b].state).not.toBe('tiled');
  });

  it('snapWindow on one pane of a 3-up group leaves the other two tiled without it', () => {
    const { a, b } = makeTiledPair(); // A | B
    const c = useWindowStore.getState().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    useWindowStore.getState().dockWindow(c, 'right'); // joins the tree as a third pane
    expect(collectLeafWindowIds(useWindowStore.getState().tileTree).sort()).toEqual([a, b, c].sort());

    useWindowStore.getState().snapWindow(b, { x: 0, y: 0, w: 1, h: 0.5 }); // snap the middle one out
    const state = useWindowStore.getState();
    expect(state.windows[b].state).toBe('snapped');
    // The other two stay tiled; the tree no longer references the snapped window.
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, c].sort());
    expect(collectLeafWindowIds(state.tileTree)).not.toContain(b);
  });

  it('dockIntoWindow never duplicates a leaf when the dragged window is already in the tree', () => {
    const { a, b } = makeTiledPair(); // tree [a, b]
    // Re-dock A (already tiled) into B - a stale-reference scenario that used to add a
    // SECOND leaf for A (a phantom empty pane / invisible wall). It must MOVE, not dup.
    useWindowStore.getState().dockIntoWindow(a, b, 'right');
    const leaves = collectLeafWindowIds(useWindowStore.getState().tileTree);
    expect(leaves.filter((id) => id === a).length).toBe(1);
    expect(leaves.sort()).toEqual([a, b].sort());
  });

  it('snap-menu presets never corrupt the tree (no duplicate or stale leaves)', () => {
    // The snap menu (Snap left/right/top/bottom, Columns, Grid) maps to applyTilePreset.
    // Hammer cumulative sequences over 3 windows and assert the tree invariant after
    // every step: each leaf is unique AND maps to a window whose state is 'tiled'. A
    // duplicate or stale leaf is the "phantom empty pane / invisible wall" corruption.
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    const b = useWindowStore.getState().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    const c = useWindowStore.getState().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    const ids = new Set([a, b, c]);
    const presets = [
      'columns', 'left-half', 'right-half', 'grid', 'top-half', 'bottom-half',
      'columns', 'left-half', 'left-half', 'right-half', 'grid', 'columns',
    ] as const;
    for (const preset of presets) {
      useWindowStore.getState().applyTilePreset(preset);
      const tree = useWindowStore.getState().tileTree;
      const leaves = collectLeafWindowIds(tree);
      // No duplicates.
      expect(leaves.length).toBe(new Set(leaves).size);
      // Every leaf maps to a known window that is actually 'tiled' (no stale ref).
      for (const id of leaves) {
        expect(ids.has(id)).toBe(true);
        expect(useWindowStore.getState().windows[id].state).toBe('tiled');
      }
    }
  });

  it('restoreWindow returns a maximized TILED window to its docked slot, not floating', () => {
    const { a, b } = makeTiledPair(); // a | b tiled
    useWindowStore.getState().maximizeWindow(a);
    expect(useWindowStore.getState().windows[a].state).toBe('maximized');
    useWindowStore.getState().restoreWindow(a);
    const state = useWindowStore.getState();
    // Un-maximize re-docks it (no floating), and the tree keeps both panes (no stale ref).
    expect(state.windows[a].state).toBe('tiled');
    expect(collectLeafWindowIds(state.tileTree).sort()).toEqual([a, b].sort());
  });

  it('restoreWindow returns a maximized FLOATING window to floating', () => {
    const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    useWindowStore.getState().maximizeWindow(a); // floating -> maximized (not in any tree)
    useWindowStore.getState().restoreWindow(a);
    expect(useWindowStore.getState().windows[a].state).toBe('floating');
    expect(useWindowStore.getState().tileTree).toBeNull();
  });
});

/** Walk a tile tree and collect every leaf's windowId (test-local helper). */
function collectLeafWindowIds(tree: ReturnType<typeof useWindowStore.getState>['tileTree']): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.windowId];
  return tree.children.flatMap((child) => collectLeafWindowIds(child));
}

// ---------------------------------------------------------------------------
// Factory isolation: createWindowManagerStore builds fully independent instances.
// ---------------------------------------------------------------------------
import { createWindowManagerStore } from '../../src/renderer/window-manager/store/window-store';

describe('createWindowManagerStore - two-instance isolation, id namespacing, and kind-gated dedup', () => {
  it('opening a window in instance A does NOT appear in instance B (windows maps are fully disjoint)', () => {
    const instanceA = createWindowManagerStore({ idPrefix: 'board', kind: 'task-detail' });
    const instanceB = createWindowManagerStore({ idPrefix: 'cmd', kind: 'command-terminal' });

    instanceA.store.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A' });

    // Instance B's windows map must remain empty.
    expect(Object.keys(instanceB.store.getState().windows)).toHaveLength(0);
    // Instance A must have exactly one window.
    expect(Object.keys(instanceA.store.getState().windows)).toHaveLength(1);
  });

  it('generated window ids carry the instance idPrefix so two layers never collide', () => {
    const instanceA = createWindowManagerStore({ idPrefix: 'board', kind: 'task-detail' });
    const instanceB = createWindowManagerStore({ idPrefix: 'cmd', kind: 'command-terminal' });

    const idFromA = instanceA.store.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A' });
    const idFromB = instanceB.store.getState().openWindow({ anchor: 'slot-1', sessionId: null, title: 'Cmd' });

    // Each id must start with its layer's prefix.
    expect(idFromA).toMatch(/^board-/);
    expect(idFromB).toMatch(/^cmd-/);
    // They must not be equal (no cross-layer collision).
    expect(idFromA).not.toBe(idFromB);
  });

  it('openWindow dedups by (kind, anchor): same anchor + same kind returns the existing window', () => {
    const instance = createWindowManagerStore({ idPrefix: 'board', kind: 'task-detail' });

    const firstId = instance.store.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A' });
    const secondId = instance.store.getState().openWindow({ anchor: 'task-a', sessionId: 'sess-a', title: 'A again' });

    // Re-opening the same anchor+kind must return the same id (one window only).
    expect(secondId).toBe(firstId);
    expect(Object.keys(instance.store.getState().windows)).toHaveLength(1);
  });

  it('openWindow kind-gated dedup: same anchor with a DIFFERENT kind creates a second window', () => {
    // One store configured as task-detail; opening a command-terminal kind for the
    // same anchor value must NOT collide with the task-detail window.
    const instance = createWindowManagerStore({ idPrefix: 'board', kind: 'task-detail' });

    const taskDetailId = instance.store.getState().openWindow({
      kind: 'task-detail',
      anchor: 'shared-anchor',
      sessionId: 'sess-a',
      title: 'Task window',
    });
    const commandId = instance.store.getState().openWindow({
      kind: 'command-terminal',
      anchor: 'shared-anchor',
      sessionId: null,
      title: 'Command window',
    });

    // Different kind -> two distinct windows, not a dedup.
    expect(commandId).not.toBe(taskDetailId);
    expect(Object.keys(instance.store.getState().windows)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Stale-leaf invariant: the tree <-> state <-> leafId contract must always hold.
// The checker (findWindowTreeViolations) is the single source of truth shared by
// the dev runtime tripwire and these tests. First prove the checker DETECTS each
// corruption form, then prove every store mutation KEEPS the state clean.
// ---------------------------------------------------------------------------

/** Build a plain ManagedWindow for the pure-checker tests (no store). */
function makeWindow(id: string, overrides: Partial<ManagedWindow> = {}): ManagedWindow {
  return {
    id,
    kind: 'task-detail',
    anchor: id,
    sessionId: null,
    geometry: { x: 0, y: 0, w: 0.5, h: 1 },
    state: 'floating',
    zIndex: 1,
    leafId: null,
    sessionStatus: 'closed',
    restoreGeometry: null,
    title: id,
    ...overrides,
  };
}

function leafNode(windowId: string, id: string): TileNode {
  return { kind: 'leaf', id, windowId };
}

/** A clean two-leaf horizontal split between two windows. */
function pairTree(leftWindowId: string, rightWindowId: string): TileNode {
  return {
    kind: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [leafNode(leftWindowId, 'leaf-1'), leafNode(rightWindowId, 'leaf-2')],
    sizes: [0.5, 0.5],
  };
}

describe('findWindowTreeViolations - stale-leaf checker', () => {
  it('passes an empty workspace', () => {
    expect(findWindowTreeViolations({}, null)).toEqual([]);
  });

  it('passes a lone floating window', () => {
    expect(findWindowTreeViolations({ a: makeWindow('a') }, null)).toEqual([]);
  });

  it('passes a clean tiled pair', () => {
    const windows = {
      a: makeWindow('a', { state: 'tiled', leafId: 'leaf-1' }),
      b: makeWindow('b', { state: 'tiled', leafId: 'leaf-2' }),
    };
    expect(findWindowTreeViolations(windows, pairTree('a', 'b'))).toEqual([]);
  });

  it('flags a stale leaf: a floating window still referenced by the tree', () => {
    const windows = {
      a: makeWindow('a', { state: 'floating', leafId: null }), // floating yet in the tree
      b: makeWindow('b', { state: 'tiled', leafId: 'leaf-2' }),
    };
    expect(findWindowTreeViolations(windows, pairTree('a', 'b')).some((v) => v.includes('stale leaf'))).toBe(true);
  });

  it('flags a phantom tiled window not present in the tree', () => {
    const windows = { a: makeWindow('a', { state: 'tiled', leafId: 'leaf-x' }) };
    expect(findWindowTreeViolations(windows, null).some((v) => v.includes('not in the tile tree'))).toBe(true);
  });

  it('flags a dangling leafId on a floating window', () => {
    const windows = { a: makeWindow('a', { state: 'floating', leafId: 'leaf-ghost' }) };
    expect(findWindowTreeViolations(windows, null).some((v) => v.includes('dangling'))).toBe(true);
  });

  it('flags a duplicate leaf (the invisible-wall corruption)', () => {
    const windows = {
      a: makeWindow('a', { state: 'tiled', leafId: 'leaf-1' }),
      b: makeWindow('b', { state: 'tiled', leafId: 'leaf-2' }),
    };
    // A referenced by TWO leaves -> the phantom empty pane / invisible wall.
    const tree: TileNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [leafNode('a', 'leaf-1'), leafNode('a', 'leaf-3'), leafNode('b', 'leaf-2')],
      sizes: [1 / 3, 1 / 3, 1 / 3],
    };
    expect(findWindowTreeViolations(windows, tree).some((v) => v.includes('duplicate leaf'))).toBe(true);
  });

  it('flags an orphan leaf referencing a missing window', () => {
    const windows = { a: makeWindow('a', { state: 'tiled', leafId: 'leaf-1' }) };
    expect(findWindowTreeViolations(windows, pairTree('a', 'ghost')).some((v) => v.includes('missing window ghost'))).toBe(true);
  });

  it('flags a degenerate single-leaf tree (collapse should have cleared it)', () => {
    const windows = { a: makeWindow('a', { state: 'tiled', leafId: 'leaf-1' }) };
    expect(findWindowTreeViolations(windows, leafNode('a', 'leaf-1')).some((v) => v.includes('needs >= 2'))).toBe(true);
  });

  it('allows a maximized window that is still a tiled pane (maximize keeps its leaf)', () => {
    const windows = {
      a: makeWindow('a', { state: 'maximized', leafId: 'leaf-1' }),
      b: makeWindow('b', { state: 'tiled', leafId: 'leaf-2' }),
    };
    expect(findWindowTreeViolations(windows, pairTree('a', 'b'))).toEqual([]);
  });

  it('flags a maximized window outside the tree that still carries a leafId', () => {
    const windows = { a: makeWindow('a', { state: 'maximized', leafId: 'leaf-ghost' }) };
    expect(findWindowTreeViolations(windows, null).some((v) => v.includes('dangling'))).toBe(true);
  });
});

describe('window-store maintains the tiling invariant across every operation', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null, zCounter: 0, tileTree: null, tileTreeRect: { x: 0, y: 0, w: 1, h: 1 } });
  });

  /** Assert the live store state has no stale-leaf violations; the label + the
   *  offending violation strings both print on failure so the failing step is
   *  obvious. */
  function assertClean(label: string): void {
    const state = useWindowStore.getState();
    const violations = findWindowTreeViolations(state.windows, state.tileTree);
    expect({ label, violations }).toEqual({ label, violations: [] });
  }

  it('stays consistent through a full open/snap/dock/insert/untile/close lifecycle', () => {
    const store = useWindowStore.getState;
    const a = store().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    assertClean('open A');
    store().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    assertClean('snap A left');
    const b = store().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    store().dockWindow(b, 'right');
    assertClean('dock B right (pair)');
    const c = store().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    store().dockIntoWindow(c, b, 'right');
    assertClean('insert C (3-up)');
    store().untileWindow(c);
    assertClean('untile C');
    store().untileWindow(a);
    assertClean('untile A (collapse to floating)');
    store().closeWindow(b);
    assertClean('close last window');
  });

  it('stays consistent through maximize / restore on both tiled and floating windows', () => {
    const store = useWindowStore.getState;
    const a = store().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    store().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = store().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    store().dockWindow(b, 'right'); // a | b tiled
    store().maximizeWindow(a);
    assertClean('maximize tiled pane A');
    store().restoreWindow(a);
    assertClean('restore A back to its docked slot');
    store().untileWindow(a); // dissolve so B is no longer tiled
    const d = store().openWindow({ anchor: 'd', sessionId: 's4', title: 'D' });
    store().maximizeWindow(d);
    assertClean('maximize floating D');
    store().restoreWindow(d);
    assertClean('restore floating D');
  });

  it('stays consistent under cumulative snap-menu presets over three windows', () => {
    const store = useWindowStore.getState;
    store().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    store().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    store().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    const presets = ['columns', 'left-half', 'right-half', 'grid', 'top-half', 'bottom-half', 'columns', 'grid'] as const;
    for (const preset of presets) {
      store().applyTilePreset(preset);
      assertClean(`applyTilePreset ${preset}`);
    }
  });

  it('stays consistent when snapping a middle pane out of a 3-up group', () => {
    const store = useWindowStore.getState;
    const a = store().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    store().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = store().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    store().dockWindow(b, 'right');
    const c = store().openWindow({ anchor: 'c', sessionId: 's3', title: 'C' });
    store().dockWindow(c, 'right'); // a | b | c
    store().snapWindow(b, { x: 0, y: 0, w: 1, h: 0.5 }); // snap the middle one out
    assertClean('snap middle pane out of 3-up');
  });

  it('setGeometry on a still-tiled window evicts it instead of leaving a stale leaf', () => {
    const store = useWindowStore.getState;
    const a = store().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
    store().snapWindow(a, { x: 0, y: 0, w: 0.5, h: 1 });
    const b = store().openWindow({ anchor: 'b', sessionId: 's2', title: 'B' });
    store().dockWindow(b, 'right'); // a | b tiled
    expect(store().windows[a].state).toBe('tiled');
    // Commit a free geometry directly on the still-tiled pane A (the latent hole).
    store().setGeometry(a, { x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
    const state = useWindowStore.getState();
    expect(state.windows[a].state).toBe('floating');
    expect(state.windows[a].leafId).toBeNull();
    // A left the tree cleanly: no stale leaf, no dangling reference.
    expect(findWindowTreeViolations(state.windows, state.tileTree)).toEqual([]);
  });

  it('restoreWindow scrubs a dangling leafId when un-maximizing to floating', () => {
    // Silence the one expected dev-tripwire log from the crafted corrupt precondition.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const a = useWindowStore.getState().openWindow({ anchor: 'a', sessionId: 's1', title: 'A' });
      // Craft the impossible-via-API state: maximized, carrying a leafId, but NOT in
      // any tree (the tree was torn down under it). The floating restore branch must
      // scrub the leafId so no dangling reference survives.
      useWindowStore.setState((current) => ({
        windows: { ...current.windows, [a]: { ...current.windows[a], state: 'maximized', leafId: 'leaf-ghost' } },
      }));
      useWindowStore.getState().restoreWindow(a);
      const state = useWindowStore.getState();
      expect(state.windows[a].state).toBe('floating');
      expect(state.windows[a].leafId).toBeNull();
      expect(findWindowTreeViolations(state.windows, state.tileTree)).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
