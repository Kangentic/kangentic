/**
 * The decisions behind a push-to-talk hold. The event shapes are the ones Chromium
 * was measured to send for Back and Left overlapping in each order: a button that
 * changes with another held arrives as a `pointermove` naming it, and `pointerup`
 * fires only for the last button up, naming that one.
 */
import { describe, it, expect } from 'vitest';
import { decidePress, holdEndFromPointer } from '../../src/renderer/utils/dictation-hold';

const BACK = 8;
const LEFT = 1;
const BACK_BUTTON = 3;
const LEFT_BUTTON = 0;
const NO_BUTTON = -1;

function pointer(type: string, button: number, buttons: number, pointerType = 'mouse'): PointerEvent {
  return { type, button, buttons, pointerType } as unknown as PointerEvent;
}

describe('decidePress', () => {
  it('starts when nothing is running', () => {
    expect(decidePress({ active: false, finalizing: false, repeat: false })).toBe('start');
  });

  it('finishes a hold whose release was missed instead of swallowing the press', () => {
    expect(decidePress({ active: true, finalizing: false, repeat: false })).toBe('finish');
  });

  it('refuses a press while the last utterance is finishing', () => {
    expect(decidePress({ active: false, finalizing: true, repeat: false })).toBe('ignore');
  });

  it('ignores a keyboard auto-repeat, which must never finish a hold', () => {
    expect(decidePress({ active: true, finalizing: false, repeat: true })).toBe('ignore');
  });
});

describe('holdEndFromPointer on Mouse:Back', () => {
  const combo = 'Mouse:Back';

  it('does not end on a left press during the hold', () => {
    expect(holdEndFromPointer(pointer('pointermove', LEFT_BUTTON, BACK | LEFT), combo)).toBeNull();
  });

  it('does not end on a left release with Back still held', () => {
    expect(holdEndFromPointer(pointer('pointermove', LEFT_BUTTON, BACK), combo)).toBeNull();
  });

  it('does not end on plain movement with Back held', () => {
    expect(holdEndFromPointer(pointer('pointermove', NO_BUTTON, BACK), combo)).toBeNull();
  });

  it('ends when Back lifts under a held Left, and leaves the event alone', () => {
    expect(holdEndFromPointer(pointer('pointermove', BACK_BUTTON, LEFT), combo)).toEqual({
      reason: 'lifted-with-other-button', mayNavigate: true, consume: false,
    });
  });

  it('ends on the ordinary pointerup of Back, and consumes it', () => {
    expect(holdEndFromPointer(pointer('pointerup', BACK_BUTTON, 0), combo)).toEqual({
      reason: 'released', mayNavigate: true, consume: true,
    });
  });

  it('recovers on the next event that shows Back up, without navigating', () => {
    const recovered = { reason: 'missed-release', mayNavigate: false, consume: false };
    expect(holdEndFromPointer(pointer('pointermove', NO_BUTTON, 0), combo)).toEqual(recovered);
    // A Left pointerup names no bound button, and `buttons` still shows Back up.
    expect(holdEndFromPointer(pointer('pointerup', LEFT_BUTTON, 0), combo)).toEqual(recovered);
  });

  it('ends on a mouse pointercancel, which no release follows', () => {
    expect(holdEndFromPointer(pointer('pointercancel', 0, BACK), combo)).toEqual({
      reason: 'pointercancel', mayNavigate: false, consume: false,
    });
  });

  it('ignores a touch or a pen, whose buttons say nothing about the mouse', () => {
    expect(holdEndFromPointer(pointer('pointermove', LEFT_BUTTON, LEFT, 'touch'), combo)).toBeNull();
    expect(holdEndFromPointer(pointer('pointerup', LEFT_BUTTON, 0, 'pen'), combo)).toBeNull();
    expect(holdEndFromPointer(pointer('pointercancel', 0, 0, 'touch'), combo)).toBeNull();
  });
});

describe('holdEndFromPointer on a chord', () => {
  it('ends when any button of the chord lifts', () => {
    const combo = 'Mouse:Back+Mouse:Forward';
    expect(holdEndFromPointer(pointer('pointermove', NO_BUTTON, BACK | 16), combo)).toBeNull();
    expect(holdEndFromPointer(pointer('pointermove', 4, BACK), combo)?.reason).toBe('lifted-with-other-button');
  });
});

describe('holdEndFromPointer on a keyboard combo', () => {
  it('leaves a key hold to its keyup', () => {
    expect(holdEndFromPointer(pointer('pointerup', 0, 0), 'Alt+Shift+Q')).toBeNull();
  });
});
