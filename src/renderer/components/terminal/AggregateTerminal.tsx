import React, { useEffect, useRef } from 'react';
import { useAggregateTerminal } from '../../hooks/useAggregateTerminal';
import { useConfigStore } from '../../stores/config-store';

interface AggregateTerminalProps {
  active: boolean;
  sessionIds: string[];
  taskIdMap: Map<string, string>;
}

export function AggregateTerminal({ active, sessionIds, taskIdMap }: AggregateTerminalProps) {
  const config = useConfigStore((s) => s.config);
  const { terminalRef, initTerminal, fit, focus } = useAggregateTerminal({
    sessionIds,
    taskIdMap,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
  });
  const initialized = useRef(false);
  const draggingRef = useRef(false);

  // Init terminal once the container has real pixel dimensions
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

    const tryInit = () => {
      if (initialized.current) return;
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        initTerminal();
        initialized.current = true;
      }
    };

    tryInit();

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

  // Re-fit when tab becomes active or container resizes
  useEffect(() => {
    if (!active) return;

    const initRafId = requestAnimationFrame(() => {
      if (initialized.current) {
        fit();
        focus();
      }
    });

    const delayedFitId = setTimeout(() => {
      if (initialized.current) {
        fit();
      }
    }, 100);

    // Suppress fit() during panel drag to prevent scrollback eviction
    const handleDragStart = () => { draggingRef.current = true; };
    const handleDragEnd = () => { draggingRef.current = false; };
    window.addEventListener('terminal-panel-drag-start', handleDragStart);
    window.addEventListener('terminal-panel-drag-end', handleDragEnd);

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
    <div ref={terminalRef} className="h-full w-full" />
  );
}
