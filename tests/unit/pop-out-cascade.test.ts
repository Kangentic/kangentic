/**
 * Unit tests for the pure cascade math behind multi-window pop-out kinds
 * (src/main/pop-out/cascade.ts). Saved pop-out bounds are keyed by KIND, so
 * without the cascade every additional live window of a kind restores exactly
 * stacked on the first.
 */
import { describe, it, expect } from 'vitest';
import { cascadePopOutPosition, CASCADE_STEP_PX } from '../../src/main/pop-out/cascade';

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

describe('cascadePopOutPosition', () => {
  it('returns the base position unchanged when no window of the kind is live', () => {
    const base = { x: 100, y: 80, width: 900, height: 700 };
    expect(cascadePopOutPosition(base, 0, WORK_AREA)).toEqual({ x: 100, y: 80 });
  });

  it('offsets down-right by one step per already-live window', () => {
    const base = { x: 100, y: 80, width: 900, height: 700 };
    expect(cascadePopOutPosition(base, 1, WORK_AREA)).toEqual({ x: 100 + CASCADE_STEP_PX, y: 80 + CASCADE_STEP_PX });
    expect(cascadePopOutPosition(base, 2, WORK_AREA)).toEqual({ x: 100 + 2 * CASCADE_STEP_PX, y: 80 + 2 * CASCADE_STEP_PX });
    expect(cascadePopOutPosition(base, 3, WORK_AREA)).toEqual({ x: 100 + 3 * CASCADE_STEP_PX, y: 80 + 3 * CASCADE_STEP_PX });
  });

  it('wraps an axis back near the work-area origin instead of walking off the right edge', () => {
    // 1920 - 900 = 1020 max x; base 1010 + 28 overflows.
    const base = { x: 1010, y: 80, width: 900, height: 700 };
    expect(cascadePopOutPosition(base, 1, WORK_AREA)).toEqual({ x: WORK_AREA.x + CASCADE_STEP_PX, y: 80 + CASCADE_STEP_PX });
  });

  it('wraps an axis back near the work-area origin instead of walking off the bottom edge', () => {
    // 1080 - 700 = 380 max y; base 370 + 28 overflows.
    const base = { x: 100, y: 370, width: 900, height: 700 };
    expect(cascadePopOutPosition(base, 1, WORK_AREA)).toEqual({ x: 100 + CASCADE_STEP_PX, y: WORK_AREA.y + CASCADE_STEP_PX });
  });

  it('wraps each axis independently, honoring a non-origin work area (secondary display)', () => {
    const workArea = { x: 1920, y: 40, width: 1280, height: 960 };
    // x overflows (1920 + 1280 - 900 = 2300 max; 2295 + 28 > 3200 edge), y fits.
    const base = { x: 2295, y: 100, width: 900, height: 700 };
    expect(cascadePopOutPosition(base, 1, workArea)).toEqual({ x: workArea.x + CASCADE_STEP_PX, y: 100 + CASCADE_STEP_PX });
  });

  /**
   * A window that fills the vertical axis leaves no room for a y offset (not
   * even the wrapped one): it must stay flush with the work-area top rather
   * than hang off the bottom edge, cascading on x alone.
   */
  it('an axis the window fills takes no offset (full-height windows cascade horizontally only)', () => {
    const base = { x: 100, y: 0, width: 900, height: WORK_AREA.height };
    expect(cascadePopOutPosition(base, 1, WORK_AREA)).toEqual({ x: 100 + CASCADE_STEP_PX, y: WORK_AREA.y });
    expect(cascadePopOutPosition(base, 3, WORK_AREA)).toEqual({ x: 100 + 3 * CASCADE_STEP_PX, y: WORK_AREA.y });
  });

  /**
   * A secondary monitor to the LEFT of the primary reports a negative work-area
   * origin (e.g. { x: -1920, y: 0 } for a same-size display placed to the left
   * of a primary at { x: 0, y: 0 }). cascadeAxis must stay sign-agnostic: it
   * compares against areaStart/areaEnd directly rather than clamping through
   * something like Math.max(0, ...), which would silently snap a legitimately
   * negative cascaded position back to the primary display's origin.
   */
  it('honors a negative work-area origin (secondary monitor left of primary) without clamping to 0', () => {
    const negativeWorkArea = { x: -1920, y: 0, width: 1920, height: 1080 };

    // Plain offset case: base sits well inside the negative work area, so the
    // offset candidate does not overflow and both coordinates stay negative.
    const base = { x: -1800, y: 80, width: 900, height: 700 };
    expect(cascadePopOutPosition(base, 1, negativeWorkArea)).toEqual({
      x: -1800 + CASCADE_STEP_PX,
      y: 80 + CASCADE_STEP_PX,
    });

    // Wrap case: base + offset overflows the work area's right edge (0), so x
    // wraps back to areaStart + CASCADE_STEP_PX - a NEGATIVE number
    // (-1920 + 28 = -1892). A Math.max(0, ...) clamp regression would instead
    // return 0 (or clamp the overflowing candidate to 0), which this pins
    // against.
    const wrappingBase = { x: -900, y: 80, width: 900, height: 700 };
    expect(cascadePopOutPosition(wrappingBase, 1, negativeWorkArea)).toEqual({
      x: negativeWorkArea.x + CASCADE_STEP_PX,
      y: 80 + CASCADE_STEP_PX,
    });
  });

  it('a window larger than the work area on an axis stays at that axis start', () => {
    const base = { x: 100, y: 0, width: 900, height: WORK_AREA.height + 200 };
    expect(cascadePopOutPosition(base, 1, WORK_AREA)).toEqual({ x: 100 + CASCADE_STEP_PX, y: WORK_AREA.y });
  });
});
