/**
 * The pure rules behind the task-detail split divider, run through the real
 * module useTaskSplitResize.ts imports (hooks/task-split-ratio.ts). The hook
 * itself needs Zustand and document listeners, and the unit tier has no jsdom.
 * The drag, the CustomEvent dispatch and the overlay are covered in
 * tests/ui/task-detail-split-divider.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  clampSplitRatio,
  displayedSplitRatio,
  splitRatioFromPointer,
} from '../../src/renderer/hooks/task-split-ratio';

describe('clampSplitRatio', () => {
  it('passes through a value already within [0.25, 0.75]', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.25)).toBe(0.25);
    expect(clampSplitRatio(0.75)).toBe(0.75);
    expect(clampSplitRatio(0.4)).toBe(0.4);
  });

  it('clamps below-minimum values to 0.25', () => {
    expect(clampSplitRatio(0)).toBe(0.25);
    expect(clampSplitRatio(-1)).toBe(0.25);
    expect(clampSplitRatio(0.249)).toBe(0.25);
  });

  it('clamps above-maximum values to 0.75', () => {
    expect(clampSplitRatio(1)).toBe(0.75);
    expect(clampSplitRatio(2)).toBe(0.75);
    expect(clampSplitRatio(0.751)).toBe(0.75);
  });

  it('pins the bounds and the default to their documented values', () => {
    expect(MIN_SPLIT_RATIO).toBe(0.25);
    expect(MAX_SPLIT_RATIO).toBe(0.75);
    expect(DEFAULT_SPLIT_RATIO).toBe(0.5);
  });
});

describe('splitRatioFromPointer', () => {
  it('is the pointer position as a fraction of the container', () => {
    expect(splitRatioFromPointer(300, 100, 400)).toBe(0.5);
    expect(splitRatioFromPointer(240, 100, 400)).toBe(0.35);
  });

  it('clamps a pointer dragged past either end', () => {
    expect(splitRatioFromPointer(0, 100, 400)).toBe(0.25);
    expect(splitRatioFromPointer(900, 100, 400)).toBe(0.75);
  });

  it('ignores the move for a zero-width container', () => {
    expect(splitRatioFromPointer(300, 100, 0)).toBeNull();
  });
});

describe('displayedSplitRatio', () => {
  it('shows the stored ratio when no drag is in flight', () => {
    expect(displayedSplitRatio(false, 0.3, 0.65)).toBe(0.65);
  });

  it('shows the live ratio while a drag is in flight, ignoring the stored one', () => {
    expect(displayedSplitRatio(true, 0.3, 0.65)).toBe(0.3);
    expect(displayedSplitRatio(true, 0.3, DEFAULT_SPLIT_RATIO)).toBe(0.3);
  });

  it('shows the stored ratio again once the drag ends', () => {
    expect(displayedSplitRatio(false, 0.3, 0.6)).toBe(0.6);
  });
});
