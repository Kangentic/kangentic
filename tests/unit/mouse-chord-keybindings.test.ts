import { describe, it, expect } from 'vitest';
import { isMouseCombo, mouseComboTokens, normalizeCombo } from '../../src/shared/keybindings';
import {
  heldMouseTokens,
  matchesCombo,
  matchesMouseChordPress,
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

  it('matchesMouseRelease (release) fires when any chord button is up', () => {
    const backUp = { buttons: 16 } as unknown as PointerEvent; // back lifted, forward held
    const forwardUp = { buttons: 8 } as unknown as PointerEvent; // forward lifted, back held
    const middleUp = { buttons: 8 | 16 } as unknown as PointerEvent; // both chord buttons held
    expect(matchesMouseRelease(backUp, 'Mouse:Back+Mouse:Forward')).toBe(true);
    expect(matchesMouseRelease(forwardUp, 'Mouse:Back+Mouse:Forward')).toBe(true);
    expect(matchesMouseRelease(middleUp, 'Mouse:Back+Mouse:Forward')).toBe(false);
    expect(matchesMouseRelease({ buttons: 0 } as unknown as PointerEvent, 'Mouse:Back')).toBe(true);
  });

  it('matchesMouseRelease reads the held set, so another button never ends a hold', () => {
    const leftPressed = { buttons: 8 | 1 } as unknown as PointerEvent;
    const backLiftedLeftHeld = { button: 3, buttons: 1 } as unknown as PointerEvent;
    const leftUpAfterBack = { button: 0, buttons: 0 } as unknown as PointerEvent;
    expect(matchesMouseRelease(leftPressed, 'Mouse:Back')).toBe(false);
    expect(matchesMouseRelease(backLiftedLeftHeld, 'Mouse:Back')).toBe(true);
    expect(matchesMouseRelease(leftUpAfterBack, 'Mouse:Back')).toBe(true);
  });

  it('matchesMouseRelease ignores a pointer that is not the mouse', () => {
    const touch = { buttons: 1, pointerType: 'touch' } as unknown as PointerEvent;
    expect(matchesMouseRelease(touch, 'Mouse:Back')).toBe(false);
  });

  it('matchesMouseChordPress finds a press that landed while another button was down', () => {
    const backOverLeft = { type: 'pointermove', button: 3, buttons: 8 | 1 } as unknown as PointerEvent;
    const plainMove = { type: 'pointermove', button: -1, buttons: 8 | 1 } as unknown as PointerEvent;
    const backLifted = { type: 'pointermove', button: 3, buttons: 1 } as unknown as PointerEvent;
    const leftOverBack = { type: 'pointermove', button: 0, buttons: 8 | 1 } as unknown as PointerEvent;
    expect(matchesMouseChordPress(backOverLeft, 'Mouse:Back')).toBe(true);
    expect(matchesMouseChordPress(plainMove, 'Mouse:Back')).toBe(false);
    expect(matchesMouseChordPress(backLifted, 'Mouse:Back')).toBe(false);
    expect(matchesMouseChordPress(leftOverBack, 'Mouse:Back')).toBe(false);
  });

  it('matchesMouseChordPress completes a chord on its second button', () => {
    const forwardOverBack = { type: 'pointermove', button: 4, buttons: 8 | 16 } as unknown as PointerEvent;
    expect(matchesMouseChordPress(forwardOverBack, 'Mouse:Back+Mouse:Forward')).toBe(true);
  });
});

describe('mouse chord display', () => {
  it('formatComboSegments renders one label per chord button', () => {
    expect(formatComboSegments('Mouse:Back+Mouse:Forward')).toEqual(['Back Click', 'Forward Click']);
    expect(formatComboSegments('Mouse:Middle')).toEqual(['Middle Click']);
  });
});
