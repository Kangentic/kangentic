/**
 * Serialize / restore an in-app window-manager layout.
 *
 * Persisted form is ANCHOR-anchored (the durable anchor is a taskId for a
 * task-detail window, a session id for a conversation window, or a slot id on the
 * command-terminal layer) and uses fractional geometry (re-projects cleanly at a
 * different viewport size). Restore re-resolves the live sessionId from the
 * anchor (kind-aware), regenerates window + tile-node ids, stamps each window
 * with its own persisted `kind` (falling back to the restoring layer's `kind` for
 * older blobs that predate the per-window field), and drops anything whose
 * anchor no longer exists for its kind. The on-disk field is named `taskId` for
 * back-compat with the board's existing `AppConfig.workspaceByProject` blobs; for
 * the command layer it simply carries the slot id.
 *
 * Restore is deliberately TOTAL: the layout is read back from an on-disk config the
 * app must never trust blindly. A stamped schema `version` gates the whole blob, and
 * each window's geometry is clamped into the overlay (with a minimum visible size) so
 * a corrupt or off-overlay entry can never restore an invisible / off-screen window;
 * a window with malformed geometry or an unknown state is dropped, never thrown on.
 *
 * Pure module: the store actions supply the id generators + the anchor->session /
 * anchor-exists resolvers (which need live board + session state).
 */

import type { ManagedWindow, TileNode, FractionalRect, WindowState, WindowContentKind } from '../store/types';
import type { SerializedWorkspace, SerializedTileNode } from '../../../shared/types';

/** Bump when the persisted shape changes; an older / unknown version is ignored on
 *  restore rather than mis-applied. */
export const WORKSPACE_SCHEMA_VERSION = 1;

/** Minimum window width/height as a fraction of the overlay, so a clamped or corrupt
 *  rect always restores to something the user can see and grab. */
const MIN_WINDOW_FRACTION = 0.05;

const VALID_WINDOW_STATES: ReadonlySet<WindowState> = new Set<WindowState>([
  'floating',
  'tiled',
  'snapped',
  'maximized',
]);

const VALID_WINDOW_CONTENT_KINDS: ReadonlySet<WindowContentKind> = new Set<WindowContentKind>([
  'task-detail',
  'command-terminal',
  'conversation',
]);

const FULL_RECT: FractionalRect = { x: 0, y: 0, w: 1, h: 1 };

/** Clamp a persisted rect into the overlay and enforce a minimum visible size.
 *  Returns null when the value is not a usable `{x,y,w,h}` of finite numbers, so the
 *  caller can drop the offending window (geometry) or simply forget it (restoreGeometry). */
function sanitizeRect(rect: FractionalRect | null | undefined): FractionalRect | null {
  if (!rect || typeof rect !== 'object') return null;
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  const width = Math.min(1, Math.max(MIN_WINDOW_FRACTION, w));
  const height = Math.min(1, Math.max(MIN_WINDOW_FRACTION, h));
  const left = Math.min(1 - width, Math.max(0, x));
  const top = Math.min(1 - height, Math.max(0, y));
  return { x: left, y: top, w: width, h: height };
}

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
    version: WORKSPACE_SCHEMA_VERSION,
    windows: windows.map((window) => ({
      taskId: window.anchor,
      kind: window.kind,
      title: window.title,
      geometry: { ...window.geometry },
      restoreGeometry: window.restoreGeometry ? { ...window.restoreGeometry } : null,
      state: window.state,
    })),
    tileTree: tileTree ? serializeNode(tileTree, windowById) : null,
    tileTreeRect: { ...tileTreeRect },
    focusedTaskId: focused?.anchor ?? null,
  };
}

function serializeNode(node: TileNode, windowById: Map<string, ManagedWindow>): SerializedTileNode {
  if (node.kind === 'leaf') {
    return { kind: 'leaf', taskId: windowById.get(node.windowId)?.anchor ?? node.windowId };
  }
  return {
    kind: 'split',
    direction: node.direction,
    children: node.children.map((child) => serializeNode(child, windowById)),
    sizes: [...node.sizes],
  };
}

export interface RestoreContext {
  /** The content kind to stamp on a restored window whose persisted entry has no
   *  `kind` of its own (back-compat with pre-existing blobs). */
  kind: WindowContentKind;
  /** Live PTY session id for an anchor, given the window's kind (its own
   *  persisted kind, or `context.kind` when absent), or null when suspended /
   *  not yet spawned. */
  resolveSessionId: (anchor: string, kind: WindowContentKind) => string | null;
  /** Whether the anchor still exists for a window of the given kind (else its
   *  window is dropped). For the command layer (synthetic slot anchors) this is
   *  always true. */
  isKnownAnchor: (anchor: string, kind: WindowContentKind) => boolean;
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
  // Version gate: an unknown / older-shaped blob (or a non-object) is ignored
  // wholesale rather than partially mis-applied.
  if (!serialized || serialized.version !== WORKSPACE_SCHEMA_VERSION) return null;
  if (!Array.isArray(serialized.windows)) return null;

  // Keep only windows whose anchor still exists AND whose geometry/state survive
  // sanitization; a malformed entry is dropped, never thrown on. restoreGeometry is
  // forgotten (set null) when invalid rather than dropping the window. A window
  // with no persisted `kind` (a pre-existing blob) defaults to the restoring
  // layer's own kind.
  const surviving = serialized.windows
    // The persisted `kind` is read straight off the untrusted on-disk blob: an
    // absent OR out-of-enum value falls back to the restoring layer's own kind,
    // the same defensive treatment `state`/`geometry` get below.
    .map((window) => ({
      ...window,
      kind: window.kind && VALID_WINDOW_CONTENT_KINDS.has(window.kind) ? window.kind : context.kind,
    }))
    .filter((window) => context.isKnownAnchor(window.taskId, window.kind))
    .map((window) => {
      const geometry = sanitizeRect(window.geometry);
      if (!geometry || !VALID_WINDOW_STATES.has(window.state)) return null;
      return { ...window, geometry, restoreGeometry: sanitizeRect(window.restoreGeometry) };
    })
    .filter((window): window is NonNullable<typeof window> => window !== null);
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
      kind: persisted.kind,
      anchor: persisted.taskId,
      sessionId: context.resolveSessionId(persisted.taskId, persisted.kind),
      geometry: { ...persisted.geometry },
      state: persisted.state,
      zIndex,
      leafId: null,
      sessionStatus: 'live',
      restoreGeometry: persisted.restoreGeometry ? { ...persisted.restoreGeometry } : null,
      title: persisted.title,
      skipEnterAnimation: true,
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

  const tileTreeRect = sanitizeRect(serialized.tileTreeRect) ?? { ...FULL_RECT };

  return { windows, order, tileTree, tileTreeRect, focusedWindowId };
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
