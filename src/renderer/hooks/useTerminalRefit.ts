import { useEffect } from 'react';
import type { RefObject } from 'react';
import { isManagerResizeInProgress } from '../window-manager/terminal/manager-resize-gate';

/**
 * Shared container-refit logic for every xterm host (task-detail TerminalTab,
 * bottom-panel TerminalTab, CommandTerminalWindow). Extracted so hosts cannot
 * drift: the Command Terminal's hand-rolled subset was missing the persistent
 * ResizeObserver, so container-only height changes (its footer ContextBar
 * growing) silently clipped the TUI's bottom rows.
 *
 * Unified debounced resize mechanism. One timer, two entry points:
 * - ResizeObserver debounces at 200ms (handles drag without scrollback
 *   eviction: timer resets every frame during drag, fires once after).
 * - terminal-panel-resize event uses 50ms (faster for explicit triggers
 *   like sidebar resize, dialog edit-mode toggle, drag mouseUp), 0ms for
 *   deferContainerResize hosts, or a synchronous fit for
 *   immediatePanelResize hosts.
 */

export const OBSERVER_REFIT_DEBOUNCE_MS = 200;
export const PANEL_EVENT_REFIT_DEBOUNCE_MS = 50;
export const DEFERRED_RESIZE_SETTLE_MS = 800;

/**
 * Whether a ResizeObserver notification should schedule a debounced refit.
 *
 * Window-manager terminals defer container-driven fits: the window manager
 * owns sizing and dispatches a single settle-debounced terminal-panel-resize,
 * so rapid snap/maximize/restore resizes the PTY once (one clean SIGWINCH).
 *
 * While a window-manager imperative resize gesture is in progress (seam drag,
 * footprint resize, 8-handle window resize) the observer fires per frame as
 * the frame's DOM box is rewritten. Refitting per frame would send a SIGWINCH
 * per frame, and a full-screen TUI re-emits its whole banner on each - stacking
 * duplicates in scrollback. Suppress the per-frame refit during the gesture; the
 * store commit on release dispatches a single terminal-panel-resize that refits
 * once. The gate is OFF for container-only changes (Changes/Browser pane toggle,
 * the Command Terminal's ContextBar growing), so those still refit normally.
 */
export function shouldObserverScheduleRefit(
  deferContainerResize: boolean,
  managerResizeInProgress: boolean,
): boolean {
  return !deferContainerResize && !managerResizeInProgress;
}

export type PanelResizeAction =
  | { kind: 'immediate-fit-flush' }
  | { kind: 'debounced-fit'; delayMs: number; scheduleSettleCleanup: boolean };

/**
 * How a `terminal-panel-resize` event is handled for a given host mode.
 *
 * - immediatePanelResize hosts fit SYNCHRONOUSLY: the window engine dispatches
 *   the event from a layout effect via a microtask (before the browser paints),
 *   so fitting fills the committed size in the SAME frame as the resized
 *   window - no letterbox lag.
 * - deferContainerResize hosts fit on the next tick (0ms) and schedule the
 *   settle cleanup (scrollback reload) once resizing fully stops.
 * - Other surfaces keep the 50ms debounce to batch their own events.
 */
export function resolvePanelResizeAction(
  deferContainerResize: boolean,
  immediatePanelResize: boolean,
): PanelResizeAction {
  if (immediatePanelResize) return { kind: 'immediate-fit-flush' };
  return {
    kind: 'debounced-fit',
    delayMs: deferContainerResize ? 0 : PANEL_EVENT_REFIT_DEBOUNCE_MS,
    scheduleSettleCleanup: deferContainerResize,
  };
}

export interface TerminalRefitOptions {
  /** The xterm host element to observe (useTerminal's terminalRef). Must be
   *  mounted unconditionally for the effect's lifetime: the effect reads
   *  `.current` once on run and bails if it is null, and since the ref identity
   *  is stable it will not re-attach when a later-mounted element appears. Every
   *  current host renders the ref'd div unconditionally. */
  terminalRef: RefObject<HTMLDivElement | null>;
  /** Host-owned "xterm initialized" flag, read at fire time (not a dep) so a
   *  session-respawn reset suppresses refits without re-running the effect. */
  initializedRef: RefObject<boolean>;
  fit: () => void;
  flushResize: () => void;
  /** Attach the observer/listener only while true (TerminalTab's `active`).
   *  Defaults to true. */
  enabled?: boolean;
  /** See TerminalTab's prop JSDoc: skip the per-container ResizeObserver
   *  auto-fit and reload scrollback after a resize settles. */
  deferContainerResize?: boolean;
  /** See TerminalTab's prop JSDoc: refit synchronously on
   *  `terminal-panel-resize`; the ResizeObserver stays ON. */
  immediatePanelResize?: boolean;
  /** deferContainerResize only: runs once resizing has settled (800ms). A
   *  full-screen TUI re-emits its frame on each SIGWINCH; while the width is
   *  changing those redraws stack as duplicated banners in xterm's history.
   *  Hosts pass a reloadScrollback({ skipResize: true }) so the buffer is
   *  replayed ONCE at the now-stable width. */
  onDeferredResizeSettled?: () => void;
}

export function useTerminalRefit(options: TerminalRefitOptions): void {
  const {
    terminalRef,
    initializedRef,
    fit,
    flushResize,
    enabled = true,
    deferContainerResize = false,
    immediatePanelResize = false,
    onDeferredResizeSettled,
  } = options;

  useEffect(() => {
    if (!enabled) return;
    const element = terminalRef.current;
    if (!element) return;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefit = (delayMs: number) => {
      if (!initializedRef.current) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        fit();
      }, delayMs);
    };

    // Persistent: stays connected for the effect's lifetime so container-only
    // size changes keep refitting long after init.
    const observer = new ResizeObserver(() => {
      if (shouldObserverScheduleRefit(deferContainerResize, isManagerResizeInProgress())) {
        scheduleRefit(OBSERVER_REFIT_DEBOUNCE_MS);
      }
    });
    observer.observe(element);

    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    const handlePanelResize = () => {
      const action = resolvePanelResizeAction(deferContainerResize, immediatePanelResize);
      if (action.kind === 'immediate-fit-flush') {
        // Clear any pending debounced fit so it cannot run a redundant second
        // fit afterward. Fit synchronously, then flush the PTY resize
        // immediately (don't wait out the 200ms debounce) so Claude's redraw
        // lands with the reflow instead of a beat later - minimizes the resize
        // "flash". The manager-resize gate already guarantees one resize per
        // gesture, so there's nothing to coalesce.
        if (resizeTimer) {
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        if (initializedRef.current) {
          fit();
          flushResize();
        }
        return;
      }
      scheduleRefit(action.delayMs);
      if (action.scheduleSettleCleanup) {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimer = setTimeout(() => {
          cleanupTimer = null;
          if (initializedRef.current) onDeferredResizeSettled?.();
        }, DEFERRED_RESIZE_SETTLE_MS);
      }
    };
    window.addEventListener('terminal-panel-resize', handlePanelResize);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      observer.disconnect();
      window.removeEventListener('terminal-panel-resize', handlePanelResize);
    };
  }, [
    enabled,
    terminalRef,
    initializedRef,
    fit,
    flushResize,
    deferContainerResize,
    immediatePanelResize,
    onDeferredResizeSettled,
  ]);
}
