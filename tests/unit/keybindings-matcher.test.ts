/**
 * Unit tests for the renderer-side keybinding helpers in
 * src/renderer/utils/keybindings.ts: matchesCombo, comboFromEvent, formatCombo,
 * and formatComboSegments.
 *
 * IS_MAC is a module-load-time constant that reads window.electronAPI.platform.
 * The non-Mac path (IS_MAC = false) is the natural vitest environment.
 * The Mac path (IS_MAC = true) requires stubbing window.electronAPI before the
 * module is imported; we do that with a dynamic import inside a describe block
 * that calls vi.stubGlobal first.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: build a minimal KeyboardEvent-shaped object without the DOM overhead.
// ---------------------------------------------------------------------------
function makeEvent(overrides: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    key: overrides.key,
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
  } as KeyboardEvent;
}

// ---------------------------------------------------------------------------
// Non-Mac (IS_MAC = false) suite - natural vitest environment.
// window is undefined in Node, so IS_MAC evaluates to false on import.
// ---------------------------------------------------------------------------
describe('Non-Mac helpers (IS_MAC = false)', () => {
  // Dynamic import so the module is loaded after the describe block is entered,
  // guaranteeing window is undefined (no electronAPI stub). We then hold
  // references to the exported functions for use in each test.
  let matchesCombo: (event: KeyboardEvent, combo: string) => boolean;
  let comboFromEvent: (event: KeyboardEvent) => string | null;
  let formatCombo: (combo: string) => string;
  let formatComboSegments: (combo: string) => string[];
  let MODIFIER_KEY_NAMES: Set<string>;

  beforeAll(async () => {
    const module = await import('../../src/renderer/utils/keybindings');
    matchesCombo = module.matchesCombo;
    comboFromEvent = module.comboFromEvent;
    formatCombo = module.formatCombo;
    formatComboSegments = module.formatComboSegments;
    MODIFIER_KEY_NAMES = module.MODIFIER_KEY_NAMES;
  });

  // ── matchesCombo ─────────────────────────────────────────────────────────

  describe('matchesCombo', () => {
    it('Mod+Shift+P matches ctrlKey+shiftKey, key "p" on non-Mac', () => {
      const event = makeEvent({ key: 'p', ctrlKey: true, shiftKey: true });
      expect(matchesCombo(event, 'Mod+Shift+P')).toBe(true);
    });

    it('Mod+Shift+P also matches with key "P" (uppercase from Shift)', () => {
      const event = makeEvent({ key: 'P', ctrlKey: true, shiftKey: true });
      expect(matchesCombo(event, 'Mod+Shift+P')).toBe(true);
    });

    it('Mod+Shift+P does NOT match when ctrlKey is false', () => {
      const event = makeEvent({ key: 'p', shiftKey: true });
      expect(matchesCombo(event, 'Mod+Shift+P')).toBe(false);
    });

    it('bare key combo (no modifier) does NOT match while Ctrl is held', () => {
      // F5 with no modifier specified: should reject when ctrlKey is true.
      const event = makeEvent({ key: 'F5', ctrlKey: true });
      expect(matchesCombo(event, 'F5')).toBe(false);
    });

    it('bare key combo does NOT match while Meta is held', () => {
      const event = makeEvent({ key: 'F5', metaKey: true });
      expect(matchesCombo(event, 'F5')).toBe(false);
    });

    it('bare key combo matches when no modifier is held', () => {
      const event = makeEvent({ key: 'F5' });
      expect(matchesCombo(event, 'F5')).toBe(true);
    });

    it('literal Ctrl+C requires ctrlKey && !metaKey', () => {
      const ctrlOnly = makeEvent({ key: 'c', ctrlKey: true });
      expect(matchesCombo(ctrlOnly, 'Ctrl+C')).toBe(true);
    });

    it('literal Ctrl+C does NOT match when metaKey is also held', () => {
      const both = makeEvent({ key: 'c', ctrlKey: true, metaKey: true });
      expect(matchesCombo(both, 'Ctrl+C')).toBe(false);
    });

    it('letter matching is case-insensitive (key "n" matches combo "Mod+N")', () => {
      const event = makeEvent({ key: 'n', ctrlKey: true });
      expect(matchesCombo(event, 'Mod+N')).toBe(true);
    });

    it('Mod+= matches key "=" with ctrlKey (no shift required)', () => {
      const event = makeEvent({ key: '=', ctrlKey: true });
      expect(matchesCombo(event, 'Mod+=')).toBe(true);
    });

    it('Mod+= also matches key "+" (Shift-held zoom-in layout variant)', () => {
      // On most layouts, '+' is produced by holding Shift + '='. The spec says
      // Mod+= should accept a Shift-held '+' press without requiring wantShift.
      const event = makeEvent({ key: '+', ctrlKey: true, shiftKey: true });
      expect(matchesCombo(event, 'Mod+=')).toBe(true);
    });

    it('Mod+Shift+= requires shiftKey to be held', () => {
      const withShift = makeEvent({ key: '=', ctrlKey: true, shiftKey: true });
      const withoutShift = makeEvent({ key: '=', ctrlKey: true });
      expect(matchesCombo(withShift, 'Mod+Shift+=')).toBe(true);
      expect(matchesCombo(withoutShift, 'Mod+Shift+=')).toBe(false);
    });

    it('does NOT match when Alt is held but not in the combo', () => {
      const event = makeEvent({ key: 'n', ctrlKey: true, altKey: true });
      expect(matchesCombo(event, 'Mod+N')).toBe(false);
    });

    it('matches Mod+Alt+N when Alt is also held', () => {
      const event = makeEvent({ key: 'n', ctrlKey: true, altKey: true });
      expect(matchesCombo(event, 'Mod+Alt+N')).toBe(true);
    });
  });

  // ── comboFromEvent ────────────────────────────────────────────────────────

  describe('comboFromEvent', () => {
    it('returns null for a lone modifier key (Control)', () => {
      expect(comboFromEvent(makeEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
    });

    it('returns null for a lone modifier key (Shift)', () => {
      expect(comboFromEvent(makeEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
    });

    it('returns null for a lone modifier key (Meta)', () => {
      expect(comboFromEvent(makeEvent({ key: 'Meta', metaKey: true }))).toBeNull();
    });

    it('returns null for a lone modifier key (Alt)', () => {
      expect(comboFromEvent(makeEvent({ key: 'Alt', altKey: true }))).toBeNull();
    });

    it('folds Shift+"+" back to canonical "=" token', () => {
      const event = makeEvent({ key: '+', ctrlKey: true, shiftKey: true });
      const result = comboFromEvent(event);
      // normalizeCombo puts Shift before the main key
      expect(result).toBe('Mod+Shift+=');
    });

    it('uppercases letter keys', () => {
      const event = makeEvent({ key: 'p', ctrlKey: true, shiftKey: true });
      expect(comboFromEvent(event)).toBe('Mod+Shift+P');
    });

    it('records Mod for primary Ctrl on non-Mac', () => {
      const event = makeEvent({ key: 'n', ctrlKey: true });
      expect(comboFromEvent(event)).toBe('Mod+N');
    });

    it('records a named key (Enter) verbatim', () => {
      const event = makeEvent({ key: 'Enter', ctrlKey: true });
      expect(comboFromEvent(event)).toBe('Mod+Enter');
    });

    it('records a named key (Escape) without modifiers', () => {
      const event = makeEvent({ key: 'Escape' });
      expect(comboFromEvent(event)).toBe('Escape');
    });

    it('records F5 without modifiers', () => {
      const event = makeEvent({ key: 'F5' });
      expect(comboFromEvent(event)).toBe('F5');
    });
  });

  // ── formatComboSegments ───────────────────────────────────────────────────

  describe('formatComboSegments (non-Mac)', () => {
    it('returns word-label segments joined for Mod+Shift+P', () => {
      const segments = formatComboSegments('Mod+Shift+P');
      // Non-Mac: Mod -> "Ctrl", Shift -> "Shift", main key "P" stays uppercase.
      expect(segments).toEqual(['Ctrl', 'Shift', 'P']);
    });

    it('uppercases a single lowercase letter in the main key slot', () => {
      const segments = formatComboSegments('Mod+n');
      expect(segments[segments.length - 1]).toBe('N');
    });

    it('leaves named keys (Enter, F5) verbatim', () => {
      expect(formatComboSegments('Enter')).toEqual(['Enter']);
      expect(formatComboSegments('F5')).toEqual(['F5']);
    });
  });

  // ── formatCombo ───────────────────────────────────────────────────────────

  describe('formatCombo (non-Mac)', () => {
    it('joins with "+" on non-Mac', () => {
      expect(formatCombo('Mod+Shift+P')).toBe('Ctrl+Shift+P');
    });

    it('single named key has no separator', () => {
      expect(formatCombo('F5')).toBe('F5');
    });
  });

  // ── MODIFIER_KEY_NAMES ────────────────────────────────────────────────────

  describe('MODIFIER_KEY_NAMES', () => {
    it('includes all four modifier key names', () => {
      expect(MODIFIER_KEY_NAMES.has('Control')).toBe(true);
      expect(MODIFIER_KEY_NAMES.has('Shift')).toBe(true);
      expect(MODIFIER_KEY_NAMES.has('Alt')).toBe(true);
      expect(MODIFIER_KEY_NAMES.has('Meta')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Mouse-button combos. A binding can be either a keyboard chord or a mouse
// button; matchesCombo discriminates by event shape (property presence, not
// instanceof, so it works in this node environment). Placed before the Mac
// suite so the pristine (unstubbed) window keeps IS_MAC = false.
// ---------------------------------------------------------------------------
describe('Mouse-button combos', () => {
  let matchesCombo: (event: KeyboardEvent | PointerEvent, combo: string) => boolean;
  let comboFromPointerEvent: (event: PointerEvent) => string | null;
  let formatCombo: (combo: string) => string;
  let formatComboSegments: (combo: string) => string[];

  beforeAll(async () => {
    const module = await import('../../src/renderer/utils/keybindings');
    matchesCombo = module.matchesCombo;
    comboFromPointerEvent = module.comboFromPointerEvent;
    formatCombo = module.formatCombo;
    formatComboSegments = module.formatComboSegments;
  });

  // A minimal PointerEvent-shaped object: matchesCombo only reads `.button`.
  const pointer = (button: number): PointerEvent => ({ button }) as unknown as PointerEvent;

  describe('matchesCombo', () => {
    it('a middle-button pointerdown matches Mouse:Middle', () => {
      expect(matchesCombo(pointer(1), 'Mouse:Middle')).toBe(true);
    });

    it('the side buttons match Mouse:Back (3) and Mouse:Forward (4)', () => {
      expect(matchesCombo(pointer(3), 'Mouse:Back')).toBe(true);
      expect(matchesCombo(pointer(4), 'Mouse:Forward')).toBe(true);
    });

    it('the wrong button does NOT match', () => {
      expect(matchesCombo(pointer(0), 'Mouse:Middle')).toBe(false);
      expect(matchesCombo(pointer(4), 'Mouse:Middle')).toBe(false);
    });

    it('a keyboard event never matches a mouse combo', () => {
      const keyEvent = makeEvent({ key: 'w', ctrlKey: true, shiftKey: true });
      expect(matchesCombo(keyEvent, 'Mouse:Middle')).toBe(false);
    });

    it('a pointer event never matches a keyboard combo', () => {
      expect(matchesCombo(pointer(1), 'Mod+Shift+W')).toBe(false);
    });
  });

  describe('comboFromPointerEvent', () => {
    it('maps the middle and side buttons to their combos', () => {
      expect(comboFromPointerEvent(pointer(1))).toBe('Mouse:Middle');
      expect(comboFromPointerEvent(pointer(3))).toBe('Mouse:Back');
      expect(comboFromPointerEvent(pointer(4))).toBe('Mouse:Forward');
    });

    it('returns null for the left and right buttons', () => {
      expect(comboFromPointerEvent(pointer(0))).toBeNull();
      expect(comboFromPointerEvent(pointer(2))).toBeNull();
    });
  });

  describe('formatting', () => {
    it('renders a mouse combo as a single readable segment', () => {
      expect(formatComboSegments('Mouse:Middle')).toEqual(['Middle Click']);
      expect(formatCombo('Mouse:Back')).toBe('Back Click');
      expect(formatCombo('Mouse:Forward')).toBe('Forward Click');
    });
  });
});

// ---------------------------------------------------------------------------
// Mac (IS_MAC = true) suite - stub window.electronAPI before import.
// We use a fresh module import (vi.doMock + dynamic import) to get a module
// instance where IS_MAC was evaluated as true.
// ---------------------------------------------------------------------------
describe('Mac helpers (IS_MAC = true)', () => {
  let matchesComboMac: (event: KeyboardEvent, combo: string) => boolean;
  let comboFromEventMac: (event: KeyboardEvent) => string | null;
  let formatComboMac: (combo: string) => string;
  let formatComboSegmentsMac: (combo: string) => string[];

  beforeAll(async () => {
    // Stub window so the module-load `typeof window !== 'undefined'` is true
    // and platform is 'darwin'.
    vi.stubGlobal('window', {
      electronAPI: { platform: 'darwin' },
    });

    // Force vitest to re-evaluate the module so IS_MAC is true for THIS import.
    vi.resetModules();
    const module = await import('../../src/renderer/utils/keybindings');
    matchesComboMac = module.matchesCombo;
    comboFromEventMac = module.comboFromEvent;
    formatComboMac = module.formatCombo;
    formatComboSegmentsMac = module.formatComboSegments;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  describe('matchesCombo (Mac)', () => {
    it('Mod+Shift+P matches metaKey+shiftKey on Mac', () => {
      const event = makeEvent({ key: 'P', metaKey: true, shiftKey: true });
      expect(matchesComboMac(event, 'Mod+Shift+P')).toBe(true);
    });

    it('Mod+Shift+P does NOT match ctrlKey (Ctrl is not Mod on Mac)', () => {
      const event = makeEvent({ key: 'p', ctrlKey: true, shiftKey: true });
      expect(matchesComboMac(event, 'Mod+Shift+P')).toBe(false);
    });

    it('literal Ctrl+C requires ctrlKey (not meta) even on Mac', () => {
      const ctrlOnly = makeEvent({ key: 'c', ctrlKey: true });
      expect(matchesComboMac(ctrlOnly, 'Ctrl+C')).toBe(true);
    });

    it('Mod+= zoom-in: matches metaKey + "+" (shift-held) on Mac', () => {
      const event = makeEvent({ key: '+', metaKey: true, shiftKey: true });
      expect(matchesComboMac(event, 'Mod+=')).toBe(true);
    });
  });

  describe('comboFromEvent (Mac)', () => {
    it('records metaKey as Mod on Mac', () => {
      const event = makeEvent({ key: 'p', metaKey: true, shiftKey: true });
      expect(comboFromEventMac(event)).toBe('Mod+Shift+P');
    });

    it('non-primary ctrlKey on Mac adds both Mod and Ctrl tokens', () => {
      // On Mac: metaKey=true (Mod) AND ctrlKey=true → both "Mod" and "Ctrl" in combo.
      const event = makeEvent({ key: 'c', metaKey: true, ctrlKey: true });
      const result = comboFromEventMac(event);
      // normalizeCombo sorts Mod before Ctrl: Mod+Ctrl+C
      expect(result).toBe('Mod+Ctrl+C');
    });

    it('lone ctrlKey (no meta) on Mac produces literal Ctrl prefix', () => {
      // On Mac, ctrlKey without metaKey: IS_MAC means modActive=false for Mod,
      // but ctrlKey branch still fires "Ctrl". Result: Ctrl+C.
      const event = makeEvent({ key: 'c', ctrlKey: true });
      expect(comboFromEventMac(event)).toBe('Ctrl+C');
    });
  });

  describe('formatComboSegments (Mac)', () => {
    it('uses glyphs (not word labels) on Mac', () => {
      const segments = formatComboSegmentsMac('Mod+Shift+P');
      // Mac: Mod -> "⌘", Shift -> "⇧", main key "P".
      expect(segments).toEqual(['⌘', '⇧', 'P']);
    });

    it('uses ⌃ for literal Ctrl on Mac', () => {
      const segments = formatComboSegmentsMac('Ctrl+C');
      expect(segments).toEqual(['⌃', 'C']);
    });
  });

  describe('formatCombo (Mac)', () => {
    it('joins with "" (no separator) on Mac', () => {
      expect(formatComboMac('Mod+Shift+P')).toBe('⌘⇧P');
    });
  });
});
