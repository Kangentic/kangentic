import { useState, useCallback, useRef, useEffect } from 'react';
import type { AppConfig } from '../../shared/types';
import { startPanelDrag } from './panel-drag';

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const COLLAPSE_THRESHOLD = 200;
const DEFAULT_WIDTH = MAX_WIDTH;
export const COLLAPSED_STRIP_WIDTH = 36; // matches w-9 Tailwind class
// Movement below this many px is treated as a click (a no-op); at/past it a resize drag
// begins. Matches the dnd-kit activationConstraint distance used across the app's sortables.
const DRAG_ACTIVATION_DISTANCE = 5;

export interface SidebarResizeState {
  open: boolean;
  width: number;
  isResizing: boolean;
  ready: boolean;
  toggle: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
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

  const onResizeStart = useCallback((event: React.MouseEvent) => {
    const startX = event.clientX;
    const wasClosed = !openRef.current;
    const startWidth = wasClosed ? 0 : latestWidthRef.current;
    let isDragging = false;
    let didCollapse = false;

    startPanelDrag(event, {
      // Cursor is set lazily below, only once the drag clears the activation
      // distance, so a pure click never changes the cursor.
      onMove: (moveEvent) => {
        const delta = Math.abs(moveEvent.clientX - startX);

        // Don't start dragging until past the activation distance
        if (!isDragging) {
          if (delta < DRAG_ACTIVATION_DISTANCE) return;
          isDragging = true;
          setIsResizing(true);
          document.body.style.cursor = 'col-resize';
        }

        const rawWidth = startWidth + (moveEvent.clientX - startX);

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
      },

      onRelease: () => {
        if (!isDragging) {
          // A click (or a sub-threshold "dead drag") on the divider is intentionally
          // inert. Collapsing happens only via the PROJECTS-panel chevron or by dragging
          // the divider closed past COLLAPSE_THRESHOLD, never an accidental click here.
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
      },
    });
  }, []);

  return { open, width, isResizing, ready, toggle, onResizeStart };
}
