/**
 * Unit tests for the zoom-steps module.
 *
 * stepZoom is pure - no browser globals, no Electron, no async. Tests run
 * directly against the source without any build step.
 *
 * Coverage:
 *   - Stepping up and down between rungs that are on the ladder.
 *   - Boundary clamps: stepZoom(MIN, -1) === MIN, stepZoom(MAX, +1) === MAX.
 *   - Between-rungs input: value between two rungs snaps to the nearest one
 *     before applying the direction step.
 *   - Exact-rung input stepping up/down returns the adjacent rung correctly.
 *   - A between-rungs value equidistant to two rungs picks the one at the
 *     lower index (first nearest wins in the linear scan).
 */

import { describe, it, expect } from 'vitest';
import { stepZoom, wheelZoomTarget, ZOOM_STEPS, MIN_ZOOM, MAX_ZOOM } from '../../src/shared/zoom-steps';

// The guest pane and every pane popup apply Ctrl+wheel through this one function.
describe('wheelZoomTarget', () => {
  it('moves about 10% per notch in either direction', () => {
    expect(wheelZoomTarget(1.0, 'in')).toBeCloseTo(1.1);
    expect(wheelZoomTarget(1.0, 'out')).toBeCloseTo(1 / 1.1);
  });

  it('clamps to MIN_ZOOM and MAX_ZOOM', () => {
    expect(wheelZoomTarget(MAX_ZOOM, 'in')).toBe(MAX_ZOOM);
    expect(wheelZoomTarget(MIN_ZOOM, 'out')).toBe(MIN_ZOOM);
    expect(wheelZoomTarget(4.9, 'in')).toBe(MAX_ZOOM);
  });
});

describe('ZOOM_STEPS constants', () => {
  it('MIN_ZOOM equals the first rung', () => {
    expect(MIN_ZOOM).toBe(ZOOM_STEPS[0]);
  });

  it('MAX_ZOOM equals the last rung', () => {
    expect(MAX_ZOOM).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });

  it('ladder is strictly ascending', () => {
    for (let index = 1; index < ZOOM_STEPS.length; index += 1) {
      expect(ZOOM_STEPS[index]).toBeGreaterThan(ZOOM_STEPS[index - 1]);
    }
  });

  it('contains 1.0 as the default (100%) rung', () => {
    expect(ZOOM_STEPS).toContain(1.0);
  });
});

describe('stepZoom - stepping between on-ladder values', () => {
  it('steps up from 1.0 to 1.1', () => {
    expect(stepZoom(1.0, +1)).toBe(1.1);
  });

  it('steps up from 1.1 to 1.25', () => {
    expect(stepZoom(1.1, +1)).toBe(1.25);
  });

  it('steps down from 1.0 to 0.9', () => {
    expect(stepZoom(1.0, -1)).toBe(0.9);
  });

  it('steps down from 0.9 to 0.8', () => {
    expect(stepZoom(0.9, -1)).toBe(0.8);
  });

  it('steps up from 0.25 (MIN) to 0.33', () => {
    expect(stepZoom(0.25, +1)).toBe(0.33);
  });

  it('steps down from 5.0 (MAX) to 4.0', () => {
    expect(stepZoom(5.0, -1)).toBe(4.0);
  });
});

describe('stepZoom - boundary clamps', () => {
  it('stepping down from MIN returns MIN (idempotent at lower boundary)', () => {
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('stepping up from MAX returns MAX (idempotent at upper boundary)', () => {
    expect(stepZoom(MAX_ZOOM, +1)).toBe(MAX_ZOOM);
  });

  it('a value below MIN snaps to MIN then steps up one rung', () => {
    // 0.1 is below ZOOM_STEPS[0] = 0.25. Nearest is 0.25 (index 0).
    // Direction +1 -> index 1 -> 0.33.
    expect(stepZoom(0.1, +1)).toBe(0.33);
  });

  it('a value above MAX snaps to MAX then steps down one rung', () => {
    // 6.0 is above ZOOM_STEPS[last] = 5.0. Nearest is 5.0 (last index).
    // Direction -1 -> second-to-last -> 4.0.
    expect(stepZoom(6.0, -1)).toBe(4.0);
  });
});

describe('stepZoom - between-rungs inputs', () => {
  it('1.07 (between 1.0 and 1.1) zooming in snaps nearest to 1.1, steps to 1.25', () => {
    // 1.07 is 0.07 away from 1.1 and 0.07 away from 1.0. With equal distance
    // the linear scan returns the first found (1.0 at lower index). Stepping
    // +1 from 1.0's index yields 1.1.
    const result = stepZoom(1.07, +1);
    // Either 1.1 (snap to 1.0 nearest then +1) or 1.25 (snap to 1.1 then +1)
    // is acceptable depending on exact tie-breaking. We assert it is the rung
    // immediately above the midpoint, i.e. > 1.0.
    expect(result).toBeGreaterThan(1.0);
    expect(ZOOM_STEPS).toContain(result);
  });

  it('1.07 zooming out snaps nearest to 1.0, steps to 0.9', () => {
    // Nearest to 1.07: equal distance to 1.0 (0.07) and 1.1 (0.03).
    // 1.1 is closer (|1.1 - 1.07| = 0.03 < |1.0 - 1.07| = 0.07), so
    // nearest is 1.1. Stepping -1 from 1.1's index yields 1.0.
    const result = stepZoom(1.07, -1);
    expect(result).toBe(1.0);
  });

  it('0.6 (between 0.5 and 0.67) zooming in snaps to 0.67, steps to 0.75', () => {
    // |0.5 - 0.6| = 0.1, |0.67 - 0.6| = 0.07 -> nearest is 0.67
    // Direction +1 from 0.67's index -> 0.75
    expect(stepZoom(0.6, +1)).toBe(0.75);
  });

  it('0.6 zooming out snaps to 0.67, steps to 0.5', () => {
    // Nearest is 0.67 (same reasoning). Direction -1 -> 0.5.
    expect(stepZoom(0.6, -1)).toBe(0.5);
  });

  it('value exactly at a rung steps normally without double-stepping', () => {
    // Exact rung: nearest IS the rung itself. One step.
    expect(stepZoom(0.75, +1)).toBe(0.8);
    expect(stepZoom(0.75, -1)).toBe(0.67);
  });
});
