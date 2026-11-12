/**
 * The board card's artifact count chip: which step ("3 artifacts", "3 artifacts"
 * without the chevron, "3" with it, "3" alone) it takes for the widths it
 * measured, and which of its parts each step shows. The measurement needs a
 * laid-out chip, so the UI tier covers it (`tests/ui/task-artifacts.spec.ts`).
 *
 * What a user loses if this goes: a count cut off mid-word at a narrow column,
 * or a chip that gives up its chevron (the one sign it opens a menu) while the
 * room for it is still there.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import {
  chooseArtifactCountStep,
  countStepShowsChevron,
  countStepShowsWord,
  needsStepMeasure,
  type ArtifactCountStep,
} from '../../src/renderer/components/artifacts/useArtifactCountStep';

/** Widths shaped like a real chip's, widest step first (illustrative). */
const WIDTHS: Record<ArtifactCountStep, number> = {
  full: 120,
  word: 106,
  'number-chevron': 58,
  number: 44,
};

describe('chooseArtifactCountStep', () => {
  it('takes the widest step that fits, full before word before number-chevron', () => {
    expect(chooseArtifactCountStep(WIDTHS, 500)).toBe('full');
    expect(chooseArtifactCountStep(WIDTHS, 120)).toBe('full');
    expect(chooseArtifactCountStep(WIDTHS, 119)).toBe('word');
  });

  it('takes the word step once the chevron no longer fits but the word does', () => {
    expect(chooseArtifactCountStep(WIDTHS, 110)).toBe('word');
    expect(chooseArtifactCountStep(WIDTHS, 106)).toBe('word');
  });

  it('takes number-chevron once the word does not fit', () => {
    expect(chooseArtifactCountStep(WIDTHS, 105)).toBe('number-chevron');
    expect(chooseArtifactCountStep(WIDTHS, 58)).toBe('number-chevron');
  });

  it('falls back to the bare number when nothing fits, even when it does not fit either', () => {
    expect(chooseArtifactCountStep(WIDTHS, 57)).toBe('number');
    expect(chooseArtifactCountStep(WIDTHS, 44)).toBe('number');
    expect(chooseArtifactCountStep(WIDTHS, 10)).toBe('number');
    expect(chooseArtifactCountStep(WIDTHS, 0)).toBe('number');
  });

  it('allows half a pixel of slack for sub-pixel rounding, and no more', () => {
    expect(chooseArtifactCountStep(WIDTHS, 119.5)).toBe('full');
    expect(chooseArtifactCountStep(WIDTHS, 119.4)).toBe('word');
    expect(chooseArtifactCountStep(WIDTHS, 57.5)).toBe('number-chevron');
    expect(chooseArtifactCountStep(WIDTHS, 57.4)).toBe('number');
  });

  it('keeps the widest fit when a wider step measures no wider than a narrower one', () => {
    const equal = { full: 80, word: 80, 'number-chevron': 40, number: 30 };
    expect(chooseArtifactCountStep(equal, 80)).toBe('full');
  });
});

describe('needsStepMeasure', () => {
  // The browser cannot show these apart: "3 artifacts" and "2 artifacts"
  // measure nearly the same, and the UI mock has no hidden-then-shown card.
  it('measures when nothing has been measured yet', () => {
    expect(needsStepMeasure(null, '3 artifacts')).toBe(true);
  });

  it('reuses the widths for the label they were measured for', () => {
    expect(needsStepMeasure({ countLabel: '3 artifacts', widths: WIDTHS }, '3 artifacts')).toBe(false);
  });

  it('measures again when the label changes, as after an edit or a language switch', () => {
    expect(needsStepMeasure({ countLabel: '3 artifacts', widths: WIDTHS }, '2 artifacts')).toBe(true);
    expect(needsStepMeasure({ countLabel: '3 artifacts', widths: WIDTHS }, '3 Artefakte')).toBe(true);
  });

  it('measures again when the first read came from a hidden chip', () => {
    const hidden = { full: 0, word: 0, 'number-chevron': 0, number: 0 };
    expect(needsStepMeasure({ countLabel: '3 artifacts', widths: hidden }, '3 artifacts')).toBe(true);
  });
});

describe('step predicates', () => {
  const STEPS: ArtifactCountStep[] = ['full', 'word', 'number-chevron', 'number'];

  it('shows the count word at full and word only', () => {
    expect(STEPS.map(countStepShowsWord)).toEqual([true, true, false, false]);
  });

  it('shows the chevron at full and number-chevron only', () => {
    expect(STEPS.map(countStepShowsChevron)).toEqual([true, false, true, false]);
  });
});
