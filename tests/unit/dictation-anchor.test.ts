/**
 * Unit coverage for `placeDictationChip` - where the dictation chip sits
 * relative to the thing the words are landing in.
 *
 * The bug this replaces was pure geometry, which is why the geometry is pinned
 * here. The chip anchored to the focused WINDOW and centred horizontally, and in
 * a split task-detail window the window's centre IS the split seam - so the chip
 * straddled the divider whichever side the user was dictating into, and its
 * bottom edge landed on the Browser pane's own controls. The numbers in
 * `SPLIT_WINDOW` below are measured from a real one, so these cases are the
 * actual failure rather than an invented one.
 *
 * `resolveDictationAnchor` itself reads the DOM (element rects) and this tier
 * has no jsdom, so it is covered at the UI tier instead. Everything that DECIDES
 * is in the pure function below.
 */
import { describe, it, expect } from 'vitest';
import { placeDictationChip, type DictationAnchor } from '../../src/renderer/utils/dictation-anchor';

const VIEWPORT = { width: 2560, height: 1392 };
const GAP = 8;
const CHIP = { width: 272, height: 30 };

/** Measured from a live split task-detail window. */
const SPLIT_WINDOW = {
  frame: { left: 538, right: 2022 },
  terminalPane: { left: 539, right: 1280, top: 293, bottom: 1123 },
  browserPane: { left: 1281, right: 2021, top: 293, bottom: 1123 },
  /** The Browser pane's note field, at the very bottom of its toolbar. */
  noteInput: { left: 1579, right: 1943, top: 1091, bottom: 1117 },
};

function rect(box: { left: number; right: number; top: number; bottom: number }) {
  return {
    left: box.left,
    right: box.right,
    top: box.top,
    bottom: box.bottom,
    width: box.right - box.left,
    height: box.bottom - box.top,
  };
}

/** Mirrors `TERMINAL_INPUT_RESERVE_PX`. Duplicated rather than imported because
 *  the point of these cases is to pin the NUMBER: if the constant changes, the
 *  expected clearance should have to change with it, deliberately. */
const RESERVE = 85;

/**
 * What `resolveDictationAnchor` builds for a terminal: the pane's bottom BAND -
 * the agent's input box - centred on the pane.
 *
 * It anchored to the xterm caret at first, via the helper textarea xterm keeps
 * positioned on it for IME composition. That is a real behaviour and still not a
 * usable anchor: an agent TUI hides the cursor, and with it hidden xterm parks
 * the textarea somewhere unrelated (measured at `top: 799px` in an 829px-tall
 * pane while the caret was on line 2), then snaps it onto the caret the instant
 * input arrives. The chip slid across the pane at the start of every utterance.
 */
function terminalAnchor(pane = SPLIT_WINDOW.terminalPane): DictationAnchor {
  const bounds = rect(pane);
  return {
    rect: { ...bounds, top: bounds.bottom - RESERVE, height: RESERVE },
    centerX: (bounds.left + bounds.right) / 2,
    bounds,
  };
}

function inputAnchor(): DictationAnchor {
  const field = rect(SPLIT_WINDOW.noteInput);
  return { rect: field, centerX: (field.left + field.right) / 2, bounds: field };
}

function place(anchor: DictationAnchor, chip = CHIP) {
  return placeDictationChip({
    anchor,
    chipWidth: chip.width,
    chipHeight: chip.height,
    viewport: VIEWPORT,
    gap: GAP,
  });
}

describe('placeDictationChip - the split-window regression', () => {
  it('keeps a terminal-anchored chip entirely inside the TERMINAL pane', () => {
    // THE bug. The old code centred on the window (538..2022 -> 1280), which is
    // the split seam, so the chip spanned roughly 1144..1416 and reached 136px
    // into the Browser pane, on top of its Clear / Inspect buttons.
    const result = place(terminalAnchor());
    expect(result.left).toBeGreaterThanOrEqual(SPLIT_WINDOW.terminalPane.left);
    expect(result.left + CHIP.width).toBeLessThanOrEqual(SPLIT_WINDOW.terminalPane.right);
    // And specifically: it does not reach the seam.
    expect(result.left + CHIP.width).toBeLessThan(SPLIT_WINDOW.browserPane.left);
  });

  it('centres a terminal-anchored chip on the PANE', () => {
    const result = place(terminalAnchor());
    const paneCentre = (SPLIT_WINDOW.terminalPane.left + SPLIT_WINDOW.terminalPane.right) / 2;
    expect(result.left + CHIP.width / 2).toBe(paneCentre);
  });

  it('rests ABOVE the agent input box, the whole utterance', () => {
    // The chip must not move while the user speaks. Nothing in a terminal
    // anchor comes from the terminal's CONTENT, so a repaint, a growing input
    // box, or a caret that jumps cannot shift it - only the pane can.
    const result = place(terminalAnchor());
    expect(result.placement).toBe('above');
    expect(result.top + CHIP.height).toBe(SPLIT_WINDOW.terminalPane.bottom - RESERVE - GAP);
  });

  it('clears the five bottom rows a real agent TUI uses for its input box', () => {
    // The reason the reserve exists, in the units it was measured in. A live
    // Claude TUI puts a rule, the prompt line, a rule, a blank, and the status
    // line in the bottom five rows; the chip used to cover under three of them,
    // so it sat on the words being dictated.
    const CELL = 17;
    const result = place(terminalAnchor());
    const rowsClear = (SPLIT_WINDOW.terminalPane.bottom - (result.top + CHIP.height)) / CELL;
    expect(rowsClear).toBeGreaterThanOrEqual(5);
  });

  it('never pushes the anchor above a pane SHORTER than the reserve', () => {
    // A pane can be dragged down to a few rows. Reserving more than it has
    // would put the anchor outside its own bounds.
    const short = { ...SPLIT_WINDOW.terminalPane, top: SPLIT_WINDOW.terminalPane.bottom - 40 };
    const bounds = rect(short);
    const reserved = Math.min(RESERVE, bounds.height);
    const anchor: DictationAnchor = {
      rect: { ...bounds, top: bounds.bottom - reserved, height: reserved },
      centerX: (bounds.left + bounds.right) / 2,
      bounds,
    };
    expect(anchor.rect.top).toBeGreaterThanOrEqual(bounds.top);
    expect(place(anchor).placement).toBe('above');
  });

  it('moves only when the PANE does', () => {
    // A window drag or a resize still carries the chip along.
    const before = place(terminalAnchor());
    const after = place(terminalAnchor({
      ...SPLIT_WINDOW.terminalPane,
      top: SPLIT_WINDOW.terminalPane.top - 40,
      bottom: SPLIT_WINDOW.terminalPane.bottom - 40,
    }));
    expect(before.top - after.top).toBe(40);
  });
});

describe('placeDictationChip - flipping above', () => {
  it('flips ABOVE a terminal anchor, whose line IS the pane bottom', () => {
    // Below is outside the pane by construction, so a terminal always flips.
    // Not an edge case: it is every terminal dictation.
    const result = place(terminalAnchor());
    expect(result.placement).toBe('above');
  });

  it('flips ABOVE the note input, which is the last row of its pane', () => {
    const result = place(inputAnchor());
    expect(result.placement).toBe('above');
    expect(result.top + CHIP.height).toBe(SPLIT_WINDOW.noteInput.top - GAP);
    // Clear of the field it belongs to, so it never covers what is being typed.
    expect(result.top + CHIP.height).toBeLessThan(SPLIT_WINDOW.noteInput.top);
  });

  it('centres an input-anchored chip on the FIELD', () => {
    const result = place(inputAnchor());
    const fieldCentre = (SPLIT_WINDOW.noteInput.left + SPLIT_WINDOW.noteInput.right) / 2;
    expect(result.left + CHIP.width / 2).toBe(fieldCentre);
  });

  it('flips below-to-above exactly at the boundary, not one pixel early', () => {
    const bounds = rect(SPLIT_WINDOW.terminalPane);
    // Anchor bottom + gap + chip height === pane bottom is the last position
    // that still fits below.
    const fits = bounds.bottom - GAP - CHIP.height;
    const at = (bottom: number): DictationAnchor => ({
      rect: rect({ left: 600, right: 900, top: bottom - 17, bottom }),
      centerX: 750,
      bounds,
    });
    expect(place(at(fits)).placement).toBe('below');
    expect(place(at(fits + 1)).placement).toBe('above');
  });
});

describe('placeDictationChip - clamping', () => {
  it('clamps to the pane rather than overflowing when the anchor hugs an edge', () => {
    const bounds = rect(SPLIT_WINDOW.terminalPane);
    // A pathological anchor whose centre is outside its own pane.
    const line = { ...bounds, top: bounds.bottom, height: 0 };
    const result = place({ rect: line, centerX: bounds.left - 500, bounds });
    expect(result.left).toBe(bounds.left);
  });

  it('never places the chip off the top of the viewport when flipping above', () => {
    const bounds = { left: 0, right: 400, top: 0, bottom: 40, width: 400, height: 40 };
    const anchor: DictationAnchor = {
      rect: { left: 0, right: 40, top: 0, bottom: 12, width: 40, height: 12 },
      centerX: 200,
      bounds,
    };
    const result = place(anchor);
    expect(result.placement).toBe('above');
    expect(result.top).toBe(0);
  });

  it('starts at the pane edge when the pane is NARROWER than the chip', () => {
    // A very thin terminal pane. Overhanging the right edge beats centring the
    // chip on a pane it cannot fit in, which would push it off the left.
    const bounds = { left: 1000, right: 1100, top: 200, bottom: 900, width: 100, height: 700 };
    const anchor: DictationAnchor = {
      rect: { left: 1040, right: 1047, top: 300, bottom: 317, width: 7, height: 17 },
      centerX: 1050,
      bounds,
    };
    expect(place(anchor).left).toBe(1000);
  });
});
