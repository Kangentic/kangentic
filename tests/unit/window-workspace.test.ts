import { describe, it, expect } from 'vitest';
import {
  serializeWorkspace,
  deserializeWorkspace,
  type RestoreContext,
} from '../../src/renderer/window-manager/persistence/workspace';
import type { ManagedWindow, TileNode, FractionalRect, WindowState } from '../../src/renderer/window-manager/store/types';

function makeWindow(
  id: string,
  taskId: string,
  state: WindowState,
  geometry: FractionalRect,
  leafId: string | null = null,
): ManagedWindow {
  return {
    id,
    taskId,
    sessionId: `sess-${taskId}`,
    geometry,
    state,
    zIndex: 1,
    leafId,
    sessionStatus: 'live',
    restoreGeometry: null,
    title: `Task ${taskId}`,
  };
}

function makeContext(knownTasks: string[]): RestoreContext {
  let windowCounter = 0;
  let tileCounter = 0;
  return {
    resolveSessionId: (taskId) => (knownTasks.includes(taskId) ? `live-${taskId}` : null),
    isKnownTask: (taskId) => knownTasks.includes(taskId),
    makeWindowId: () => `w${(windowCounter += 1)}`,
    makeTileId: (kind) => `${kind}-${(tileCounter += 1)}`,
  };
}

function leafWindowIds(node: TileNode): string[] {
  return node.kind === 'leaf' ? [node.windowId] : node.children.flatMap(leafWindowIds);
}

const HALF_LEFT: FractionalRect = { x: 0, y: 0, w: 0.5, h: 1 };
const HALF_RIGHT: FractionalRect = { x: 0.5, y: 0, w: 0.5, h: 1 };
const FULL: FractionalRect = { x: 0, y: 0, w: 1, h: 1 };

describe('workspace serialize / deserialize', () => {
  it('round-trips floating + maximized windows by taskId, re-resolving the session', () => {
    const windows = [
      makeWindow('win-1', 'task-a', 'floating', { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }),
      makeWindow('win-2', 'task-b', 'maximized', { x: 0.2, y: 0.2, w: 0.4, h: 0.5 }),
    ];
    const serialized = serializeWorkspace(windows, null, FULL, 'win-1');
    expect(serialized.windows.map((window) => window.taskId)).toEqual(['task-a', 'task-b']);
    expect(serialized.focusedTaskId).toBe('task-a');

    const restored = deserializeWorkspace(serialized, makeContext(['task-a', 'task-b']))!;
    const byTask = Object.fromEntries(Object.values(restored.windows).map((window) => [window.taskId, window]));
    expect(byTask['task-a'].state).toBe('floating');
    expect(byTask['task-a'].geometry).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.5 });
    expect(byTask['task-a'].sessionId).toBe('live-task-a'); // re-resolved, not the stale serialized one
    expect(byTask['task-b'].state).toBe('maximized');
    expect(restored.focusedWindowId).toBe(byTask['task-a'].id);
    expect(restored.tileTree).toBeNull();
  });

  it('round-trips a 2-up tile tree, re-anchoring leaves by taskId then back to fresh window ids', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'leaf-1', windowId: 'win-1' },
        { kind: 'leaf', id: 'leaf-2', windowId: 'win-2' },
      ],
      sizes: [0.5, 0.5],
    };
    const windows = [
      makeWindow('win-1', 'task-a', 'tiled', HALF_LEFT, 'leaf-1'),
      makeWindow('win-2', 'task-b', 'tiled', HALF_RIGHT, 'leaf-2'),
    ];
    const serialized = serializeWorkspace(windows, tree, FULL, 'win-1');
    expect(serialized.tileTree).toEqual({
      kind: 'split',
      direction: 'horizontal',
      children: [{ kind: 'leaf', taskId: 'task-a' }, { kind: 'leaf', taskId: 'task-b' }],
      sizes: [0.5, 0.5],
    });

    const restored = deserializeWorkspace(serialized, makeContext(['task-a', 'task-b']))!;
    expect(restored.tileTree?.kind).toBe('split');
    const tiled = Object.values(restored.windows).filter((window) => window.state === 'tiled');
    expect(tiled).toHaveLength(2);
    expect(tiled.every((window) => window.leafId)).toBe(true);
    // The tree's leaves reference exactly the restored windows' new ids.
    expect(new Set(leafWindowIds(restored.tileTree!))).toEqual(new Set(Object.keys(restored.windows)));
  });

  it('drops a window whose task no longer exists', () => {
    const windows = [
      makeWindow('win-1', 'task-a', 'floating', HALF_LEFT),
      makeWindow('win-2', 'task-gone', 'floating', HALF_RIGHT),
    ];
    const serialized = serializeWorkspace(windows, null, FULL, null);
    const restored = deserializeWorkspace(serialized, makeContext(['task-a']))!;
    expect(Object.values(restored.windows).map((window) => window.taskId)).toEqual(['task-a']);
  });

  it('drops the tile tree and floats the survivor when a tiled task is gone', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'leaf-1', windowId: 'win-1' },
        { kind: 'leaf', id: 'leaf-2', windowId: 'win-2' },
      ],
      sizes: [0.5, 0.5],
    };
    const survivor = makeWindow('win-1', 'task-a', 'tiled', HALF_LEFT, 'leaf-1');
    survivor.restoreGeometry = { x: 0.15, y: 0.15, w: 0.4, h: 0.5 };
    const windows = [survivor, makeWindow('win-2', 'task-gone', 'tiled', HALF_RIGHT, 'leaf-2')];
    const serialized = serializeWorkspace(windows, tree, FULL, null);

    const restored = deserializeWorkspace(serialized, makeContext(['task-a']))!;
    expect(restored.tileTree).toBeNull();
    const restoredSurvivor = Object.values(restored.windows)[0];
    expect(restoredSurvivor.taskId).toBe('task-a');
    expect(restoredSurvivor.state).toBe('floating');
    expect(restoredSurvivor.geometry).toEqual({ x: 0.15, y: 0.15, w: 0.4, h: 0.5 }); // its pre-tile float
  });

  it('returns null when no persisted task survives', () => {
    const windows = [makeWindow('win-1', 'task-gone', 'floating', HALF_LEFT)];
    const serialized = serializeWorkspace(windows, null, FULL, null);
    expect(deserializeWorkspace(serialized, makeContext([]))).toBeNull();
  });
});
