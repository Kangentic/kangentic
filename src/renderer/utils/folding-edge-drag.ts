/**
 * Where a drag of a folding edge leaves its panel: the project sidebar's divider
 * (`useSidebarResize`) and the Command Terminal rail's edge
 * (`useCommandTerminalRail`) share this one rule, so the two edges side by side
 * never fold differently.
 *
 * The panel follows the pointer down to its minimum, holds there while the
 * pointer goes on to half of it, and folds to its strip only past that, while
 * the drag is still running: what the screen shows is what letting go keeps,
 * and dragging back past the same line opens it at its minimum again. A fold
 * line AT the minimum made the narrowest open panel a release within a pixel or
 * two of the edge, with nothing on screen to say the next pixel folds. VS Code's
 * split views draw the line at half the minimum too.
 */

export interface FoldingEdgeDrag {
  /** The pointer's distance from the panel's fixed side: the width it asks for. */
  raw: number;
  /** The narrowest the panel shows open. */
  minWidth: number;
  /** The widest it may go. A cap under `minWidth` leaves the panel at `minWidth`. */
  maxWidth: number;
}

export interface FoldingEdgeStep {
  /** The panel shows its strip. */
  collapsed: boolean;
  /** Its open width, whole pixels: the minimum while it holds or is folded. */
  width: number;
}

/** The share of the minimum width a drag must pass below before the panel folds. */
export const FOLD_LINE_SHARE_OF_MINIMUM = 0.5;

export function resolveFoldingEdgeDrag({ raw, minWidth, maxWidth }: FoldingEdgeDrag): FoldingEdgeStep {
  if (raw < minWidth * FOLD_LINE_SHARE_OF_MINIMUM) return { collapsed: true, width: minWidth };
  return { collapsed: false, width: Math.round(Math.max(minWidth, Math.min(maxWidth, raw))) };
}
