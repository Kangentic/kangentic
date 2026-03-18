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
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
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

    let previousHeight = availableHeightRef.current;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.contentRect.height;
        // Skip if only the width changed (e.g. sidebar open/close)
        if (newHeight === previousHeight) return;
        previousHeight = newHeight;
        availableHeightRef.current = newHeight;
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

      // Expanding: DON'T show content yet. Wait for transitionend so
      // TerminalTab initializes at the final container height.
      // handleTransitionEnd will set showContent(true).
      if (newCollapsed) {
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
    // TerminalTab's init effect handles fit at the correct size.
    if (!collapsedRef.current) {
      setShowContent(true);
    }
  }, []);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = height;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const newHeight = clampHeight(startHeight + delta);
      setHeight(newHeight);
      latestHeightRef.current = newHeight;
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.electronAPI.config.set({
        terminal: { ...config.terminal, panelHeight: latestHeightRef.current },
      });
      setIsResizing(false);
      // Explicit refit signal. The debounced ResizeObserver also handles this,
      // but the explicit event gives a faster 50ms response.
      window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height, config.terminal, clampHeight]);

  return { height, collapsed, isResizing, showContent, ready, contentColRef, onToggleCollapse, onResizeStart, handleTransitionEnd };
}
