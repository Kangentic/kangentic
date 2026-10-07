/**
 * Pins the pre-registered Phase 0 decision rules in scripts/review-eval/decide.mjs at their
 * boundaries, so a threshold cannot move after a result is in without a test going red:
 *
 * 1. E1 picks the cheapest arm within one hit of the best recall, and B wins a recall tie with C.
 * 2. E2 adopts the precision bar only when recall holds AND the volume cut is at least 30%,
 *    with exactly 30% adopting.
 * 3. E3 adopts delta verify at 3 of 4 caught and refuses at 2, and D5 is never counted.
 */
import { describe, it, expect } from 'vitest';
import { pickCorrectnessArm, adoptPrecisionBar, adoptDeltaVerify } from '../../scripts/review-eval/decide.mjs';

describe('E1 pickCorrectnessArm', () => {
  it('takes the cheapest arm within one hit of the best', () => {
    const result = pickCorrectnessArm([
      { name: 'A', lateHits: 4, costUsd: 3 },
      { name: 'B', lateHits: 5, costUsd: 5 },
      { name: 'C', lateHits: 5.5, costUsd: 20 },
    ]);
    expect(result.bestHits).toBe(5.5);
    expect(result.eligible).toEqual(['B', 'C']);
    expect(result.chosen).toBe('B');
  });

  it('accepts an arm exactly one hit below the best', () => {
    const result = pickCorrectnessArm([
      { name: 'A', lateHits: 4, costUsd: 2 },
      { name: 'C', lateHits: 5, costUsd: 20 },
    ]);
    expect(result.chosen).toBe('A');
  });

  it('lets B win a recall tie with C even when C is cheaper', () => {
    const result = pickCorrectnessArm([
      { name: 'A', lateHits: 2, costUsd: 1 },
      { name: 'B', lateHits: 6, costUsd: 9 },
      { name: 'C', lateHits: 6, costUsd: 8 },
    ]);
    expect(result.chosen).toBe('B');
  });

  it('keeps C when it is cheapest and B trails it', () => {
    const result = pickCorrectnessArm([
      { name: 'B', lateHits: 5, costUsd: 9 },
      { name: 'C', lateHits: 6, costUsd: 8 },
    ]);
    expect(result.chosen).toBe('C');
  });
});

describe('E2 adoptPrecisionBar', () => {
  it('adopts at exactly a 30% cut with recall held', () => {
    expect(adoptPrecisionBar({ lateHits: 3, totalRaised: 100 }, { lateHits: 3, totalRaised: 70 })).toEqual({
      adopt: true,
      recallHeld: true,
      volumeCut: 0.3,
    });
  });

  it('refuses a 29% cut', () => {
    expect(adoptPrecisionBar({ lateHits: 3, totalRaised: 100 }, { lateHits: 3, totalRaised: 71 }).adopt).toBe(false);
  });

  it('refuses any recall drop, however large the cut', () => {
    const result = adoptPrecisionBar({ lateHits: 3, totalRaised: 100 }, { lateHits: 2.5, totalRaised: 20 });
    expect(result.recallHeld).toBe(false);
    expect(result.adopt).toBe(false);
  });
});

describe('E3 adoptDeltaVerify', () => {
  it('adopts at 3 of 4 and ignores D5', () => {
    expect(adoptDeltaVerify({ D1: true, D2: true, D3: true, D4: false, D5: false })).toEqual({ adopt: true, caught: 3, of: 4 });
  });

  it('refuses at 2 of 4', () => {
    expect(adoptDeltaVerify({ D1: true, D2: false, D3: true, D4: false }).adopt).toBe(false);
  });

  it('throws when a counted case has no result', () => {
    expect(() => adoptDeltaVerify({ D1: true, D2: true, D3: true })).toThrow('D4');
  });
});
