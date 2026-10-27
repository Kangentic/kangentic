/**
 * `expectHoldThenDraw` reads "the change showed before the terminals drew" from the
 * frames' own hold marker, never from a frame's stamp against the page's clock. These
 * recordings are built by hand (no browser, no page) so each shape the helper must
 * tell apart is pinned: the starved runner it once failed on, a layout that really
 * was held back, and the ordinary ones.
 */
import { test, expect } from '@playwright/test';
import { expectHoldThenDraw, type LayoutChangeRecording } from './helpers';

const PICTURE_BYTES = 100;
const picture = (bright: number, value: number) => {
  const bytes = new Uint8Array(PICTURE_BYTES);
  bytes.fill(value, 0, bright);
  return bytes;
};
const BEFORE = picture(0, 0);
/** The new layout with every terminal still showing its kept frame. */
const HELD = picture(50, 200);
/** The new layout with each terminal's new frame drawn. */
const DRAWN = picture(100, 200);

const ACTED_AT = 1_000;

/** A recording whose frames are given as `[milliseconds from the action, picture, holding]`. */
function recording(
  frames: Array<[number, Uint8Array, boolean]>,
  heldMs: number,
  drawnMs: number,
): LayoutChangeRecording {
  return {
    frames: frames.map(([ms, shown, holding]) => ({ at: ACTED_AT + ms / 1000, picture: shown, holding })),
    actedAt: ACTED_AT,
    heldAt: ACTED_AT + heldMs / 1000,
    drawnAt: ACTED_AT + drawnMs / 1000,
    scopeBox: { x: 0, y: 0, width: 100, height: 1 },
    pictureWidth: 100,
    pictureHeight: 1,
  };
}

test.describe('expectHoldThenDraw', () => {
  test('a starved compositor that painted nothing inside the hold is not a held-back layout', () => {
    // The shape a loaded CI runner recorded: the terminals held from +259 ms to +695 ms, and the
    // screen's first frame after the action was stamped at +698 ms, 3 ms past the draw. Six frames
    // in 1.6 s, none of them painted during the hold.
    expectHoldThenDraw(recording([
      [-52, BEFORE, false],
      [698, HELD, false],
      [1032, DRAWN, false],
    ], 259, 695), 2);
  });

  test('the change showing in a frame painted during the hold passes, whatever the stamps say', () => {
    // The stamp of the held frame is past the draw time here too: only the marker orders it.
    expectHoldThenDraw(recording([
      [-20, BEFORE, false],
      [700, HELD, true],
      [900, DRAWN, false],
    ], 100, 500), 2);
  });

  test('panel chrome that moves a frame ahead of the terminals\' hold passes', () => {
    // Maximize: the panel's own box changes first, the terminals hold in the hops after it.
    expectHoldThenDraw(recording([
      [-10, BEFORE, false],
      [316, HELD, false],
      [350, HELD, true],
      [651, DRAWN, false],
    ], 236, 541), 2);
  });

  test('a layout held back until the draw fails: the hold frames still show the old picture', () => {
    // Frames painted during the hold show the picture from before, and the change first shows
    // after the marker went off.
    expect(() => expectHoldThenDraw(recording([
      [-10, BEFORE, false],
      [120, BEFORE, true],
      [250, BEFORE, true],
      [420, DRAWN, false],
    ], 100, 400), 2)).toThrow();
  });

  test('a recording where nothing changed on screen fails', () => {
    expect(() => expectHoldThenDraw(recording([
      [-10, BEFORE, false],
      [300, BEFORE, false],
    ], 100, 200), 2)).toThrow();
  });
});
