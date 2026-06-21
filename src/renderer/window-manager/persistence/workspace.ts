/**
 * Serialize / restore the in-app window-manager layout to `AppConfig.workspace`.
 *
 * Persisted form is taskId-anchored (a session respawn changes the sessionId but
 * not the task, so the durable anchor is the task) and uses fractional geometry
 * (re-projects cleanly at a different viewport size). Restore re-resolves the live
 * sessionId from the taskId, regenerates window + tile-node ids, and drops anything
 * whose task no longer exists.
 *
 * Pure module: the store actions supply the id generators + the taskId->session /
 * taskId-exists resolvers (which need live board + session state).
 */

import type { ManagedWindow, TileNode, FractionalRect } from '../store/types';
import type { SerializedWorkspace, SerializedTileNode } from '../../../shared/types';

/** Snapshot the live window-manager state into the persisted form. */
export function serializeWorkspace(
  windows: ManagedWindow[],
  tileTree: TileNode | null,
  tileTreeRect: FractionalRect,
  focusedWindowId: string | null,
): SerializedWorkspace {
  const windowById = new Map(windows.map((window) => [window.id, window]));
  const focused = focusedWindowId ? windowById.get(focusedWindowId) : undefined;
  return {
    windows: windows.map((window) => ({
      taskId: window.taskId,
      title: window.title,
      geometry: { ...window.geometry },
      restoreGeometry: window.restoreGeometry ? { ...window.restoreGeometry } : null,
      state: window.state,
    })),
    tileTree: tileTree ? serializeNode(tileTree, windowById) : null,
    tileTreeRect: { ...tileTreeRect },
    focusedTaskId: focused?.taskId ?? null,
  };
}

function serializeNode(node: TileNode, windowById: Map<string, ManagedWindow>): SerializedTileNode {
  if (node.kind === 'leaf') {
    return { kind: 'leaf', taskId: windowById.get(node.windowId)?.taskId ?? node.windowId };
  }
  return {
    kind: 'split',
    direction: node.direction,
    children: node.children.map((child) => serializeNode(child, windowById)),
    sizes: [...node.sizes],
  };
}

export interface RestoreContext {
  /** Live PTY session id for a task, or null when suspended / not yet spawned. */
  resolveSessionId: (taskId: string) => string | null;
  /** Whether the task still exists on the board (else its window is dropped). */
  isKnownTask: (taskId: string) => boolean;
  makeWindowId: () => string;
  makeTileId: (kind: 'split' | 'leaf') => string;
}

export interface RestoredWorkspace {
  windows: Record<string, ManagedWindow>;
  order: string[];
  tileTree: TileNode | null;
  tileTreeRect: FractionalRect;
  focusedWindowId: string | null;
}

/**
 * Rebuild live window-manager state from a persisted layout. Returns null when
 * nothing restorable remains (every task gone). Windows for missing tasks are
 * dropped; if a TILED task is missing, the whole tile tree is dropped and the
 * surviving would-be-tiled windows fall back to floating (rather than leaving a
 * dangling tree).
 */
export function deserializeWorkspace(
  serialized: SerializedWorkspace,
  context: RestoreContext,
): RestoredWorkspace | null {
  const surviving = serialized.windows.filter((window) => context.isKnownTask(window.taskId));
  if (surviving.length === 0) return null;

  const windowIdByTask = new Map<string, string>();
  const windows: Record<string, ManagedWindow> = {};
  const order: string[] = [];
  let zIndex = 0;
  for (const persisted of surviving) {
    const id = context.makeWindowId();
    windowIdByTask.set(persisted.taskId, id);
    order.push(id);
    zIndex += 1;
    windows[id] = {
      id,
      taskId: persisted.taskId,
      sessionId: context.resolveSessionId(persisted.taskId),
      geometry: { ...persisted.geometry },
      state: persisted.state,
      zIndex,
      leafId: null,
      sessionStatus: 'live',
      restoreGeometry: persisted.restoreGeometry ? { ...persisted.restoreGeometry } : null,
      title: persisted.title,
    };
  }

  let tileTree: TileNode | null = null;
  if (serialized.tileTree) {
    const leafByWindow = new Map<string, string>();
    const rebuilt = rebuildNode(serialized.tileTree, windowIdByTask, context.makeTileId, leafByWindow);
    if (rebuilt) {
      tileTree = rebuilt;
      for (const [windowId, leafId] of leafByWindow) {
        windows[windowId] = { ...windows[windowId], state: 'tiled', leafId };
      }
    }
  }

  // Any window still marked tiled without a live leaf (tree dropped, or an orphan)
  // falls back to floating at its pre-tile geometry.
  for (const id of order) {
    if (windows[id].state === 'tiled' && !windows[id].leafId) {
      windows[id] = {
        ...windows[id],
        state: 'floating',
        geometry: windows[id].restoreGeometry ?? windows[id].geometry,
        restoreGeometry: null,
      };
    }
  }

  const focusedWindowId = serialized.focusedTaskId
    ? windowIdByTask.get(serialized.focusedTaskId) ?? null
    : null;

  return { windows, order, tileTree, tileTreeRect: { ...serialized.tileTreeRect }, focusedWindowId };
}

/** Rebuild a tile subtree with fresh ids; returns null if any leaf's task is gone
 *  (signals the caller to drop the whole tree). */
function rebuildNode(
  node: SerializedTileNode,
  windowIdByTask: Map<string, string>,
  makeTileId: (kind: 'split' | 'leaf') => string,
  leafByWindow: Map<string, string>,
): TileNode | null {
  if (node.kind === 'leaf') {
    const windowId = windowIdByTask.get(node.taskId);
    if (!windowId) return null;
    const leafId = makeTileId('leaf');
    leafByWindow.set(windowId, leafId);
    return { kind: 'leaf', id: leafId, windowId };
  }
  const children: TileNode[] = [];
  for (const child of node.children) {
    const rebuilt = rebuildNode(child, windowIdByTask, makeTileId, leafByWindow);
    if (!rebuilt) return null;
    children.push(rebuilt);
  }
  return { kind: 'split', id: makeTileId('split'), direction: node.direction, children, sizes: [...node.sizes] };
}
