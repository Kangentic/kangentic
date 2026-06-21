/**
 * Coalesces window size changes into a single terminal resize, dispatched in a
 * microtask so it lands BEFORE the browser paints.
 *
 * A window snap / maximize / restore / resize-commit / overlay-resize changes
 * the terminal's container size. WindowFrame calls this from a `useLayoutEffect`
 * (commit phase, after the DOM is updated, before paint). Scheduling the
 * `terminal-panel-resize` dispatch in a microtask (not a `requestAnimationFrame`)
 * means it fires at the end of the same commit task, still before the first
 * paint, so a window-hosted terminal (TerminalTab `immediatePanelResize`) can
 * refit synchronously and fill the new size in the SAME frame as the resized
 * window, instead of letterboxing for a frame or two while an rAF + timer chain
 * settles.
 *
 * The microtask flag coalesces multiple size changes in one commit (e.g. several
 * windows reprojecting on an overlay resize) into a single dispatch.
 */

// hmr-safe: a transient per-tick flag; a reset on HMR only drops a pending
// dispatch, which the next size change reschedules.
let dispatchScheduled = false;

export function scheduleWindowTerminalResize(): void {
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  queueMicrotask(() => {
    dispatchScheduled = false;
    window.dispatchEvent(new Event('terminal-panel-resize'));
  });
}
