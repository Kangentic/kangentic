/**
 * The key-chord vocabulary `dispatchKeypress` (`cdp.ts`) sends, as a pure
 * parser with no CDP in it.
 *
 * Its own module so a caller can refuse an unparseable combo BEFORE touching
 * the page: `kangentic_browser_keypress` clicks its selector first, and a typo
 * in `keys` must not cost the user a stray click.
 */

/**
 * A named key, and the text it produces when it produces any.
 *
 * Only Enter has `text`. Space deliberately has none: carrying `' '` would make
 * it scroll the page, which would contradict the tool's promise that a key's
 * browser default action is not performed. `kangentic_browser_type` types a
 * space.
 */
export interface SpecialKey {
  code: string;
  key: string;
  vk: number;
  text?: string;
}

const SPECIAL_KEY_MAP: Record<string, SpecialKey> = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Space: { code: 'Space', key: ' ', vk: 32 },
  // The page-navigation keys, added after a live agent run hit `unknown-key`
  // on all of them. They DELIVER the key to the page; they do not perform the
  // browser's default action. Measured against a live guest: two PageDowns on
  // a focused document left `scrollY` at 0, and only `scrollBy`'s wheel event
  // moved it. So these serve a page that handles the keys ITSELF - a grid, a
  // slide deck, a listbox - and `scrollBy` is what scrolls. Delete rides along
  // because a form test needs it and its absence was the same oversight.
  PageUp: { code: 'PageUp', key: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  End: { code: 'End', key: 'End', vk: 35 },
  Home: { code: 'Home', key: 'Home', vk: 36 },
  Delete: { code: 'Delete', key: 'Delete', vk: 46 },
};

/**
 * The keys a US keyboard types punctuation with, by the unshifted character:
 * the UI Events `code` and the Windows virtual-key code Chromium reports as
 * `keyCode`. xterm reads `keyCode`, and handlers matching a key by position
 * read `code`, so both have to name the real key.
 */
const US_PUNCTUATION_KEYS: Record<string, { code: string; vk: number }> = {
  '`': { code: 'Backquote', vk: 192 },
  '-': { code: 'Minus', vk: 189 },
  '=': { code: 'Equal', vk: 187 },
  '[': { code: 'BracketLeft', vk: 219 },
  ']': { code: 'BracketRight', vk: 221 },
  '\\': { code: 'Backslash', vk: 220 },
  ';': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 },
  ',': { code: 'Comma', vk: 188 },
  '.': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 },
};

/**
 * The physical key a chord's single character names: `KeyV` and 86 for `v`,
 * `Digit1` and 49 for `1`, `Backquote` and 192 for `` ` ``. The UI Events spec
 * names every `code` after the key's place on a US keyboard, so the US
 * character is the honest spelling of that key. A character with no key of its
 * own there (a shifted symbol, non-Latin text) gets no `code` rather than an
 * invented one: `Key1`, or "Key" plus a backtick, is a code no real keyboard
 * ever sends, and a handler matching `event.code` never fired on it.
 */
export function chordKeyIdentity(character: string): { code?: string; vk: number } {
  const upper = character.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { code: `Key${upper}`, vk: upper.charCodeAt(0) };
  if (/^[0-9]$/.test(character)) return { code: `Digit${character}`, vk: character.charCodeAt(0) };
  if (Object.hasOwn(US_PUNCTUATION_KEYS, character)) return US_PUNCTUATION_KEYS[character];
  return { vk: upper.charCodeAt(0) };
}

export const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
  Cmd: 4, // alias for Meta
};

export interface ParsedKeyCombo {
  target: string;
  modifierFlags: number;
  special: SpecialKey | null;
}

/**
 * Parse a chord like `Ctrl+Shift+P`, or return null when `dispatchKeypress`
 * could not send it: an unknown modifier, or a target that is neither a named
 * key nor a single character (a sequence like "ArrowDown ArrowDown" lands
 * here).
 */
export function parseKeyCombo(combo: string): ParsedKeyCombo | null {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length === 0) return null;
  const target = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  // Own-property checks, not bare lookups: `MODIFIER_FLAGS['toString']` and
  // `SPECIAL_KEY_MAP['constructor']` are inherited from Object.prototype and
  // would otherwise pass as a known modifier and a named key.
  let modifierFlags = 0;
  for (const modifier of modifiers) {
    if (!Object.hasOwn(MODIFIER_FLAGS, modifier)) return null;
    modifierFlags |= MODIFIER_FLAGS[modifier];
  }

  const special = Object.hasOwn(SPECIAL_KEY_MAP, target) ? SPECIAL_KEY_MAP[target] : null;
  if (!special && target.length !== 1) return null;
  return { target, modifierFlags, special };
}
