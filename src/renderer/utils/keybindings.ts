/**
 * Renderer-side keybinding helpers: platform-aware combo matching and display
 * formatting. The pure registry, types, and normalization live in
 * `src/shared/keybindings.ts`; this module is the part that touches
 * `KeyboardEvent` / `PointerEvent` and the host platform.
 */
import { isMouseCombo, mouseComboToButton, normalizeCombo } from '../../shared/keybindings';

/** True on macOS, where `Mod` resolves to Cmd (metaKey) instead of Ctrl.
 *  Guard `window` so this module is safe to import in the node/unit test
 *  environment (where renderer components are imported for their pure helpers). */
export const IS_MAC = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

/** Modifier key names, used to ignore lone-modifier keydowns during capture. */
export const MODIFIER_KEY_NAMES = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** Compare the event's main key against a canonical main-key token. */
function keyMatches(event: KeyboardEvent, mainKey: string): boolean {
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
    const wantButton = mouseComboToButton(combo);
    return wantButton !== null && 'button' in event && event.button === wantButton;
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
};

/** Human-readable labels for the bindable mouse buttons. */
const MOUSE_COMBO_LABELS: Record<string, string> = {
  'Mouse:Middle': 'Middle Click',
  'Mouse:Back': 'Back Click',
  'Mouse:Forward': 'Forward Click',
};

/**
 * Split a canonical combo into display segments for rendering as `<kbd>`
 * elements. macOS uses glyphs (no separator on screen); other platforms use
 * word labels. Returns segments in canonical order, main key last. A mouse combo
 * renders as a single readable segment.
 */
export function formatComboSegments(combo: string): string[] {
  if (isMouseCombo(combo)) return [MOUSE_COMBO_LABELS[combo] ?? combo];
  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const labels = IS_MAC ? MAC_GLYPHS : OTHER_LABELS;
  const modifierSegments = modifiers.map((modifier) => {
    const canonical = modifier.charAt(0).toUpperCase() + modifier.slice(1).toLowerCase();
    return labels[canonical] ?? modifier;
  });
  const mainSegment = MAIN_KEY_LABELS[mainKey] ?? (mainKey.length === 1 ? mainKey.toUpperCase() : mainKey);
  return [...modifierSegments, mainSegment];
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
