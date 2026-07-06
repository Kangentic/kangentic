/**
 * One modeless window. `pointer-events:auto` (the overlay around it is
 * `pointer-events:none`, so clicks in the gaps fall through to the live board).
 *
 * Reuses the BaseDialog content wrapper (copied inline) + `useOverlayPhase` for
 * the open/close animation, but drops BaseDialog's backdrop, global-Escape, and
 * focus-trap (a window is modeless). Pointer-down anywhere raises it; the title
 * bar drags it; geometry is fractional, projected to pixels against the overlay.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import type { ContainerSize, PixelRect } from '../store/geometry';
import { fractionalToPixels } from '../store/geometry';
import type { ManagedWindow } from '../store/types';
import { useLayerStore } from '../context';
import { useWindowDrag } from '../dnd/useWindowDrag';
import { useWindowResize } from '../dnd/useWindowResize';
import { scheduleWindowTerminalResize } from '../terminal/resize-coalescer';
import { WindowContent } from './WindowContent';
import { WindowResizeHandles } from './WindowResizeHandles';

interface WindowFrameProps {
  managedWindow: ManagedWindow;
  containerSize: ContainerSize;
  overlayRef: RefObject<HTMLDivElement | null>;
  /** Resolved pixel rect when this window is tiled (driven by the tile tree,
   *  not its own geometry). Null/undefined for floating/snapped/maximized. */
  tiledRect?: PixelRect | null;
}

const MAXIMIZED_GEOMETRY = { x: 0, y: 0, w: 1, h: 1 };

export function WindowFrame({ managedWindow, containerSize, overlayRef, tiledRect }: WindowFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const useStore = useLayerStore();
  const focusWindow = useStore((state) => state.focusWindow);
  const closeWindow = useStore((state) => state.closeWindow);
  const isFocused = useStore((state) => state.focusedWindowId === managedWindow.id);

  const { requestClose, contentClassName, onAnimationEnd, isExiting } = useOverlayPhase(
    () => closeWindow(managedWindow.id),
    { variant: 'dialog', skipEnterOnHmr: true, skipEnter: managedWindow.skipEnterAnimation ?? false },
  );

  // Fallback: if the exit animation's `animationend` never fires (animations
  // disabled, the frame re-rendered/re-focused mid-close, etc.), force the
  // removal so a window can never get stuck in the exiting state.
  useEffect(() => {
    if (!isExiting) return;
    const fallback = setTimeout(() => closeWindow(managedWindow.id), 300);
    return () => clearTimeout(fallback);
  }, [isExiting, closeWindow, managedWindow.id]);

  const { titleBarPointerDown, framePointerMove, framePointerUp, framePointerCancel } = useWindowDrag({
    windowId: managedWindow.id,
    frameRef,
    overlayRef,
  });

  const resize = useWindowResize({ windowId: managedWindow.id, frameRef, overlayRef });

  // The frame owns capture for BOTH the drag and the resize; each handler bails
  // when its own gesture is not active, so only one runs at a time.
  const handleFramePointerMove = (event: React.PointerEvent) => {
    framePointerMove(event);
    resize.handlePointerMove(event);
  };
  const handleFramePointerUp = (event: React.PointerEvent) => {
    framePointerUp(event);
    resize.handlePointerUp(event);
  };
  const handleFramePointerCancel = (event: React.PointerEvent) => {
    framePointerCancel(event);
    resize.handlePointerCancel(event);
  };

  const isMaximized = managedWindow.state === 'maximized';
  const isTiled = managedWindow.state === 'tiled';
  // A tiled window's rect comes from the tile tree (resolved by WindowLayer), not
  // its own geometry. Falls back to geometry if the resolved rect is missing.
  const pixelRect =
    isTiled && tiledRect
      ? tiledRect
      : fractionalToPixels(isMaximized ? MAXIMIZED_GEOMETRY : managedWindow.geometry, containerSize);

  // Whenever the rendered size changes (snap, maximize, restore, resize-commit,
  // overlay resize) OR the window's state transitions (floating <-> snapped <->
  // tiled), schedule ONE coalesced terminal resize at the settled size. A LAYOUT
  // effect (commit phase, before paint) so the coalescer's microtask dispatch +
  // the window terminal's synchronous refit land in the SAME frame as the
  // resized window, with no letterbox lag.
  //
  // Keying on `state` too is the safety net for a transition whose pixel
  // dimensions happen to match a prior fit but whose container actually changed
  // (e.g. dock/undock sequences) - without it a terminal could keep a stale row
  // count and leave blank space at the bottom.
  useLayoutEffect(() => {
    scheduleWindowTerminalResize();
  }, [pixelRect.width, pixelRect.height, managedWindow.state]);

  return (
    <div
      ref={frameRef}
      onPointerDownCapture={() => focusWindow(managedWindow.id)}
      onMouseDownCapture={(event) => {
        // Clicking the window's chrome (header, padding - anything that is not a
        // control and not the terminal itself) focuses the terminal, so the focus
        // cue + blinking cursor activate and you can type right away. preventDefault
        // stops the browser's default focus-reset to <body> (the header is not
        // focusable), so the terminal focus actually sticks. A conversation window
        // has no terminal to focus at all - its body is read-only, selectable
        // message text - so this preventDefault has no benefit there and only
        // side effect: it kills the browser's native text-selection drag before it
        // can start, since preventDefault on mousedown is exactly what suppresses
        // that. Excluded the same way .xterm is.
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"]')) return;
        if (target.closest('.xterm')) return;
        if (target.closest('[data-testid="conversation-view"]')) return;
        event.preventDefault();
        frameRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus();
      }}
      onPointerMove={handleFramePointerMove}
      onPointerUp={handleFramePointerUp}
      onPointerCancel={handleFramePointerCancel}
      onAnimationEnd={onAnimationEnd}
      style={{
        position: 'absolute',
        left: pixelRect.left,
        top: pixelRect.top,
        width: pixelRect.width,
        height: pixelRect.height,
        zIndex: managedWindow.zIndex,
      }}
      className={`pointer-events-auto group bg-surface-raised border border-edge focus-within:border-accent/40 ${
        isMaximized || isTiled ? 'rounded-none' : 'rounded-lg'
      } ${isTiled ? '' : 'shadow-2xl'} flex flex-col overflow-hidden ${contentClassName}`}
      data-testid={`window-frame-${managedWindow.id}`}
    >
      {/* Focus cue driven by REAL focus (:focus-within), not the sticky
          focusedWindowId: a faint 1px accent outline (border above) + a 2px dimmed
          accent line along the top that gently pulses, shown ONLY while this window
          actually holds keyboard focus (its terminal or a control) - so it drops the
          moment focus moves to a dialog or another window, matching the blinking
          cursor. Always rendered; CSS toggles visibility, so no layout shift. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden h-0.5 bg-accent/70 animate-pulse group-focus-within:block"
        aria-hidden
      />
      <WindowContent
        managedWindow={managedWindow}
        isFocused={isFocused}
        isMaximized={isMaximized}
        titleBarPointerDown={titleBarPointerDown}
        requestClose={requestClose}
      />
      {!isMaximized && !isTiled && (
        <WindowResizeHandles windowId={managedWindow.id} onHandlePointerDown={resize.handlePointerDown} />
      )}
    </div>
  );
}
