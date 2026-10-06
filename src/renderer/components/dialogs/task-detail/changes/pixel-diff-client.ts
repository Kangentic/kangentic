import { useEffect, useState } from 'react';
import PixelDiffWorker from './pixel-diff.worker?worker';
import type { PixelDiffRequest, PixelDiffResponse } from './pixel-diff.worker';
import { loadImage, type DiffImageSide } from './diff-content';
import { pixelDiffCanvas } from './pixel-diff-canvas';

/**
 * Main-thread half of the Diff mode: decodes both sides to ImageBitmaps,
 * hands them to the pixel-diff worker, and caches each pair's result so
 * stepping back to a file in Diff mode does not compare it again.
 */

export type DecodedImageSide = Extract<DiffImageSide, { kind: 'image' }>;

export type PixelDiffOutcome =
  | { status: 'done'; maskUrl: string; changedPixels: number; totalPixels: number }
  | { status: 'failed' };

export type PixelDiffState = { status: 'idle' } | { status: 'pending' } | PixelDiffOutcome;

/** The changed-pixel color: saturated, and far from every status and accent color the pane uses. */
const PIXEL_DIFF_COLOR: [number, number, number] = [255, 60, 199];
export const PIXEL_DIFF_COLOR_CSS = `rgb(${PIXEL_DIFF_COLOR.join(' ')})`;

// hmr-safe: the dispose at the bottom of this file terminates this worker and
// fails every pending request, so the next module instance starts clean.
let worker: Worker | null = null;
// hmr-safe: ids only pair a reply with its request inside one worker's life.
let nextRequestId = 1;
// hmr-safe: emptied by the dispose at the bottom of this file.
const pendingRequests = new Map<number, (outcome: PixelDiffOutcome) => void>();
// hmr-safe: set by the Fast Refresh dispose below. A comparison still decoding
// when the module is replaced resumes here afterwards, and must not build a
// worker that nothing would ever terminate.
let disposed = false;

/**
 * Results keyed by side identity. A DiffContent's side objects stay the same
 * for as long as the panel's content cache holds them, so a revisit hits; once
 * the cache drops a file, its results go with it.
 */
// hmr-safe: a refresh only costs the next Diff view one comparison.
const outcomeCache = new WeakMap<DecodedImageSide, WeakMap<DecodedImageSide, PixelDiffOutcome>>();

/**
 * Comparisons still running, keyed the same way. A second request for the
 * same pair (React StrictMode's double effect, or a re-render before the
 * worker answers) joins the running one instead of decoding both images again
 * and queuing a duplicate behind it in the single worker. An entry leaves when
 * its comparison settles, failure included, so a failed pair is tried afresh.
 */
// hmr-safe: the comparisons it holds fail with the disposed worker anyway.
const runningComparisons = new WeakMap<DecodedImageSide, WeakMap<DecodedImageSide, Promise<PixelDiffOutcome>>>();

function failAllPending(): void {
  for (const resolve of pendingRequests.values()) resolve({ status: 'failed' });
  pendingRequests.clear();
}

function getWorker(): Worker {
  if (disposed) throw new Error('Pixel diff client was replaced by a Fast Refresh');
  if (worker !== null) return worker;
  const created = new PixelDiffWorker();
  created.onmessage = (event: MessageEvent<PixelDiffResponse>) => {
    const response = event.data;
    const resolve = pendingRequests.get(response.id);
    pendingRequests.delete(response.id);
    if (!resolve) return;
    resolve(response.ok
      ? { status: 'done', maskUrl: response.maskUrl, changedPixels: response.changedPixels, totalPixels: response.totalPixels }
      : { status: 'failed' });
  };
  created.onerror = () => {
    failAllPending();
    created.terminate();
    if (worker === created) worker = null;
  };
  worker = created;
  return created;
}

/** Decoded on this thread because a worker cannot decode SVG. The resize also pins an SVG with no intrinsic size to the size the view uses. */
async function bitmapOf(side: DecodedImageSide, scale: number): Promise<ImageBitmap> {
  const image = await loadImage(side.dataUrl);
  return createImageBitmap(image, { resizeWidth: side.width * scale, resizeHeight: side.height * scale, resizeQuality: 'high' });
}

function cachedPixelDiff(before: DecodedImageSide, after: DecodedImageSide): PixelDiffOutcome | null {
  return outcomeCache.get(before)?.get(after) ?? null;
}

/**
 * One pair's comparison, shared by every caller asking for it while it runs.
 * A side is fixed to one file, and `scalable` is fixed by the file's type, so
 * the pair alone identifies the request.
 */
function computePixelDiff(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): Promise<PixelDiffOutcome> {
  const cached = cachedPixelDiff(before, after);
  if (cached !== null) return Promise.resolve(cached);
  const running = runningComparisons.get(before)?.get(after);
  if (running !== undefined) return running;
  const comparison = runPixelDiff(before, after, scalable).finally(() => {
    runningComparisons.get(before)?.delete(after);
  });
  const byAfter = runningComparisons.get(before) ?? new WeakMap<DecodedImageSide, Promise<PixelDiffOutcome>>();
  byAfter.set(after, comparison);
  runningComparisons.set(before, byAfter);
  return comparison;
}

async function runPixelDiff(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): Promise<PixelDiffOutcome> {
  const canvas = pixelDiffCanvas(before, after, scalable);
  if (canvas === null) return { status: 'failed' };
  const { scale, width, height } = canvas;
  let outcome: PixelDiffOutcome;
  try {
    const decoded = await Promise.allSettled([bitmapOf(before, scale), bitmapOf(after, scale)]);
    if (decoded[0].status === 'rejected' || decoded[1].status === 'rejected') {
      // The side that did decode is still this thread's to free.
      for (const result of decoded) if (result.status === 'fulfilled') result.value.close();
      return { status: 'failed' };
    }
    const beforeBitmap = decoded[0].value;
    const afterBitmap = decoded[1].value;
    outcome = await new Promise<PixelDiffOutcome>((resolve) => {
      const id = nextRequestId++;
      const request: PixelDiffRequest = { id, before: beforeBitmap, after: afterBitmap, width, height, color: PIXEL_DIFF_COLOR };
      try {
        getWorker().postMessage(request, [beforeBitmap, afterBitmap]);
      } catch (postError) {
        // Nothing was transferred, so both bitmaps are still this thread's to free.
        beforeBitmap.close();
        afterBitmap.close();
        throw postError;
      }
      // Registered only once the post went through: a throw from getWorker or
      // postMessage rejects this promise, and must not strand an entry. The
      // worker's reply is a later task, so it cannot arrive before the set.
      pendingRequests.set(id, resolve);
    });
  } catch {
    outcome = { status: 'failed' };
  }
  if (outcome.status === 'done') {
    const byAfter = outcomeCache.get(before) ?? new WeakMap<DecodedImageSide, PixelDiffOutcome>();
    byAfter.set(after, outcome);
    outcomeCache.set(before, byAfter);
  }
  return outcome;
}

/**
 * The Diff mode's comparison for a pair of decoded sides: 'idle' while the
 * mode is off, 'pending' until the worker answers, then the outcome.
 */
export function usePixelDiff(
  before: DecodedImageSide | null,
  after: DecodedImageSide | null,
  enabled: boolean,
  scalable: boolean,
): PixelDiffState {
  const [settled, setSettled] = useState<{ before: DecodedImageSide; after: DecodedImageSide; outcome: PixelDiffOutcome } | null>(null);
  useEffect(() => {
    if (!enabled || before === null || after === null) return;
    let cancelled = false;
    void computePixelDiff(before, after, scalable).then((outcome) => {
      if (!cancelled) setSettled({ before, after, outcome });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, before, after, scalable]);

  if (!enabled || before === null || after === null) return { status: 'idle' };
  const cached = cachedPixelDiff(before, after);
  if (cached !== null) return cached;
  if (settled !== null && settled.before === before && settled.after === after) return settled.outcome;
  return { status: 'pending' };
}

// A Fast Refresh of this module builds a fresh worker; end the old one and
// settle anything still waiting on it so no caller hangs.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => {
    disposed = true;
    failAllPending();
    worker?.terminate();
    worker = null;
  });
}
