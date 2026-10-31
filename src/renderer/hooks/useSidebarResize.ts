import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import type { AppConfig } from '../../shared/types';
import { startPanelDrag } from './panel-drag';
import { SWITCH_SNAP_WINDOW_MS } from './useTerminalResize';
import { resolveFoldingEdgeDrag } from '../utils/folding-edge-drag';

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
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
  /** A view's fold or unfold just happened: the width and fade transitions are off, so it lands in one frame. */
  suppressTransition: boolean;
  toggle: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
}

/**
 * `viewCollapse`: a view that wants the room (Workflows, for its canvas and its
 * agent's terminal) folds the sidebar to its strip on the way in, and the user's
 * own choice comes back on the way out. It never writes the persisted
 * preference. The user can still open the sidebar there: the toggle, or a drag
 * on the divider, lifts the fold for the rest of that visit. Both edges of the
 * view's fold snap, since the view switch is not the user moving the sidebar;
 * the toggle and the drag keep their slide.
 */
export function useSidebarResize(config: Pick<AppConfig, 'sidebarVisible' | 'sidebar'>, viewCollapse = false): SidebarResizeState {
  const [preferredOpen, setOpen] = useState(config.sidebarVisible !== false);
  const [width, setWidth] = useState(config.sidebar?.width ?? DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [ready, setReady] = useState(false);

  // Folded for the view: set on the way into a collapsing view, cleared on the
  // way out or when the user opens the sidebar there. A render-time adjustment
  // on the transition, so the first frame of the view is already folded. It
  // raises the snap in the same render, so the commit that folds already lacks
  // the transition classes: dropping them a commit later would not stop a
  // transition that commit started (`useTerminalResize`'s project-switch snap).
  const [viewFolded, setViewFolded] = useState(viewCollapse);
  const [syncedViewCollapse, setSyncedViewCollapse] = useState(viewCollapse);
  const [suppressTransition, setSuppressTransition] = useState(false);
  if (viewCollapse !== syncedViewCollapse) {
    setSyncedViewCollapse(viewCollapse);
    setViewFolded(viewCollapse);
    setSuppressTransition(true);
  }
  const open = preferredOpen && !viewFolded;

  // Lift the snap after its settle window, so a toggle or a drag in the view
  // slides again. Keyed on the view as well, so a switch back inside the window
  // restarts it, and a re-run (Fast Refresh, the StrictMode double mount)
  // re-arms the timer rather than leaving the sidebar without its slide.
  useEffect(() => {
    if (!suppressTransition) return;
    const timer = setTimeout(() => setSuppressTransition(false), SWITCH_SNAP_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [suppressTransition, viewCollapse]);

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

  // Adopt the saved width when IT changes. A render-time adjustment (React's
  // "adjusting state when a prop changes" pattern) rather than an effect, so the
  // sidebar never paints the old width for a frame. The initial state already
  // comes from the mount-time config.
  //
  // Keyed on the value, never on the config object, for the same reason as
  // `useTerminalResize`: the drag persists its width straight to main, so the
  // config store keeps the width it loaded, and an unrelated config write (opening
  // a task's detail saves the window layout) rebuilt the object around that stale
  // width and slid the sidebar back to it.
  const savedWidth = config.sidebar?.width;
  const [syncedSavedWidth, setSyncedSavedWidth] = useState(savedWidth);
  if (savedWidth !== syncedSavedWidth) {
    setSyncedSavedWidth(savedWidth);
    if (typeof savedWidth === 'number' && savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) setWidth(savedWidth);
  }
  // The ref half of that sync, which render cannot do. Keyed on the saved width
  // and NOT mirrored from `width`: a drag keeps the ref itself, so the toggle
  // restores the last width the drag left open.
  useLayoutEffect(() => {
    if (typeof savedWidth === 'number' && savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) latestWidthRef.current = savedWidth;
  }, [savedWidth]);

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
    // Whether the drag shows the strip now. A fold lands while the drag runs,
    // so the release keeps what the screen shows.
    let folded = wasClosed;

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

        // The Command Terminal rail's rule too (`resolveFoldingEdgeDrag`): held at
        // the minimum down to half of it, folded past that, open again on the way back.
        const step = resolveFoldingEdgeDrag({
          raw: startWidth + (moveEvent.clientX - startX),
          minWidth: MIN_WIDTH,
          maxWidth: MAX_WIDTH,
        });

        if (step.collapsed) {
          if (!folded) {
            folded = true;
            setOpen(false);
          }
        } else {
          setWidth(step.width);
          latestWidthRef.current = step.width;
          if (folded || !openRef.current) {
            folded = false;
            setViewFolded(false);
            setOpen(true);
          }
        }
      },

      onRelease: () => {
        if (!isDragging) {
          // A click (or a sub-threshold "dead drag") on the divider is intentionally
          // inert. Collapsing happens only via the PROJECTS-panel chevron or by dragging
          // the divider past half the minimum width, never an accidental click here.
          return;
        }

        // End resize state first so CSS transition re-enables
        setIsResizing(false);

        if (folded) {
          // Already the strip on screen: the drag folded it.
          collapsedByDragRef.current = true;
          setViewFolded(false);
          setOpen(false);
          window.electronAPI.config.set({ sidebarVisible: false });
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

  return { open, width, isResizing, ready, suppressTransition, toggle, onResizeStart };
}
