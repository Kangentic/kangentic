import type { ColumnWidth } from '../../../shared/types';

/**
 * How wide each board column is (#1056). Eight columns at a fixed 288px do
 * not fit a 2124px row, so a column has one of three shapes:
 *
 * - `shared`: it has tasks. Its width is the Column width setting: a fixed
 *   width under Narrow, Default and Wide, and a share of the row under Fill.
 * - `shrunk`: it has no tasks and Shrink empty columns is on. It is as wide as
 *   its own header, so its name never cuts off.
 * - `collapsed`: the user folded it to a strip.
 *
 * Three ways fit a crowded board, each the user's own choice: Fill, which
 * sizes the columns to the window; Shrink empty columns; and collapsing one.
 * Narrow, Default and Wide never change a column's width on their own, so
 * nothing reflows when another column empties or folds.
 *
 * Pure, so the rule is tested without a board (`tests/unit/lane-widths.test.ts`).
 * `KanbanBoard` turns a shape into the flex style of the column's wrapper.
 */
export type LaneShape = 'shared' | 'shrunk' | 'collapsed';

/** The strip a collapsed column folds to. */
export const COLLAPSED_LANE_WIDTH_PX = 40;

/** How long a column takes to reach a new width: the sidebar's own motion. */
export const LANE_WIDTH_MOTION_MS = 200;
export const LANE_WIDTH_MOTION_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

/**
 * Narrow was 256px until #1056. At 240px eight columns fit the 2124px row the
 * task started from (251px a column of room), and the three steps are easier
 * to tell apart than 256 and 288 were.
 */
const NARROW_PX = 240;
const DEFAULT_PX = 288;
const WIDE_PX = 384;

/**
 * The narrowest a column gets under Fill before the board scrolls. Fill exists
 * to fit the columns to the window, so its floor sits well under Narrow: at
 * 256px it stopped sharing on the very board it was added for, eight columns
 * needing 2160px in a 2124px row. 200px still holds a card's title and number
 * on one line, and is about the width of an empty column's header.
 */
export const FILL_FLOOR_PX = 200;

export interface LaneWidthRange {
  /** A column with tasks is never narrower than this; past it the board scrolls. */
  minPx: number;
  /** A column with tasks stops growing here. Null under Fill: it takes its share of the row. */
  maxPx: number | null;
}

/**
 * Narrow, Default and Wide are fixed widths, the ones the board has always
 * had. Fill shares the row between its columns, down to `FILL_FLOOR_PX`.
 */
export function laneWidthRange(columnWidth: ColumnWidth): LaneWidthRange {
  switch (columnWidth) {
    case 'narrow':
      return { minPx: NARROW_PX, maxPx: NARROW_PX };
    case 'wide':
      return { minPx: WIDE_PX, maxPx: WIDE_PX };
    case 'fill':
      return { minPx: FILL_FLOOR_PX, maxPx: null };
    case 'default':
    default:
      return { minPx: DEFAULT_PX, maxPx: DEFAULT_PX };
  }
}

export interface LaneShapeInput {
  /** The user collapsed this column. */
  collapsed: boolean;
  /** The column holds a task, whatever the board filter shows of it. */
  occupied: boolean;
  /** The Done column. Its cards are archived, so it would always read as empty. */
  isDone: boolean;
  shrinkEmpty: boolean;
}

/** A collapse the user made wins; Done never shrinks; an empty column shrinks when the setting is on. */
export function laneShape(input: LaneShapeInput): LaneShape {
  if (input.collapsed) return 'collapsed';
  if (input.shrinkEmpty && !input.occupied && !input.isDone) return 'shrunk';
  return 'shared';
}

/** The flex sizing of a column's wrapper, as CSS property values. */
export interface LaneFlexStyle {
  flex: string;
  width?: string;
  minWidth?: string;
  maxWidth?: string;
}

/**
 * The custom property the lanes row carries: the one width every shrunk column
 * takes, which is the widest header on the board. Columns of several widths
 * side by side read as clutter and are harder to aim a drag at, so the empty
 * ones match, and the width does not depend on which columns are empty, so a
 * move never resizes a column it did not touch. `useLaneWidthMotion` measures
 * and sets it; without it a shrunk column falls back to its own content's width.
 */
export const SHRUNK_LANE_WIDTH_PROPERTY = '--lane-shrunk-width';

/** A column's header, and the count inside it: what `useLaneWidthMotion` measures. */
export const LANE_HEADER_ATTRIBUTE = 'data-lane-header';
export const LANE_COUNT_ATTRIBUTE = 'data-lane-count';

/**
 * The wrapper is the row's flex item. A shared column grows from its floor to
 * its cap (the same number for a fixed width) and never shrinks below the
 * floor, so a row that cannot fit overflows and the board scrolls, as before.
 * Under Fill every shared column starts from the same floor and grows by the
 * same share, so they split the row evenly. A shrunk column takes the shrunk
 * columns' shared width, capped so a very long name cannot make an empty
 * column wider than a full one.
 */
export function laneFlexStyle(shape: LaneShape, range: LaneWidthRange): LaneFlexStyle {
  if (shape === 'collapsed') {
    return { flex: `0 0 ${COLLAPSED_LANE_WIDTH_PX}px`, width: `${COLLAPSED_LANE_WIDTH_PX}px` };
  }
  if (shape === 'shrunk') {
    return {
      flex: '0 0 auto',
      width: `var(${SHRUNK_LANE_WIDTH_PROPERTY}, max-content)`,
      maxWidth: `${range.maxPx ?? WIDE_PX}px`,
    };
  }
  return {
    flex: `1 0 ${range.minPx}px`,
    minWidth: `${range.minPx}px`,
    ...(range.maxPx === null ? {} : { maxWidth: `${range.maxPx}px` }),
  };
}

/**
 * One string for the whole row's shapes. A column animates to a new width only
 * when this changes: a window resize or a setting change moves widths without
 * changing any column's shape, and those never animate.
 */
export function laneShapesKey(shapes: ReadonlyArray<{ id: string; shape: LaneShape }>): string {
  return shapes.map((entry) => `${entry.id}:${entry.shape}`).join('|');
}
