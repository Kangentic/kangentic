/**
 * Window-manager store (Zustand) - a content-agnostic FACTORY.
 *
 * `createWindowManagerStore(options)` builds one independent instance: its own
 * windows, floating z-order, focused window, and tiling tree, plus its own
 * monotonic id space (so two layers never collide on a window/tile id or a
 * `data-testid` DOM query). The app mounts TWO instances - the board task-detail
 * layer and the command-terminal layer - each with its own persistence target.
 *
 * Renderer-only state: there is no IPC truth to re-sync, so HMR uses Pattern E
 * (pin the instance in `import.meta.hot.data` and self-accept). Pinning the
 * instance preserves the live layout AND the in-closure id counters across a Fast
 * Refresh, so an open window never vanishes or re-collides while dogfooding. The
 * settled layout is persisted by each layer's own bridge (see `persistence/`).
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { FractionalRect, ManagedWindow, TileNode, WindowContentKind } from './types';
import { clampGeometry, defaultWindowGeometry } from './geometry';
import type { PixelRect } from './geometry';
import { resolveTileLayout } from '../tiling/resolve-layout';
import {
  collectWindowIds,
  insertWindowIntoTree,
  removeWindowFromTree,
  setSeamRatio,
  treeContainsWindow,
  wrapTreeWithRoot,
} from '../tiling/tree-ops';
import type { TileInsertSide } from '../tiling/tree-ops';
import { buildPresetTree, presetHalfGeometry } from '../tiling/presets';
import type { TilePreset } from '../tiling/presets';
import { serializeWorkspace as toSerializedWorkspace, deserializeWorkspace } from '../persistence/workspace';
import { findWindowTreeViolations } from './tree-invariants';
import { monitorAnchorToTaskId } from './monitor-anchor';
import type { SerializedWorkspace } from '../../../shared/types';

/** The whole overlay: the default tiling footprint (edge-snap pairs fill it). */
const FULL_TILE_RECT: FractionalRect = { x: 0, y: 0, w: 1, h: 1 };

/** Fraction of an axis within which a window counts as edge-flush / full-height
 *  when deciding whether docking next to it should PAIR the two at 50/50. Lifted
 *  to module scope so it sits with the other fractional thresholds. */
const PARTNER_EDGE_TOLERANCE = 0.06;

/** Mark a window as a tiled pane, remembering its pre-tile geometry so dragging
 *  it back out restores the user's floating size. */
function markWindowTiled(windowState: ManagedWindow, leafId: string): ManagedWindow {
  return {
    ...windowState,
    state: 'tiled',
    leafId,
    restoreGeometry: windowState.restoreGeometry ?? windowState.geometry,
  };
}

/** Which side of the tree's footprint a not-yet-tiled window sits on, so it joins
 *  the tree as a root pane on that side (a left-snapped window joins on the left).
 *  The dominant axis of the window-center-to-footprint-center offset decides. */
function rootSideForWindow(geometry: FractionalRect, footprint: FractionalRect): TileInsertSide {
  const deltaX = geometry.x + geometry.w / 2 - (footprint.x + footprint.w / 2);
  const deltaY = geometry.y + geometry.h / 2 - (footprint.y + footprint.h / 2);
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX < 0 ? 'left' : 'right';
  return deltaY < 0 ? 'top' : 'bottom';
}

/**
 * Evict ONE window from the tile tree (PARTIAL eviction, 3b). The removed
 * window's leaf is pruned and its sibling subtree promoted to fill the space;
 * every OTHER tiled window stays tiled and simply re-resolves to a larger rect.
 * Used whenever a single window leaves tiling (close / drag-out).
 *
 * The evicted window goes back to FLOATING at its pre-tile geometry (undo the
 * tiling). The caller may then override it (close deletes it, drag-out floats it
 * under the cursor); this is just the standalone default.
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
    const heldGeometry = heldRect
      ? clampGeometry({ x: heldRect.left, y: heldRect.top, w: heldRect.width, h: heldRect.height })
      : null;
    // Float the window back to its pre-tile size (or the rect it held while tiled).
    const floatGeometry = evicted.restoreGeometry ?? heldGeometry ?? evicted.geometry;
    nextWindows[windowId] = { ...evicted, state: 'floating', leafId: null, geometry: floatGeometry, restoreGeometry: null };
  }

  const remainingIds = collectWindowIds(prunedTree);
  if (remainingIds.length >= 2 && prunedTree) {
    // Still a valid multi-pane tree. If removing the window collapsed the ROOT (a
    // top-level pane left, so a sub-group was promoted to the root - detected by
    // the root node changing identity), the freed region should stay EMPTY board
    // rather than the surviving group expanding into it. Shrink the footprint to
    // the surviving group's former region so it keeps its size and position
    // (e.g. moving the left pane away leaves the right column at its right-half
    // width, not stretched full-screen). A removal WITHIN a container keeps the
    // same root, so the footprint is unchanged and the siblings renormalise to
    // fill that container as before.
    let nextFootprint = tileTreeRect;
    if (tileTree.kind === 'split' && prunedTree.kind === 'split' && prunedTree.id !== tileTree.id) {
      const survivorRects = remainingIds
        .map((id) => originalLayout.rects.get(id))
        .filter((rect): rect is PixelRect => !!rect);
      if (survivorRects.length > 0) {
        const minX = Math.min(...survivorRects.map((rect) => rect.left));
        const minY = Math.min(...survivorRects.map((rect) => rect.top));
        const maxX = Math.max(...survivorRects.map((rect) => rect.left + rect.width));
        const maxY = Math.max(...survivorRects.map((rect) => rect.top + rect.height));
        nextFootprint = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }
    }
    return { tileTree: prunedTree, windows: nextWindows, tileTreeRect: nextFootprint };
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
  /** Window content kind. Defaults to the store's configured kind when omitted. */
  kind?: WindowContentKind;
  /** Durable anchor (taskId for task-detail; slot id for command-terminal). */
  anchor: string;
  sessionId: string | null;
  title: string;
  /** Open the hosted task-detail content directly in edit mode. */
  initialEdit?: boolean;
  /** The task is already Done/archived at open time (so it must NOT auto-close). */
  openedDone?: boolean;
  /** Stamp the opened window to paint flat (no entrance animation). Used by
   *  programmatic population restores (the command layer's per-project
   *  reconcile) so a rebuilt window matches the flat presentation of a
   *  workspace-restored one. A plain user open leaves it unset so the entrance
   *  plays. Transient, never persisted (mirrors `deserializeWorkspace`). */
  skipEnterAnimation?: boolean;
}

export interface WindowStoreState {
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

  /** Open a window for an anchor, or focus the existing one for that anchor. */
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
  /** Arrange the open windows with a one-shot tiling preset (like Win11 snap
   *  layouts): a half-snap of the focused window, or a columns / grid tree of all
   *  open windows. */
  applyTilePreset: (preset: TilePreset) => void;
  /** Resize one seam: the boundary between children `index` and `index + 1` of
   *  the split with `splitId`. `pairRatio` is the first pane's share of the pair. */
  setSeamRatio: (splitId: string, index: number, pairRatio: number) => void;
  /** Resize the whole tiling footprint (the group's outer region) - e.g. drag a
   *  right-docked group's left edge to widen all its panes while it stays docked
   *  right. The vacated space stays empty board. */
  setTileTreeRect: (rect: FractionalRect) => void;
  /** Grow the tile group's footprint (if needed) so the NARROWEST pane is at least
   *  the configured min pixel size on each axis - the hard floor the engine never
   *  crosses when docking. The overlay pixel size converts the fractional footprint
   *  to pixels. No-op without a tree, or when every pane already clears the floor. */
  enforceMinPaneSize: (minWidthPx: number, minHeightPx: number, overlayWidthPx: number, overlayHeightPx: number) => void;
  /** Pull a window out of tiling (drag-out); dissolves the group to floating. */
  untileWindow: (id: string) => void;
  toggleMaximizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  /** Snapshot the current layout into the persisted, anchor-anchored form. */
  serializeWorkspace: () => SerializedWorkspace;
  /** Replace the layout with a restored one: re-resolve each window's live
   *  sessionId from its anchor (kind-aware: a window's own persisted `kind`, or
   *  this layer's kind when absent), drop windows whose anchor is gone for their
   *  kind, and regenerate window + tile-node ids. */
  applyWorkspace: (
    workspace: SerializedWorkspace,
    resolveSessionId: (anchor: string, kind: WindowContentKind) => string | null,
    isKnownAnchor: (anchor: string, kind: WindowContentKind) => boolean,
  ) => void;
}

/** Per-layer configuration for a window-manager instance. */
export interface WindowManagerStoreOptions {
  /** Prefix for every window / tile-node id, so two layers never collide on an id
   *  (the global `data-testid` DOM queries the DnD code runs rely on this). */
  idPrefix: string;
  /** The content kind windows in this instance host (the default for openWindow
   *  and the kind stamped on restored windows). */
  kind: WindowContentKind;
  /**
   * Extract the taskId from a task-detail window's `anchor`. Defaults to
   * identity, which is correct for the board (it anchors BY taskId).
   *
   * The monitor anchors by `projectId:taskId`, so it supplies a decoder. This is
   * an option rather than a branch at each call site because the consumers are
   * renderer-GLOBAL (`dialogSessionIds`, the terminal-visibility plan): they walk
   * every layer's windows and must resolve each one's session without knowing
   * which layer produced it. See `store/monitor-anchor.ts`.
   */
  anchorToTaskId?: (anchor: string) => string;
}

/** A built window-manager instance: the bound store hook + its layer options. */
export interface WindowManager {
  store: UseBoundStore<StoreApi<WindowStoreState>>;
  options: WindowManagerStoreOptions;
}

/**
 * Build one independent window-manager instance. Each gets its own monotonic id
 * space via closures (so no cross-layer id collision) and its own store.
 */
export function createWindowManagerStore(options: WindowManagerStoreOptions): WindowManager {
  // Monotonic id sources, per instance. They live in this closure (not module
  // scope), so the two layers never share a counter and a Pattern-E instance pin
  // preserves them across HMR for free.
  let windowSequence = 0;
  const nextWindowId = (): string => {
    windowSequence += 1;
    return `${options.idPrefix}-window-${windowSequence}`;
  };
  let tileSequence = 0;
  const nextTileId = (prefix: 'split' | 'leaf'): string => {
    tileSequence += 1;
    return `${options.idPrefix}-${prefix}-${tileSequence}`;
  };

  const store = create<WindowStoreState>((set, get) => ({
    windows: {},
    order: [],
    focusedWindowId: null,
    zCounter: 0,
    tileTree: null,
    tileTreeRect: FULL_TILE_RECT,

    openWindow: (input) => {
      const kind = input.kind ?? options.kind;
      const existing = Object.values(get().windows).find(
        (candidate) => candidate.kind === kind && candidate.anchor === input.anchor,
      );
      if (existing) {
        get().focusWindow(existing.id);
        return existing.id;
      }

      const id = nextWindowId();
      const zCounter = get().zCounter + 1;
      const openIndex = get().order.length;
      const newWindow: ManagedWindow = {
        id,
        kind,
        anchor: input.anchor,
        sessionId: input.sessionId,
        geometry: defaultWindowGeometry(openIndex),
        state: 'floating',
        zIndex: zCounter,
        leafId: null,
        sessionStatus: input.sessionId ? 'live' : 'closed',
        restoreGeometry: null,
        title: input.title,
        initialEdit: input.initialEdit,
        openedDone: input.openedDone,
        // Only set when true so a plain open leaves the property absent (a
        // freshly opened window keeps its entrance animation).
        ...(input.skipEnterAnimation ? { skipEnterAnimation: true } : {}),
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
        // Committing a free geometry means the window is now floating. If it is
        // STILL a member of the tile tree (a tiled pane whose geometry is set
        // directly), evict it first so the tree never keeps a stale reference to a
        // now-floating window - the same stale-leaf class fixed in snapWindow /
        // restoreWindow. Eviction is a no-op (same refs) when the window is already
        // untiled, which is the live path: drag/resize untiles before committing.
        const base = evictWindowFromTiling(current.windows, current.tileTree, current.tileTreeRect, id);
        const evicted = base.windows[id] ?? target;
        return {
          tileTree: base.tileTree,
          tileTreeRect: base.tileTreeRect,
          windows: {
            ...base.windows,
            [id]: { ...evicted, geometry: clampGeometry(geometry), state: 'floating', leafId: null, restoreGeometry: null },
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
            [id]: { ...target, state: 'maximized', restoreGeometry: target.geometry },
          },
        };
      });
    },

    snapWindow: (id, geometry) => {
      set((current) => {
        const target = current.windows[id];
        if (!target) return current;
        // Snapping to a half LEAVES any tile group: evict from the tree first so it
        // never keeps a stale reference to a now-floating window. A lingering
        // reference made `collectCandidatePanes` resolve this pane at its phantom
        // tiled position, so drop previews appeared in the wrong place and the drag
        // still thought the windows were docked. Eviction is a no-op when untiled.
        const base = evictWindowFromTiling(current.windows, current.tileTree, current.tileTreeRect, id);
        const evicted = base.windows[id] ?? target;
        // A half-dock is like maximize: remember the pre-snap geometry so dragging
        // the window away restores the size the user had. Preserve an existing
        // restore point so snapping left then right keeps the original size (after
        // eviction the held pre-tile size is the window's geometry).
        const restoreGeometry = evicted.restoreGeometry ?? evicted.geometry;
        return {
          tileTree: base.tileTree,
          tileTreeRect: base.tileTreeRect,
          windows: {
            ...base.windows,
            [id]: { ...evicted, geometry: clampGeometry(geometry), state: 'snapped', restoreGeometry },
          },
        };
      });
    },

    dockWindow: (id, edge) => {
      const current = get();
      const target = current.windows[id];
      if (!target) return;

      // A tree already exists and this window is not part of it: JOIN the tree as a
      // new full-overlay root pane on `edge`, so edge-snapping builds ONE cohesive
      // tiling (with a resizable seam to the rest) instead of orphaning a lone snap
      // beside it. This is also how an existing lone-snapped window is merged in:
      // drag it back to the edge and it joins the tree.
      if (current.tileTree && !treeContainsWindow(current.tileTree, id)) {
        const newLeafId = nextTileId('leaf');
        const nextTree = wrapTreeWithRoot(
          current.tileTree,
          { kind: 'leaf', id: newLeafId, windowId: id },
          edge,
          nextTileId('split'),
        );
        set((state) => ({
          tileTree: nextTree,
          tileTreeRect: FULL_TILE_RECT,
          windows: { ...state.windows, [id]: markWindowTiled(state.windows[id], newLeafId) },
        }));
        return;
      }

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
      const partner = current.tileTree
        ? undefined
        : Object.values(current.windows).find((candidate) => {
            if (candidate.id === id) return false;
            if (candidate.state !== 'snapped' && candidate.state !== 'floating') return false;
            const geometry = candidate.geometry;
            const fullHeight = geometry.y < PARTNER_EDGE_TOLERANCE && geometry.y + geometry.h > 1 - PARTNER_EDGE_TOLERANCE;
            const flushToOppositeEdge =
              edge === 'left' ? geometry.x + geometry.w > 1 - PARTNER_EDGE_TOLERANCE : geometry.x < PARTNER_EDGE_TOLERANCE;
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
        children: [
          { kind: 'leaf', id: leftLeafId, windowId: leftWindowId },
          { kind: 'leaf', id: rightLeafId, windowId: rightWindowId },
        ],
        sizes: [0.5, 0.5],
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

      // Defensive dedupe: if the dragged window is ALREADY referenced in the tree
      // (a stale leaf left by an earlier op), remove that leaf first so docking MOVES
      // the window instead of creating a SECOND leaf for it. A duplicate leaf renders
      // as a phantom empty pane and the footprint clamps against it - an "invisible
      // wall" that blocks the group from moving / resizing into that space. The normal
      // drag path pops the window out (untile) before docking, so this is a no-op
      // there; it only repairs a corrupt/stale state.
      const tree = current.tileTree && treeContainsWindow(current.tileTree, draggedId)
        ? removeWindowFromTree(current.tileTree, draggedId)
        : current.tileTree;
      // Insert beside the target when it is already a tiled pane (arbitrary N-way).
      if (tree && treeContainsWindow(tree, targetId)) {
        const newLeafId = nextTileId('leaf');
        const nextTree = insertWindowIntoTree(tree, targetId, draggedId, newLeafId, nextTileId('split'), side);
        set((state) => ({
          tileTree: nextTree,
          windows: { ...state.windows, [draggedId]: markWindowTiled(state.windows[draggedId], newLeafId) },
        }));
        return;
      }

      // Build the (target + dragged) pane split per the drop `side`.
      const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
      const draggedFirst = side === 'left' || side === 'top';
      const draggedLeafId = nextTileId('leaf');
      const targetLeafId = nextTileId('leaf');
      const draggedLeaf: TileNode = { kind: 'leaf', id: draggedLeafId, windowId: draggedId };
      const targetLeaf: TileNode = { kind: 'leaf', id: targetLeafId, windowId: targetId };
      const pairTree: TileNode = {
        kind: 'split',
        id: nextTileId('split'),
        direction,
        children: draggedFirst ? [draggedLeaf, targetLeaf] : [targetLeaf, draggedLeaf],
        sizes: [0.5, 0.5],
      };

      const markBoth = (state: WindowStoreState) => ({
        ...state.windows,
        [draggedId]: markWindowTiled(state.windows[draggedId], draggedLeafId),
        [targetId]: markWindowTiled(state.windows[targetId], targetLeafId),
      });

      if (tree) {
        // A tree exists but the TARGET is a lone snapped/floating window outside it.
        // Merge into the SINGLE tree: wrap the existing tree under a new root with
        // the target+dragged pane on the side of the footprint the target sits on,
        // so everything stays one cohesive, resizable tiling (no second tree).
        const rootSide = rootSideForWindow(target.geometry, current.tileTreeRect);
        const nextTree = wrapTreeWithRoot(tree, pairTree, rootSide, nextTileId('split'));
        set((state) => ({ tileTree: nextTree, tileTreeRect: FULL_TILE_RECT, windows: markBoth(state) }));
        return;
      }

      // No tree yet: seed a fresh pair confined to the TARGET's footprint (a half-
      // snapped window splits within its half; a maximized target fills the overlay),
      // so docking does not blow the layout up to full width.
      const footprint = target.state === 'maximized' ? FULL_TILE_RECT : clampGeometry(target.geometry);
      set((state) => ({ tileTree: pairTree, tileTreeRect: footprint, windows: markBoth(state) }));
    },

    applyTilePreset: (preset) => {
      const current = get();
      // Half presets act on a single window: the focused one, else the top-most.
      const halfGeometry = presetHalfGeometry(preset);
      if (halfGeometry) {
        const focusedId = current.focusedWindowId;
        const targetId =
          focusedId && current.windows[focusedId]
            ? focusedId
            : Object.values(current.windows).sort((first, second) => second.zIndex - first.zIndex)[0]?.id ?? null;
        if (!targetId) return;
        // Left / right DOCK (so snapping one then the other pairs them into a tile,
        // exactly like the keyboard snap + drag-to-edge); top / bottom are a plain
        // snap (dockWindow only pairs horizontal halves).
        if (preset === 'left-half') get().dockWindow(targetId, 'left');
        else if (preset === 'right-half') get().dockWindow(targetId, 'right');
        else get().snapWindow(targetId, halfGeometry);
        return;
      }
      // Multi presets tile EVERY open window (focused first, so it lands top-left),
      // replacing any existing tiling so no window is left orphaned.
      const orderedWindowIds = Object.values(current.windows)
        .sort((first, second) => second.zIndex - first.zIndex)
        .map((window) => window.id);
      const built = buildPresetTree(preset, orderedWindowIds, {
        leaf: () => nextTileId('leaf'),
        split: () => nextTileId('split'),
      });
      if (!built) return;
      set((state) => {
        const nextWindows = { ...state.windows };
        for (const { windowId, leafId } of built.leaves) {
          if (nextWindows[windowId]) nextWindows[windowId] = markWindowTiled(nextWindows[windowId], leafId);
        }
        return { tileTree: built.tree, tileTreeRect: FULL_TILE_RECT, windows: nextWindows };
      });
    },

    setSeamRatio: (splitId, index, pairRatio) => {
      set((current) => {
        if (!current.tileTree) return current;
        return { tileTree: setSeamRatio(current.tileTree, splitId, index, pairRatio) };
      });
    },

    setTileTreeRect: (rect) => {
      set((current) => (current.tileTree ? { tileTreeRect: clampGeometry(rect) } : current));
    },

    enforceMinPaneSize: (minWidthPx, minHeightPx, overlayWidthPx, overlayHeightPx) => {
      set((current) => {
        const { tileTree, tileTreeRect } = current;
        if (!tileTree || overlayWidthPx <= 0 || overlayHeightPx <= 0) return current;
        // Measure the panes at the current footprint (pixels).
        const layout = resolveTileLayout(
          tileTree,
          { width: tileTreeRect.w * overlayWidthPx, height: tileTreeRect.h * overlayHeightPx },
          0,
          0,
          { left: tileTreeRect.x * overlayWidthPx, top: tileTreeRect.y * overlayHeightPx },
        );
        let narrowestPx = Infinity;
        let shortestPx = Infinity;
        for (const rect of layout.rects.values()) {
          narrowestPx = Math.min(narrowestPx, rect.width);
          shortestPx = Math.min(shortestPx, rect.height);
        }
        if (!Number.isFinite(narrowestPx)) return current;

        // Panes scale proportionally with the footprint, so growing an axis by
        // (minSize / narrowestPane) lifts the narrowest pane exactly to the floor.
        // Grow around the footprint's centre, capped at the full overlay.
        let next = tileTreeRect;
        const grow = (axisMinPx: number, smallestPanePx: number, start: number, extent: number): { start: number; extent: number } | null => {
          if (smallestPanePx <= 0 || smallestPanePx >= axisMinPx) return null;
          const targetExtent = Math.min(1, extent * (axisMinPx / smallestPanePx));
          if (targetExtent <= extent) return null;
          const centre = start + extent / 2;
          const nextStart = Math.min(Math.max(0, centre - targetExtent / 2), 1 - targetExtent);
          return { start: nextStart, extent: targetExtent };
        };
        const widthGrow = grow(minWidthPx, narrowestPx, next.x, next.w);
        if (widthGrow) next = { ...next, x: widthGrow.start, w: widthGrow.extent };
        const heightGrow = grow(minHeightPx, shortestPx, next.y, next.h);
        if (heightGrow) next = { ...next, y: heightGrow.start, h: heightGrow.extent };

        if (next === tileTreeRect) return current;
        return { tileTreeRect: clampGeometry(next) };
      });
    },

    untileWindow: (id) => {
      set((current) => {
        const { tileTree, tileTreeRect } = current;
        if (!tileTree || !treeContainsWindow(tileTree, id)) return current;
        // Resolve the tree within its footprint in 0..1 space so the rects ARE
        // fractional geometry (the live tiled sizes/positions).
        const layout = resolveTileLayout(
          tileTree,
          { width: tileTreeRect.w, height: tileTreeRect.h },
          0,
          0,
          { left: tileTreeRect.x, top: tileTreeRect.y },
        );
        const floatAt = (windowId: string, base: Record<string, ManagedWindow>): void => {
          const rect = layout.rects.get(windowId);
          const target = base[windowId];
          if (!target || !rect) return;
          base[windowId] = {
            ...target,
            state: 'floating',
            leafId: null,
            geometry: clampGeometry({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }),
            restoreGeometry: null,
          };
        };

        const nextWindows = { ...current.windows };
        // The popped window floats at its current rect (keep its size, ready to drag).
        floatAt(id, nextWindows);

        const prunedTree = removeWindowFromTree(tileTree, id);
        const survivorIds = collectWindowIds(prunedTree);

        if (survivorIds.length <= 1) {
          // 2 -> 1: the lone survivor also floats at its current rect, so popping one
          // of a PAIR leaves both independently resizable (the group dissolves).
          if (survivorIds.length === 1) floatAt(survivorIds[0], nextWindows);
          return { windows: nextWindows, tileTree: null, tileTreeRect: FULL_TILE_RECT };
        }

        // 3+ -> the survivors STAY DOCKED and keep their absolute widths (no rescale
        // to fill the freed slot): shrink the footprint to the survivors' packed
        // extent. `removeWindowFromTree` renormalised their sizes to sum 1, so a
        // footprint equal to their combined extent reproduces their original sizes.
        const survivorRects = survivorIds
          .map((survivorId) => layout.rects.get(survivorId))
          .filter((rect): rect is PixelRect => !!rect);
        const minX = Math.min(...survivorRects.map((rect) => rect.left));
        const maxX = Math.max(...survivorRects.map((rect) => rect.left + rect.width));
        const minY = Math.min(...survivorRects.map((rect) => rect.top));
        const maxY = Math.max(...survivorRects.map((rect) => rect.top + rect.height));
        let nextFootprint: FractionalRect;
        if (prunedTree && prunedTree.kind === 'split' && prunedTree.children.every((child) => child.kind === 'leaf')) {
          // Flat split (the common case): the footprint along the split axis is the
          // SUM of survivor extents (gap removed); the perpendicular axis is their
          // shared span. So end-pops keep the survivors in place and a middle-pop
          // packs them together, freeing the popped slot as empty board.
          nextFootprint = prunedTree.direction === 'horizontal'
            ? { x: minX, y: minY, w: survivorRects.reduce((sum, rect) => sum + rect.width, 0), h: maxY - minY }
            : { x: minX, y: minY, w: maxX - minX, h: survivorRects.reduce((sum, rect) => sum + rect.height, 0) };
        } else {
          // Nested tree: best-effort to the survivors' bounding box.
          nextFootprint = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        return { windows: nextWindows, tileTree: prunedTree, tileTreeRect: clampGeometry(nextFootprint) };
      });
    },

    toggleMaximizeWindow: (id) => {
      const target = get().windows[id];
      if (!target) return;
      if (target.state === 'maximized') get().restoreWindow(id);
      else get().maximizeWindow(id);
    },

    restoreWindow: (id) => {
      set((current) => {
        const target = current.windows[id];
        if (!target) return current;
        if (target.state !== 'maximized') return current;
        // A maximized window that is STILL a member of the tile tree was TILED before
        // it maximized (maximize keeps its leaf + tree membership): un-maximize back
        // to its DOCKED slot, not to a floating window. Returning it to 'floating'
        // while the tree still referenced it left a stale reference - a now-floating
        // window resolved at its phantom tiled rect - which mis-placed later drop
        // previews (the same class as the snapWindow stale-ref bug).
        if (target.leafId && current.tileTree && treeContainsWindow(current.tileTree, id)) {
          return {
            windows: { ...current.windows, [id]: { ...target, state: 'tiled', restoreGeometry: null } },
          };
        }
        // Otherwise un-maximize back to floating at the pre-maximize geometry, and
        // clear any leafId so a window that left the tree under itself while
        // maximized can never carry a dangling leaf reference.
        return {
          windows: {
            ...current.windows,
            [id]: {
              ...target,
              state: 'floating',
              geometry: target.restoreGeometry ?? target.geometry,
              leafId: null,
              restoreGeometry: null,
            },
          },
        };
      });
    },

    serializeWorkspace: () => {
      const current = get();
      // Every window kind is persisted (conversation windows included, each
      // stamped with its own `kind` by toSerializedWorkspace), so a docked
      // conversation panel restores like a task-detail window on a project
      // switch. Restore's `isKnownAnchor` is kind-aware (a conversation leaf's
      // session-id anchor is never mistaken for a taskId), so a persisted
      // conversation leaf no longer needs to be pruned from the tile tree here.
      return toSerializedWorkspace(
        Object.values(current.windows),
        current.tileTree,
        current.tileTreeRect,
        current.focusedWindowId,
      );
    },

    applyWorkspace: (workspace, resolveSessionId, isKnownAnchor) => {
      const restored = deserializeWorkspace(workspace, {
        kind: options.kind,
        resolveSessionId,
        isKnownAnchor,
        makeWindowId: nextWindowId,
        makeTileId: nextTileId,
      });
      if (!restored) return;
      set({
        windows: restored.windows,
        order: restored.order,
        focusedWindowId: restored.focusedWindowId,
        zCounter: Object.keys(restored.windows).length,
        tileTree: restored.tileTree,
        tileTreeRect: restored.tileTreeRect,
      });
    },
  }));

  // Dev-only stale-leaf tripwire: after EVERY mutation, assert the tiling
  // invariant (tree membership <-> state <-> leafId). A regression then surfaces
  // loudly at the mutator that caused it while dogfooding, instead of three drags
  // later as a phantom pane / "invisible wall". Subscribed once here in the store
  // factory, which runs only on a cold load (the HMR-pinned instance keeps its one
  // subscription), and compiled out of production builds where import.meta.env.DEV
  // is statically false.
  // @ts-expect-error -- Vite defines import.meta.env; tsc's "module": "commonjs" doesn't support it
  if (import.meta.env?.DEV) {
    store.subscribe((state) => {
      const violations = findWindowTreeViolations(state.windows, state.tileTree);
      if (violations.length > 0) {
        console.error(
          `[window-manager:${options.idPrefix}] tiling invariant violated:\n  - ${violations.join('\n  - ')}`,
        );
      }
    });
  }

  return { store, options };
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const HMR_DATA: Record<string, WindowManager> | undefined = import.meta.hot?.data;

/** Build (or reuse the HMR-pinned) instance for a layer. Pattern E: pinning the
 *  instance across a Fast Refresh preserves its live layout and in-closure id
 *  counters, and guarantees one store per layer (no split-brain second store).
 *  On the first cold load `HMR_DATA` is empty, so the `??` fallback builds fresh;
 *  on a later Fast Refresh the prior evaluation already wrote the instances into
 *  `import.meta.hot.data` (the block at the bottom of this module), so they are
 *  recovered here. That write MUST stay after these `resolveInstance` calls. */
function resolveInstance(
  key: 'boardWindowManager' | 'commandWindowManager' | 'monitorWindowManager',
  options: WindowManagerStoreOptions,
): WindowManager {
  return HMR_DATA?.[key] ?? createWindowManagerStore(options);
}

/** The board task-detail window layer (the original, modeless, per-project layer). */
export const boardWindowManager = resolveInstance('boardWindowManager', {
  idPrefix: 'board',
  kind: 'task-detail',
});

/** The command-terminal window layer (modal-ish, globally persisted). */
export const commandWindowManager = resolveInstance('commandWindowManager', {
  idPrefix: 'cmd',
  kind: 'command-terminal',
});

/**
 * The Agent Monitor's task-detail layer. Task-detail windows again, but hosted
 * over the monitor rather than the board, and NOT per-project: a monitor row can
 * belong to any project, so this layer's windows are keyed only by task and its
 * layout is never persisted per-project the way the board's is.
 */
export const monitorWindowManager = resolveInstance('monitorWindowManager', {
  idPrefix: 'mon',
  kind: 'task-detail',
  anchorToTaskId: monitorAnchorToTaskId,
});

/**
 * Every window-manager instance in this renderer.
 *
 * Some state the layers feed is renderer-GLOBAL rather than per-layer - notably
 * `session-store.dialogSessionIds`, the set of sessions owned by an open detail
 * window, which the bottom terminal panel reads to decide whether to render its
 * own xterm. A reconciler that walked only ONE layer's windows would treat the
 * other layers' claims as stale and erase them, putting a second xterm on a live
 * PTY. Consumers of that kind iterate THIS list, so a fourth layer is covered the
 * day it is added.
 */
export const allWindowManagers: readonly WindowManager[] = [
  boardWindowManager,
  commandWindowManager,
  monitorWindowManager,
];

/** Back-compat: the board instance's bound store hook. Existing engine consumers
 *  (index.ts, bridges, restore-workspace, the "Open in Window" entry points) keep
 *  importing this singleton and operate on the board layer unchanged. */
export const useWindowStore = boardWindowManager.store;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.boardWindowManager = boardWindowManager;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.commandWindowManager = commandWindowManager;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.monitorWindowManager = monitorWindowManager;
  // Self-accept: editing this module forces a clean reload rather than handing a
  // second store instance to part of an already-mounted tree (Pattern E).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
