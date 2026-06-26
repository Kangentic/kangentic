import { useEffect, useRef } from 'react';
import { useConfigStore } from '../stores/config-store';
import { effectiveCombo, getKeybinding, isMouseCombo } from '../../shared/keybindings';
import { matchesCombo, formatCombo } from '../utils/keybindings';
import { isRebindCaptureActive } from '../utils/rebind-state';

/**
 * The current effective combo for an action, formatted for display (tooltips,
 * hints). Reads the user override or the registry default and updates reactively
 * when the user rebinds, so callers never hard-code a combo string. Returns '' for
 * an unknown id.
 */
export function useFormattedCombo(actionId: string): string {
  const override = useConfigStore((state) => state.globalConfig.hotkeyOverrides?.[actionId]);
  // Subscribe to just this action's override (not the whole map) for render
  // efficiency, then resolve through the shared effectiveCombo helper.
  const combo = effectiveCombo(actionId, override ? { [actionId]: override } : undefined);
  return combo ? formatCombo(combo) : '';
}

interface UseKeybindingOptions {
  /** When false, the listener is not installed (e.g. gated on a project being
   *  open, edit mode, or pane visibility). Default true. */
  enabled?: boolean;
  /** Listen in the capture phase. Required for dialog/overlay shortcuts that must
   *  beat the embedded xterm's control-character handling. Default false. */
  capture?: boolean;
  /** Listen on `window` or `document`. Default 'window'. */
  target?: 'window' | 'document';
  /** Call event.preventDefault() on a match. Default true. */
  preventDefault?: boolean;
  /** Call event.stopPropagation() on a match. Default true. */
  stopPropagation?: boolean;
  /** Extra predicate run before matching (e.g. skip when typing in an input, or
   *  gate on a pane being hovered/focused). Return false to ignore the event.
   *  Receives a `PointerEvent` when the action is bound to a mouse button. */
  when?: (event: KeyboardEvent | PointerEvent) => boolean;
}

/**
 * Register a shortcut by its registry action id. Reads the effective combo (user
 * override or registry default) live, so a rebind in settings takes effect
 * immediately. The combo may be a keyboard chord (listened for on `keydown`) or a
 * mouse button (`Mouse:Middle` etc., listened for on `pointerdown`), so any action
 * can be rebound to either input. This is the single sanctioned way to bind an app
 * shortcut; see `src/shared/keybindings.ts` for the registry and `.claude/rules/
 * keybindings-registry.md` for the convention.
 */
export function useKeybinding(
  actionId: string,
  handler: (event: KeyboardEvent | PointerEvent) => void,
  options: UseKeybindingOptions = {},
): void {
  const override = useConfigStore((state) => state.globalConfig.hotkeyOverrides?.[actionId]);
  const definition = getKeybinding(actionId);
  // Resolve through the shared effectiveCombo helper (single source of truth),
  // subscribing to just this action's override above for render efficiency.
  const combo = effectiveCombo(actionId, override ? { [actionId]: override } : undefined);
  const altCombo = definition?.defaultComboAlt;

  const {
    enabled = true,
    capture = false,
    target = 'window',
    preventDefault = true,
    stopPropagation = true,
    when,
  } = options;

  // Keep the latest handler/predicate without re-arming the listener every render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const whenRef = useRef(when);
  whenRef.current = when;

  useEffect(() => {
    if (!enabled || !combo) return;
    const element: Window | Document = target === 'document' ? document : window;
    const onEvent = (event: Event): void => {
      // While a Hotkeys-settings rebind capture is active, suppress ALL app
      // shortcuts (without preventDefault/stopPropagation) so the captured input
      // reaches the capture widget instead of firing its current binding.
      if (isRebindCaptureActive()) return;
      const inputEvent = event as KeyboardEvent | PointerEvent;
      if (whenRef.current && !whenRef.current(inputEvent)) return;
      const hit = matchesCombo(inputEvent, combo) || (!!altCombo && matchesCombo(inputEvent, altCombo));
      if (!hit) return;
      if (preventDefault) inputEvent.preventDefault();
      if (stopPropagation) inputEvent.stopPropagation();
      handlerRef.current(inputEvent);
    };
    // A keyboard combo is delivered by `keydown`, a mouse combo by `pointerdown`.
    // The combo and its alt can be different input kinds, so listen for each kind
    // either actually uses.
    const eventTypes = new Set<'keydown' | 'pointerdown'>();
    eventTypes.add(isMouseCombo(combo) ? 'pointerdown' : 'keydown');
    if (altCombo) eventTypes.add(isMouseCombo(altCombo) ? 'pointerdown' : 'keydown');
    for (const eventType of eventTypes) element.addEventListener(eventType, onEvent, capture);
    return () => {
      for (const eventType of eventTypes) element.removeEventListener(eventType, onEvent, capture);
    };
  }, [combo, altCombo, enabled, capture, target, preventDefault, stopPropagation]);
}
