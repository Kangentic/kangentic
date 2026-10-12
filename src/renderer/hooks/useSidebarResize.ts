import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
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

/**
 * `viewCollapse`: a view that wants the room (Workflows, for its canvas and its
 * agent's terminal) folds the sidebar to its strip on the way in, and the user's
 * own choice comes back on the way out. It never writes the persisted
 * preference. The user can still open the sidebar there: the toggle, or a drag
 * on the divider, lifts the fold for the rest of that visit.
 */
export function useSidebarResize(config: AppConfig, viewCollapse = false): SidebarResizeState {
  const [preferredOpen, setOpen] = useState(config.sidebarVisible !== false);
  const [width, setWidth] = useState(config.sidebar?.width ?? DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [ready, setReady] = useState(false);

  // Folded for the view: set on the way into a collapsing view, cleared on the
  // way out or when the user opens the sidebar there. A render-time adjustment
  // on the transition, so the first frame of the view is already folded.
  const [viewFolded, setViewFolded] = useState(viewCollapse);
  const [syncedViewCollapse, setSyncedViewCollapse] = useState(viewCollapse);
  if (viewCollapse !== syncedViewCollapse) {
    setSyncedViewCollapse(viewCollapse);
    setViewFolded(viewCollapse);
  }
  const open = preferredOpen && !viewFolded;

  const latestWidthRef = useRef(width);
  const openRef = useRef(open);
  const preferredOpenRef = useRef(preferredOpen);
  const viewFoldedRef = useRef(viewFolded);
  // Written on commit (a layout effect, ahead of the handlers that read it),
  // never during render, which the compiler rules forbid.
  useLayoutEffect(() => {
    openRef.current = open;
    preferredOpenRef.current = preferredOpen;
    viewFoldedRef.current = viewFolded;
  });

  const collapsedByDragRef = useRef(false);

  // Sync from config when it changes. A render-time adjustment on the config
  // transition (React's "adjusting state when a prop changes" pattern) rather
  // than an effect, so the sidebar never paints the old width for a frame. The
  // initial state already comes from the mount-time config.
  const [syncedConfig, setSyncedConfig] = useState(config);
  if (config !== syncedConfig) {
    setSyncedConfig(config);
    const saved = config.sidebar?.width;
    if (typeof saved === 'number' && saved >= MIN_WIDTH && saved <= MAX_WIDTH) setWidth(saved);
  }
  // The ref half of that sync, which render cannot do. Keyed on the config and
  // NOT mirrored from `width`: a collapsing drag sets the width to MIN_WIDTH
  // and then 0 on purpose while the ref keeps the last real width for the
  // toggle to restore.
  useLayoutEffect(() => {
    const saved = config.sidebar?.width;
    if (typeof saved === 'number' && saved >= MIN_WIDTH && saved <= MAX_WIDTH) latestWidthRef.current = saved;
  }, [config]);

  // Enable transitions after the first frame, and again after a config change
  // (matching the previous mount-and-config effect), to avoid animating the
  // synced width.
  useEffect(() => {
    requestAnimationFrame(() => setReady(true));
  }, [config]);

  const toggle = useCallback(() => {
    // Folded for the view over an open preference: opening it lifts the fold
    // and leaves the saved preference as it was.
    if (viewFoldedRef.current) {
      setViewFolded(false);
      if (openRef.current === false && preferredOpenRef.current) return;
    }
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
          if (!openRef.current) {
            setViewFolded(false);
            setOpen(true);
          }
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
          setViewFolded(false);
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
