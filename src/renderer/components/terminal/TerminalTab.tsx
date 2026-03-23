import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { ShimmerOverlay } from '../ShimmerOverlay';

const FIT_DELAY_MS = 100;

/** Priority: pending command (explicit transition/invoke) > resuming > auto_command > default. */
function deriveOverlayLabel(
  pendingCommandLabel: string | null,
  isResuming: boolean,
  autoCommand: string | null,
): string {
  if (pendingCommandLabel) return pendingCommandLabel;
  if (isResuming) return 'Resuming agent...';
  if (autoCommand) return autoCommand;
  return 'Starting agent...';
}

interface TerminalTabProps {
  sessionId: string;
  taskId: string;
  active: boolean;
}

export function TerminalTab({ sessionId, taskId, active }: TerminalTabProps) {
  const config = useConfigStore((s) => s.config);
  const hasFirstOutput = useSessionStore((s) => !!s.sessionFirstOutput[sessionId]);
  const hasUsage = useSessionStore((s) => !!s.sessionUsage[sessionId]);

  const isResuming = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.resuming ?? false,
      [sessionId],
    ),
  );
  const sessionStatus = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.status ?? null,
      [sessionId],
    ),
  );

  // Derive overlay label: pending command (set by moveTask or manual invoke) > resume state > swimlane auto_command > generic fallback.
  // pendingCommandLabel is keyed by taskId (a prop), so it resolves on the very first render
  // without waiting for syncSessions IPC. This prevents flicker during command invocations.
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[taskId] ?? null);
  const autoCommand = useBoardStore(
    useCallback(
      (s: ReturnType<typeof useBoardStore.getState>) => {
        const task = s.tasks.find((t) => t.session_id === sessionId);
        if (!task) return null;
        const swimlane = s.swimlanes.find((l) => l.id === task.swimlane_id);
        return swimlane?.auto_command ?? null;
      },
      [sessionId],
    ),
  );
  const overlayLabel = deriveOverlayLabel(pendingCommandLabel, isResuming, autoCommand);

  // Terminal is "ready" once startup noise has been cleared. Until then,
  // an overlay hides the raw command line and suppressDataRef prevents
  // PTY output from accumulating in xterm behind the overlay.
  const [terminalReady, setTerminalReady] = useState(() => hasFirstOutput || hasUsage);

  const { terminalRef, initTerminal, fit, focus, reloadScrollback, scrollbackPending, suppressDataRef } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    scrollbackLines: config.terminal.scrollbackLines,
    cursorStyle: config.terminal.cursorStyle,
  });

  // Sync suppressDataRef with overlay state: suppress all PTY data while overlay is showing.
  suppressDataRef.current = !terminalReady;

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
      setTerminalReady(false);
    };
  }, [initTerminal]);

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

    const observer = new ResizeObserver(() => scheduleRefit(200));
    observer.observe(el);

    const handlePanelResize = () => scheduleRefit(50);
    window.addEventListener('terminal-panel-resize', handlePanelResize);

    return () => {
      cancelAnimationFrame(initRafId);
      clearTimeout(delayedFitId);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener('terminal-panel-resize', handlePanelResize);
    };
  }, [active, fit, focus]);

  return (
    <div className="h-full w-full bg-surface relative">
      <div ref={terminalRef} className="h-full w-full" />
      {/* Placeholder overlay while Claude CLI is loading (before first usage report).
          Stays visible until scrollback replay + clear are both done.
          z-10 ensures it paints above xterm's WebGL canvas layers. */}
      {!terminalReady && <ShimmerOverlay label={overlayLabel} />}
    </div>
  );
}
