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

  // Re-fit and focus when tab becomes active or container resizes
  useEffect(() => {
    if (!active || !initialized.current) return;

    // Fit after a frame to ensure layout is settled.
    // Skip fit if scrollback is still loading — initTerminal handles the
    // fit-after-scrollback sequence to ensure proper xterm reflow.
    const initRafId = requestAnimationFrame(() => {
      if (!scrollbackPending.current) {
        fit();
      }
      focus();
    });

    // Debounced re-fit on container resize via rAF coalescing
    const el = terminalRef.current;
    if (!el) return () => cancelAnimationFrame(initRafId);

    let pendingRaf = 0;
    const observer = new ResizeObserver(() => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0;
        fit();
      });
    });
    observer.observe(el);

    // Refit after panel drag ends (the ResizeObserver may miss the final
    // layout when rAF debouncing races with React re-renders during drag).
    const handlePanelResize = () => {
      requestAnimationFrame(() => fit());
    };
    window.addEventListener('terminal-panel-resize', handlePanelResize);

    return () => {
      cancelAnimationFrame(initRafId);
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      observer.disconnect();
      window.removeEventListener('terminal-panel-resize', handlePanelResize);
    };
  }, [active, fit, focus]);

  return (
    <div ref={terminalRef} className="h-full w-full" />
  );
}
