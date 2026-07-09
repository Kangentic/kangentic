import { describe, it, expect } from 'vitest';
import { computeThumbGeometry, thumbPositionToOffset, MIN_THUMB_SIZE_PX } from '../../src/renderer/components/conversation/scrollbar-math';

/**
 * Pure geometry helpers behind ConversationScrollbar.tsx. Covers: the
 * offset<->thumb-position round trip, the minimum-thumb clamp engaging on a
 * very long transcript, and both scroll extremes pinning the thumb to the
 * rail ends.
 */

describe('computeThumbGeometry', () => {
  it('sizes the thumb proportionally when the proportional size is above the floor', () => {
    // viewport is half the total content -> thumb should be ~half the rail.
    const { thumbSize } = computeThumbGeometry({ scrollOffset: 0, totalSize: 2000, viewportSize: 500, railSize: 500 });
    expect(thumbSize).toBeCloseTo(125, 0);
  });

  it('clamps the thumb to MIN_THUMB_SIZE_PX on a very long transcript', () => {
    const { thumbSize } = computeThumbGeometry({ scrollOffset: 0, totalSize: 500_000, viewportSize: 600, railSize: 600 });
    expect(thumbSize).toBe(MIN_THUMB_SIZE_PX);
  });

  it('pins the thumb to the TOP of the rail at scrollOffset 0', () => {
    const { thumbTop } = computeThumbGeometry({ scrollOffset: 0, totalSize: 500_000, viewportSize: 600, railSize: 600 });
    expect(thumbTop).toBe(0);
  });

  it('pins the thumb to the BOTTOM of the rail at the maximum scroll offset', () => {
    const totalSize = 500_000;
    const viewportSize = 600;
    const railSize = 600;
    const maxOffset = totalSize - viewportSize;
    const { thumbTop, thumbSize } = computeThumbGeometry({ scrollOffset: maxOffset, totalSize, viewportSize, railSize });
    expect(thumbTop + thumbSize).toBeCloseTo(railSize, 0);
  });

  it('handles a zero/negative-size input gracefully (no NaN, no throw)', () => {
    const result = computeThumbGeometry({ scrollOffset: 0, totalSize: 0, viewportSize: 0, railSize: 600 });
    expect(Number.isNaN(result.thumbTop)).toBe(false);
    expect(Number.isNaN(result.thumbSize)).toBe(false);
  });
});

describe('thumbPositionToOffset <-> computeThumbGeometry round trip', () => {
  it('round-trips a mid-scroll position through thumbTop -> offset -> thumbTop', () => {
    const totalSize = 500_000;
    const viewportSize = 600;
    const railSize = 600;
    const originalOffset = 120_000;

    const { thumbTop, thumbSize } = computeThumbGeometry({ scrollOffset: originalOffset, totalSize, viewportSize, railSize });
    const recoveredOffset = thumbPositionToOffset({ thumbTop, thumbSize, totalSize, viewportSize, railSize });
    const { thumbTop: recoveredThumbTop } = computeThumbGeometry({ scrollOffset: recoveredOffset, totalSize, viewportSize, railSize });

    expect(recoveredThumbTop).toBeCloseTo(thumbTop, 1);
  });

  it('dragging the thumb to the very top of the rail maps back to offset 0', () => {
    const offset = thumbPositionToOffset({ thumbTop: 0, thumbSize: MIN_THUMB_SIZE_PX, totalSize: 500_000, viewportSize: 600, railSize: 600 });
    expect(offset).toBe(0);
  });

  it('dragging the thumb to the very bottom of the rail maps back to the maximum scroll offset', () => {
    const totalSize = 500_000;
    const viewportSize = 600;
    const railSize = 600;
    const thumbSize = MIN_THUMB_SIZE_PX;
    const thumbTravel = railSize - thumbSize;

    const offset = thumbPositionToOffset({ thumbTop: thumbTravel, thumbSize, totalSize, viewportSize, railSize });

    expect(offset).toBeCloseTo(totalSize - viewportSize, 0);
  });
});
