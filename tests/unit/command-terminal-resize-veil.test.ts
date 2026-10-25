/**
 * The lift rule for the veil over a Command Terminal that jumped size: a floor
 * past the agent's own frame, then a quiet beat, and a cap. The timings in
 * `resize-veil.ts` come from four live runs; these replay them.
 */
import { describe, it, expect } from 'vitest';
import {
  msUntilResizeVeilLifts,
  RESIZE_VEIL_MAX_HOLD_MS,
  RESIZE_VEIL_MIN_HOLD_MS,
  RESIZE_VEIL_QUIET_MS,
} from '../../src/renderer/components/command-bar/resize-veil';

/** When the veil comes down for output arriving at `outputAt` ms after the jump. */
function liftTime(outputAt: number[]): number {
  let now = 0;
  let lastOutputAt = 0;
  const pending = [...outputAt];
  for (;;) {
    const wait = msUntilResizeVeilLifts(now, 0, lastOutputAt);
    const next = pending[0];
    if (next !== undefined && next <= now + wait) {
      now = next;
      lastOutputAt = next;
      pending.shift();
      continue;
    }
    return now + wait;
  }
}

describe('msUntilResizeVeilLifts', () => {
  it('holds past the agent frame in every measured run, then lifts after the quiet beat', () => {
    expect(liftTime([29, 131, 162, 186])).toBe(226);
    expect(liftTime([27, 126, 159, 182, 213])).toBe(253);
    expect(liftTime([26, 41, 181, 212])).toBe(252);
    expect(liftTime([0, 31, 157, 172])).toBe(212);
  });

  it('never lifts on the early redraw alone', () => {
    // ConPTY's redraw of the old screen, and then nothing: the floor holds.
    expect(liftTime([27, 41])).toBe(RESIZE_VEIL_MIN_HOLD_MS);
  });

  it('lifts at the floor when no output arrives at all', () => {
    expect(liftTime([])).toBe(RESIZE_VEIL_MIN_HOLD_MS);
  });

  it('is capped under output that never goes quiet', () => {
    const streaming = Array.from({ length: 40 }, (_, index) => index * (RESIZE_VEIL_QUIET_MS - 10));
    expect(liftTime(streaming)).toBe(RESIZE_VEIL_MAX_HOLD_MS);
  });

  it('answers 0 once the moment has passed', () => {
    expect(msUntilResizeVeilLifts(RESIZE_VEIL_MAX_HOLD_MS + 50, 0, 10)).toBe(0);
  });
});
