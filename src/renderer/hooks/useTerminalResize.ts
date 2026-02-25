import { useState, useCallback, useRef, useEffect } from 'react';
import type { AppConfig } from '../../shared/types';

const MIN_HEIGHT = 100;

export interface TerminalResizeState {
  height: number;
  collapsed: boolean;
  isResizing: boolean;
  contentColRef: React.RefObject<HTMLDivElement | null>;
  onToggleCollapse: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function useTerminalResize(config: AppConfig): TerminalResizeState {
  const [height, setHeight] = useState(config.terminal.panelHeight);
  const [collapsed, setCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const latestHeightRef = useRef(height);
  const availableHeightRef = useRef(0);
  const contentColRef = useRef<HTMLDivElement>(null);

  // Sync from config on load
  useEffect(() => {
    const saved = config.terminal?.panelHeight;
    if (typeof saved === 'number' && saved >= MIN_HEIGHT) {
      setHeight(saved);
      latestHeightRef.current = saved;
    }
  }, [config]);

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
    setCollapsed((prev) => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      });
      return !prev;
    });
  }, []);

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
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.electronAPI.config.set({
        terminal: { ...config.terminal, panelHeight: latestHeightRef.current },
      });
      window.dispatchEvent(new CustomEvent('terminal-panel-drag-end'));
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height, config.terminal, clampHeight]);

  return { height, collapsed, isResizing, contentColRef, onToggleCollapse, onResizeStart };
}
