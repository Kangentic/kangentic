import { useEffect, useRef } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { useWindowStore } from '../store/window-store';
import { resolveLightDismissTargets } from '../light-dismiss/resolve-targets';
import { requestWindowClose } from '../store/window-close-registry';

/** Pointer travel (px) above which a press is a drag, not a click, so a text
 *  selection or board pan that releases on empty board never dismisses. Matches
 *  DRAG_ACTIVATION_PX in dnd/useWindowDrag. */
const CLEAN_CLICK_MAX_PX = 4;

/** Real interactive controls on the board whose own click must win (the add-task
 *  button, links, inputs). Deliberately NARROWER than TaskDetailWindow's
 *  INTERACTIVE_SELECTOR: it omits `[role="button"]` because dnd-kit's useSortable
 *  stamps `role="button"` on every swimlane column wrapper, so excluding it would
 *  block the common click on a column's empty body, the very empty-board click
 *  this feature exists for. Cards are excluded separately via `[data-task-id]`. */
const BOARD_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"]';

interface PendingPress {
  pointerId: number;
  startX: number;
  startY: number;
  /** A dismissable layer (menu / dropdown / modal dialog) was open when the press
   *  began, so this click belongs to that layer, not the window underneath. */
  dismissableLayerWasOpen: boolean;
}

/** True for a clean press on the empty board: within the board background region,
 *  and not on a card, a window/popover, or an interactive control. */
function isBoardBackgroundTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('#window-layer-root')) return false; // a task-detail window frame (portaled popovers exclude themselves via the board-background gate + the layer guard)
  if (target.closest('[data-task-id]')) return false; // a task card (opens/focuses itself)
  if (target.closest(BOARD_INTERACTIVE_SELECTOR)) return false; // a real button / input on the board
  return !!target.closest('[data-board-background]'); // within the board region
}

/**
 * Click-outside (light-dismiss) for modeless task-detail windows. Mounted once in
 * `WindowLayer`. A clean click on the empty board closes open windows per the
 * user's `windowLightDismiss` policy, routed through each window's unsaved-edits
 * guard (the close registry). The session/PTY is untouched: closing only releases
 * the dialog-session claim, so the terminal returns to the bottom panel and
 * reopening the task reattaches.
 *
 * Detection is a `document`-level pointerdown/pointerup pair, not a board-scoped
 * React handler: cards `stopPropagation` only their synthetic click (not pointer
 * events), windows live in a body portal, and ancestry classification is robust
 * regardless. The "a layer was open" signal is read at pointerdown because a menu
 * self-closes synchronously on its own capture-phase mousedown (React 19 flushes
 * discrete events), so by pointerup it would already be gone.
 */
export function useClickOutsideToClose(): void {
  const policy = useConfigStore((state) => state.config.windowLightDismiss);
  const pendingRef = useRef<PendingPress | null>(null);

  useEffect(() => {
    if (policy === 'off') return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isBoardBackgroundTarget(event.target)) {
        pendingRef.current = null;
        return;
      }
      pendingRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dismissableLayerWasOpen: !!document.querySelector('[data-dismissable-layer]'),
      };
    };

    const handlePointerUp = (event: PointerEvent) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending || event.pointerId !== pending.pointerId || pending.dismissableLayerWasOpen) return;
      if (Math.abs(event.clientX - pending.startX) >= CLEAN_CLICK_MAX_PX) return;
      if (Math.abs(event.clientY - pending.startY) >= CLEAN_CLICK_MAX_PX) return;
      if (!isBoardBackgroundTarget(event.target)) return;

      const { windows, focusedWindowId } = useWindowStore.getState();
      for (const windowId of resolveLightDismissTargets(policy, windows, focusedWindowId)) {
        requestWindowClose(windowId);
      }
    };

    // A cancelled pointer (browser scroll / gesture takeover, capture loss) fires
    // no pointerup, so clear any pending press to avoid a stale dismiss later.
    const handlePointerCancel = () => { pendingRef.current = null; };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [policy]);
}
