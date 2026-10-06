import pixelmatch from 'pixelmatch';
import { readAsDataUrl } from '../../../../lib/read-as-data-url';

/**
 * Off-main-thread pixel comparison for the Changes panel's Diff mode. A raster
 * image arrives as its data URL and is decoded here, off the main thread. An
 * SVG arrives as an ImageBitmap the main thread decoded, since SVG cannot be
 * decoded inside a worker. This worker draws each at its natural size,
 * top-left, onto one shared canvas size, runs pixelmatch, and returns the
 * changed pixels as a transparent PNG mask plus the count.
 *
 * `diffMask: true` draws only counted differences: pixelmatch leaves
 * anti-aliased pixels out of a mask (and out of the count, `includeAA: false`),
 * so every highlighted pixel is one the "% of pixels changed" line counts.
 */

/** A decoded bitmap, or a raster image's data URL for this worker to decode. */
export type PixelDiffSource = ImageBitmap | string;

export interface PixelDiffRequest {
  id: number;
  before: PixelDiffSource;
  after: PixelDiffSource;
  width: number;
  height: number;
  color: [number, number, number];
}

export type PixelDiffResponse =
  | { id: number; ok: true; maskUrl: string; changedPixels: number; totalPixels: number }
  | { id: number; ok: false };

/**
 * The two members of the dedicated worker scope this file uses. The renderer
 * program is typed with the DOM lib, where `self` is a Window; pulling in the
 * webworker lib would collide with it for every other file.
 */
interface PixelDiffWorkerScope {
  onmessage: ((event: MessageEvent<PixelDiffRequest>) => void) | null;
  postMessage(message: PixelDiffResponse): void;
}

const workerScope = self as unknown as PixelDiffWorkerScope;

function pixelsOf(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2d canvas context unavailable');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, width, height).data;
}

async function bitmapFrom(source: PixelDiffSource): Promise<ImageBitmap> {
  if (typeof source !== 'string') return source;
  // A Blob decodes off the calling thread, unlike an <img>.
  const blob = await (await fetch(source)).blob();
  return createImageBitmap(blob);
}

/** Both sides as bitmaps. A side that decoded is closed if the other did not, so a failure leaks nothing. */
async function bitmapsFor(request: PixelDiffRequest): Promise<[ImageBitmap, ImageBitmap]> {
  const decoded = await Promise.allSettled([bitmapFrom(request.before), bitmapFrom(request.after)]);
  if (decoded[0].status === 'fulfilled' && decoded[1].status === 'fulfilled') return [decoded[0].value, decoded[1].value];
  for (const result of decoded) if (result.status === 'fulfilled') result.value.close();
  throw new Error('An image did not decode');
}

async function comparePixels(request: PixelDiffRequest): Promise<PixelDiffResponse> {
  const { id, width, height, color } = request;
  const [before, after] = await bitmapsFor(request);
  const beforeWidth = before.width;
  const beforeHeight = before.height;
  const afterWidth = after.width;
  const afterHeight = after.height;
  const beforePixels = pixelsOf(before, width, height);
  const afterPixels = pixelsOf(after, width, height);

  // pixelmatch compares only where both images have pixels. A pixel exactly
  // one image covers (the strip a taller screenshot added) is changed by
  // definition, so it is painted and counted here instead: compared, its
  // transparent side would blend against pixelmatch's pseudo-random
  // checkerboard and come out speckled. Two images of one size cover every
  // pixel together, so the walk is skipped for them (a regenerated screenshot,
  // the common case, up to PIXEL_DIFF_MAX_PIXELS iterations that mark nothing).
  const ignoreMask = new Uint8Array(width * height);
  const mask = new Uint8ClampedArray(width * height * 4);
  let coveredByOneImage = 0;
  const sameSize = beforeWidth === afterWidth && beforeHeight === afterHeight;
  for (let y = 0; !sameSize && y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBefore = x < beforeWidth && y < beforeHeight;
      const inAfter = x < afterWidth && y < afterHeight;
      if (inBefore && inAfter) continue;
      const index = y * width + x;
      ignoreMask[index] = 1;
      if (inBefore === inAfter) continue; // covered by neither: nothing changed
      coveredByOneImage++;
      mask[index * 4] = color[0];
      mask[index * 4 + 1] = color[1];
      mask[index * 4 + 2] = color[2];
      mask[index * 4 + 3] = 255;
    }
  }
  const comparedChanges = pixelmatch(afterPixels, beforePixels, mask, width, height, {
    threshold: 0.1,
    includeAA: false,
    diffMask: true,
    diffColor: color,
    ignoreMask,
  });
  const changedPixels = comparedChanges + coveredByOneImage;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2d canvas context unavailable');
  context.putImageData(new ImageData(mask, width, height), 0, 0);
  // A data URL, not an object URL: the view never has to revoke anything.
  const maskUrl = await readAsDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  return { id, ok: true, maskUrl, changedPixels, totalPixels: width * height };
}

workerScope.onmessage = (event) => {
  comparePixels(event.data).then(
    (response) => workerScope.postMessage(response),
    () => workerScope.postMessage({ id: event.data.id, ok: false }),
  );
};
