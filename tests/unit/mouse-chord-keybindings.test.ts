import { describe, it, expect } from 'vitest';
import { isMouseCombo, mouseComboTokens, normalizeCombo } from '../../src/shared/keybindings';
import {
  heldMouseTokens,
  matchesCombo,
  matchesMouseRelease,
  formatComboSegments,
} from '../../src/renderer/utils/keybindings';

// Multi-button mouse chord support: binding e.g. Back + Forward together as a
// single push-to-talk trigger. These are the pure grammar/matching helpers.

describe('mouse chord grammar', () => {
  it('isMouseCombo recognizes single buttons and chords, rejects keyboard/empty', () => {
    expect(isMouseCombo('Mouse:Back')).toBe(true);
    expect(isMouseCombo('Mouse:Back+Mouse:Forward')).toBe(true);
    expect(isMouseCombo('Mod+Shift+P')).toBe(false);
    expect(isMouseCombo('Shift+Mouse:Back')).toBe(false); // mixed is not a mouse combo
    expect(isMouseCombo('')).toBe(false);
  });

  it('normalizeCombo sorts and dedupes chord buttons into canonical order', () => {
    expect(normalizeCombo('Mouse:Forward+Mouse:Back')).toBe('Mouse:Back+Mouse:Forward');
    expect(normalizeCombo('Mouse:Back+Mouse:Forward')).toBe('Mouse:Back+Mouse:Forward');
    expect(normalizeCombo('Mouse:Back+Mouse:Back')).toBe('Mouse:Back');
    expect(normalizeCombo('Mouse:Forward+Mouse:Middle+Mouse:Back')).toBe(
      'Mouse:Middle+Mouse:Back+Mouse:Forward',
    );
  });

  it('mouseComboTokens splits a combo into its button tokens', () => {
    expect(mouseComboTokens('Mouse:Back+Mouse:Forward')).toEqual(['Mouse:Back', 'Mouse:Forward']);
    expect(mouseComboTokens('Mod+P')).toEqual([]);
  });
});

describe('mouse chord matching', () => {
  // buttons bitmask: 4 = middle, 8 = back (X1), 16 = forward (X2).
  it('heldMouseTokens decodes the buttons bitmask', () => {
    expect(heldMouseTokens(8)).toEqual(['Mouse:Back']);
    expect(heldMouseTokens(8 | 16)).toEqual(['Mouse:Back', 'Mouse:Forward']);
    expect(heldMouseTokens(4)).toEqual(['Mouse:Middle']);
    expect(heldMouseTokens(1 | 2)).toEqual([]); // left/right are not bindable
  });

  it('matchesCombo (press) requires the exact held-button set', () => {
    const pressBoth = { buttons: 8 | 16 } as unknown as PointerEvent;
    const pressBackOnly = { buttons: 8 } as unknown as PointerEvent;
    expect(matchesCombo(pressBoth, 'Mouse:Back+Mouse:Forward')).toBe(true);
    // A single-button binding does not fire while a second bindable button is held.
    expect(matchesCombo(pressBoth, 'Mouse:Back')).toBe(false);
    // The chord does not fire until BOTH buttons are down.
    expect(matchesCombo(pressBackOnly, 'Mouse:Back+Mouse:Forward')).toBe(false);
    expect(matchesCombo(pressBackOnly, 'Mouse:Back')).toBe(true);
  });

  it('matchesMouseRelease (release) fires when any chord button lifts', () => {
    const releaseBack = { button: 3 } as unknown as PointerEvent; // back
    const releaseForward = { button: 4 } as unknown as PointerEvent; // forward
    const releaseMiddle = { button: 1 } as unknown as PointerEvent; // middle
    expect(matchesMouseRelease(releaseBack, 'Mouse:Back+Mouse:Forward')).toBe(true);
    expect(matchesMouseRelease(releaseForward, 'Mouse:Back+Mouse:Forward')).toBe(true);
    expect(matchesMouseRelease(releaseMiddle, 'Mouse:Back+Mouse:Forward')).toBe(false);
    expect(matchesMouseRelease(releaseBack, 'Mouse:Back')).toBe(true);
  });
});

describe('mouse chord display', () => {
  it('formatComboSegments renders one label per chord button', () => {
    expect(formatComboSegments('Mouse:Back+Mouse:Forward')).toEqual(['Back Click', 'Forward Click']);
    expect(formatComboSegments('Mouse:Middle')).toEqual(['Middle Click']);
  });
});
