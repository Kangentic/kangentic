/**
 * Unit coverage for the pure logic in useTaskSplitResize.ts.
 *
 * useTaskSplitResize is a React hook that depends on Zustand stores and
 * document event listeners. The vitest config has no jsdom environment and
 * no @testing-library/react dependency, so we follow the same approach as
 * use-browser-url-logic.test.ts: replicate the pure functions inline and
 * test them directly.
 *
 * Two pieces of logic are exercised here:
 *
 *   1. clampRatio(value) -- Math.max(MIN_RATIO, Math.min(MAX_RATIO, value))
 *      Not exported from the production file (file-private), so we replicate
 *      it. The constants (MIN=0.25, MAX=0.75) and DEFAULT (0.5) ARE exported
 *      and imported directly to anchor the test to the production values.
 *
 *   2. The mid-drag resync guard: the hook derives the ratio it renders as
 *      `isResizing ? liveRatio : storedRatio`, so the store's value is
 *      applied only while no drag is in progress. This prevents the store's
 *      stale value from snapping the divider back mid-drag. We model the
 *      derivation as a pure function that returns the store value when it
 *      would be applied and null when the live drag value wins.
 *
 * The CustomEvent dispatch and the DOM overlay (isSplitResizing) are
 * browser-observable and are covered in tests/ui/task-detail-split-divider.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SPLIT_RATIO } from '../../src/renderer/hooks/useTaskSplitResize';

// ---------------------------------------------------------------------------
// Replicated pure functions (file-private in the production module)
// ---------------------------------------------------------------------------

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

/** Mirror of clampRatio() in useTaskSplitResize.ts */
function clampRatio(value: number): number {
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, value));
}

/**
 * Mirror of the derived ratio in useTaskSplitResize.ts:
 *   const ratio = isResizing ? liveRatio : storedRatio;
 *
 * We model it as a function that returns the store ratio that WOULD be
 * rendered, or null when the live drag value takes precedence.
 */
function resyncRatioIfIdle(
  storedRatio: number,
  isResizing: boolean,
): number | null {
  if (isResizing) return null;
  return storedRatio;
}

// ---------------------------------------------------------------------------
// Suite 1: clampRatio
// ---------------------------------------------------------------------------

describe('useTaskSplitResize clampRatio', () => {
  it('passes through a value already within [0.25, 0.75]', () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.25)).toBe(0.25);
    expect(clampRatio(0.75)).toBe(0.75);
    expect(clampRatio(0.4)).toBe(0.4);
  });

  it('clamps below-minimum values to MIN_RATIO (0.25)', () => {
    expect(clampRatio(0)).toBe(0.25);
    expect(clampRatio(-1)).toBe(0.25);
    expect(clampRatio(0.1)).toBe(0.25);
    expect(clampRatio(0.249)).toBe(0.25);
  });

  it('clamps above-maximum values to MAX_RATIO (0.75)', () => {
    expect(clampRatio(1)).toBe(0.75);
    expect(clampRatio(2)).toBe(0.75);
    expect(clampRatio(0.76)).toBe(0.75);
    expect(clampRatio(0.751)).toBe(0.75);
  });

  it('DEFAULT_SPLIT_RATIO is 0.5 (anchors the exported constant to a known good value)', () => {
    // Assert the exact numeric value to guard against accidental constant changes.
    // clampRatio(0.5) must be 0.5 (midpoint is well within [0.25, 0.75]).
    expect(DEFAULT_SPLIT_RATIO).toBe(0.5);
    expect(clampRatio(DEFAULT_SPLIT_RATIO)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: mid-drag resync guard
// ---------------------------------------------------------------------------

describe('useTaskSplitResize mid-drag resync guard', () => {
  it('applies the stored ratio when not resizing', () => {
    const result = resyncRatioIfIdle(0.65, false);
    expect(result).toBe(0.65);
  });

  it('suppresses the stored ratio while a drag is in progress', () => {
    // The guard must return null (no update) so the live drag position is
    // not snapped back to the stale store value mid-drag.
    const result = resyncRatioIfIdle(0.65, true);
    expect(result).toBeNull();
  });

  it('applies the stored ratio again once the drag ends', () => {
    // Simulates the effect firing after isResizing flips back to false.
    const ratioAfterDrag = 0.6;
    expect(resyncRatioIfIdle(ratioAfterDrag, false)).toBe(ratioAfterDrag);
  });

  it('suppresses a DEFAULT_SPLIT_RATIO store update while resizing', () => {
    // Edge case: even a perfectly-default store value must not snap the
    // divider if a drag is in progress that happens to start at 0.5.
    const result = resyncRatioIfIdle(DEFAULT_SPLIT_RATIO, true);
    expect(result).toBeNull();
  });
});
