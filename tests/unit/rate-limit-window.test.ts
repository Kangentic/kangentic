import { describe, it, expect } from 'vitest';
import { windowElapsedPercentage } from '../../src/renderer/utils/rate-limit-window';

// All cases pass `nowMs` explicitly, so the helper is fully deterministic and
// these assertions carry no wall-clock or platform dependence.
describe('windowElapsedPercentage', () => {
  const FIVE_HOUR_SECONDS = 5 * 60 * 60; // 18000
  const resetsAt = 1_000_000; // arbitrary epoch seconds
  const windowStartMs = (resetsAt - FIVE_HOUR_SECONDS) * 1000;
  const windowMs = FIVE_HOUR_SECONDS * 1000;

  it('returns ~50 at the midpoint of the window', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, windowStartMs + windowMs / 2)).toBe(50);
  });

  it('returns 0 exactly at the window start', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, windowStartMs)).toBe(0);
  });

  it('clamps to 0 before the window has opened', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, windowStartMs - windowMs)).toBe(0);
  });

  it('reaches 100 exactly at the reset time', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, resetsAt * 1000)).toBe(100);
  });

  it('clamps to 100 once the reset time has passed', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, resetsAt * 1000 + windowMs)).toBe(100);
  });

  it('returns null when there is no usable timing anchor', () => {
    expect(windowElapsedPercentage(0, FIVE_HOUR_SECONDS, Date.now())).toBeNull();
    expect(windowElapsedPercentage(-1, FIVE_HOUR_SECONDS, Date.now())).toBeNull();
    expect(windowElapsedPercentage(resetsAt, 0, Date.now())).toBeNull();
    expect(windowElapsedPercentage(resetsAt, NaN, Date.now())).toBeNull();
    expect(windowElapsedPercentage(NaN, FIVE_HOUR_SECONDS, Date.now())).toBeNull();
  });
});
