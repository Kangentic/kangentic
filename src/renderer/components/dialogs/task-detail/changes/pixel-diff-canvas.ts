/**
 * The canvas the Diff mode compares two images on. Kept apart from
 * pixel-diff-client.ts, which owns the worker, so the sizing rules can be
 * tested without a DOM.
 */

/**
 * A vector image (SVG) has no pixel grid of its own and the view draws it
 * scaled up to fill the pane, so it is compared at a raster size near what is
 * on screen instead of its nominal size. A 64x64 icon compared at 64x64 would
 * paint a blocky mask once scaled to 500px. Raster images always compare at
 * their real pixels.
 */
const VECTOR_COMPARE_LONG_EDGE = 1024;
const VECTOR_COMPARE_MAX_SCALE = 16;

/**
 * The byte cap does not bound pixels: a flat 10000 x 10000 PNG compresses far
 * under IMAGE_PREVIEW_MAX_BYTES, and the worker holds about five full-canvas
 * buffers at once (both images, the mask, the ignore mask, the output), near
 * 20 bytes a pixel. Past this many pixels the Diff mode reports that it could
 * not compare rather than allocate gigabytes in the renderer process.
 */
export const PIXEL_DIFF_MAX_PIXELS = 4096 * 4096;

interface ImageDimensions {
  width: number;
  height: number;
}

export interface PixelDiffCanvas {
  /** Factor each image's natural size is drawn at. */
  scale: number;
  width: number;
  height: number;
}

/**
 * One canvas both images fit, each drawn at its natural size from the
 * top-left, so area only one image covers counts as changed. Null when that
 * canvas is over PIXEL_DIFF_MAX_PIXELS.
 */
export function pixelDiffCanvas(before: ImageDimensions, after: ImageDimensions, scalable: boolean): PixelDiffCanvas | null {
  let scale = 1;
  if (scalable) {
    const longEdge = Math.max(before.width, before.height, after.width, after.height);
    scale = Math.max(1, Math.min(VECTOR_COMPARE_MAX_SCALE, Math.floor(VECTOR_COMPARE_LONG_EDGE / longEdge)));
  }
  const width = Math.max(before.width, after.width) * scale;
  const height = Math.max(before.height, after.height) * scale;
  if (width * height > PIXEL_DIFF_MAX_PIXELS) return null;
  return { scale, width, height };
}
