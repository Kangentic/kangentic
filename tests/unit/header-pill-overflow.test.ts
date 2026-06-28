/**
 * Unit coverage for the task-detail / command-terminal header overflow math
 * (`computeHiddenPills`), the pure core extracted from `useHeaderPillOverflow`.
 *
 * This is the robust, font-independent companion to the UI spec
 * (`tests/ui/task-detail-header-overflow.spec.ts`). The UI spec can prove the
 * extreme cases (a screen-wide title always truncates; a maximized window shows the
 * pills), but the floor's defining behavior - reserving only ~50ch of the title so
 * pills reclaim the rest, instead of reserving the title's FULL natural width - only
 * flips a pill's visibility inside a narrow, font-sensitive width band that a DOM
 * test cannot pin without flaking. Driving the pure function with synthetic
 * measurements pins exactly that behavior with zero DOM or font dependence.
 */
import { describe, it, expect } from 'vitest';
import {
  computeHiddenPills,
  type HeaderOverflowMeasurements,
  type HeaderPillSpec,
} from '../../src/renderer/components/dialogs/task-detail/useHeaderPillOverflow';

/** A measurement base with no pills folded; tests override the interesting fields. */
function measurements(overrides: Partial<HeaderOverflowMeasurements>): HeaderOverflowMeasurements {
  return {
    headerWidth: 1000,
    leadingWidth: 100,
    trailingWidth: 100,
    titleNaturalWidth: 100,
    titleCharCount: 10,
    pillWidths: new Map(),
    ...overrides,
  };
}

describe('computeHiddenPills', () => {
  it('reserves only the ~50ch floor, so a long title does NOT bury the pills', () => {
    const pills: HeaderPillSpec[] = [
      { id: 'a', priority: 50 },
      { id: 'b', priority: 40 },
    ];
    // A title far wider than the header: natural width 5000px, 500 chars -> average
    // char width 10px, so the floor is 50 * 10 = 500px (clamped under 5000). The old
    // behavior reserved the FULL 5000px, which would push `available` deeply negative
    // and fold BOTH pills. With the 500px floor there is room for both.
    const hidden = computeHiddenPills(
      pills,
      measurements({
        headerWidth: 1000,
        titleNaturalWidth: 5000,
        titleCharCount: 500,
        pillWidths: new Map([
          ['a', 80],
          ['b', 80],
        ]),
      }),
    );
    // Reverting the floor to a full-natural-width reserve makes this go red.
    expect(hidden).toEqual(new Set());
  });

  it('folds the lowest-priority pill first when the leftover runs out', () => {
    const pills: HeaderPillSpec[] = [
      { id: 'high', priority: 50 },
      { id: 'mid', priority: 30 },
      { id: 'low', priority: 10 },
    ];
    // Tuned so exactly two of three 100px pills fit: the two highest priorities stay,
    // the lowest folds. (available ~= 250px: 100 + 100+12 fits, the third 324 does not.)
    const hidden = computeHiddenPills(
      pills,
      measurements({
        headerWidth: 646,
        leadingWidth: 100,
        trailingWidth: 100,
        titleNaturalWidth: 120,
        titleCharCount: 12,
        pillWidths: new Map([
          ['high', 100],
          ['mid', 100],
          ['low', 100],
        ]),
      }),
    );
    expect(hidden).toEqual(new Set(['low']));
  });

  it('keeps an as-yet-unmeasured pill so it can measure on the next pass', () => {
    const pills: HeaderPillSpec[] = [
      { id: 'measured', priority: 50 },
      { id: 'unmeasured', priority: 10 },
    ];
    // No room for anything (huge title floor), but the unmeasured pill (absent from
    // pillWidths) is shown regardless so it can report its width next pass.
    const hidden = computeHiddenPills(
      pills,
      measurements({
        headerWidth: 500,
        titleNaturalWidth: 5000,
        titleCharCount: 250,
        pillWidths: new Map([['measured', 100]]),
      }),
    );
    expect(hidden.has('measured')).toBe(true);
    expect(hidden.has('unmeasured')).toBe(false);
  });

  it('clamps the floor to the natural width for a short title', () => {
    const pills: HeaderPillSpec[] = [{ id: 'a', priority: 50 }];
    // Short title: natural 80px, 8 chars -> average char 10px. An unclamped floor
    // would reserve 50 * 10 = 500px and fold the pill; the Math.min clamp reserves
    // only the 80px the title needs, leaving room for the 100px pill.
    const hidden = computeHiddenPills(
      pills,
      measurements({
        headerWidth: 400,
        leadingWidth: 50,
        trailingWidth: 50,
        titleNaturalWidth: 80,
        titleCharCount: 8,
        pillWidths: new Map([['a', 100]]),
      }),
    );
    expect(hidden).toEqual(new Set());
  });

  it('is safe for an empty title (no NaN from a zero char count)', () => {
    const pills: HeaderPillSpec[] = [{ id: 'a', priority: 50 }];
    const compute = () =>
      computeHiddenPills(
        pills,
        measurements({
          headerWidth: 1000,
          titleNaturalWidth: 0,
          titleCharCount: 0,
          pillWidths: new Map([['a', 100]]),
        }),
      );
    expect(compute).not.toThrow();
    // Zero floor + a wide header leaves ample room, so the pill stays.
    expect(compute()).toEqual(new Set());
  });
});
