/**
 * Whether the panel can show its terminals as a grid. The preset for a count
 * (`tiling/host-arrangement.ts`) is one terminal filling the area, two side by
 * side, three as one tall beside two stacked, and four as a two by two grid, so
 * two or more need two columns and three or more need two rows. Every terminal
 * keeps the pane floor, a task window's 650px width, which is about the 80
 * columns an agent's interface is laid out for; an area too small for the
 * preset at that floor shows one terminal expanded and lists the others under
 * Running instead (`CommandTerminalLayer`).
 */

export interface AreaSize {
  width: number;
  height: number;
}

export function commandTerminalGridFits(terminalCount: number, area: AreaSize, floor: AreaSize): boolean {
  if (terminalCount <= 1) return true;
  const columns = 2;
  const rows = terminalCount >= 3 ? 2 : 1;
  return area.width >= columns * floor.width && area.height >= rows * floor.height;
}
