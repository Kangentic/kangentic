/**
 * Pins the pre-registered Phase 0 decision rules in scripts/review-eval/decide.mjs at their
 * boundaries, so a threshold cannot move after a result is in without a test going red:
 *
 * 1. E1 picks the cheapest arm within one hit of the best recall, and B wins a recall tie with C.
 * 2. E2 adopts the precision bar only when recall holds AND the volume cut is at least 30%,
 *    with exactly 30% adopting.
 * 3. E3 adopts delta verify at 3 of 4 caught and refuses at 2, and D5 is never counted.
 * 4. Malformed input throws instead of deciding: no arms for E1, and a missing or non-boolean
 *    result for any counted E3 case.
 * 5. E5 (2026-10-07) adopts a candidate finder model only when all four bars hold against E2 arm A:
 *    mean late hits at least 1.5 - 1 (0.5 adopts, 0 refuses), S4 P1 to P3 in both repetitions,
 *    at most 2 distinct negatives (3 refuses), at most 117 raised (118 refuses). Of the passing
 *    arms the cheapest wins, an exact cost tie goes to the lower effort, and none passing keeps
 *    the incumbent.
 * 6. E6 adopts a candidate auditor model only at 4 of 4 plants found over two runs, with no more
 *    false findings than the incumbent.
 */
import { describe, it, expect } from 'vitest';
import {
  pickCorrectnessArm,
  adoptPrecisionBar,
  adoptDeltaVerify,
  E2_ARM_A,
  adoptFinderModel,
  pickFinderModel,
  adoptAuditorModel,
} from '../../scripts/review-eval/decide.mjs';

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

  it('throws on an empty arm list instead of picking from nothing', () => {
    expect(() => pickCorrectnessArm([])).toThrow('needs at least one arm');
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

  it('throws when the FIRST counted case is the one missing', () => {
    expect(() => adoptDeltaVerify({ D2: true, D3: true, D4: true })).toThrow('D1');
  });

  it('throws on a counted case whose result is not a boolean', () => {
    expect(() => adoptDeltaVerify({ D1: true, D2: 'yes', D3: true, D4: true } as unknown as Record<string, boolean>)).toThrow('D2');
    expect(() => adoptDeltaVerify({ D1: true, D2: true, D3: 1, D4: true } as unknown as Record<string, boolean>)).toThrow('D3');
  });

  it('does not throw when only the D5 control is missing', () => {
    expect(() => adoptDeltaVerify({ D1: true, D2: true, D3: true, D4: true })).not.toThrow();
  });
});

const ALL_POSITIVES = ['S4-P1', 'S4-P2', 'S4-P3'];

/** A candidate that sits exactly on every E5 bar. */
function boundaryArm(overrides: Record<string, unknown> = {}) {
  return {
    name: 'haiku-medium',
    effort: 'medium',
    costUsd: 3,
    lateHitsByRep: [0, 1],
    s4PositivesByRep: [ALL_POSITIVES, [...ALL_POSITIVES].reverse()],
    negativesRaised: ['S2-N1', 'S2-N2', 'S2-N1'],
    totalRaised: 117,
    ...overrides,
  };
}

describe('E5 adoptFinderModel', () => {
  it('pins the E2 arm A baseline the bars compare against', () => {
    expect(E2_ARM_A).toEqual({ lateHits: 1.5, negativesRaised: 2, totalRaised: 117 });
  });

  it('adopts an arm sitting exactly on every bar, counting a repeated negative once', () => {
    expect(adoptFinderModel(E2_ARM_A, boundaryArm())).toEqual({
      adopt: true,
      lateHits: 0.5,
      recallHeld: true,
      positivesHeld: true,
      negatives: 2,
      negativesHeld: true,
      totalRaised: 117,
      volumeHeld: true,
    });
  });

  it('refuses a mean of 0 late hits, one and a half below the baseline', () => {
    const result = adoptFinderModel(E2_ARM_A, boundaryArm({ lateHitsByRep: [0, 0] }));
    expect(result.recallHeld).toBe(false);
    expect(result.adopt).toBe(false);
  });

  it('refuses when one repetition misses one S4 positive', () => {
    const result = adoptFinderModel(E2_ARM_A, boundaryArm({ s4PositivesByRep: [ALL_POSITIVES, ['S4-P1', 'S4-P3']] }));
    expect(result.positivesHeld).toBe(false);
    expect(result.adopt).toBe(false);
  });

  it('refuses a third distinct negative', () => {
    const result = adoptFinderModel(E2_ARM_A, boundaryArm({ negativesRaised: ['S2-N1', 'S2-N2', 'S3-N1'] }));
    expect(result.negatives).toBe(3);
    expect(result.adopt).toBe(false);
  });

  it('refuses 118 raised', () => {
    const result = adoptFinderModel(E2_ARM_A, boundaryArm({ totalRaised: 118 }));
    expect(result.volumeHeld).toBe(false);
    expect(result.adopt).toBe(false);
  });

  it('throws on a repetition count other than two, and on a missing field', () => {
    expect(() => adoptFinderModel(E2_ARM_A, boundaryArm({ lateHitsByRep: [1] }))).toThrow('exactly 2 repetitions');
    expect(() => adoptFinderModel(E2_ARM_A, boundaryArm({ s4PositivesByRep: [ALL_POSITIVES, ALL_POSITIVES, ALL_POSITIVES] }))).toThrow('exactly 2');
    expect(() => adoptFinderModel(E2_ARM_A, boundaryArm({ negativesRaised: undefined }))).toThrow('negativesRaised');
    expect(() => adoptFinderModel(E2_ARM_A, boundaryArm({ totalRaised: undefined }))).toThrow('totalRaised');
  });
});

describe('E5 pickFinderModel', () => {
  it('takes the cheaper of two passing arms', () => {
    const result = pickFinderModel(E2_ARM_A, [
      boundaryArm({ name: 'haiku-high', effort: 'high', costUsd: 2 }),
      boundaryArm({ name: 'haiku-medium', effort: 'medium', costUsd: 3 }),
    ]);
    expect(result.chosen).toBe('haiku-high');
    expect(result.passing).toEqual(['haiku-high', 'haiku-medium']);
  });

  it('gives an exact cost tie to the lower effort', () => {
    const result = pickFinderModel(E2_ARM_A, [
      boundaryArm({ name: 'haiku-high', effort: 'high', costUsd: 3 }),
      boundaryArm({ name: 'haiku-medium', effort: 'medium', costUsd: 3 }),
    ]);
    expect(result.chosen).toBe('haiku-medium');
  });

  it('skips a cheaper arm that fails a bar', () => {
    const result = pickFinderModel(E2_ARM_A, [
      boundaryArm({ name: 'haiku-medium', effort: 'medium', costUsd: 1, totalRaised: 118 }),
      boundaryArm({ name: 'haiku-high', effort: 'high', costUsd: 4 }),
    ]);
    expect(result.chosen).toBe('haiku-high');
    expect(result.verdicts['haiku-medium'].adopt).toBe(false);
  });

  it('returns null, keeping the incumbent, when no arm passes', () => {
    const result = pickFinderModel(E2_ARM_A, [boundaryArm({ lateHitsByRep: [0, 0] }), boundaryArm({ name: 'haiku-high', effort: 'high', negativesRaised: ['a', 'b', 'c'] })]);
    expect(result).toMatchObject({ chosen: null, passing: [] });
  });

  it('throws on no arms, an unknown effort, or a missing cost', () => {
    expect(() => pickFinderModel(E2_ARM_A, [])).toThrow('at least one arm');
    expect(() => pickFinderModel(E2_ARM_A, [boundaryArm({ effort: 'turbo' })])).toThrow('unknown effort');
    expect(() => pickFinderModel(E2_ARM_A, [boundaryArm({ costUsd: undefined })])).toThrow('costUsd');
  });
});

describe('E6 adoptAuditorModel', () => {
  const found = { missingFound: true, extraFound: true, falseFindings: 0 };

  it('adopts at 4 of 4 plants found with no more false findings than the incumbent', () => {
    expect(adoptAuditorModel([found, { ...found, falseFindings: 1 }], [{ ...found, falseFindings: 1 }, found])).toEqual({
      adopt: true,
      candidateFound: 4,
      incumbentFound: 4,
      of: 4,
      candidateFalse: 1,
      incumbentFalse: 1,
    });
  });

  it('refuses at 3 of 4, even when the incumbent did worse', () => {
    const missedOnce = { ...found, extraFound: false };
    const result = adoptAuditorModel([missedOnce, missedOnce], [found, missedOnce]);
    expect(result.candidateFound).toBe(3);
    expect(result.adopt).toBe(false);
  });

  it('refuses one false finding more than the incumbent', () => {
    expect(adoptAuditorModel([found, found], [found, { ...found, falseFindings: 1 }]).adopt).toBe(false);
  });

  it('throws on a run count other than two or a malformed run', () => {
    expect(() => adoptAuditorModel([found], [found, found])).toThrow('exactly 2 runs');
    expect(() => adoptAuditorModel([found, found], [found, { missingFound: true, extraFound: 'yes', falseFindings: 0 } as unknown as typeof found])).toThrow('candidate');
  });
});
