/**
 * Window-manager data model.
 *
 * Defined in full up front (P0) even where later phases wire the fields:
 * the tiling tree (`TileNode`) and `leafId` are unused until P2, and the
 * multi-owner terminal model lands in P3. Keeping the shapes stable now means
 * each phase fills the model rather than reshaping it.
 *
 * Geometry is FRACTIONAL (0..1 of the window-manager overlay rect) so a saved
 * layout survives monitor and viewport size changes. Pixels are derived at
 * render time against the overlay's measured size (see `geometry.ts`).
 */

/** A rectangle expressed as fractions (0..1) of the overlay rect. */
export interface FractionalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `snapped` is a half-dock (left/right). It renders like `floating` (resizable,
 * not full-screen) but, like `maximized`, remembers `restoreGeometry` so dragging
 * the window away restores the user's pre-snap size (Win11 behavior).
 */
export type WindowState = 'floating' | 'tiled' | 'snapped' | 'maximized' | 'minimized';

/** Live-session disposition mirrored onto the window so it can render a
 *  suspended/closed shell after its `sessionId` is cleared (P3 reconciliation). */
export type WindowSessionStatus = 'live' | 'suspended' | 'closed';

export interface ManagedWindow {
  /** Window id, distinct from the session id. */
  id: string;
  /** Durable anchor: survives a session respawn (model/agent/isolation change). */
  taskId: string;
  /** Live PTY binding; null when suspended, closed, or respawning. */
  sessionId: string | null;
  /** Position + size as fractions of the overlay rect. */
  geometry: FractionalRect;
  state: WindowState;
  /** Stacking order among floating windows (ephemeral, re-derived from `order`). */
  zIndex: number;
  /** Set only while `state === 'tiled'`; references the owning tile leaf. */
  leafId: string | null;
  sessionStatus: WindowSessionStatus;
  /** Geometry to return to when un-maximizing / un-tiling. */
  restoreGeometry: FractionalRect | null;
  /** State to return to when un-minimizing. */
  previousState: WindowState | null;
  /** Title-bar label. */
  title: string;
  /** When true, the hosted task-detail content opens in edit mode (set from the
   *  open intent, e.g. the context-menu "Edit" or a To Do task with no session). */
  initialEdit?: boolean;
}

/**
 * Binary-split tiling tree (P2). Floating windows live OUTSIDE this tree; a
 * window is in the tree iff `state === 'tiled'`, with exactly one leaf
 * referencing it.
 */
export interface TileLeaf {
  kind: 'leaf';
  id: string;
  windowId: string;
}

export interface TileSplit {
  kind: 'split';
  id: string;
  /**
   * Names the axis the children are arranged ALONG:
   * 'horizontal' = side by side (a | b), a vertical splitter bar between them.
   * 'vertical'   = stacked (a over b), a horizontal splitter bar between them.
   */
  direction: 'horizontal' | 'vertical';
  a: TileNode;
  b: TileNode;
  /** Fraction (0..1) of the split allotted to child `a`. */
  ratio: number;
}

export type TileNode = TileLeaf | TileSplit;

/** Screen-edge snap targets recognised while dragging a window. */
export type SnapEdge = 'left' | 'right' | 'maximize';
