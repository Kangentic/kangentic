/**
 * Unit coverage for the shared image pixel budget
 * (`src/shared/image-fidelity.ts`), which both the main-process terminal paste
 * path and the renderer attachment path size by.
 */

import { describe, it, expect } from 'vitest';
import { IMAGE_LONG_EDGE_CAP, resolveResizeTarget } from '../../src/shared/image-fidelity';

describe('IMAGE_LONG_EDGE_CAP', () => {
  it('sits at the measured clamp, not below it', () => {
    // This number is load-bearing in a way a round constant usually is not.
    // Measured: cost stops tracking pixel area above ~2.25MP (about 2000px on the
    // long edge at 16:9), so capping here discards nothing the model would have
    // used. Measured separately: at 1568px an agent misreads small text and
    // non-text detail with full confidence and no warning (11 silent errors in 84
    // probes, against 0 at this cap). Lowering it to buy tokens buys wrong answers
    // instead - the upstream clamp was already doing the saving.
    expect(IMAGE_LONG_EDGE_CAP).toBe(2000);
  });

  it('is the default for resolveResizeTarget, so the two paths cannot drift', () => {
    expect(resolveResizeTarget(4000, 2000)).toEqual(
      resolveResizeTarget(4000, 2000, IMAGE_LONG_EDGE_CAP),
    );
  });
});

describe('resolveResizeTarget', () => {
  it('scales a landscape image by its width and preserves aspect ratio', () => {
    expect(resolveResizeTarget(3840, 2160, 1568)).toEqual({ width: 1568, height: 882 });
  });

  it('scales a portrait image by its height', () => {
    expect(resolveResizeTarget(1080, 2400, 1024)).toEqual({ width: 461, height: 1024 });
  });

  it('returns null when the image already fits, so callers skip the resize', () => {
    expect(resolveResizeTarget(1200, 800, 1568)).toBeNull();
  });

  it('returns null at exactly the cap rather than emitting a no-op scale', () => {
    expect(resolveResizeTarget(1568, 882, 1568)).toBeNull();
  });

  it('never rounds an edge down to zero on an extreme aspect ratio', () => {
    const target = resolveResizeTarget(10000, 3, 1024);
    expect(target).not.toBeNull();
    expect(target?.height).toBeGreaterThanOrEqual(1);
  });

  it('returns null for malformed dimensions', () => {
    expect(resolveResizeTarget(0, 100, 1568)).toBeNull();
    expect(resolveResizeTarget(100, -5, 1568)).toBeNull();
    expect(resolveResizeTarget(Number.NaN, 100, 1568)).toBeNull();
  });
});
