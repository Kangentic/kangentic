import { useState, useCallback, useRef, useEffect } from 'react';
import type { AppConfig } from '../../shared/types';

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const COLLAPSE_THRESHOLD = 200;
const DEFAULT_WIDTH = MAX_WIDTH;
export const COLLAPSED_STRIP_WIDTH = 36; // matches w-9 Tailwind class
const DRAG_DEAD_ZONE = 1; // any movement at all starts a drag; 0 movement = click toggle

export interface SidebarResizeState {
  open: boolean;
  width: number;
  isResizing: boolean;
  ready: boolean;
  toggle: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function useSidebarResize(config: AppConfig): SidebarResizeState {
  const [open, setOpen] = useState(config.sidebarVisible !== false);
  const [width, setWidth] = useState(config.sidebar?.width ?? DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [ready, setReady] = useState(false);

  const latestWidthRef = useRef(width);
  const openRef = useRef(open);
  openRef.current = open;

  const collapsedByDragRef = useRef(false);
  const toggleRef = useRef<() => void>(() => {});

  // Sync from config on load
  useEffect(() => {
    const saved = config.sidebar?.width;
    if (typeof saved === 'number' && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
      setWidth(saved);
      latestWidthRef.current = saved;
    }
    requestAnimationFrame(() => setReady(true));
  }, [config]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) {
        const w = collapsedByDragRef.current ? MAX_WIDTH : latestWidthRef.current;
        const restored = w >= MIN_WIDTH ? w : MAX_WIDTH;
        setWidth(restored);
        latestWidthRef.current = restored;
        collapsedByDragRef.current = false;
      }
      window.electronAPI.config.set({ sidebarVisible: !prev });
      return !prev;
    });
  }, []);
  toggleRef.current = toggle;

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.userSelect = 'none';

    const startX = e.clientX;
    const wasClosed = !openRef.current;
    const startWidth = wasClosed ? 0 : latestWidthRef.current;
    let isDragging = false;
    let didCollapse = false;

    const onMouseMove = (e: MouseEvent) => {
      const delta = Math.abs(e.clientX - startX);

      // Don't start dragging until past the dead zone
      if (!isDragging) {
        if (delta < DRAG_DEAD_ZONE) return;
        isDragging = true;
        setIsResizing(true);
        document.body.style.cursor = 'col-resize';
      }

      const rawWidth = startWidth + (e.clientX - startX);

      if (rawWidth < COLLAPSE_THRESHOLD) {
        // Hold at min width during drag; collapse animates on mouseUp
        setWidth(MIN_WIDTH);
        didCollapse = true;
      } else {
        const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, rawWidth));
        setWidth(newWidth);
        latestWidthRef.current = newWidth;
        didCollapse = false;
        if (!openRef.current) setOpen(true);
      }
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!isDragging) {
        // Pure click -- toggle sidebar
        toggleRef.current();
        return;
      }

      // End resize state first so CSS transition re-enables
      setIsResizing(false);

      if (didCollapse) {
        collapsedByDragRef.current = true;
        window.electronAPI.config.set({ sidebarVisible: false });
        // Animate closed: transition is now active, so setting width to 0
        // triggers the CSS transition from MIN_WIDTH → 0
        requestAnimationFrame(() => {
          setWidth(0);
          setOpen(false);
        });
      } else {
        setOpen(true);
        window.electronAPI.config.set({
          sidebar: { width: latestWidthRef.current },
          sidebarVisible: true,
        });
      }
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return { open, width, isResizing, ready, toggle, onResizeStart };
}
