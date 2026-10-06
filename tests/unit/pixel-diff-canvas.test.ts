/**
 * The canvas the Changes panel's Diff mode compares two images on
 * (src/renderer/components/dialogs/task-detail/changes/pixel-diff-canvas.ts).
 * Pure sizing rules, so no DOM: a raster pair compares at real pixels, a vector
 * pair is scaled up toward what is on screen, and a canvas over the pixel cap
 * is refused rather than allocated.
 */
import { describe, it, expect } from 'vitest';
import { PIXEL_DIFF_MAX_PIXELS, pixelDiffCanvas } from '../../src/renderer/components/dialogs/task-detail/changes/pixel-diff-canvas';

function size(width: number, height: number) {
  return { width, height };
}

describe('pixelDiffCanvas: raster images', () => {
  it('compares at real pixels on a canvas the size of the larger width and the larger height', () => {
    expect(pixelDiffCanvas(size(100, 50), size(80, 70), false)).toEqual({ scale: 1, width: 100, height: 70 });
  });

  it('never scales a raster image, however small', () => {
    // The same 8x8 pair as an SVG would be scaled 16x (see below).
    expect(pixelDiffCanvas(size(8, 8), size(8, 8), false)).toEqual({ scale: 1, width: 8, height: 8 });
  });
});

describe('pixelDiffCanvas: vector images', () => {
  it('scales a 64x64 pair by 16, so 1024 on its long edge', () => {
    expect(pixelDiffCanvas(size(64, 64), size(64, 64), true)).toEqual({ scale: 16, width: 1024, height: 1024 });
  });

  it('caps the scale at 16 for a small icon', () => {
    // 1024 / 32 would be 32. Only the cap holds it to 16, which a 64x64 pair
    // cannot show because 1024 / 64 is already exactly 16.
    expect(pixelDiffCanvas(size(32, 32), size(32, 32), true)).toEqual({ scale: 16, width: 512, height: 512 });
  });

  it('floors the scale to a whole number from the long edge', () => {
    // floor(1024 / 100) is 10, not 10.24.
    expect(pixelDiffCanvas(size(100, 40), size(60, 20), true)).toEqual({ scale: 10, width: 1000, height: 400 });
  });

  it('takes the long edge across both images and both dimensions', () => {
    // The long edge (100) is the second image's height, not the first image's.
    // Reading only the first image would give floor(1024 / 30) = 34, capped to 16.
    expect(pixelDiffCanvas(size(20, 30), size(40, 100), true)).toEqual({ scale: 10, width: 400, height: 1000 });
  });

  it('draws a pair whose long edge is over 1024 at scale 1 instead of shrinking it', () => {
    // floor(1024 / 1025) is 0, which would collapse the canvas to nothing.
    expect(pixelDiffCanvas(size(1025, 10), size(10, 10), true)).toEqual({ scale: 1, width: 1025, height: 10 });
    expect(pixelDiffCanvas(size(2000, 1000), size(1500, 800), true)).toEqual({ scale: 1, width: 2000, height: 1000 });
  });
});

describe('pixelDiffCanvas: the pixel cap', () => {
  it('pins the cap at 4096 x 4096 pixels', () => {
    expect(PIXEL_DIFF_MAX_PIXELS).toBe(4096 * 4096);
  });

  it('allows a canvas of exactly the cap', () => {
    expect(pixelDiffCanvas(size(4096, 4096), size(4096, 4096), false)).toEqual({ scale: 1, width: 4096, height: 4096 });
  });

  it('refuses a canvas one pixel wider or one pixel taller than the cap allows', () => {
    expect(pixelDiffCanvas(size(4097, 4096), size(4097, 4096), false)).toBeNull();
    expect(pixelDiffCanvas(size(4096, 4097), size(4096, 4097), false)).toBeNull();
  });

  it('measures the shared canvas, not each image: two thin images can still need a canvas over the cap', () => {
    // 4097 x 1 and 1 x 4096 are each tiny, but the canvas that fits both is 4097 x 4096.
    expect(pixelDiffCanvas(size(4097, 1), size(1, 4096), false)).toBeNull();
    // The same shape one pixel narrower lands exactly on the cap.
    expect(pixelDiffCanvas(size(4096, 1), size(1, 4096), false)).toEqual({ scale: 1, width: 4096, height: 4096 });
  });

  it('applies the cap to a vector pair too, which draws at scale 1 once its long edge passes 1024', () => {
    expect(pixelDiffCanvas(size(5000, 5000), size(5000, 5000), true)).toBeNull();
  });
});
