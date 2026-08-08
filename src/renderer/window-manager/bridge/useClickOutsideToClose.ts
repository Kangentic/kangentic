import { useEffect, useRef } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { useLayerStore } from '../context';
import { resolveLightDismissTargets } from '../light-dismiss/resolve-targets';
import { requestWindowClose } from '../store/window-close-registry';

/**
 * Which layer a `[data-dismiss-layer]` subtree belongs to.
 *
 * Light dismiss is per-LAYER, because the layers stack: the Agent Monitor is a
 * full-bleed overlay ABOVE the board, so a click on the monitor's empty space is
 * not a click on the board underneath it. Scoping is what lets each layer's hook
 * instance answer only for its own clicks - the monitor's windows close on a
 * monitor click, the board's on a board click, and neither reaches through the
 * other.
 *
 * The marker declares layer OWNERSHIP, not dismissibility: it answers "whose
 * window would this click close", never "does this click close anything". That
 * second question is the denylist's job (see `isDismissibleDeadArea`).
 */
export type DismissScope = 'board' | 'monitor';

/** Pointer travel (px) above which a press is a drag, not a click, so a text
 *  selection or board pan that releases on empty board never dismisses. Matches
 *  DRAG_ACTIVATION_PX in dnd/useWindowDrag. */
const CLEAN_CLICK_MAX_PX = 4;

/** Controls and explicitly-excluded regions whose click must never light-dismiss.
 *  Real form controls (button/a/input/...) cover most actions. We deliberately OMIT
 *  `[role="button"]` because dnd-kit's useSortable stamps it on every swimlane column
 *  wrapper, which is structural (its empty body is dead space, not an action).
 *  `.xterm` keeps a click into a running terminal from dismissing, in every xterm host
 *  (bottom panel, task detail, command terminal), independent of any wrapper marking.
 *  It is deliberately a SECOND guarantee: each host is already covered by an ancestor
 *  marker today (the bottom panel's pane wrapper carries `[data-no-dismiss]`, the window
 *  layers' portal hosts carry `[data-window-layer-root]`). Keep it anyway, because the
 *  cursor check below cannot stand in for either if one is ever dropped - xterm's own CSS
 *  sets `cursor: text` on `.xterm` and `default` on `.xterm-viewport`, so NEITHER candidate
 *  hit target resolves to `pointer`. Note it does not reach the pane's non-xterm children
 *  or the pane's horizontal remainder, which is why the wrapper marker is not redundant
 *  either (see `TerminalPanel.tsx`).
 *  `[data-no-dismiss]` opts out an action that is a `<div onClick>` or a drag handle
 *  whose cursor is not `pointer` and would slip past the cursor check (a swimlane
 *  column header, the sidebar / terminal resize handles, a row drag handle), plus the
 *  live terminal pane's non-xterm children (the launch overlay, the file-drop overlay).
 *  Task cards are excluded separately via `[data-task-id]`; ordinary clickable elements
 *  (project rows, group headers, header/footer items) are auto-excluded by their pointer
 *  cursor in `isDismissibleDeadArea`, with no marker. */
const EXCLUDED_CONTROL_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], [data-no-dismiss], .xterm';

interface PendingPress {
  pointerId: number;
  startX: number;
  startY: number;
  /** A dismissable layer (menu / dropdown / modal dialog) was open when the press
   *  began, so this click belongs to that layer, not the window underneath. */
  dismissableLayerWasOpen: boolean;
}

/** True for a clean press on dead (non-action) space that THIS layer owns.
 *
 *  The rule is one sentence: clicking anything outside the window closes it, unless
 *  you clicked something interactive. This is a DENYLIST - the whole app shell
 *  dismisses, and the exclusions are all semantically "I clicked this to use it": a
 *  window or popover, a task card, a real control, a live terminal.
 *
 *  `[data-dismiss-layer]` is NOT an allowlist of dismissible regions. It declares which
 *  layer owns a subtree, so a click resolves to the right window store. Two facts fall
 *  out of resolving the NEAREST one and requiring it to match:
 *   - Anything with no scope root above it is inert. That covers every OVERLAY, because
 *     they mount as siblings of the marked shell subtree (settings panel, stats page,
 *     search palette, command-terminal layer, walkthrough, toasts, dictation, and every
 *     dialog), plus everything portaled to `document.body`. New overlays mounted there
 *     are inert on arrival rather than being holes that must be found and marked.
 *   - The layers stay off each other. The monitor overlay covers the board, so an
 *     unscoped match let a click on the monitor also dismiss the board's windows behind
 *     it.
 *  The app title bar resolves to no scope either, which is the right outcome for an
 *  independent reason: it is the OS window-drag region, so the OS swallows clicks there
 *  to move the window before the renderer ever sees them.
 *
 *  It is still not dead space when the target is a task card, a window/popover, a real
 *  control, a `[data-no-dismiss]` element, a live terminal, or anything showing a pointer
 *  cursor (`cursor` is inherited, so a child of a clickable element reports `pointer` too,
 *  auto-excluding clickable `<div>`s like project rows and group headers with no
 *  per-element marker). The cursor read stays a CLASSIFIER only; nothing drives a visual
 *  from it, so styling can never silently alter dismiss behavior. The converse is a real
 *  obligation on call sites: an element that shows an action cursor or lights up on hover
 *  must be excluded, or the UI promises an action the click will not deliver. */
function isDismissibleDeadArea(target: EventTarget | null, scope: DismissScope): boolean {
  if (!(target instanceof Element)) return false;
  // Any layer's window frame (portaled popovers self-exclude via the same guard).
  // Matched by marker, not by host id, so a new layer is covered on creation.
  if (target.closest('[data-window-layer-root]')) return false;
  if (target.closest('[data-task-id]')) return false; // a task card (opens/focuses itself)
  if (target.closest(EXCLUDED_CONTROL_SELECTOR)) return false; // a control, a live terminal, or an opted-out region
  // Bail out before the (style-flushing) getComputedStyle read when the click is not in
  // this layer's subtree, which is the common case (another layer, an overlay, a portal).
  const scopeRoot = target.closest('[data-dismiss-layer]');
  if (scopeRoot?.getAttribute('data-dismiss-layer') !== scope) return false;
  return window.getComputedStyle(target).cursor !== 'pointer'; // dead space, unless it shows an action (pointer) cursor
}

/**
 * Click-outside (light-dismiss) for modeless task-detail windows. Mounted once per
 * LAYER, inside that layer's provider, so it closes that layer's windows: the board's
 * instance answers for clicks on the app shell, the Agent Monitor's for clicks on the
 * monitor. A clean click on dead space anywhere in this layer's subtree (everything but
 * a live terminal pane and action controls) closes its open windows per the user's
 * `windowLightDismiss` policy, routed through each window's unsaved-edits guard (the
 * close registry). The session/PTY is untouched: closing only releases the
 * dialog-session claim, so the terminal returns to the bottom panel and reopening
 * the task reattaches.
 *
 * The accepted interaction model is that clicking dead space closes the detail and the
 * user clicks again to do what they wanted. Interactive controls are unaffected: they
 * are excluded, so they still action on the first click.
 *
 * Detection is a `document`-level pointerdown/pointerup pair, not a board-scoped
 * React handler: cards `stopPropagation` only their synthetic click (not pointer
 * events), windows live in a body portal, and ancestry classification is robust
 * regardless. The "a layer was open" signal is read at pointerdown because a menu
 * self-closes synchronously on its own capture-phase mousedown (React 19 flushes
 * discrete events), so by pointerup it would already be gone.
 */
export function useClickOutsideToClose(scope: DismissScope): void {
  const policy = useConfigStore((state) => state.config.windowLightDismiss);
  const useStore = useLayerStore();
  const pendingRef = useRef<PendingPress | null>(null);

  useEffect(() => {
    if (policy === 'off') return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isDismissibleDeadArea(event.target, scope)) {
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
      if (!isDismissibleDeadArea(event.target, scope)) return;

      const { windows, focusedWindowId } = useStore.getState();
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
  }, [policy, scope, useStore]);
}
