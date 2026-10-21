import { describe, it, expect } from 'vitest';
import {
  computeThumbGeometry,
  thumbPositionToOffset,
  isScrolledToBottom,
  logicalAtOffset,
  offsetAtLogical,
  MIN_THUMB_SIZE_PX,
  BOTTOM_EPSILON_PX,
} from '../../src/renderer/components/conversation/scrollbar-math';

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
});

describe('isScrolledToBottom', () => {
  it('is true when scrollTop + clientHeight exactly reaches scrollHeight', () => {
    expect(isScrolledToBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 })).toBe(true);
  });

  it('is true within the epsilon (sub-pixel rounding tolerance)', () => {
    expect(isScrolledToBottom({ scrollTop: 400 - BOTTOM_EPSILON_PX, scrollHeight: 1000, clientHeight: 600 })).toBe(true);
  });

  it('is false just beyond the epsilon', () => {
    expect(isScrolledToBottom({ scrollTop: 400 - BOTTOM_EPSILON_PX - 1, scrollHeight: 1000, clientHeight: 600 })).toBe(false);
  });

  it('is false when scrolled to the top of a long transcript', () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 10_000, clientHeight: 600 })).toBe(false);
  });

  it('is true when content does not overflow the viewport at all', () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
  });

  it('honors a custom epsilon override', () => {
    expect(isScrolledToBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 600 }, 150)).toBe(true);
    expect(isScrolledToBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 600 }, 50)).toBe(false);
  });
});

describe('logicalAtOffset and offsetAtLogical (a paged window)', () => {
  // Ten rows of 100px each; row i sits at logical 10*i, the window ends at 100.
  const rowLogical = Array.from({ length: 10 }, (_, index) => index * 10);
  const itemAt = (index: number) => (index >= 0 && index < 10 ? { index, start: index * 100, size: 100 } : undefined);
  const itemForOffset = (offset: number) => itemAt(Math.min(9, Math.max(0, Math.floor(offset / 100))));
  const mapping = { rowLogical, itemAt, logicalEnd: 100 };

  it('interpolates a pixel offset through the row it lands in', () => {
    expect(logicalAtOffset({ ...mapping, itemForOffset, offset: 0 })).toBe(0);
    expect(logicalAtOffset({ ...mapping, itemForOffset, offset: 150 })).toBe(15);
    expect(logicalAtOffset({ ...mapping, itemForOffset, offset: 5000 })).toBe(100);
  });

  it('maps a logical position back to its pixel offset', () => {
    const offset = offsetAtLogical({ ...mapping, logical: 15, startLoaded: false, endLoaded: false, maxOffset: 400 });
    expect(offset).toBe(150);
    expect(logicalAtOffset({ ...mapping, itemForOffset, offset: offset! })).toBe(15);
  });

  it('answers null past an edge with more to load, and clamps past one with none', () => {
    const before = { ...mapping, logical: -5, maxOffset: 400 };
    expect(offsetAtLogical({ ...before, startLoaded: false, endLoaded: false })).toBeNull();
    expect(offsetAtLogical({ ...before, startLoaded: true, endLoaded: false })).toBe(0);
    const after = { ...mapping, logical: 120, maxOffset: 400 };
    expect(offsetAtLogical({ ...after, startLoaded: false, endLoaded: false })).toBeNull();
    expect(offsetAtLogical({ ...after, startLoaded: false, endLoaded: true })).toBe(400);
  });
});

describe('thumbPositionToOffset <-> computeThumbGeometry round trip (top/bottom pins)', () => {
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
