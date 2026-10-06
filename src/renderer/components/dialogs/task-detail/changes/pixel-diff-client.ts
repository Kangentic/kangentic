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
export const PIXEL_DIFF_COLOR: [number, number, number] = [255, 60, 199];
export const PIXEL_DIFF_COLOR_CSS = `rgb(${PIXEL_DIFF_COLOR.join(' ')})`;

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, (outcome: PixelDiffOutcome) => void>();
// Set by the Fast Refresh dispose below. A comparison still decoding when the
// module is replaced resumes here afterwards, and must not build a worker that
// nothing would ever terminate.
let disposed = false;

/**
 * Results keyed by side identity. A DiffContent's side objects stay the same
 * for as long as the panel's content cache holds them, so a revisit hits; once
 * the cache drops a file, its results go with it.
 */
const outcomeCache = new WeakMap<DecodedImageSide, WeakMap<DecodedImageSide, PixelDiffOutcome>>();

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

async function computePixelDiff(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): Promise<PixelDiffOutcome> {
  const cached = cachedPixelDiff(before, after);
  if (cached !== null) return cached;
  const canvas = pixelDiffCanvas(before, after, scalable);
  if (canvas === null) return { status: 'failed' };
  const { scale, width, height } = canvas;
  let outcome: PixelDiffOutcome;
  try {
    const [beforeBitmap, afterBitmap] = await Promise.all([bitmapOf(before, scale), bitmapOf(after, scale)]);
    outcome = await new Promise<PixelDiffOutcome>((resolve) => {
      const id = nextRequestId++;
      const request: PixelDiffRequest = { id, before: beforeBitmap, after: afterBitmap, width, height, color: PIXEL_DIFF_COLOR };
      // Registered only once the post went through: a throw from getWorker or
      // postMessage rejects this promise, and must not strand an entry. The
      // worker's reply is a later task, so it cannot arrive before the set.
      getWorker().postMessage(request, [beforeBitmap, afterBitmap]);
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
