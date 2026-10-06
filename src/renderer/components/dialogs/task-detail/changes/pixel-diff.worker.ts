import pixelmatch from 'pixelmatch';

/**
 * Off-main-thread pixel comparison for the Changes panel's Diff mode. The main
 * thread decodes both images (SVG cannot be decoded inside a worker) and
 * transfers them here as ImageBitmaps; this worker draws each at its natural
 * size, top-left, onto one shared canvas size, runs pixelmatch, and returns
 * the changed pixels as a transparent PNG mask plus the count.
 *
 * `diffMask: true` draws only counted differences: pixelmatch leaves
 * anti-aliased pixels out of a mask (and out of the count, `includeAA: false`),
 * so every highlighted pixel is one the "% of pixels changed" line counts.
 */

export interface PixelDiffRequest {
  id: number;
  before: ImageBitmap;
  after: ImageBitmap;
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

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode the diff mask'));
    reader.readAsDataURL(blob);
  });
}

async function comparePixels(request: PixelDiffRequest): Promise<PixelDiffResponse> {
  const { id, before, after, width, height, color } = request;
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
  // checkerboard and come out speckled.
  const ignoreMask = new Uint8Array(width * height);
  const mask = new Uint8ClampedArray(width * height * 4);
  let coveredByOneImage = 0;
  for (let y = 0; y < height; y++) {
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
