import { useEffect, useRef } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { useWindowStore } from '../store/window-store';
import { resolveLightDismissTargets } from '../light-dismiss/resolve-targets';
import { requestWindowClose } from '../store/window-close-registry';

/** Pointer travel (px) above which a press is a drag, not a click, so a text
 *  selection or board pan that releases on empty board never dismisses. Matches
 *  DRAG_ACTIVATION_PX in dnd/useWindowDrag. */
const CLEAN_CLICK_MAX_PX = 4;

/** Controls and explicitly-excluded regions whose click must never light-dismiss.
 *  Real form controls (button/a/input/...) cover most actions. We deliberately OMIT
 *  `[role="button"]` because dnd-kit's useSortable stamps it on every swimlane column
 *  wrapper, which is structural (its empty body is dead space, not an action).
 *  `[data-no-dismiss]` opts out an action that is a `<div onClick>` whose inner cursor
 *  is not `pointer` and would slip past the cursor check (a swimlane column header +
 *  its drag handle). Task cards are excluded separately via `[data-task-id]`; ordinary
 *  clickable elements (project rows, group headers, header/footer items) are
 *  auto-excluded by their pointer cursor in `isDismissibleDeadArea`, with no marker. */
const EXCLUDED_CONTROL_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], [data-no-dismiss]';

interface PendingPress {
  pointerId: number;
  startX: number;
  startY: number;
  /** A dismissable layer (menu / dropdown / modal dialog) was open when the press
   *  began, so this click belongs to that layer, not the window underneath. */
  dismissableLayerWasOpen: boolean;
}

/** True for a clean press on dead (non-action) space within a MARKED app-shell
 *  surface (`[data-dismiss-surface]`): the board columns, the toolbar, the project
 *  sidebar, and the status bar carry it. (The app title bar is deliberately NOT a
 *  surface: it is the OS window-drag region, which swallows clicks to move the window
 *  before the renderer sees them.) Requiring the marker is what keeps OVERLAYS off the
 *  dismiss surface: the settings panel, the command/search
 *  palettes, and any modal backdrop sit ABOVE the shell and are NOT marked, so a click
 *  on them (or on a backdrop to dismiss them) never closes the window beneath. The
 *  terminal panel is likewise unmarked, so it never dismisses. Within a surface, it is
 *  still not dead space when the target is a task card, a window/popover, a real
 *  control or a `[data-no-dismiss]` element (a column header strip + its drag handle),
 *  or anything showing a pointer cursor (`cursor` is inherited, so a child of a
 *  clickable element reports `pointer` too, auto-excluding clickable `<div>`s like
 *  project rows and group headers with no per-element marker). */
function isDismissibleDeadArea(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('#window-layer-root')) return false; // a task-detail window frame (portaled popovers also self-exclude via the layer guard)
  if (target.closest('[data-task-id]')) return false; // a task card (opens/focuses itself)
  if (target.closest(EXCLUDED_CONTROL_SELECTOR)) return false; // a real control or a [data-no-dismiss] element
  // Bail out before the (style-flushing) getComputedStyle read when the click is
  // outside every marked surface, which is the common case (task windows, menus,
  // anywhere else): only within a marked app-shell surface can a click dismiss.
  if (!target.closest('[data-dismiss-surface]')) return false;
  return window.getComputedStyle(target).cursor !== 'pointer'; // dead space, unless it shows an action (pointer) cursor
}

/**
 * Click-outside (light-dismiss) for modeless task-detail windows. Mounted once in
 * `WindowLayer`. A clean click on dead space anywhere in the app shell (everywhere
 * but the terminal panel and action controls) closes open windows per the user's
 * `windowLightDismiss` policy, routed through each window's unsaved-edits guard (the
 * close registry). The session/PTY is untouched: closing only releases the
 * dialog-session claim, so the terminal returns to the bottom panel and reopening
 * the task reattaches.
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
      if (event.button !== 0 || !isDismissibleDeadArea(event.target)) {
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
      if (!isDismissibleDeadArea(event.target)) return;

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
