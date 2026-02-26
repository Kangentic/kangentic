import React, { useEffect, useRef } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useConfigStore } from '../../stores/config-store';

interface TerminalTabProps {
  sessionId: string;
  active: boolean;
}

export function TerminalTab({ sessionId, active }: TerminalTabProps) {
  const config = useConfigStore((s) => s.config);
  const { terminalRef, initTerminal, fit, focus, scrollbackPending } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
  });
  const initialized = useRef(false);
  const draggingRef = useRef(false);

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
    };
  }, [initTerminal]);

  // Re-fit and focus when tab becomes active or container resizes.
  // Always set up the ResizeObserver when active — even if the terminal
  // hasn't initialized yet. Tabs that start with display:none initialize
  // late (via the init effect's ResizeObserver), so we guard fit() calls
  // with initialized checks inside the callbacks instead of bailing early.
  useEffect(() => {
    if (!active) return;

    // Fit after a frame to ensure layout is settled.
    // Skip fit if scrollback is still loading — initTerminal handles the
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
    }, 100);

    // Suppress fit() while the user drags the panel resize handle.
    // Calling fit() on every frame during a drag changes xterm's row count
    // repeatedly; each shrink pushes viewport lines into scrollback, and
    // if the 5000-line scrollback buffer is full the oldest lines are
    // permanently evicted.  Deferring to mouseup avoids this.
    const handleDragStart = () => { draggingRef.current = true; };
    const handleDragEnd = () => { draggingRef.current = false; };
    window.addEventListener('terminal-panel-drag-start', handleDragStart);
    window.addEventListener('terminal-panel-drag-end', handleDragEnd);

    // Debounced re-fit on container resize via rAF coalescing
    const el = terminalRef.current;
    if (!el) return () => {
      cancelAnimationFrame(initRafId);
      clearTimeout(delayedFitId);
      window.removeEventListener('terminal-panel-drag-start', handleDragStart);
      window.removeEventListener('terminal-panel-drag-end', handleDragEnd);
    };

    let pendingRaf = 0;
    const observer = new ResizeObserver(() => {
      if (!initialized.current || draggingRef.current) return;
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0;
        fit();
      });
    });
    observer.observe(el);

    // Refit after panel drag / resize events. Uses double-rAF so the fit
    // runs after React commits layout changes and the browser paints.
    let panelRaf = 0;
    const handlePanelResize = () => {
      if (!initialized.current) return;
      if (panelRaf) cancelAnimationFrame(panelRaf);
      panelRaf = requestAnimationFrame(() => {
        panelRaf = requestAnimationFrame(() => {
          panelRaf = 0;
          fit();
        });
      });
    };
    window.addEventListener('terminal-panel-resize', handlePanelResize);

    return () => {
      cancelAnimationFrame(initRafId);
      clearTimeout(delayedFitId);
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      if (panelRaf) cancelAnimationFrame(panelRaf);
      observer.disconnect();
      window.removeEventListener('terminal-panel-resize', handlePanelResize);
      window.removeEventListener('terminal-panel-drag-start', handleDragStart);
      window.removeEventListener('terminal-panel-drag-end', handleDragEnd);
    };
  }, [active, fit, focus]);

  return (
    <div ref={terminalRef} className="h-full w-full bg-[#18181b]" />
  );
}
