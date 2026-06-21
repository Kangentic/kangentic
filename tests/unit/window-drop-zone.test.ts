import { describe, it, expect } from 'vitest';
import {
  collectCandidatePanes,
  detectDropTarget,
  detectTiledDropTarget,
} from '../../src/renderer/window-manager/dnd/drop-zone';
import type { CandidatePane, TreeBounds } from '../../src/renderer/window-manager/dnd/drop-zone';
import type { ManagedWindow, TileNode } from '../../src/renderer/window-manager/store/types';

const CONTAINER = { width: 1000, height: 800 };

function makeWindow(overrides: Partial<ManagedWindow> & { id: string }): ManagedWindow {
  return {
    id: overrides.id,
    taskId: overrides.taskId ?? `task-${overrides.id}`,
    sessionId: overrides.sessionId ?? null,
    geometry: overrides.geometry ?? { x: 0, y: 0, w: 0.5, h: 1 },
    state: overrides.state ?? 'floating',
    zIndex: overrides.zIndex ?? 1,
    leafId: overrides.leafId ?? null,
    sessionStatus: overrides.sessionStatus ?? 'live',
    restoreGeometry: overrides.restoreGeometry ?? null,
    title: overrides.title ?? overrides.id,
  };
}

const PANE: CandidatePane = { windowId: 'w1', zIndex: 1, rect: { left: 0, top: 0, width: 1000, height: 800 } };

describe('collectCandidatePanes', () => {
  it('returns the tiled panes (resolved edge-to-edge) when a tree exists, excluding the dragged window', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'la', windowId: 'w1' },
        { kind: 'leaf', id: 'lb', windowId: 'w2' },
      ],
      sizes: [0.5, 0.5],
    };
    const windows: Record<string, ManagedWindow> = {
      w1: makeWindow({ id: 'w1', state: 'tiled', zIndex: 3 }),
      w2: makeWindow({ id: 'w2', state: 'tiled', zIndex: 4 }),
    };
    const panes = collectCandidatePanes('w1', windows, tree, CONTAINER, { x: 0, y: 0, w: 1, h: 1 });
    expect(panes).toHaveLength(1);
    expect(panes[0]).toEqual({ windowId: 'w2', zIndex: 4, rect: { left: 500, top: 0, width: 500, height: 800 } });
  });

  it('resolves tiled panes WITHIN a confined footprint (left-half group), not the full overlay', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'la', windowId: 'w1' },
        { kind: 'leaf', id: 'lb', windowId: 'w2' },
      ],
      sizes: [0.5, 0.5],
    };
    const windows: Record<string, ManagedWindow> = {
      w1: makeWindow({ id: 'w1', state: 'tiled' }),
      w2: makeWindow({ id: 'w2', state: 'tiled', zIndex: 2 }),
    };
    // Group confined to the LEFT half: panes split that half, staying in 0..500px.
    const panes = collectCandidatePanes('w1', windows, tree, CONTAINER, { x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes[0]).toEqual({ windowId: 'w2', zIndex: 2, rect: { left: 250, top: 0, width: 250, height: 800 } });
  });

  it('returns every visible floating window when no tree exists, excluding the dragged one', () => {
    const windows: Record<string, ManagedWindow> = {
      dragged: makeWindow({ id: 'dragged' }),
      floater: makeWindow({ id: 'floater', geometry: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, zIndex: 2 }),
    };
    const panes = collectCandidatePanes('dragged', windows, null, CONTAINER, { x: 0, y: 0, w: 1, h: 1 });
    expect(panes.map((pane) => pane.windowId)).toEqual(['floater']);
    expect(panes[0].rect).toEqual({ left: 250, top: 80, width: 500, height: 400 });
  });

  it('also offers lone non-tree windows as candidates when a tree exists (so an orphan is dockable)', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'la', windowId: 'w1' },
        { kind: 'leaf', id: 'lb', windowId: 'w2' },
      ],
      sizes: [0.5, 0.5],
    };
    const windows: Record<string, ManagedWindow> = {
      w1: makeWindow({ id: 'w1', state: 'tiled' }),
      w2: makeWindow({ id: 'w2', state: 'tiled', zIndex: 2 }),
      orphan: makeWindow({ id: 'orphan', state: 'snapped', geometry: { x: 0, y: 0, w: 0.5, h: 1 }, zIndex: 3 }),
      dragged: makeWindow({ id: 'dragged', zIndex: 4 }),
    };
    // Tree confined to the right half; the orphan is a separate snapped window.
    const panes = collectCandidatePanes('dragged', windows, tree, CONTAINER, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const ids = panes.map((pane) => pane.windowId).sort();
    expect(ids).toEqual(['orphan', 'w1', 'w2']);
    // The orphan is hit-tested at its own geometry (left half), not a tree rect.
    expect(panes.find((pane) => pane.windowId === 'orphan')?.rect).toEqual({ left: 0, top: 0, width: 500, height: 800 });
  });

  it('projects a maximized window to the full container', () => {
    const windows: Record<string, ManagedWindow> = {
      dragged: makeWindow({ id: 'dragged' }),
      big: makeWindow({ id: 'big', state: 'maximized', geometry: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } }),
    };
    const panes = collectCandidatePanes('dragged', windows, null, CONTAINER, { x: 0, y: 0, w: 1, h: 1 });
    expect(panes[0].rect).toEqual({ left: 0, top: 0, width: 1000, height: 800 });
  });
});

describe('detectDropTarget', () => {
  it('arms the LEFT band and previews the left half', () => {
    const target = detectDropTarget(40, 400, [PANE]);
    expect(target).toEqual({
      targetWindowId: 'w1',
      side: 'left',
      previewRect: { left: 0, top: 0, width: 500, height: 800 },
    });
  });

  it('arms the RIGHT band and previews the right half', () => {
    const target = detectDropTarget(960, 400, [PANE]);
    expect(target?.side).toBe('right');
    expect(target?.previewRect).toEqual({ left: 500, top: 0, width: 500, height: 800 });
  });

  it('arms TOP in the center column above the midline (horizontal split preview)', () => {
    const target = detectDropTarget(500, 40, [PANE]);
    expect(target?.side).toBe('top');
    expect(target?.previewRect).toEqual({ left: 0, top: 0, width: 1000, height: 400 });
  });

  it('arms BOTTOM in the center column below the midline', () => {
    const target = detectDropTarget(500, 760, [PANE]);
    expect(target?.side).toBe('bottom');
    expect(target?.previewRect).toEqual({ left: 0, top: 400, width: 1000, height: 400 });
  });

  it('left/right bands are FULL-HEIGHT: the side is the same at top, middle, and bottom', () => {
    // The reported inconsistency: near the vertical middle on the left side it
    // used to flip left <-> top/bottom along a diagonal. The left third now docks
    // LEFT at every height (right third docks RIGHT), so the choice is predictable.
    expect(detectDropTarget(150, 80, [PANE])?.side).toBe('left');
    expect(detectDropTarget(150, 400, [PANE])?.side).toBe('left');
    expect(detectDropTarget(150, 720, [PANE])?.side).toBe('left');
    expect(detectDropTarget(850, 80, [PANE])?.side).toBe('right');
    expect(detectDropTarget(850, 720, [PANE])?.side).toBe('right');
  });

  it('ALWAYS docks while over a pane - no dead zone; the center column splits at the midline', () => {
    // Center column (x in the middle third): top above the midline, bottom below.
    expect(detectDropTarget(500, 400, [PANE])).not.toBeNull();
    expect(detectDropTarget(500, 360, [PANE])?.side).toBe('top');
    expect(detectDropTarget(500, 440, [PANE])?.side).toBe('bottom');
  });

  it('returns null only when the center is over no pane (then it floats / edge-snaps)', () => {
    expect(detectDropTarget(1200, 400, [PANE])).toBeNull();
  });

  it('picks the front-most (highest zIndex) pane when panes overlap', () => {
    const back: CandidatePane = { windowId: 'back', zIndex: 1, rect: { left: 0, top: 0, width: 1000, height: 800 } };
    const front: CandidatePane = { windowId: 'front', zIndex: 5, rect: { left: 0, top: 0, width: 1000, height: 800 } };
    const target = detectDropTarget(40, 400, [back, front]);
    expect(target?.targetWindowId).toBe('front');
  });
});

describe('detectTiledDropTarget', () => {
  // A vertical stack of three full-width panes (each 300 tall) over a 1000x900 tree.
  const STACK: CandidatePane[] = [
    { windowId: 'a', zIndex: 1, rect: { left: 0, top: 0, width: 1000, height: 300 } },
    { windowId: 'b', zIndex: 2, rect: { left: 0, top: 300, width: 1000, height: 300 } },
    { windowId: 'c', zIndex: 3, rect: { left: 0, top: 600, width: 1000, height: 300 } },
  ];
  const STACK_BOUNDS: TreeBounds = { left: 0, top: 0, right: 1000, bottom: 900 };

  it('arms the TOP extreme when the dragged window TOP EDGE reaches the stack top', () => {
    // Window pushed to the top: top edge at 0, center in the upper half.
    const dragged = { left: 250, top: 0, width: 500, height: 350 };
    const target = detectTiledDropTarget(dragged, STACK, 'vertical', STACK_BOUNDS);
    expect(target).toMatchObject({ targetWindowId: 'a', side: 'top' });
  });

  it('arms the BOTTOM extreme when the dragged window BOTTOM EDGE reaches the stack bottom', () => {
    const dragged = { left: 250, top: 550, width: 500, height: 350 }; // bottom edge at 900
    const target = detectTiledDropTarget(dragged, STACK, 'vertical', STACK_BOUNDS);
    expect(target).toMatchObject({ targetWindowId: 'c', side: 'bottom' });
  });

  it('uses the BODY CENTER for interior gaps, even when the window is TALLER than a pane', () => {
    // 350-tall window (taller than a 300 pane), centered in pane B, not near an edge.
    const dragged = { left: 250, top: 300, width: 500, height: 350 }; // center y = 475
    const target = detectTiledDropTarget(dragged, STACK, 'vertical', STACK_BOUNDS);
    // 475 sits in pane B's lower half -> insert BELOW B (the B/C gap), via body center.
    expect(target).toMatchObject({ targetWindowId: 'b', side: 'bottom' });
  });

  it('does NOT arm an extreme when the window is flung off the stack (cross-axis guard)', () => {
    // Top edge at the boundary, but the center is far left of the stack.
    const dragged = { left: -800, top: 0, width: 500, height: 350 };
    expect(detectTiledDropTarget(dragged, STACK, 'vertical', STACK_BOUNDS)).toBeNull();
  });

  it('a HORIZONTAL root owns left/right extremes: left edge to the row left arms LEFT', () => {
    const row: CandidatePane[] = [
      { windowId: 'l', zIndex: 1, rect: { left: 0, top: 0, width: 500, height: 800 } },
      { windowId: 'r', zIndex: 2, rect: { left: 500, top: 0, width: 500, height: 800 } },
    ];
    const rowBounds: TreeBounds = { left: 0, top: 0, right: 1000, bottom: 800 };
    const dragged = { left: 0, top: 200, width: 350, height: 400 }; // left edge at 0
    const target = detectTiledDropTarget(dragged, row, 'horizontal', rowBounds);
    expect(target).toMatchObject({ targetWindowId: 'l', side: 'left' });
  });
});
