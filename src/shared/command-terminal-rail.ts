/**
 * The Command Terminal panel's rail: how wide it is by default, how far its
 * edge drags, and what it folds to. Shared by the config default and the panel.
 *
 * The range is the project sidebar's (`useSidebarResize`): 200 to 400, folding
 * to a strip. The default, 300, fits about half of the Earlier names measured
 * on a real project (everything up to about 39 characters) against 4 of 18 at
 * the old fixed 248.
 */

export const COMMAND_RAIL_DEFAULT_WIDTH_PX = 300;
export const COMMAND_RAIL_MIN_WIDTH_PX = 200;
export const COMMAND_RAIL_MAX_WIDTH_PX = 400;
/**
 * The collapsed strip: 36px inside its 1px right border, so its 28px buttons
 * sit 4px from each side on whole pixels. At 36 overall they sat 4px from the
 * left and 3px from the border, and centering them would land on half pixels.
 */
export const COMMAND_RAIL_COLLAPSED_WIDTH_PX = 37;

/** What is saved: the width the user dragged to, and whether the rail is folded. */
export interface CommandTerminalRailState {
  width: number;
  collapsed: boolean;
}

/** A saved width the drag could have produced, else the default. */
export function savedRailWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return COMMAND_RAIL_DEFAULT_WIDTH_PX;
  return Math.min(COMMAND_RAIL_MAX_WIDTH_PX, Math.max(COMMAND_RAIL_MIN_WIDTH_PX, Math.round(width)));
}

/**
 * The width the rail shows: the strip when collapsed, else the saved width,
 * narrowed so the row beside it keeps `terminalFloorWidth` (the terminals' grid
 * at its floor), but never under the drag's minimum. Never written back: a narrow
 * window shows the rail narrower, and the saved width returns with the room.
 * `rowWidth` is the panel's body (rail plus terminal area); unknown (0) shows
 * the saved width.
 */
export function resolveRailWidth(input: {
  saved: CommandTerminalRailState;
  rowWidth: number;
  terminalFloorWidth: number;
}): number {
  if (input.saved.collapsed) return COMMAND_RAIL_COLLAPSED_WIDTH_PX;
  const width = savedRailWidth(input.saved.width);
  if (input.rowWidth <= 0) return width;
  const room = Math.floor(input.rowWidth - input.terminalFloorWidth);
  return Math.max(COMMAND_RAIL_MIN_WIDTH_PX, Math.min(width, room));
}
