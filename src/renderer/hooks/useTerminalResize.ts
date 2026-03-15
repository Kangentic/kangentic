import { useState, useCallback, useRef, useEffect } from 'react';
import type { AppConfig } from '../../shared/types';

const MIN_HEIGHT = 100;
export const COLLAPSED_HEIGHT = 36;

export interface TerminalResizeState {
  height: number;
  collapsed: boolean;
  isResizing: boolean;
  showContent: boolean;
  ready: boolean;
  contentColRef: React.RefObject<HTMLDivElement | null>;
  onToggleCollapse: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
  handleTransitionEnd: () => void;
}

export function useTerminalResize(config: AppConfig): TerminalResizeState {
  const [height, setHeight] = useState(config.terminal.panelHeight);
  const [collapsed, setCollapsed] = useState(config.terminal.panelCollapsed ?? false);
  const [isResizing, setIsResizing] = useState(false);
  const [showContent, setShowContent] = useState(!(config.terminal.panelCollapsed ?? false));
  const [ready, setReady] = useState(false);

  const latestHeightRef = useRef(height);
  const terminalConfigRef = useRef(config.terminal);
  terminalConfigRef.current = config.terminal;
  const availableHeightRef = useRef(0);
  const contentColRef = useRef<HTMLDivElement>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync from config on load
  useEffect(() => {
    const saved = config.terminal?.panelHeight;
    if (typeof saved === 'number' && saved >= MIN_HEIGHT) {
      setHeight(saved);
      latestHeightRef.current = saved;
    }
  }, [config]);

  // Enable transitions after first frame to prevent animation on mount
  useEffect(() => {
    requestAnimationFrame(() => setReady(true));
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    };
  }, []);

  const getMaxHeight = useCallback(() => {
    return Math.floor(availableHeightRef.current / 2) - 4;
  }, []);

  const clampHeight = useCallback((h: number) => {
    if (availableHeightRef.current === 0) {
      return Math.max(MIN_HEIGHT, h);
    }
    const max = getMaxHeight();
    if (max <= MIN_HEIGHT) return MIN_HEIGHT;
    return Math.max(MIN_HEIGHT, Math.min(max, h));
  }, [getMaxHeight]);

  // Track content column height via ResizeObserver and clamp when window shrinks
  useEffect(() => {
    const el = contentColRef.current;
    if (!el) return;

    availableHeightRef.current = el.getBoundingClientRect().height;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        availableHeightRef.current = entry.contentRect.height;
      }
      const clamped = clampHeight(latestHeightRef.current);
      if (clamped !== latestHeightRef.current) {
        latestHeightRef.current = clamped;
        setHeight(clamped);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [clampHeight]);

  const onToggleCollapse = useCallback(() => {
    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }
    setCollapsed((prev) => {
      const newCollapsed = !prev;

      if (prev) {
        // Expanding: DON'T show content yet. Wait for transitionend so
        // TerminalTab initializes at the final container height.
        // handleTransitionEnd will set showContent(true).
      } else {
        // Collapsing: delay hiding content until animation completes
        contentTimerRef.current = setTimeout(() => {
          setShowContent(false);
          contentTimerRef.current = null;
        }, 200);
      }

      // Persist collapsed state
      window.electronAPI.config.set({
        terminal: { ...terminalConfigRef.current, panelCollapsed: newCollapsed },
      });

      return newCollapsed;
    });
  }, []);

  const handleTransitionEnd = useCallback(() => {
    // When expanding, mount content NOW (container has final height).
    if (!collapsed) {
      setShowContent(true);
    }
    // Always dispatch resize for forceFit.
    window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
  }, [collapsed]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = height;

    window.dispatchEvent(new CustomEvent('terminal-panel-drag-start'));

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const newHeight = clampHeight(startHeight + delta);
      setHeight(newHeight);
      latestHeightRef.current = newHeight;
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Do NOT setIsResizing(false) yet. Keeps transition class OFF so no
      // CSS animation can corrupt fitAddon.fit() measurements.
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.electronAPI.config.set({
        terminal: { ...config.terminal, panelHeight: latestHeightRef.current },
      });
      window.dispatchEvent(new CustomEvent('terminal-panel-drag-end'));
      // Dispatch synchronously. handlePanelResize schedules double-rAF then forceFit.
      window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      // Re-enable transitions AFTER forceFit measures stable dimensions.
      // forceFit runs at double-rAF (frame N+2). Wait until frame N+3.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setIsResizing(false);
          });
        });
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height, config.terminal, clampHeight]);

  return { height, collapsed, isResizing, showContent, ready, contentColRef, onToggleCollapse, onResizeStart, handleTransitionEnd };
}
