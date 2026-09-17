import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolveTerminalBackground, useTerminal } from '../../hooks/useTerminal';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from './FileDropOverlay';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { LaunchOverlay } from '../LaunchOverlay';
import { useTerminalOverlay } from '../../utils/task-progress';
import { useTerminalRefit } from '../../hooks/useTerminalRefit';
import { useDeferredTerminalInit } from '../../hooks/useDeferredTerminalInit';
import { mayTakeArrivalFocus, type ArrivalFocusSite } from '../../utils/terminal-arrival-focus';

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
  //
  // Lifted when Claude Code's TUI activates the alternate screen buffer
  // (first-output), when usage data arrives (fallback), or when the session
  // exits before either (Ctrl+C, a crash), so the terminal is never stuck
  // behind the shimmer. Derived from the store rather than held as state an
  // effect set: every host keys this component by session id, and each of the
  // three signals is monotonic for a session, so it can never flip back. That
  // is also what retires the StrictMode-remount reset the state needed - the
  // derived value is right on every mount, synthetic or real, with nothing to
  // re-seed and no frame at the wrong value.
  const terminalReady = hasFirstOutput || hasUsage || sessionStatus === 'exited';

  // For an already-running session, terminalReady starts true so the
  // LaunchOverlay never shows - which used to leave the whole mount-time
  // fit -> replay -> refit -> held-byte-flush sequence painting live (the
  // occasional open-flash). The replay veil below covers the terminal from
  // mount until the first scrollback settle so only the settled frame is
  // ever shown. Never reset once lifted: later reloads (resize cleanup,
  // parked reveal) repaint in place and must not re-veil.
  const [replaySettled, setReplaySettled] = useState(false);
  const handleScrollbackSettled = useCallback(() => setReplaySettled(true), []);

  // Arrival-focus policy for every programmatic focus this tab can produce. A
  // TerminalTab mounts in the bottom panel AND in a task-detail window, and both
  // pass `active` hardcoded true, so `active` carries no information about which
  // surface the user is actually on - the arbiter answers that from user-intent
  // state instead. See terminal-arrival-focus.ts.
  const mayFocusOnArrival = useCallback(
    (site: ArrivalFocusSite) => mayTakeArrivalFocus(sessionId, site),
    [sessionId],
  );

  const { terminalRef, initTerminal, fit, flushResize, focus, reloadScrollback, scrollbackPending, suppressDataRef } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    cursorStyle: config.terminal.cursorStyle,
    colors: config.terminal.colors,
    shellName: sessionShell,
    releaseEscapeWhenPointerOutside,
    pasteImageTemplate,
    backspaceSendsCtrlH: config.terminal.backspaceSendsCtrlH,
    onScrollbackSettled: handleScrollbackSettled,
    mayTakeArrivalFocus: mayFocusOnArrival,
  });

  // Sync suppressDataRef with overlay state: suppress all PTY data while the
  // overlay is showing. Written on commit (a layout effect), never during
  // render, which the compiler rules forbid; the PTY data handler that reads
  // it is attached by initTerminal on a later frame, so it never runs ahead.
  useLayoutEffect(() => {
    suppressDataRef.current = !terminalReady;
  });

  // Relative wrapper that hosts the xterm div and its overlays.
  const containerRef = useRef<HTMLDivElement>(null);

  // Init deferred to a frame where no other terminal is being constructed,
  // shared with CommandTerminalPane via useDeferredTerminalInit (see the hook
  // for the pointer-stall, StrictMode one-terminal, and display:none
  // rationales). The deferral is pixel-invisible here - the replay veil /
  // LaunchOverlay cover the pane from the first frame, and the container div
  // paints the terminal background either way.
  //
  // This is NOT the reverted drag-end deferral. A pane mounting on its own
  // still inits on the very next frame, ahead of the active effect's
  // FIT_DELAY_MS corrective fit. A pane mounting in a BURST does not: the
  // shared queue in terminal-init-queue.ts runs one construction per frame,
  // so the Nth pane inits N turns later and the 100ms corrective fit can fire
  // first and no-op. That is safe rather than merely tolerated, because
  // initTerminal's own fit is a pure function of the container's live geometry
  // at the moment it runs (see useTerminal.ts), so a late init still fits
  // correctly without needing this effect's window.
  const { initializedRef: initialized } = useDeferredTerminalInit({
    terminalRef,
    initTerminal,
  });

  // When the overlay lifts (terminalReady transitions false -> true), reload
  // scrollback from the PTY buffer. While the overlay was showing, all PTY
  // output (including the TUI's initial full-screen draw) was suppressed.
  // The PTY buffer still contains that output, so re-fetching it populates
  // the terminal with the current TUI state. No clear() needed: the fresh
  // xterm has no stale content, and suppressDataRef blocked all noise while
  // the overlay was showing. The same transition retires the pending-command
  // label the launch overlay was showing.
  const wasReadyRef = useRef(terminalReady);
  useEffect(() => {
    const wasReady = wasReadyRef.current;
    wasReadyRef.current = terminalReady;
    if (!terminalReady || wasReady) return;
    if (initialized.current) reloadScrollback();
    if (taskId && pendingCommandLabel) {
      useSessionStore.getState().clearPendingCommandLabel(taskId);
    }
    // `initialized` is the stable ref returned by useDeferredTerminalInit -
    // listed for exhaustive-deps (which cannot see through the hook), never
    // a re-run trigger.
  }, [terminalReady, reloadScrollback, initialized, taskId, pendingCommandLabel]);

  // Re-fit and focus when the tab becomes active. Tabs that start with
  // display:none initialize late (via the init effect's ResizeObserver), so we
  // guard fit() calls with initialized checks inside the callbacks instead of
  // bailing early.
  useEffect(() => {
    if (!active) return;

    // Fit after a frame to ensure layout is settled.
    // Skip fit if scrollback is still loading -- initTerminal handles the
    // fit-after-scrollback sequence to ensure proper xterm reflow.
    const initRafId = requestAnimationFrame(() => {
      if (initialized.current && !scrollbackPending.current) {
        fit();
      }
      // Arbitrated, not unconditional. On a SOLO mount this frame runs with
      // `initialized` already true, so it focuses about one frame after mount -
      // well before any replay settles. Gating only the replay would therefore
      // leave the race intact, just decided earlier.
      if (initialized.current && mayFocusOnArrival('tab-init')) {
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

    return () => {
      cancelAnimationFrame(initRafId);
      clearTimeout(delayedFitId);
    };
    // `initialized` is the stable ref returned by useDeferredTerminalInit -
    // listed for exhaustive-deps (which cannot see through the hook), never
    // a re-run trigger.
  }, [active, fit, focus, mayFocusOnArrival, scrollbackPending, initialized]);

  // Container refit while active: persistent gate-aware ResizeObserver plus the
  // terminal-panel-resize handling, shared with CommandTerminalWindow via
  // useTerminalRefit so the two hosts cannot drift.
  const handleDeferredResizeSettled = useCallback(
    () => reloadScrollback({ skipResize: true }),
    [reloadScrollback],
  );
  useTerminalRefit({
    terminalRef,
    initializedRef: initialized,
    fit,
    flushResize,
    enabled: active,
    deferContainerResize,
    immediatePanelResize,
    onDeferredResizeSettled: handleDeferredResizeSettled,
  });

  const fileDrop = useTerminalFileDrop(sessionId, focus, sessionShell, pasteImageTemplate);
  const terminalBackground = resolveTerminalBackground(config.terminal.colors);

  return (
    <div ref={containerRef} data-testid="terminal-tab-container" className="h-full w-full relative" style={{ backgroundColor: terminalBackground }}>
      <div ref={terminalRef} className="h-full w-full" />
      <FileDropOverlay {...fileDrop} />
      {/* Replay veil: covers the mount-time replay window (first fit, chunked
          scrollback write, afterWrite refit, held-byte flush, DOM-to-WebGL
          promotion) so a warm session's terminal appears once, settled, with
          no intermediate frame. Same color as the terminal background (tracks
          the user's custom override, if any), so it reads as the empty
          terminal, not a flash of its own; no transition, per
          restore-no-animation-replay. Rendered BEFORE LaunchOverlay so the
          cold-start overlay (same z-10, later sibling) paints above it. */}
      {!replaySettled && (
        <div
          data-testid="terminal-replay-veil"
          className="pointer-events-none absolute inset-0 z-10"
          style={{ backgroundColor: terminalBackground }}
        />
      )}
      {/* Placeholder overlay while Claude CLI is loading (before first usage report).
          Stays visible until scrollback replay + clear are both done.
          z-10 ensures it paints above xterm's WebGL canvas layers. */}
      {!terminalReady && <LaunchOverlay label={overlayLabel} variant="terminal" />}
    </div>
  );
}
