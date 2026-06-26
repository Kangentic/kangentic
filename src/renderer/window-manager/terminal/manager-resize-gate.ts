/**
 * Shared "manager-resize in progress" gate.
 *
 * The window manager's imperative resizers (TileSplitter seam-drag,
 * FootprintResizer, useWindowResize 8-handle) resize the tiled frames' DOM boxes
 * on every pointermove WITHOUT a store write, so a window-hosted terminal's
 * ResizeObserver fires per frame. Refitting per frame sends a SIGWINCH per frame,
 * and a full-screen TUI (Claude Code) re-emits its whole banner + transcript frame
 * on each SIGWINCH - stacking duplicate banners in the PTY scrollback.
 *
 * A resizer marks "a manager drag is in progress" for the duration of its gesture.
 * While the gate is open the terminal suppresses its per-frame ResizeObserver
 * refit (see `TerminalTab`); the PTY is then resized exactly once, from the single
 * `terminal-panel-resize` the store commit already dispatches on release. The gate
 * does NOT itself dispatch - the existing commit path owns the one settle-resize.
 *
 * Balance invariant: every `beginManagerResize()` is matched by exactly one
 * `endManagerResize()`. The counter is floored at 0, and each resizer's end runs
 * only when that gesture opened the gate, with its drag ref nulled first - so a
 * pathological multi-pointer race can only close the gate EARLY (degrading to the
 * pre-gate behavior), never leave it stuck open.
 */

// A transient gesture counter: how many imperative manager-resize drags are open.
// hmr-safe: a reset on HMR can only drop an in-flight drag's gate, which the next pointerdown re-establishes.
let activeGestureCount = 0;

export function beginManagerResize(): void {
  activeGestureCount += 1;
}

export function endManagerResize(): void {
  activeGestureCount = Math.max(0, activeGestureCount - 1);
}

export function isManagerResizeInProgress(): boolean {
  return activeGestureCount > 0;
}
