import { describe, it, expect } from 'vitest';
import {
  collectCandidatePanes,
  detectDropTarget,
  hasClearedFreeMove,
  resolveDockTarget,
  FREE_MOVE_RADIUS_PX,
} from '../../src/renderer/window-manager/dnd/drop-zone';
import type { CandidatePane } from '../../src/renderer/window-manager/dnd/drop-zone';
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

  it('the POINT test has no dead zone - it always resolves a side while over a pane', () => {
    // Deliberately no positional dead zone: one would reintroduce the flip-flopping
    // the priority bands fixed. Free movement comes from the TRAVEL budget in
    // `resolveDockTarget` instead, which is what a drag actually calls.
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

describe('every tile-tree slot is reachable from the bands alone', () => {
  // This is the test that lets the second targeting signal be DELETED rather than
  // reimplemented. A body center could not reach a stack's first or last slot (the
  // dragged window is bigger than a pane), which is what forced an entire parallel
  // path into existence - tree bounds, edge zones, extreme-pane search, root-axis
  // plumbing. A pointer reaches all of them, so the bands are sufficient.
  const STACK: CandidatePane[] = [
    { windowId: 'a', zIndex: 1, rect: { left: 0, top: 0, width: 1000, height: 300 } },
    { windowId: 'b', zIndex: 2, rect: { left: 0, top: 300, width: 1000, height: 300 } },
    { windowId: 'c', zIndex: 3, rect: { left: 0, top: 600, width: 1000, height: 300 } },
  ];
  const centerColumnX = 500; // the middle third, where top/bottom resolve

  it('reaches a vertical stack: above the first pane, every seam, below the last', () => {
    // Above A - the slot a body center could never reach.
    expect(detectDropTarget(centerColumnX, 20, STACK)).toMatchObject({ targetWindowId: 'a', side: 'top' });
    // The A/B seam, from either side of it.
    expect(detectDropTarget(centerColumnX, 280, STACK)).toMatchObject({ targetWindowId: 'a', side: 'bottom' });
    expect(detectDropTarget(centerColumnX, 320, STACK)).toMatchObject({ targetWindowId: 'b', side: 'top' });
    // Below C - the other formerly unreachable extreme.
    expect(detectDropTarget(centerColumnX, 880, STACK)).toMatchObject({ targetWindowId: 'c', side: 'bottom' });
  });

  it('reaches a horizontal row: outside the first pane, the seam, outside the last', () => {
    const ROW: CandidatePane[] = [
      { windowId: 'l', zIndex: 1, rect: { left: 0, top: 0, width: 500, height: 800 } },
      { windowId: 'r', zIndex: 2, rect: { left: 500, top: 0, width: 500, height: 800 } },
    ];
    expect(detectDropTarget(20, 400, ROW)).toMatchObject({ targetWindowId: 'l', side: 'left' });
    expect(detectDropTarget(450, 400, ROW)).toMatchObject({ targetWindowId: 'l', side: 'right' });
    expect(detectDropTarget(980, 400, ROW)).toMatchObject({ targetWindowId: 'r', side: 'right' });
  });

  it('a pointer off every pane docks nothing, however the windows are arranged', () => {
    // Replaces the old confined-tree guard: dragging away from a group simply
    // leaves the cursor over no pane, with no footprint bookkeeping involved.
    expect(detectDropTarget(1400, 400, STACK)).toBeNull();
  });
});

describe('hasClearedFreeMove', () => {
  // Everything derives from FREE_MOVE_RADIUS_PX so retuning the feel constant never
  // turns into a test edit.
  it('stays closed for no movement and up to and including the radius', () => {
    expect(hasClearedFreeMove(0, 0)).toBe(false);
    expect(hasClearedFreeMove(FREE_MOVE_RADIUS_PX / 2, 0)).toBe(false);
    expect(hasClearedFreeMove(FREE_MOVE_RADIUS_PX, 0)).toBe(false);
    expect(hasClearedFreeMove(0, -FREE_MOVE_RADIUS_PX)).toBe(false);
  });

  it('opens just past the radius, on either axis and in either direction', () => {
    expect(hasClearedFreeMove(FREE_MOVE_RADIUS_PX + 1, 0)).toBe(true);
    expect(hasClearedFreeMove(-(FREE_MOVE_RADIUS_PX + 1), 0)).toBe(true);
    expect(hasClearedFreeMove(0, FREE_MOVE_RADIUS_PX + 1)).toBe(true);
  });

  it('measures Euclidean distance, so a diagonal nudge clears sooner than either axis', () => {
    // 0.8r on each axis is 1.13r of travel (clears); 0.7r each is 0.99r (does not).
    const diagonal = (factor: number) =>
      hasClearedFreeMove(FREE_MOVE_RADIUS_PX * factor, FREE_MOVE_RADIUS_PX * factor);
    expect(diagonal(0.8)).toBe(true);
    expect(diagonal(0.7)).toBe(false);
  });

  it('does not depend on the window being dragged - the trigger is a cursor position', () => {
    // The budget used to scale with the dragged window's size, a leftover from the
    // body-center model. Nothing about a pointer trigger scales with the window.
    expect(hasClearedFreeMove(FREE_MOVE_RADIUS_PX + 1, 0)).toBe(true);
  });
});

describe('resolveDockTarget (free-move budget)', () => {
  // Grabbing a header that happens to sit over another window: the dock condition
  // is already true at pointer-down, so position alone carries no intent.
  const OTHER: CandidatePane = { windowId: 'other', zIndex: 1, rect: { left: 100, top: 100, width: 800, height: 600 } };
  const POINTER = { x: 500, y: 350 }; // inside OTHER's center column, upper half
  const NUDGE = FREE_MOVE_RADIUS_PX * 0.5;
  const THROW = FREE_MOVE_RADIUS_PX * 2;

  const call = (deltaX: number) =>
    resolveDockTarget({ pointerX: POINTER.x, pointerY: POINTER.y, candidates: [OTHER], deltaX, deltaY: 0 });

  it('a nudge with the cursor over another window arms NOTHING', () => {
    // The position alone would dock - the budget is the only thing holding it back.
    expect(detectDropTarget(POINTER.x, POINTER.y, [OTHER])).not.toBeNull();
    expect(call(NUDGE)).toBeNull();
  });

  it('a deliberate move docks, resolving exactly the side the bands resolve', () => {
    expect(call(THROW)).toEqual(detectDropTarget(POINTER.x, POINTER.y, [OTHER]));
  });

  it('opens just past the radius, not at it', () => {
    expect(call(FREE_MOVE_RADIUS_PX)).toBeNull();
    expect(call(FREE_MOVE_RADIUS_PX + 1)).not.toBeNull();
  });

  it('past the budget, the cursor being off every pane still docks nothing', () => {
    expect(
      resolveDockTarget({ pointerX: 5000, pointerY: 5000, candidates: [OTHER], deltaX: THROW, deltaY: 0 }),
    ).toBeNull();
  });
});
