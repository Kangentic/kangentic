import { useEffect, useState } from 'react';
import PixelDiffWorker from './pixel-diff.worker?worker';
import type { PixelDiffRequest, PixelDiffResponse, PixelDiffSource } from './pixel-diff.worker';
import { loadImage, type DecodedImageSide } from './diff-content';
import { pixelDiffCanvas } from './pixel-diff-canvas';

/**
 * Main-thread half of the Diff mode: hands both sides to the pixel-diff
 * worker and caches each pair's result so stepping back to a file in Diff
 * mode does not compare it again.
 */

export type PixelDiffOutcome =
  | { status: 'done'; maskUrl: string; changedPixels: number; totalPixels: number }
  | { status: 'failed' };

export type PixelDiffState = { status: 'idle' } | { status: 'pending' } | PixelDiffOutcome;

/** The changed-pixel color: saturated, and far from every status and accent color the pane uses. */
const PIXEL_DIFF_COLOR: [number, number, number] = [255, 60, 199];
export const PIXEL_DIFF_COLOR_CSS = `rgb(${PIXEL_DIFF_COLOR.join(' ')})`;

/**
 * Values keyed by a pair of sides, held only as long as both sides are. A
 * side is fixed to one file, so the pair alone identifies a comparison.
 */
class SidePairMap<Value> {
  private readonly byBefore = new WeakMap<DecodedImageSide, WeakMap<DecodedImageSide, Value>>();

  get(before: DecodedImageSide, after: DecodedImageSide): Value | undefined {
    return this.byBefore.get(before)?.get(after);
  }

  set(before: DecodedImageSide, after: DecodedImageSide, value: Value): void {
    let byAfter = this.byBefore.get(before);
    if (byAfter === undefined) {
      byAfter = new WeakMap<DecodedImageSide, Value>();
      this.byBefore.set(before, byAfter);
    }
    byAfter.set(after, value);
  }

  delete(before: DecodedImageSide, after: DecodedImageSide): void {
    this.byBefore.get(before)?.delete(after);
  }
}

// hmr-safe: the dispose at the bottom of this file terminates this worker and
// fails every pending request, so the next module instance starts clean.
let worker: Worker | null = null;
// hmr-safe: ids only pair a reply with its request inside one worker's life.
let nextRequestId = 1;
// hmr-safe: emptied by the dispose at the bottom of this file.
const pendingRequests = new Map<number, (outcome: PixelDiffOutcome) => void>();
// hmr-safe: set by the Fast Refresh dispose below. A comparison still running
// when the module is replaced resumes here afterwards: it must not build a
// worker that nothing would ever terminate, and the failure the dispose hands
// it is not a real outcome, so usePixelDiff does not show it.
let disposed = false;

/**
 * Results by side pair. A DiffContent's side objects stay the same for as
 * long as the panel's content cache holds them, so a revisit hits; once the
 * cache drops a file, its results go with it.
 */
// hmr-safe: a refresh only costs the next Diff view one comparison.
const outcomeCache = new SidePairMap<PixelDiffOutcome>();

/**
 * Comparisons still running, keyed the same way. A second request for the
 * same pair (React StrictMode's double effect, or a re-render before the
 * worker answers) joins the running one instead of queuing a duplicate behind
 * it in the single worker. An entry leaves when its comparison settles,
 * failure included, so a failed pair is tried afresh.
 */
// hmr-safe: the comparisons it holds fail with the disposed worker anyway.
const runningComparisons = new SidePairMap<Promise<PixelDiffOutcome>>();

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

/**
 * What the worker draws one side from. A raster image goes as its data URL
 * and the worker decodes it, because `createImageBitmap` on an `<img>` decodes
 * on the calling thread and a large screenshot drops frames there. The data
 * URL is already held, so posting it keeps no second copy of the bytes, at the
 * cost of the worker decoding the base64 again. An SVG is decoded here,
 * because a worker cannot decode SVG, and the resize pins an SVG with no
 * intrinsic size to the size the view uses.
 */
async function sourceOf(side: DecodedImageSide, scale: number, scalable: boolean): Promise<PixelDiffSource> {
  if (!scalable) return side.dataUrl;
  const image = await loadImage(side.dataUrl);
  return createImageBitmap(image, { resizeWidth: side.width * scale, resizeHeight: side.height * scale, resizeQuality: 'high' });
}

function closeIfBitmap(source: PixelDiffSource): void {
  if (typeof source !== 'string') source.close();
}

/** One pair's comparison, shared by every caller asking for it while it runs. */
function computePixelDiff(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): Promise<PixelDiffOutcome> {
  const cached = outcomeCache.get(before, after);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = runningComparisons.get(before, after);
  if (running !== undefined) return running;
  const comparison = runPixelDiff(before, after, scalable).finally(() => {
    runningComparisons.delete(before, after);
  });
  runningComparisons.set(before, after, comparison);
  return comparison;
}

async function runPixelDiff(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): Promise<PixelDiffOutcome> {
  const canvas = pixelDiffCanvas(before, after, scalable);
  if (canvas === null) return { status: 'failed' };
  const { scale, width, height } = canvas;
  let outcome: PixelDiffOutcome;
  try {
    const prepared = await Promise.allSettled([sourceOf(before, scale, scalable), sourceOf(after, scale, scalable)]);
    if (prepared[0].status === 'rejected' || prepared[1].status === 'rejected') {
      // A side that did decode is still this thread's to free.
      for (const result of prepared) if (result.status === 'fulfilled') closeIfBitmap(result.value);
      return { status: 'failed' };
    }
    const beforeSource = prepared[0].value;
    const afterSource = prepared[1].value;
    const transfer = [beforeSource, afterSource].filter((source): source is ImageBitmap => typeof source !== 'string');
    outcome = await new Promise<PixelDiffOutcome>((resolve) => {
      const id = nextRequestId++;
      const request: PixelDiffRequest = { id, before: beforeSource, after: afterSource, width, height, color: PIXEL_DIFF_COLOR };
      try {
        getWorker().postMessage(request, transfer);
      } catch (postError) {
        // Nothing was transferred, so any bitmap is still this thread's to free.
        closeIfBitmap(beforeSource);
        closeIfBitmap(afterSource);
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
  if (outcome.status === 'done') outcomeCache.set(before, after, outcome);
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
      // `disposed` is this module instance's: a Fast Refresh failed the
      // comparison, and the replacement module's effect compares again.
      if (!cancelled && !disposed) setSettled({ before, after, outcome });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, before, after, scalable]);

  if (!enabled || before === null || after === null) return { status: 'idle' };
  const cached = outcomeCache.get(before, after);
  if (cached !== undefined) return cached;
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
