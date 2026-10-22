import { useEffect, useRef } from 'react';
import { useToastStore } from '../../stores/toast-store';
import { useAnyOverlayOpen } from '../../utils/overlay-gate';
import { ToastItem } from './ToastItem';

/** The main window clears the 36px status bar (`h-9`) by 4px. */
const MAIN_WINDOW_BOTTOM_OFFSET_PX = 40;

/**
 * Hold a timed toast's countdown while the pointer is over it.
 *
 * Tracked from the window, not from the cards: most cards are click-through
 * (`pointer-events: none`), so they never see the pointer. One rAF-throttled
 * `pointermove` listener hit-tests every card's rect and holds the ones under
 * the pointer. The pointer leaving the window, or the window losing focus,
 * releases them all, so a countdown never stays held by a pointer that is gone.
 */
function useHoverHold(containerRef: React.RefObject<HTMLDivElement | null>, active: boolean, toastCount: number) {
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const hoveredRef = useRef<Set<string>>(new Set());
  const applyRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active) return;
    const apply = (): void => {
      const point = lastPointRef.current;
      const container = containerRef.current;
      const next = new Set<string>();
      if (point && container) {
        for (const card of container.querySelectorAll<HTMLElement>('[data-toast-id]')) {
          const box = card.getBoundingClientRect();
          if (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) {
            next.add(card.dataset.toastId ?? '');
          }
        }
      }
      const store = useToastStore.getState();
      const now = Date.now();
      for (const id of hoveredRef.current) if (!next.has(id)) store.releaseCountdown(id, now);
      for (const id of next) if (!hoveredRef.current.has(id)) store.holdCountdown(id, now);
      hoveredRef.current = next;
    };
    applyRef.current = apply;

    let frame: number | null = null;
    const handlePointerMove = (event: PointerEvent): void => {
      lastPointRef.current = { x: event.clientX, y: event.clientY };
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        apply();
      });
    };
    const handleLeave = (): void => {
      lastPointRef.current = null;
      apply();
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', handleLeave);
    document.documentElement.addEventListener('pointerleave', handleLeave);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', handleLeave);
      document.documentElement.removeEventListener('pointerleave', handleLeave);
      if (frame !== null) cancelAnimationFrame(frame);
      lastPointRef.current = null;
      apply();
      applyRef.current = null;
    };
  }, [active, containerRef]);

  // A toast raised or closed moves the others under a resting pointer.
  useEffect(() => {
    applyRef.current?.();
  }, [toastCount]);
}

interface ToastContainerProps {
  /** How far above the window's bottom edge the stack sits. A pop-out has no status bar. */
  bottomOffsetPx?: number;
}

export function ToastContainer({ bottomOffsetPx = MAIN_WINDOW_BOTTOM_OFFSET_PX }: ToastContainerProps) {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);
  // While a dialog, the settings panel or the search palette is open, no
  // toast takes a click: the stack sits over a centred dialog's footer.
  const overlayOpen = useAnyOverlayOpen();
  const containerRef = useRef<HTMLDivElement>(null);
  useHoverHold(containerRef, toasts.length > 0, toasts.length);

  if (toasts.length === 0) return null;

  return (
    // `role="status"` is on the CONTAINER, not the item: board-manager-automations.spec.ts's
    // saveManager reads `[role="status"]` to report which column refused a save.
    //
    // In the main window `bottom: 40px` clears the 36px status bar (`h-9`) by 4px.
    // Nothing else is clear of this corner, which is why a card that opens nothing
    // is inert rather than interactive - the stack grows upward into a centred
    // dialog's footer.
    //
    // `z-[60]` is pinned from two directions: popover-escapes-clipping.md
    // justifies every portaled menu's `z-[2147483646]` by clearing this layer,
    // and AnnouncementDialog pins itself here to layer over its history dialog.
    <div
      ref={containerRef}
      role="status"
      aria-live="polite"
      inert={overlayOpen}
      data-toast-gate={overlayOpen ? 'closed' : 'open'}
      className="pointer-events-none fixed right-3 z-[60] flex flex-col items-end gap-2"
      style={{ bottom: bottomOffsetPx }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} interactive={!overlayOpen} />
      ))}
    </div>
  );
}
