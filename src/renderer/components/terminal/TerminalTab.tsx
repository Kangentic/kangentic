import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from './FileDropOverlay';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { LaunchOverlay } from '../LaunchOverlay';
import { getIsHmrReload } from '../../utils/hmr-flag';
import { useTerminalOverlay } from '../../utils/task-progress';
import { isManagerResizeInProgress } from '../../window-manager/terminal/manager-resize-gate';

const FIT_DELAY_MS = 100;

interface TerminalTabProps {
  sessionId: string;
  taskId: string;
  active: boolean;
  /** Let Escape bubble (to close the containing dialog) when the mouse pointer
   *  is outside the terminal. Set by the task detail dialog. */
  releaseEscapeWhenPointerOutside?: boolean;
  /** Window-manager terminals: the window manager owns sizing and dispatches a
   *  single settle-debounced `terminal-panel-resize`. Skip the per-container
   *  ResizeObserver auto-fit (so rapid snap/maximize/restore resizes the PTY once,
   *  not per size change) and reload the scrollback after a resize to clear
   *  garbled intermediate-width TUI redraws. */
  deferContainerResize?: boolean;
  /** Refit immediately (next tick) on `terminal-panel-resize` instead of the
   *  50ms debounce. The window manager already coalesces its dispatches to one
   *  per frame, so the terminal fills the committed size with no perceptible lag
   *  after a window drag-resize / snap / maximize / divider release. Unlike
   *  `deferContainerResize`, the ResizeObserver stays ON, so container-only size
   *  changes (opening the Changes / Browser pane) still refit. */
  immediatePanelResize?: boolean;
}

export function TerminalTab({ sessionId, taskId, active, releaseEscapeWhenPointerOutside, deferContainerResize, immediatePanelResize }: TerminalTabProps) {
  const config = useConfigStore((s) => s.config);
  const hasFirstOutput = useSessionStore((s) => !!s.sessionFirstOutput[sessionId]);
  const hasUsage = useSessionStore((s) => !!s.sessionUsage[sessionId]);

  const sessionStatus = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.status ?? null,
      [sessionId],
    ),
  );
  const sessionShell = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.shell ?? undefined,
      [sessionId],
    ),
  );

  // Resolve via the session's own taskId (not the taskId prop / task's forward
  // session_id), mirroring ContextBar: a model/effort restart respawns the
  // session and the board store's task.session_id can go stale until the next
  // reload, but session.taskId stays correct across the restart.
  const sessionTaskId = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.taskId,
      [sessionId],
    ),
  );
  const sessionAgent = useBoardStore((s) => s.tasks.find((t) => t.id === sessionTaskId)?.agent ?? null);
  // Adapter-declared: this agent needs an explicit reference (not a bare path)
  // to reliably read a pasted/dropped image. Never branch on agent name here -
  // see .claude/rules/agent-adapters-boundary.md.
  const pasteImageTemplate = useConfigStore(
    (s) => s.agentList.find((a) => a.name === sessionAgent)?.pastedImageReferenceTemplate,
  );

  const { overlayLabel } = useTerminalOverlay(taskId, sessionId);
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[taskId] ?? null);

  // Terminal is "ready" once startup noise has been cleared. Until then,
  // an overlay hides the raw command line and suppressDataRef prevents
  // PTY output from accumulating in xterm behind the overlay.
  const [terminalReady, setTerminalReady] = useState(() => hasFirstOutput || hasUsage);

  const { terminalRef, initTerminal, fit, flushResize, focus, reloadScrollback, scrollbackPending, suppressDataRef } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    scrollbackLines: config.terminal.scrollbackLines,
    cursorStyle: config.terminal.cursorStyle,
    shellName: sessionShell,
    releaseEscapeWhenPointerOutside,
    pasteImageTemplate,
  });

  // Sync suppressDataRef with overlay state: suppress all PTY data while overlay is showing.
  suppressDataRef.current = !terminalReady;

  // Relative wrapper that hosts the xterm div and its overlays.
  const containerRef = useRef<HTMLDivElement>(null);

  const initialized = useRef(false);

  // Init terminal once the container has real pixel dimensions.
  // The cleanup resets initialized so React StrictMode's
  // mount→unmount→remount cycle re-creates the terminal properly.
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

    // Try to init immediately if container already has dimensions
    const tryInit = () => {
      if (initialized.current) return;
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        initTerminal();
        initialized.current = true;
      }
    };

    tryInit();

    // If container didn't have dimensions yet, watch for them
    let observer: ResizeObserver | null = null;
    if (!initialized.current) {
      observer = new ResizeObserver(() => {
        tryInit();
        if (initialized.current) {
          observer?.disconnect();
        }
      });
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      initialized.current = false;
      // On HMR, don't reset terminalReady - the store still has firstOutput/usage
      // data, so the shimmer overlay is unnecessary. Resetting it causes a visible
      // single-frame flash before the overlay-lifting effect restores it.
      if (!getIsHmrReload()) {
        setTerminalReady(false);
      }
    };
  }, [initTerminal, terminalRef]);

  // Lift overlay when Claude Code's TUI activates the alternate screen buffer
  // (first-output) or when usage data arrives (fallback). No clear() needed:
  // the fresh xterm has no stale content, and suppressDataRef blocked all
  // noise while the overlay was showing.
  useEffect(() => {
    if ((hasFirstOutput || hasUsage) && !terminalReady) {
      setTerminalReady(true);
      if (taskId && pendingCommandLabel) {
        useSessionStore.getState().clearPendingCommandLabel(taskId);
      }
    }
  }, [hasFirstOutput, hasUsage, terminalReady, taskId, pendingCommandLabel]);

  // When the overlay lifts (terminalReady transitions false -> true), reload
  // scrollback from the PTY buffer. While the overlay was showing, all PTY
  // output (including the TUI's initial full-screen draw) was suppressed.
  // The PTY buffer still contains that output, so re-fetching it populates
  // the terminal with the current TUI state.
  const wasReadyRef = useRef(terminalReady);
  useEffect(() => {
    const wasReady = wasReadyRef.current;
    wasReadyRef.current = terminalReady;
    if (terminalReady && !wasReady && initialized.current) {
      reloadScrollback();
    }
  }, [terminalReady, reloadScrollback]);

  // If session exits (Ctrl+C, crash, etc.) before usage arrives, clear the overlay
  // so the terminal isn't stuck behind the shimmer indefinitely.
  useEffect(() => {
    if (!terminalReady && sessionStatus === 'exited') {
      setTerminalReady(true);
      if (taskId && pendingCommandLabel) {
        useSessionStore.getState().clearPendingCommandLabel(taskId);
      }
    }
  }, [sessionStatus, terminalReady, taskId, pendingCommandLabel]);

  // Re-fit and focus when tab becomes active or container resizes.
  // Always set up the ResizeObserver when active -- even if the terminal
  // hasn't initialized yet. Tabs that start with display:none initialize
  // late (via the init effect's ResizeObserver), so we guard fit() calls
  // with initialized checks inside the callbacks instead of bailing early.
  useEffect(() => {
    if (!active) return;

    // Fit after a frame to ensure layout is settled.
    // Skip fit if scrollback is still loading -- initTerminal handles the
    // fit-after-scrollback sequence to ensure proper xterm reflow.
    const initRafId = requestAnimationFrame(() => {
      if (initialized.current && !scrollbackPending.current) {
        fit();
      }
      if (initialized.current) {
        focus();
      }
    });

    // Secondary delayed fit: for tabs that initialize late (display:none
    // at mount), initTerminal may fit at slightly wrong dimensions during
    // the container's layout transition. This ensures correct sizing.
    const delayedFitId = setTimeout(() => {
      if (initialized.current && !scrollbackPending.current) {
        fit();
      }
    }, FIT_DELAY_MS);

    const el = terminalRef.current;
    if (!el) return () => {
      cancelAnimationFrame(initRafId);
      clearTimeout(delayedFitId);
    };

    // Unified debounced resize mechanism. One timer, two entry points:
    // - ResizeObserver debounces at 200ms (handles drag without scrollback
    //   eviction: timer resets every frame during drag, fires once after).
    // - terminal-panel-resize event uses 50ms (faster for explicit triggers
    //   like sidebar resize, dialog edit-mode toggle, drag mouseUp).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefit = (delayMs: number) => {
      if (!initialized.current) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        fit();
      }, delayMs);
    };

    const observer = new ResizeObserver(() => {
      // Window-manager terminals defer container-driven fits: the window manager
      // owns sizing and dispatches a single settle-debounced terminal-panel-resize,
      // so rapid snap/maximize/restore resizes the PTY once (one clean SIGWINCH).
      //
      // While a window-manager imperative resize gesture is in progress (seam drag,
      // footprint resize, 8-handle window resize) this observer fires per frame as
      // the frame's DOM box is rewritten. Refitting per frame would send a SIGWINCH
      // per frame, and a full-screen TUI re-emits its whole banner on each - stacking
      // duplicates in scrollback. Suppress the per-frame refit during the gesture; the
      // store commit on release dispatches a single terminal-panel-resize that refits
      // once. The gate is OFF for container-only changes (Changes/Browser pane toggle),
      // so those still refit normally.
      if (!deferContainerResize && !isManagerResizeInProgress()) scheduleRefit(200);
    });
    observer.observe(el);

    // A full-screen TUI re-emits its frame on each SIGWINCH; while the width is
    // changing those redraws stack as duplicated banners in xterm's history.
    // Once resizing fully settles, replay the buffer ONCE at the now-stable
    // width (skipResize: no new SIGWINCH, so it cannot re-pollute). This is the
    // same clean-up an HMR reload performs. Window terminals only.
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    const handlePanelResize = () => {
      // Window-hosted terminals fit SYNCHRONOUSLY. The window engine dispatches
      // this from a layout effect via a microtask (before the browser paints), so
      // fitting here fills the committed size in the SAME frame as the resized
      // window - no letterbox lag. Clear any pending debounced fit so it cannot
      // run a redundant second fit afterward.
      if (immediatePanelResize) {
        if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
        // Fit synchronously, then flush the PTY resize immediately (don't wait out
        // the 200ms debounce) so Claude's redraw lands with the reflow instead of
        // a beat later - minimizes the resize "flash". The manager-resize gate
        // already guarantees one resize per gesture, so there's nothing to coalesce.
        if (initialized.current) { fit(); flushResize(); }
        return;
      }
      // Window terminals (deferContainerResize) fit on the next tick; other
      // surfaces keep the 50ms debounce to batch their own events.
      scheduleRefit(deferContainerResize ? 0 : 50);
      if (deferContainerResize) {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimer = setTimeout(() => {
          cleanupTimer = null;
          if (initialized.current) reloadScrollback({ skipResize: true });
        }, 800);
      }
    };
    window.addEventListener('terminal-panel-resize', handlePanelResize);

    return () => {
      cancelAnimationFrame(initRafId);
      clearTimeout(delayedFitId);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      observer.disconnect();
      window.removeEventListener('terminal-panel-resize', handlePanelResize);
    };
  }, [active, fit, flushResize, focus, deferContainerResize, immediatePanelResize, reloadScrollback, terminalRef, scrollbackPending]);

  const fileDrop = useTerminalFileDrop(sessionId, focus, sessionShell, pasteImageTemplate);

  return (
    <div ref={containerRef} className="h-full w-full bg-surface relative">
      <div ref={terminalRef} className="h-full w-full" />
      <FileDropOverlay {...fileDrop} />
      {/* Placeholder overlay while Claude CLI is loading (before first usage report).
          Stays visible until scrollback replay + clear are both done.
          z-10 ensures it paints above xterm's WebGL canvas layers. */}
      {!terminalReady && <LaunchOverlay label={overlayLabel} />}
    </div>
  );
}
