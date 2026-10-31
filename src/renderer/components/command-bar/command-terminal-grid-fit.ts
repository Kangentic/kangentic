/**
 * The smallest terminal area the panel's terminals fit in. The preset for a
 * count (`tiling/host-arrangement.ts`) is one terminal filling the area, two
 * side by side, three as one tall beside two stacked, and four as a two by two
 * grid, so two or more need two columns and three or more need two rows. One
 * the user expanded needs only its own. The panel never resizes under this
 * (`CommandTerminalLayer`): a resize stops where the grid still fits, and a
 * terminal added or the grid restored grows the panel to fit. Only a window too
 * small for the grid tiles the terminals under the floor; nothing falls back to
 * one terminal expanded.
 */

import type { ContainerSize } from '../../window-manager/store/geometry';

export type AreaSize = ContainerSize;

/**
 * Each terminal's floor: 630px, about 77 columns, where the context bar's one
 * row still holds the agent, model, effort, rate limits and context beside its
 * +N pill (`useContextBarFold`) with every bar at its 40px minimum. Measured on
 * a live Claude bar, that row needs 589px of terminal for Haiku at low effort
 * and 621 for Sonnet at medium, the widest 5.x pair; a longer "(1M context)"
 * model name needs more, and at the floor its rate limits fold. Two terminals
 * tile in a 1462px panel with the rail at its narrowest; a smaller screen tiles
 * them under the floor. The height floor keeps two rows on a 1080p screen.
 */
export const COMMAND_TERMINAL_FLOOR: AreaSize = { width: 630, height: 200 };

export function commandTerminalGridMinimum(
  terminalCount: number,
  expanded: boolean,
  floor: AreaSize = COMMAND_TERMINAL_FLOOR,
): AreaSize {
  const columns = !expanded && terminalCount >= 2 ? 2 : 1;
  const rows = !expanded && terminalCount >= 3 ? 2 : 1;
  return { width: columns * floor.width, height: rows * floor.height };
}

/**
 * The terminal area's minimum width beside the rail: the grid's, or all the row
 * has beside a rail at its minimum. The open rail gives way to it in the same
 * layout pass, so a panel shrinking a frame ahead of the rail's own width never
 * squeezes the terminals under the floor.
 */
export function commandTerminalAreaMinWidth(gridMinimumWidth: number, railMinimumWidth: number): string {
  return `min(${gridMinimumWidth}px, calc(100% - ${railMinimumWidth}px))`;
}
