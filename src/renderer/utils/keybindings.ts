/**
 * Renderer-side keybinding helpers: platform-aware combo matching and display
 * formatting. The pure registry, types, and normalization live in
 * `src/shared/keybindings.ts`; this module is the part that touches
 * `KeyboardEvent` / `PointerEvent` and the host platform.
 */
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { CLICK_TOKEN, isModifiedClickCombo, isMouseCombo, normalizeCombo } from '../../shared/keybindings';

/** True on macOS, where `Mod` resolves to Cmd (metaKey) instead of Ctrl.
 *  Guard `window` so this module is safe to import in the node/unit test
 *  environment (where renderer components are imported for their pure helpers). */
export const IS_MAC = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

/** Modifier key names, used to ignore lone-modifier keydowns during capture. */
export const MODIFIER_KEY_NAMES = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/**
 * The bindable mouse buttons, mapping the canonical combo token to the DOM
 * `MouseEvent.button` code (used on pointerup, identifies the single released
 * button) and the `MouseEvent.buttons` bitmask flag (used on pointerdown,
 * identifies which buttons are currently held). Left (button 0 / flag 1) and
 * right (button 2 / flag 2) are intentionally absent: they are not bindable.
 */
const BINDABLE_MOUSE_BUTTONS: ReadonlyArray<{ token: string; button: number; flag: number }> = [
  { token: 'Mouse:Middle', button: 1, flag: 4 },
  { token: 'Mouse:Back', button: 3, flag: 8 },
  { token: 'Mouse:Forward', button: 4, flag: 16 },
];

/** The bindable mouse buttons currently held, as canonical tokens, from a
 *  pointer event's `buttons` bitmask. */
export function heldMouseTokens(buttons: number): string[] {
  return BINDABLE_MOUSE_BUTTONS.filter((entry) => (buttons & entry.flag) !== 0).map((entry) => entry.token);
}

/** The canonical token for a single `MouseEvent.button` code, or null if it is
 *  not a bindable button. */
function mouseTokenForButton(button: number): string | null {
  return BINDABLE_MOUSE_BUTTONS.find((entry) => entry.button === button)?.token ?? null;
}

/**
 * Whether a pointer event shows a held (possibly chord) mouse combo as let go:
 * true when `buttons` lacks any of the combo's buttons, so releasing one button
 * of a chord ends the hold, which is the desired push-to-talk semantics.
 *
 * It reads `buttons` rather than `button` because the event that reports a
 * release depends on the other buttons. `pointerup` fires only when the LAST
 * button lifts, so Back lifted with Left still down is a `pointermove` with
 * `button` 3, and the Left `pointerup` after it names no bound button at all.
 * A press adds a bit and leaves the bound one set, so a left click during a hold
 * never reads as a release.
 *
 * Mouse only: a touch or a pen is another pointer, and its `buttons` say nothing
 * about the mouse.
 */
export function matchesMouseRelease(event: PointerEvent, combo: string): boolean {
  if (!isMouseCombo(combo) || !('buttons' in event)) return false;
  if ('pointerType' in event && event.pointerType !== 'mouse') return false;
  const held = heldMouseTokens(event.buttons);
  return combo.split('+').some((token) => !held.includes(token));
}

/**
 * Whether a `pointermove` is a press of a combo's button that landed while
 * another button was already down. Chromium reports that as a move, not a
 * `pointerdown`, with `button` naming the button that changed. Plain moves carry
 * `button` -1, and a release of the same button lacks its bit in `buttons`.
 */
export function matchesMouseChordPress(event: PointerEvent, combo: string): boolean {
  return event.type === 'pointermove' && isMouseComboButton(event.button, combo) && matchesCombo(event, combo);
}

/** Whether a `MouseEvent.button` code is one of a mouse combo's buttons. */
export function isMouseComboButton(button: number, combo: string): boolean {
  const token = mouseTokenForButton(button);
  return token !== null && combo.split('+').includes(token);
}

/** Compare the event's main key against a canonical main-key token. */
function keyMatches(event: KeyboardEvent, mainKey: string): boolean {
  // The key left of 1 types a different character on each layout (`, ^, ², a
  // dead key), and Shift changes it again, so it is matched by position.
  if (mainKey === 'Backquote') return event.code === 'Backquote';
  // Letters: case-insensitive (Shift changes event.key casing).
  if (mainKey.length === 1 && /[a-z]/i.test(mainKey)) {
    return event.key.toLowerCase() === mainKey.toLowerCase();
  }
  // Zoom-in: treat '=' and '+' as equivalent (layout-dependent event.key).
  if (mainKey === '=') return event.key === '=' || event.key === '+';
  // Digits, other symbols, and named keys (Enter, Escape, F5): exact match.
  return event.key === mainKey;
}

/**
 * Whether an input event satisfies a canonical combo.
 *
 * A keyboard combo matches a `keydown`: resolves `Mod` to Cmd on macOS / Ctrl
 * elsewhere, requires literal `Ctrl` without meta (the terminal SIGINT case), and
 * requires an exact modifier set so, e.g., `F5` does not fire while Ctrl is held.
 * A mouse combo (`Mouse:Middle` etc.) matches a `pointerdown` on the bound button.
 * The two never cross: a mouse combo never matches a key event and vice versa.
 */
export function matchesCombo(event: KeyboardEvent | PointerEvent, combo: string): boolean {
  // Discriminate by property presence rather than `instanceof` so this stays
  // correct in the node unit-test environment, where the DOM event constructors
  // (PointerEvent / KeyboardEvent) may be absent.
  if (isMouseCombo(combo)) {
    // Press match: the held bindable mouse buttons exactly equal the combo's
    // button set, so a chord fires only when ALL its buttons are down. Read on a
    // pointerdown, where `buttons` already includes the just-pressed button.
    if (!('buttons' in event)) return false;
    const held = heldMouseTokens(event.buttons);
    const want = combo.split('+');
    return held.length === want.length && want.every((token) => held.includes(token));
  }
  // A keyboard combo never matches a pointer event.
  if (!('key' in event)) return false;

  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1).map((modifier) => modifier.toLowerCase()));

  const wantMod = modifiers.has('mod');
  const wantCtrlLiteral = modifiers.has('ctrl');
  const wantAlt = modifiers.has('alt');
  const wantShift = modifiers.has('shift');

  const modActive = IS_MAC ? event.metaKey : event.ctrlKey;

  if (wantMod && !modActive) return false;
  if (wantCtrlLiteral && !(event.ctrlKey && !event.metaKey)) return false;
  // No primary modifier requested: neither Ctrl nor Meta may be down.
  if (!wantMod && !wantCtrlLiteral && (event.ctrlKey || event.metaKey)) return false;
  if (wantAlt !== event.altKey) return false;
  // The zoom-in key is canonical '=', but on most layouts '+' is Shift+'='.
  // keyMatches() treats '=' and '+' as equivalent, so a combo that wants a bare
  // '=' must also accept the Shift-held '+' press (e.g. Ctrl+Shift+= to zoom in).
  // Every other key requires an exact Shift match.
  if (mainKey === '=') {
    if (wantShift && !event.shiftKey) return false;
  } else if (wantShift !== event.shiftKey) {
    return false;
  }

  return keyMatches(event, mainKey);
}

const MAC_GLYPHS: Record<string, string> = {
  Mod: '⌘', // Command
  Ctrl: '⌃', // Control
  Alt: '⌥', // Option
  Shift: '⇧', // Shift
};

const OTHER_LABELS: Record<string, string> = {
  Mod: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
};

/** Display glyphs for named main keys (arrow keys, etc.) so combos render
 *  cleanly in the settings panel and tooltips. The canonical token (e.g.
 *  'ArrowLeft') is unchanged, so combo matching is unaffected. */
const MAIN_KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backquote: '`',
};

/** Human-readable labels for the bindable mouse buttons, translated where a
 *  combo is formatted. The modifier and key labels above are key caps and stay
 *  as written. */
const MOUSE_COMBO_LABELS: Record<string, MessageDescriptor> = {
  'Mouse:Middle': msg`Middle Click`,
  'Mouse:Back': msg`Back Click`,
  'Mouse:Forward': msg`Forward Click`,
};

function mouseComboLabel(token: string): string {
  const label = MOUSE_COMBO_LABELS[token];
  return label ? i18n._(label) : token;
}

/** The left click of a link click combo, drawn as the chip after its modifiers. */
const CLICK_CHIP = msg({ message: 'Click', context: 'mouse button, drawn as a key chip after Ctrl or Cmd' });

/**
 * Split a canonical combo into display segments for rendering as `<kbd>`
 * elements. macOS uses glyphs (no separator on screen); other platforms use
 * word labels. Returns segments in canonical order, main key last. A mouse combo
 * renders as a single readable segment. An unbound action (empty combo) has no
 * segments, so no caller draws an empty key chip.
 */
export function formatComboSegments(combo: string, isMac: boolean = IS_MAC): string[] {
  if (combo === '') return [];
  // A mouse combo renders one segment per button (a chord becomes two chips).
  if (isMouseCombo(combo)) return combo.split('+').map(mouseComboLabel);
  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const labels = isMac ? MAC_GLYPHS : OTHER_LABELS;
  const modifierSegments = modifiers.map((modifier) => {
    const canonical = modifier.charAt(0).toUpperCase() + modifier.slice(1).toLowerCase();
    return labels[canonical] ?? modifier;
  });
  const mainSegment = mainKey === CLICK_TOKEN
    ? i18n._(CLICK_CHIP)
    : MAIN_KEY_LABELS[mainKey] ?? (mainKey.length === 1 ? mainKey.toUpperCase() : mainKey);
  return [...modifierSegments, mainSegment];
}

/** The modifier keys a click carries, which is all a link click combo reads. */
export type ClickModifiers = Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Whether a click carries exactly a link click combo's modifiers
 * (`Mod+Shift+Mouse:Left`). `Mod` is Cmd on a Mac and Ctrl elsewhere, where a
 * literal `Ctrl` is the same key. The button is the caller's to check: xterm
 * activates a link on a left mouseup only.
 */
export function matchesClickCombo(
  event: ClickModifiers,
  combo: string,
  isMac: boolean = IS_MAC,
): boolean {
  if (!isModifiedClickCombo(combo)) return false;
  const modifiers = new Set(combo.split('+').slice(0, -1).map((modifier) => modifier.toLowerCase()));
  const wantPrimary = modifiers.has('mod') || (!isMac && modifiers.has('ctrl'));
  const primaryHeld = Boolean(isMac ? event.metaKey : event.ctrlKey);
  if (primaryHeld !== wantPrimary) return false;
  // The key that is not the primary one: Control on a Mac, the Windows key elsewhere.
  const otherHeld = Boolean(isMac ? event.ctrlKey : event.metaKey);
  if (otherHeld !== (isMac && modifiers.has('ctrl'))) return false;
  return Boolean(event.altKey) === modifiers.has('alt') && Boolean(event.shiftKey) === modifiers.has('shift');
}

/**
 * The link click combo a captured press records: its modifiers then
 * `Mouse:Left`, or null with no modifier held, since a plain click belongs to
 * the program in the terminal. Used by the rebind field of a click hotkey.
 */
export function clickComboFromEvent(
  event: ClickModifiers,
  isMac: boolean = IS_MAC,
): string | null {
  const modifiers: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
  if (isMac && event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (modifiers.length === 0) return null;
  return normalizeCombo([...modifiers, CLICK_TOKEN].join('+'));
}

/** Flat display string for a combo (e.g. tooltips, aria-labels). */
export function formatCombo(combo: string): string {
  const segments = formatComboSegments(combo);
  return IS_MAC ? segments.join('') : segments.join('+');
}

/**
 * Build a canonical combo from a captured keydown event, or `null` if the press
 * is only a modifier. Used by the rebind capture widget. The primary modifier
 * (Cmd on mac, Ctrl elsewhere) is recorded as `Mod` so the override works
 * across platforms.
 */
export function comboFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEY_NAMES.has(event.key)) return null;

  const modifiers: string[] = [];
  const modActive = IS_MAC ? event.metaKey : event.ctrlKey;
  if (modActive) modifiers.push('Mod');
  // A non-primary Ctrl press on macOS (Control held while Cmd is not) maps to
  // literal Ctrl; elsewhere the primary already captured Ctrl above.
  if (IS_MAC && event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  let mainKey = event.key;
  if (mainKey.length === 1) {
    mainKey = /[a-z]/i.test(mainKey) ? mainKey.toUpperCase() : mainKey;
  }
  // Fold the Shift-shifted symbol for zoom-in back to its canonical token.
  if (mainKey === '+') mainKey = '=';
  // The key left of 1 is recorded by position, whatever character this layout gives it.
  if (event.code === 'Backquote') mainKey = 'Backquote';

  return normalizeCombo([...modifiers, mainKey].join('+'));
}

/** Canonical mouse combo for a captured pointerdown, or `null` for a button that
 *  is not bindable (left = 0, right = 2). Used by the rebind capture widget. */
const MOUSE_COMBO_BY_BUTTON: Record<number, string> = {
  1: 'Mouse:Middle',
  3: 'Mouse:Back',
  4: 'Mouse:Forward',
};

export function comboFromPointerEvent(event: PointerEvent): string | null {
  return MOUSE_COMBO_BY_BUTTON[event.button] ?? null;
}
