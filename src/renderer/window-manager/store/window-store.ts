/**
 * Window-manager store (Zustand).
 *
 * Owns the set of managed windows, their floating z-order, the focused window,
 * and (from P2) the tiling tree. Renderer-only state: there is no IPC truth to
 * re-sync, so this uses HMR Pattern A (preserve the snapshot across Vite Fast
 * Refresh via `import.meta.hot.data`), NOT Pattern B. Persistence to
 * `AppConfig.workspace` lands in P4.
 */

import { create } from 'zustand';
import type { FractionalRect, ManagedWindow, TileNode, WindowState } from './types';
import { clampGeometry, defaultWindowGeometry } from './geometry';
import { resolveTileLayout } from '../tiling/resolve-layout';
import {
  collectWindowIds,
  insertWindowIntoTree,
  removeWindowFromTree,
  setSplitRatio,
  treeContainsWindow,
} from '../tiling/tree-ops';
import type { TileInsertSide } from '../tiling/tree-ops';

/** The whole overlay: the default tiling footprint (edge-snap pairs fill it). */
const FULL_TILE_RECT: FractionalRect = { x: 0, y: 0, w: 1, h: 1 };

interface PreservedWindowState {
  windows: Record<string, ManagedWindow>;
  order: string[];
  focusedWindowId: string | null;
  zCounter: number;
  windowSequence: number;
  tileTree: TileNode | null;
  tileTreeRect: FractionalRect;
  tileSequence: number;
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preserved: PreservedWindowState | undefined = import.meta.hot?.data?.windowState;

// Monotonic id source. Preserved across HMR (below) so a window created after a
// Fast Refresh cannot collide with a preserved window's id.
let windowSequence = preserved?.windowSequence ?? 0;

function nextWindowId(): string {
  windowSequence += 1;
  return `window-${windowSequence}`;
}

// Monotonic id source for tile-tree nodes (splits + leaves), HMR-preserved.
let tileSequence = preserved?.tileSequence ?? 0;

function nextTileId(prefix: 'split' | 'leaf'): string {
  tileSequence += 1;
  return `${prefix}-${tileSequence}`;
}

/**
 * Evict ONE window from the tile tree (PARTIAL eviction, 3b). The removed
 * window's leaf is pruned and its sibling subtree promoted to fill the space;
 * every OTHER tiled window stays tiled and simply re-resolves to a larger rect.
 * Used whenever a single window leaves tiling (close / minimize / drag-out).
 *
 * The evicted window goes back to FLOATING at its pre-tile geometry (undo the
 * tiling). The caller may then override it (close deletes it, minimize hides it,
 * drag-out floats it under the cursor); this is just the standalone default.
 *
 * Collapse case: when removing the window leaves a single remaining leaf (a 2-up
 * losing one side), that lone window can no longer be "tiled" (a tree needs two
 * leaves), so it is left SNAPPED to the half it occupied (resolved from the
 * ORIGINAL tree, so it keeps its position) and the tree is cleared. Snapping (not
 * floating) is load-bearing: docking a neighbor back re-pairs with a snapped half
 * (`dockWindow`).
 */
function evictWindowFromTiling(
  windows: Record<string, ManagedWindow>,
  tileTree: TileNode | null,
  tileTreeRect: FractionalRect,
  windowId: string,
): { tileTree: TileNode | null; windows: Record<string, ManagedWindow>; tileTreeRect: FractionalRect } {
  if (!tileTree || !treeContainsWindow(tileTree, windowId)) return { tileTree, windows, tileTreeRect };
  const prunedTree = removeWindowFromTree(tileTree, windowId);
  // Resolve the ORIGINAL tree WITHIN its footprint, in 0..1 space, so the rects
  // ARE fractional geometry (positioned inside the footprint, not the overlay).
  const originalLayout = resolveTileLayout(
    tileTree,
    { width: tileTreeRect.w, height: tileTreeRect.h },
    0,
    0,
    { left: tileTreeRect.x, top: tileTreeRect.y },
  );
  const nextWindows = { ...windows };

  // Evicted window: float back to its pre-tile size (or the rect it held), and
  // unbind its leaf. The caller may override this immediately.
  const evicted = nextWindows[windowId];
  if (evicted) {
    const heldRect = originalLayout.rects.get(windowId);
    const floatGeometry =
      evicted.restoreGeometry ??
      (heldRect ? clampGeometry({ x: heldRect.left, y: heldRect.top, w: heldRect.width, h: heldRect.height }) : evicted.geometry);
    nextWindows[windowId] = { ...evicted, state: 'floating', leafId: null, geometry: floatGeometry, restoreGeometry: null };
  }

  const remainingIds = collectWindowIds(prunedTree);
  if (remainingIds.length >= 2) {
    // Still a valid multi-pane tree: the remainder stays tiled in the SAME
    // footprint (rects re-resolve to fill the freed sub-space).
    return { tileTree: prunedTree, windows: nextWindows, tileTreeRect };
  }
  if (remainingIds.length === 1) {
    // Collapsed to one pane and the tree clears. A FULL-overlay group leaves the
    // lone window snapped to the HALF it held, so a screen-edge re-dock re-pairs
    // (3a). A CONFINED group's lone window instead RECLAIMS the whole footprint
    // (the group's space) rather than shrinking to its old sub-pane.
    const loneId = remainingIds[0];
    const subRect = originalLayout.rects.get(loneId);
    const lone = nextWindows[loneId];
    const isFullOverlay =
      tileTreeRect.x === 0 && tileTreeRect.y === 0 && tileTreeRect.w === 1 && tileTreeRect.h === 1;
    if (lone && subRect) {
      const geometry = isFullOverlay
        ? clampGeometry({ x: subRect.left, y: subRect.top, w: subRect.width, h: subRect.height })
        : clampGeometry(tileTreeRect);
      nextWindows[loneId] = {
        ...lone,
        state: 'snapped',
        geometry,
        leafId: null,
        restoreGeometry: lone.restoreGeometry ?? geometry,
      };
    }
  }
  // Tree gone: the footprint resets to the whole overlay for the next group.
  return { tileTree: null, windows: nextWindows, tileTreeRect: FULL_TILE_RECT };
}

interface OpenWindowInput {
  taskId: string;
  sessionId: string | null;
  title: string;
  /** Open the hosted task-detail content directly in edit mode. */
  initialEdit?: boolean;
}

interface WindowStoreState {
  windows: Record<string, ManagedWindow>;
  /** Floating z-order, front-most last. Drives `zIndex` assignment. */
  order: string[];
  focusedWindowId: string | null;
  /** Monotonic stacking counter; bumped on every focus/raise. */
  zCounter: number;
  /** Binary-split tiling tree (P2); null until a window is tiled. */
  tileTree: TileNode | null;
  /** The fractional region of the overlay the tile tree occupies. Edge-snap
   *  pairs fill the whole overlay ({0,0,1,1}); a group seeded by docking onto a
   *  half-snapped/floating window is confined to THAT window's footprint, leaving
   *  the rest of the overlay as free board. Meaningless when `tileTree` is null. */
  tileTreeRect: FractionalRect;

  /** Open a window for a task, or focus the existing one for that task. */
  openWindow: (input: OpenWindowInput) => string;
  closeWindow: (id: string) => void;
  /** Raise + focus a window (no-op if already focused). */
  focusWindow: (id: string) => void;
  /** Commit a window's geometry (used by drag/resize/edge-snap on drop). */
  setGeometry: (id: string, geometry: FractionalRect) => void;
  maximizeWindow: (id: string) => void;
  /** Half-dock the window to a snap geometry, remembering the pre-snap size. */
  snapWindow: (id: string, geometry: FractionalRect) => void;
  /** Snap to a half, joining an opposite-half snapped window into a tile pair if
   *  one exists (else a lone snap). The edge-drag entry into tiling. */
  dockWindow: (id: string, edge: 'left' | 'right') => void;
  /** Drag-to-dock (3b): tile `draggedId` onto a side of `targetId`. Inserts into
   *  the existing tree when the target is already tiled (arbitrary N-way), else
   *  seeds a fresh two-pane split between the two windows. */
  dockIntoWindow: (draggedId: string, targetId: string, side: TileInsertSide) => void;
  /** Adjust a tile split's ratio (the draggable seam). */
  setTileRatio: (splitId: string, ratio: number) => void;
  /** Pull a window out of tiling (drag-out); dissolves the group to floating. */
  untileWindow: (id: string) => void;
  toggleMaximizeWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
}

export const useWindowStore = create<WindowStoreState>((set, get) => ({
  windows: preserved?.windows ?? {},
  order: preserved?.order ?? [],
  focusedWindowId: preserved?.focusedWindowId ?? null,
  zCounter: preserved?.zCounter ?? 0,
  tileTree: preserved?.tileTree ?? null,
  tileTreeRect: preserved?.tileTreeRect ?? FULL_TILE_RECT,

  openWindow: (input) => {
    const existing = Object.values(get().windows).find((candidate) => candidate.taskId === input.taskId);
    if (existing) {
      get().focusWindow(existing.id);
      return existing.id;
    }

    const id = nextWindowId();
    const zCounter = get().zCounter + 1;
    const openIndex = get().order.length;
    const newWindow: ManagedWindow = {
      id,
      taskId: input.taskId,
      sessionId: input.sessionId,
      geometry: defaultWindowGeometry(openIndex),
      state: 'floating',
      zIndex: zCounter,
      leafId: null,
      sessionStatus: input.sessionId ? 'live' : 'closed',
      restoreGeometry: null,
      previousState: null,
      title: input.title,
      initialEdit: input.initialEdit,
    };

    set((current) => ({
      windows: { ...current.windows, [id]: newWindow },
      order: [...current.order, id],
      focusedWindowId: id,
      zCounter,
    }));
    return id;
  },

  closeWindow: (id) => {
    set((current) => {
      if (!current.windows[id]) return current;
      // If the closing window was tiled, evict it from the tree first so the
      // remaining panes stay tiled (or the last partner snaps to its half)
      // rather than vanishing with the tree.
      const base = evictWindowFromTiling(current.windows, current.tileTree, current.tileTreeRect, id);
      const nextWindows = { ...base.windows };
      delete nextWindows[id];
      const nextOrder = current.order.filter((candidate) => candidate !== id);
      const focusedWindowId =
        current.focusedWindowId === id ? (nextOrder[nextOrder.length - 1] ?? null) : current.focusedWindowId;
      return { windows: nextWindows, order: nextOrder, focusedWindowId, tileTree: base.tileTree, tileTreeRect: base.tileTreeRect };
    });
  },

  focusWindow: (id) => {
    const current = get();
    if (!current.windows[id]) return;
    if (current.focusedWindowId === id) return;
    const zCounter = current.zCounter + 1;
    set({
      windows: {
        ...current.windows,
        [id]: { ...current.windows[id], zIndex: zCounter },
      },
      order: [...current.order.filter((candidate) => candidate !== id), id],
      focusedWindowId: id,
      zCounter,
    });
  },

  setGeometry: (id, geometry) => {
    set((current) => {
      const target = current.windows[id];
      if (!target) return current;
      return {
        windows: {
          ...current.windows,
          [id]: { ...target, geometry: clampGeometry(geometry), state: 'floating', restoreGeometry: null },
        },
      };
    });
  },

  maximizeWindow: (id) => {
    set((current) => {
      const target = current.windows[id];
      if (!target || target.state === 'maximized') return current;
      return {
        windows: {
          ...current.windows,
          [id]: { ...target, state: 'maximized', restoreGeometry: target.geometry, previousState: target.state },
        },
      };
    });
  },

  snapWindow: (id, geometry) => {
    set((current) => {
      const target = current.windows[id];
      if (!target) return current;
      // A half-dock is like maximize: remember the pre-snap geometry so dragging
      // the window away restores the size the user had. Preserve an existing
      // restore point so snapping left then right keeps the original size.
      const restoreGeometry = target.restoreGeometry ?? target.geometry;
      return {
        windows: {
          ...current.windows,
          [id]: { ...target, geometry: clampGeometry(geometry), state: 'snapped', restoreGeometry },
        },
      };
    });
  },

  dockWindow: (id, edge) => {
    const current = get();
    const target = current.windows[id];
    if (!target) return;
    const half = (side: 'left' | 'right'): FractionalRect =>
      side === 'left' ? { x: 0, y: 0, w: 0.5, h: 1 } : { x: 0.5, y: 0, w: 0.5, h: 1 };
    // Tile when the OPPOSITE SIDE is already "taken" by a window the user put
    // there deliberately: full-height AND flush against the opposite edge. That
    // covers a SNAPPED half AND a window dragged/resized to sit full-height on
    // that side (docked then resized) - in both cases docking the other should
    // pair them at 50/50 (the split resets the partner's width). A genuinely
    // free-floating window (not full-height, not edge-flush) is NOT a partner, so
    // docking next to it leaves it independent. Only when no tree exists yet (3a
    // forms a fresh 2-up pair; nesting is 3b); falls back to a lone snap.
    const EDGE_TOL = 0.06;
    const partner = current.tileTree
      ? undefined
      : Object.values(current.windows).find((candidate) => {
          if (candidate.id === id) return false;
          if (candidate.state !== 'snapped' && candidate.state !== 'floating') return false;
          const geometry = candidate.geometry;
          const fullHeight = geometry.y < EDGE_TOL && geometry.y + geometry.h > 1 - EDGE_TOL;
          const flushToOppositeEdge =
            edge === 'left' ? geometry.x + geometry.w > 1 - EDGE_TOL : geometry.x < EDGE_TOL;
          const isSidePane = geometry.w < 0.9;
          return fullHeight && flushToOppositeEdge && isSidePane;
        });
    if (!partner) {
      get().snapWindow(id, half(edge));
      return;
    }
    const leftWindowId = edge === 'left' ? id : partner.id;
    const rightWindowId = edge === 'left' ? partner.id : id;
    const leftLeafId = nextTileId('leaf');
    const rightLeafId = nextTileId('leaf');
    const tree: TileNode = {
      kind: 'split',
      id: nextTileId('split'),
      direction: 'horizontal',
      ratio: 0.5,
      a: { kind: 'leaf', id: leftLeafId, windowId: leftWindowId },
      b: { kind: 'leaf', id: rightLeafId, windowId: rightWindowId },
    };
    set((state) => ({
      tileTree: tree,
      // Edge-snap pairs fill the whole overlay (each window took a full half).
      tileTreeRect: FULL_TILE_RECT,
      windows: {
        ...state.windows,
        [leftWindowId]: {
          ...state.windows[leftWindowId],
          state: 'tiled',
          leafId: leftLeafId,
          restoreGeometry: state.windows[leftWindowId].restoreGeometry ?? state.windows[leftWindowId].geometry,
        },
        [rightWindowId]: {
          ...state.windows[rightWindowId],
          state: 'tiled',
          leafId: rightLeafId,
          restoreGeometry: state.windows[rightWindowId].restoreGeometry ?? state.windows[rightWindowId].geometry,
        },
      },
    }));
  },

  dockIntoWindow: (draggedId, targetId, side) => {
    const current = get();
    const dragged = current.windows[draggedId];
    const target = current.windows[targetId];
    if (!dragged || !target || draggedId === targetId) return;

    // Mark a window as a tiled pane, remembering its pre-tile geometry so
    // dragging it back out restores the user's floating size.
    const markTiled = (windowState: ManagedWindow, leafId: string): ManagedWindow => ({
      ...windowState,
      state: 'tiled',
      leafId,
      restoreGeometry: windowState.restoreGeometry ?? windowState.geometry,
    });

    const tree = current.tileTree;
    // Insert beside the target when it is already a tiled pane (arbitrary N-way).
    if (tree && treeContainsWindow(tree, targetId)) {
      const newLeafId = nextTileId('leaf');
      const nextTree = insertWindowIntoTree(tree, targetId, draggedId, newLeafId, nextTileId('split'), side);
      set((state) => ({
        tileTree: nextTree,
        windows: { ...state.windows, [draggedId]: markTiled(state.windows[draggedId], newLeafId) },
      }));
      return;
    }

    // Single-tree invariant: seed a fresh pair only when no tree exists. While a
    // tree exists, floating windows are not offered as drop targets, so the
    // target is always a tiled pane (handled above) and we never reach here.
    if (tree) return;
    const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
    const draggedFirst = side === 'left' || side === 'top';
    const draggedLeafId = nextTileId('leaf');
    const targetLeafId = nextTileId('leaf');
    const draggedLeaf: TileNode = { kind: 'leaf', id: draggedLeafId, windowId: draggedId };
    const targetLeaf: TileNode = { kind: 'leaf', id: targetLeafId, windowId: targetId };
    const newTree: TileNode = {
      kind: 'split',
      id: nextTileId('split'),
      direction,
      ratio: 0.5,
      a: draggedFirst ? draggedLeaf : targetLeaf,
      b: draggedFirst ? targetLeaf : draggedLeaf,
    };
    // The new group is confined to the TARGET's footprint (a half-snapped window
    // splits within its half; a maximized target fills the overlay), so docking
    // does not blow the layout up to full width.
    const footprint = target.state === 'maximized' ? FULL_TILE_RECT : clampGeometry(target.geometry);
    set((state) => ({
      tileTree: newTree,
      tileTreeRect: footprint,
      windows: {
        ...state.windows,
        [draggedId]: markTiled(state.windows[draggedId], draggedLeafId),
        [targetId]: markTiled(state.windows[targetId], targetLeafId),
      },
    }));
  },

  setTileRatio: (splitId, ratio) => {
    set((current) => {
      if (!current.tileTree) return current;
      return { tileTree: setSplitRatio(current.tileTree, splitId, ratio) };
    });
  },

  untileWindow: (id) => {
    set((current) => {
      if (!current.tileTree || !treeContainsWindow(current.tileTree, id)) return current;
      return evictWindowFromTiling(current.windows, current.tileTree, current.tileTreeRect, id);
    });
  },

  toggleMaximizeWindow: (id) => {
    const target = get().windows[id];
    if (!target) return;
    if (target.state === 'maximized') get().restoreWindow(id);
    else get().maximizeWindow(id);
  },

  minimizeWindow: (id) => {
    set((current) => {
      const target = current.windows[id];
      if (!target || target.state === 'minimized') return current;
      // Minimizing a tiled window evicts it (the remaining panes stay tiled, or
      // the last partner snaps to its half); the evicted window is floated by the
      // eviction, so it restores as a floating window (not back into the tree it
      // left). previousState is its post-eviction state.
      const base = evictWindowFromTiling(current.windows, current.tileTree, current.tileTreeRect, id);
      const baseTarget = base.windows[id] ?? target;
      const nextWindows = {
        ...base.windows,
        [id]: { ...baseTarget, state: 'minimized' as const, previousState: baseTarget.state },
      };
      // If the minimized window was focused, move focus to the top-most
      // remaining non-minimized window so its terminal hands back cleanly.
      let focusedWindowId = current.focusedWindowId;
      if (focusedWindowId === id) {
        const visible = current.order.filter(
          (candidate) => candidate !== id && nextWindows[candidate]?.state !== 'minimized',
        );
        focusedWindowId = visible[visible.length - 1] ?? null;
      }
      return { windows: nextWindows, focusedWindowId, tileTree: base.tileTree, tileTreeRect: base.tileTreeRect };
    });
  },

  restoreWindow: (id) => {
    set((current) => {
      const target = current.windows[id];
      if (!target) return current;
      // Un-maximize: back to floating at the pre-maximize geometry.
      if (target.state === 'maximized') {
        return {
          windows: {
            ...current.windows,
            [id]: {
              ...target,
              state: 'floating',
              geometry: target.restoreGeometry ?? target.geometry,
              restoreGeometry: null,
              previousState: null,
            },
          },
        };
      }
      // Un-minimize: back to the state it was in before minimizing (which may be
      // maximized). Geometry is unchanged by minimize.
      if (target.state === 'minimized') {
        const restoreState: WindowState =
          target.previousState && target.previousState !== 'minimized' ? target.previousState : 'floating';
        return {
          windows: { ...current.windows, [id]: { ...target, state: restoreState, previousState: null } },
        };
      }
      return current;
    });
  },
}));

// HMR Pattern A: preserve the live layout across a Fast Refresh so an open
// window does not vanish or reset on every save while dogfooding.
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    const state = useWindowStore.getState();
    data.windowState = {
      windows: state.windows,
      order: state.order,
      focusedWindowId: state.focusedWindowId,
      zCounter: state.zCounter,
      windowSequence,
      tileTree: state.tileTree,
      tileTreeRect: state.tileTreeRect,
      tileSequence,
    } satisfies PreservedWindowState;
  });
}
