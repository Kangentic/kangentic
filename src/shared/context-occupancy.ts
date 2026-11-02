/**
 * When a session's context occupancy can be drawn. Shared so the board card,
 * the context bar (both through `renderer/utils/format-tokens.ts`) and the
 * Agent Monitor (`main/monitor/monitor-aggregator.ts`) answer it one way.
 */

/**
 * A context window is known (has a real denominator to draw a bar against)
 * only when the reported size is positive - 0 is the "unknown size" sentinel
 * used before any window has been learned for a session's model. The used/total
 * fraction still gates on this. The bar and percent gate on
 * isContextOccupancyKnown, which also accepts a percentage-only report.
 */
export function isContextWindowKnown(contextWindowSize: number): boolean {
  return contextWindowSize > 0;
}

/**
 * True when there is occupancy to paint, even if the window size is still
 * unknown. Cursor's interactive TUI reports `Composer 2.5 · 7.8%` with no
 * token counts and no window. That is a real percent, not the broken
 * denominator of leftover tokens paired with a missing window (the case
 * `contextWindowDisplayPercent` still zeros). TaskCard, ContextBar, and the
 * Agent Monitor all gate on this so a Skip Approvals card does not sit at 0%
 * while the open terminal already shows 7.8%.
 */
export function isContextOccupancyKnown(
  contextWindowSize: number,
  usedTokens: number,
  usedPercentage: number,
): boolean {
  if (isContextWindowKnown(contextWindowSize)) return true;
  // `!(usedTokens > 0)` and not `usedTokens <= 0`: a count that is missing
  // reads as none.
  return !(usedTokens > 0) && Number.isFinite(usedPercentage) && usedPercentage > 0;
}
