/**
 * Windows-11-style STATEFUL keyboard snapping. Each arrow's result depends on the
 * window's CURRENT snap zone, so you can build a layout from the keyboard:
 * floating -> left half -> top-left corner -> top-right corner, and so on.
 *
 * Pure module: it classifies a rect into a zone and maps (zone, direction) to an
 * action. The store action + DOM measurement live at the call site (TaskDetailWindow).
 *
 * The UP ladder grows the window upward and never dead-ends:
 *   bottom corner -> side half -> top corner -> maximize -> top half.
 * DOWN reverses it (top half -> maximize -> restore-to-floating; top corner ->
 * half -> bottom corner). Left/right move across. Side halves DOCK (pair into a
 * tiled 2-up); corners + the top half are lone snaps.
 */

import type { FractionalRect } from '../store/types';

export type SnapZone =
  | 'maximized'
  | 'floating'
  | 'left-half'
  | 'right-half'
  | 'top-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type SnapDirection = 'left' | 'right' | 'up' | 'down';

/** Zones reached by a plain (lone, full-geometry) snap, not a dock or maximize. */
type LoneSnapZone = 'top-half' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type SnapAction =
  | { kind: 'none' }
  | { kind: 'maximize' }
  | { kind: 'restore' }
  | { kind: 'dock'; edge: 'left' | 'right' }
  | { kind: 'snap'; zone: LoneSnapZone; geometry: FractionalRect };

const SNAP_GEOMETRY: Record<LoneSnapZone, FractionalRect> = {
  'top-half': { x: 0, y: 0, w: 1, h: 0.5 },
  'top-left': { x: 0, y: 0, w: 0.5, h: 0.5 },
  'top-right': { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  'bottom-left': { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  'bottom-right': { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
};

function snapTo(zone: LoneSnapZone): SnapAction {
  return { kind: 'snap', zone, geometry: SNAP_GEOMETRY[zone] };
}

const NONE: SnapAction = { kind: 'none' };
const MAXIMIZE: SnapAction = { kind: 'maximize' };
const RESTORE: SnapAction = { kind: 'restore' };
const DOCK_LEFT: SnapAction = { kind: 'dock', edge: 'left' };
const DOCK_RIGHT: SnapAction = { kind: 'dock', edge: 'right' };

/** Slack when matching a rect to a snap zone, to absorb seam gaps + rounding. */
const ZONE_TOLERANCE = 0.08;

function near(value: number, target: number): boolean {
  return Math.abs(value - target) <= ZONE_TOLERANCE;
}

/**
 * Classify a window's RENDERED rect (fractions of the overlay) into a snap zone.
 * Reads the rect, not stored geometry, so it works for a tiled pane too (whose
 * stored geometry is its pre-tile float, not where it renders).
 */
export function classifySnapZone(rect: FractionalRect): SnapZone {
  const fullWidth = near(rect.x, 0) && near(rect.w, 1);
  if (fullWidth && near(rect.y, 0) && near(rect.h, 1)) return 'maximized';
  if (fullWidth && near(rect.y, 0) && near(rect.h, 0.5)) return 'top-half';

  const onLeft = near(rect.x, 0) && near(rect.w, 0.5);
  const onRight = near(rect.x, 0.5) && near(rect.w, 0.5);
  if (near(rect.h, 1)) {
    if (onLeft) return 'left-half';
    if (onRight) return 'right-half';
  }
  if (near(rect.h, 0.5)) {
    const onTop = near(rect.y, 0);
    const onBottom = near(rect.y, 0.5);
    if (onLeft && onTop) return 'top-left';
    if (onRight && onTop) return 'top-right';
    if (onLeft && onBottom) return 'bottom-left';
    if (onRight && onBottom) return 'bottom-right';
  }
  return 'floating';
}

/** The transition table: where each arrow takes a window from its current zone. */
export function nextSnap(zone: SnapZone, direction: SnapDirection): SnapAction {
  switch (direction) {
    case 'left':
      switch (zone) {
        case 'floating':
        case 'maximized':
        case 'right-half':
          return DOCK_LEFT;
        case 'top-half':
        case 'top-right':
          return snapTo('top-left');
        case 'bottom-right':
          return snapTo('bottom-left');
        default:
          return NONE; // already on the left
      }
    case 'right':
      switch (zone) {
        case 'floating':
        case 'maximized':
        case 'left-half':
          return DOCK_RIGHT;
        case 'top-half':
        case 'top-left':
          return snapTo('top-right');
        case 'bottom-left':
          return snapTo('bottom-right');
        default:
          return NONE; // already on the right
      }
    case 'up':
      switch (zone) {
        case 'floating':
          return MAXIMIZE;
        case 'maximized':
          return snapTo('top-half'); // maximized climbs to the top half
        case 'left-half':
          return snapTo('top-left');
        case 'right-half':
          return snapTo('top-right');
        case 'top-left':
        case 'top-right':
          return MAXIMIZE; // a top corner climbs to maximize
        case 'bottom-left':
          return DOCK_LEFT;
        case 'bottom-right':
          return DOCK_RIGHT;
        default:
          return NONE; // top-half is already at the very top
      }
    case 'down':
      switch (zone) {
        case 'maximized':
          return RESTORE;
        case 'top-half':
          return MAXIMIZE; // descend the top half back to maximize
        case 'left-half':
          return snapTo('bottom-left');
        case 'right-half':
          return snapTo('bottom-right');
        case 'top-left':
          return DOCK_LEFT;
        case 'top-right':
          return DOCK_RIGHT;
        default:
          return NONE; // floating (no minimize) / already at a bottom corner
      }
  }
}
