/**
 * When the veil over a Command Terminal that just jumped size (Expand,
 * Restore) comes down.
 *
 * Until the agent repaints at the new size, the terminal shows its old frame
 * on the new grid. Main's repaint settle cannot be the signal: it settles on
 * the first screen clear after the resize, and on Windows that is ConPTY's
 * redraw of the OLD screen, not the agent's frame. Measured on Claude Code
 * 2.1.310 on Windows by resizing a live PTY and timestamping its output, four
 * runs:
 *
 *   grow 120x30 to 200x50     output at 29, 131, 162, 186 ms
 *   shrink 200x50 to 120x30   output at 27, 126, 159, 182, 213 ms
 *   rows 63 to 40             output at 26, 41, 181, 212 ms
 *   rows 40 to 63             output at 0, 31, 157, 172 ms
 *
 * The first burst (under 45 ms) is ConPTY's redraw, main's settle fires on
 * it, and the agent's own frame lands 98 to 181 ms after the resize, with its
 * tail within about 35 ms of it. So the veil holds for a floor past the
 * latest frame measured and then until the output has been quiet for a beat;
 * against those runs it lifts between 212 and 253 ms. A slower agent degrades
 * to a brief look at the old frame, never a veil that stays up: the cap ends
 * it whatever the output does.
 */

/**
 * Dispatched on a Command Terminal's pane (`command-bar-terminal-pane`) by a
 * surface that is about to change that terminal's size in one step outside a
 * layout change, the swap drag's preview: the pane veils it the same way.
 */
export const TERMINAL_JUMP_EVENT = 'kangentic:terminal-jump';

/** No lift before this long after the jump: past the latest agent frame measured (181 ms). */
export const RESIZE_VEIL_MIN_HOLD_MS = 190;
/** Then the output must have been quiet this long: longer than the gaps inside the agent's own frame. */
export const RESIZE_VEIL_QUIET_MS = 40;
/** The veil comes down by this long after the jump, even under output that never stops. */
export const RESIZE_VEIL_MAX_HOLD_MS = 500;

/**
 * How long until the veil may come down, given when the jump was and when the
 * terminal's output last arrived (the jump itself when none has). 0 means now.
 */
export function msUntilResizeVeilLifts(now: number, jumpAt: number, lastOutputAt: number): number {
  const cap = jumpAt + RESIZE_VEIL_MAX_HOLD_MS;
  const ready = Math.max(jumpAt + RESIZE_VEIL_MIN_HOLD_MS, Math.max(lastOutputAt, jumpAt) + RESIZE_VEIL_QUIET_MS);
  return Math.max(0, Math.min(ready, cap) - now);
}
