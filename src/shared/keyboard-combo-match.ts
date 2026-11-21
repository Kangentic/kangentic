// Whether a key press satisfies a canonical keyboard combo (`Mod+Shift+P`
// form), with no DOM and no host platform of its own. The renderer's
// `matchesCombo` passes a `KeyboardEvent`, and main passes the fields of a
// guest's `before-input-event` (`browser-pane-guest-shortcuts.ts`), so a key
// typed into the page and one typed into the app match the same way.

/** The fields of a key press this reads. A DOM `KeyboardEvent` has them all. */
export interface ComboKeyState {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Compare the press's main key against a canonical main-key token. */
function keyMatches(state: ComboKeyState, mainKey: string, withAlt: boolean): boolean {
  // The key left of 1 types a different character on each layout (`, ^, ², a
  // dead key), and Shift changes it again, so it is matched by position.
  if (mainKey === 'Backquote') return state.code === 'Backquote';
  // Letters: case-insensitive (Shift changes the key's casing).
  if (mainKey.length === 1 && /[a-z]/i.test(mainKey)) {
    if (state.key.toLowerCase() === mainKey.toLowerCase()) return true;
    // Alt composes a character on macOS (Option+Shift+D types another letter)
    // and is AltGr with Ctrl on many Windows layouts, so the key never names
    // the letter there. With Alt held the letter is also matched by position.
    return withAlt && state.code === `Key${mainKey.toUpperCase()}`;
  }
  // Zoom-in: treat '=' and '+' as equivalent (layout-dependent key).
  if (mainKey === '=') return state.key === '=' || state.key === '+';
  // Digits, other symbols, and named keys (Enter, Escape, F5): exact match.
  return state.key === mainKey;
}

/**
 * Whether a key press satisfies a canonical keyboard combo. `Mod` resolves to
 * Cmd (`metaKey`) when `isMac`, else Ctrl; literal `Ctrl` requires Ctrl without
 * Meta (the terminal SIGINT case); and the modifier set must match exactly, so
 * `F5` does not fire while Ctrl is held.
 */
export function keyStateMatchesCombo(state: ComboKeyState, combo: string, isMac: boolean): boolean {
  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1).map((modifier) => modifier.toLowerCase()));

  const wantMod = modifiers.has('mod');
  const wantCtrlLiteral = modifiers.has('ctrl');
  const wantAlt = modifiers.has('alt');
  const wantShift = modifiers.has('shift');

  const modActive = isMac ? state.metaKey : state.ctrlKey;

  if (wantMod && !modActive) return false;
  if (wantCtrlLiteral && !(state.ctrlKey && !state.metaKey)) return false;
  // No primary modifier requested: neither Ctrl nor Meta may be down.
  if (!wantMod && !wantCtrlLiteral && (state.ctrlKey || state.metaKey)) return false;
  if (wantAlt !== state.altKey) return false;
  // The zoom-in key is canonical '=', but on most layouts '+' is Shift+'='.
  // keyMatches() treats '=' and '+' as equivalent, so a combo that wants a bare
  // '=' must also accept the Shift-held '+' press (e.g. Ctrl+Shift+= to zoom in).
  // Every other key requires an exact Shift match.
  if (mainKey === '=') {
    if (wantShift && !state.shiftKey) return false;
  } else if (wantShift !== state.shiftKey) {
    return false;
  }

  return keyMatches(state, mainKey, wantAlt);
}
