import { useEffect, useState } from 'react';
import PixelDiffWorker from './pixel-diff.worker?worker';
import type { PixelDiffRequest, PixelDiffResponse } from './pixel-diff.worker';
import { loadImage, type DiffImageSide } from './diff-content';

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
 * A vector image (SVG) has no pixel grid of its own and the view draws it
 * scaled up to fill the pane, so it is compared at a raster size near what is
 * on screen instead of its nominal size. A 64x64 icon compared at 64x64 would
 * paint a blocky mask once scaled to 500px. Raster images always compare at
 * their real pixels.
 */
const VECTOR_COMPARE_LONG_EDGE = 1024;
const VECTOR_COMPARE_MAX_SCALE = 16;

function compareScale(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): number {
  if (!scalable) return 1;
  const longEdge = Math.max(before.width, before.height, after.width, after.height);
  return Math.max(1, Math.min(VECTOR_COMPARE_MAX_SCALE, Math.floor(VECTOR_COMPARE_LONG_EDGE / longEdge)));
}

/** Decoded on this thread because a worker cannot decode SVG. The resize also pins an SVG with no intrinsic size to the size the view uses. */
async function bitmapOf(side: DecodedImageSide, scale: number): Promise<ImageBitmap> {
  const image = await loadImage(side.dataUrl);
  return createImageBitmap(image, { resizeWidth: side.width * scale, resizeHeight: side.height * scale, resizeQuality: 'high' });
}

export function cachedPixelDiff(before: DecodedImageSide, after: DecodedImageSide): PixelDiffOutcome | null {
  return outcomeCache.get(before)?.get(after) ?? null;
}

export async function computePixelDiff(before: DecodedImageSide, after: DecodedImageSide, scalable: boolean): Promise<PixelDiffOutcome> {
  const cached = cachedPixelDiff(before, after);
  if (cached !== null) return cached;
  let outcome: PixelDiffOutcome;
  try {
    const scale = compareScale(before, after, scalable);
    const [beforeBitmap, afterBitmap] = await Promise.all([bitmapOf(before, scale), bitmapOf(after, scale)]);
    outcome = await new Promise<PixelDiffOutcome>((resolve) => {
      const id = nextRequestId++;
      pendingRequests.set(id, resolve);
      const request: PixelDiffRequest = {
        id,
        before: beforeBitmap,
        after: afterBitmap,
        // One canvas both images fit, each drawn at its natural size from the
        // top-left, so area only one image covers counts as changed.
        width: Math.max(before.width, after.width) * scale,
        height: Math.max(before.height, after.height) * scale,
        color: PIXEL_DIFF_COLOR,
      };
      getWorker().postMessage(request, [beforeBitmap, afterBitmap]);
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
    failAllPending();
    worker?.terminate();
    worker = null;
  });
}
