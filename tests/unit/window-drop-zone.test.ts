import { describe, it, expect } from 'vitest';
import {
  collectCandidatePanes,
  detectDropTarget,
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
    previousState: overrides.previousState ?? null,
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
      ratio: 0.5,
      a: { kind: 'leaf', id: 'la', windowId: 'w1' },
      b: { kind: 'leaf', id: 'lb', windowId: 'w2' },
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
      ratio: 0.5,
      a: { kind: 'leaf', id: 'la', windowId: 'w1' },
      b: { kind: 'leaf', id: 'lb', windowId: 'w2' },
    };
    const windows: Record<string, ManagedWindow> = {
      w1: makeWindow({ id: 'w1', state: 'tiled' }),
      w2: makeWindow({ id: 'w2', state: 'tiled', zIndex: 2 }),
    };
    // Group confined to the LEFT half: panes split that half, staying in 0..500px.
    const panes = collectCandidatePanes('w1', windows, tree, CONTAINER, { x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes[0]).toEqual({ windowId: 'w2', zIndex: 2, rect: { left: 250, top: 0, width: 250, height: 800 } });
  });

  it('returns every visible floating window when no tree exists, excluding dragged + minimized', () => {
    const windows: Record<string, ManagedWindow> = {
      dragged: makeWindow({ id: 'dragged' }),
      floater: makeWindow({ id: 'floater', geometry: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, zIndex: 2 }),
      hidden: makeWindow({ id: 'hidden', state: 'minimized' }),
    };
    const panes = collectCandidatePanes('dragged', windows, null, CONTAINER, { x: 0, y: 0, w: 1, h: 1 });
    expect(panes.map((pane) => pane.windowId)).toEqual(['floater']);
    expect(panes[0].rect).toEqual({ left: 250, top: 80, width: 500, height: 400 });
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
  it('arms the nearest edge (left band) and previews that half', () => {
    const target = detectDropTarget(40, 400, [PANE]);
    expect(target).toEqual({
      targetWindowId: 'w1',
      side: 'left',
      previewRect: { left: 0, top: 0, width: 500, height: 800 },
    });
  });

  it('arms top when the cursor is near the top edge (vertical split preview)', () => {
    const target = detectDropTarget(500, 40, [PANE]);
    expect(target?.side).toBe('top');
    expect(target?.previewRect).toEqual({ left: 0, top: 0, width: 1000, height: 400 });
  });

  it('arms bottom near the bottom edge', () => {
    const target = detectDropTarget(500, 760, [PANE]);
    expect(target?.side).toBe('bottom');
    expect(target?.previewRect).toEqual({ left: 0, top: 400, width: 1000, height: 400 });
  });

  it('returns null in the dead center (release floats, no dock)', () => {
    expect(detectDropTarget(500, 400, [PANE])).toBeNull();
  });

  it('returns null when the cursor is over no pane', () => {
    expect(detectDropTarget(1200, 400, [PANE])).toBeNull();
  });

  it('picks the front-most (highest zIndex) pane when panes overlap', () => {
    const back: CandidatePane = { windowId: 'back', zIndex: 1, rect: { left: 0, top: 0, width: 1000, height: 800 } };
    const front: CandidatePane = { windowId: 'front', zIndex: 5, rect: { left: 0, top: 0, width: 1000, height: 800 } };
    const target = detectDropTarget(40, 400, [back, front]);
    expect(target?.targetWindowId).toBe('front');
  });
});
