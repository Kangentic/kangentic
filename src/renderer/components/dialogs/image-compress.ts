import { useToastStore } from '../../stores/toast-store';
import { IMAGE_LONG_EDGE_CAP, resolveResizeTarget } from '../../../shared/image-fidelity';
import { isImageMediaType, resolveMediaType } from './attachment-utils';

/**
 * Anthropic vision API budget:
 *   - 5MB hard cap per image (base64-encoded source bytes)
 *   - 8000x8000 absolute pixel cap, 2000x2000 when sending >20 images
 *
 * WHAT ACTUALLY COSTS TOKENS: pixel AREA, and nothing else. Re-encoding an image
 * (the WebP quality ladder below, grayscale, palette reduction, PNG optimization)
 * shrinks the file and costs the model exactly the same. The ladder is kept for
 * disk and IPC reasons - a pasted attachment is base64'd across the bridge and
 * stored - and must not be described as a token optimization.
 *
 * ON THE LONG-EDGE CAP: this path shipped 1568px for a long time, on a comment
 * claiming it matched "the API's own downscale". It did not, and 1568 was
 * actively costing accuracy: with no option to decline, an agent reading a
 * 1568px UI screenshot misread a branch hash in 6 of 7 attempts and named the
 * wrong bar in a three-bar chart in 5 of 7, confidently and without ever
 * flagging doubt. At the 2000px cap the same 84 probes produced zero errors, and
 * cost no more, because the chain normalizes above ~2.25MP anyway. See
 * `src/shared/image-fidelity.ts` for the measurements.
 *
 * We target a 1.5MB blob so the base64 payload (~2MB) fits with comfortable
 * headroom under the 5MB cap.
 */
export const MIN_COMPRESS_BYTES = 500 * 1024;
export const TARGET_BYTES = 1.5 * 1024 * 1024;
export const QUALITY_LADDER = [0.85, 0.75, 0.6] as const;

export interface CompressResult {
  file: File;
  compressed: boolean;
}

export interface CompressImageOptions {
  longEdge: number;
  quality: number;
}

const SKIP_RECOMPRESS_MEDIA_TYPES = new Set(['image/gif', 'image/svg+xml']);

function renameToWebp(originalName: string): string {
  const dotIndex = originalName.lastIndexOf('.');
  const stem = dotIndex >= 0 ? originalName.slice(0, dotIndex) : originalName;
  return `${stem}.webp`;
}

/**
 * Draw `bitmap` into a canvas at `target`, downscaling if needed.
 *
 * `imageSmoothingQuality` is set explicitly because the browser default is
 * 'low', which is visibly destructive on a large downscale of small UI text -
 * and reading small UI text is the case this whole pipeline exists to preserve.
 */
function renderToCanvas(bitmap: ImageBitmap, longEdge: number): OffscreenCanvas {
  const target = resolveResizeTarget(bitmap.width, bitmap.height, longEdge)
    ?? { width: bitmap.width, height: bitmap.height };

  const canvas = new OffscreenCanvas(target.width, target.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2d context unavailable');

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  return canvas;
}

/**
 * Pure pipeline used by both the public helper and the calibration harness.
 * Takes an explicit long-edge target and quality so callers can sweep params.
 */
export async function compressImage(input: File, options: CompressImageOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(input);
  try {
    const canvas = renderToCanvas(bitmap, options.longEdge);
    return await canvas.convertToBlob({ type: 'image/webp', quality: options.quality });
  } finally {
    bitmap.close();
  }
}

/**
 * Compress a clipboard-pasted image to fit Anthropic's vision API budget.
 *
 * Skip rules: not an image, GIF/SVG (lossy re-encode would damage them), under
 * 500KB (already small), or a PNG that already fits the long-edge cap (preserves
 * alpha for icons/UI screenshots without an explicit alpha probe, and avoids a
 * lossy round-trip for an image that is already within budget).
 *
 * Pipeline: createImageBitmap -> resize to IMAGE_LONG_EDGE_CAP on the long edge
 * at high resampling quality -> WebP at quality 0.85, falling back to 0.75 then
 * 0.6 if the result still exceeds TARGET_BYTES. The ladder is a byte budget, not
 * a token one.
 *
 * Failure handling: any thrown error toasts a single warning and returns the
 * original file. Pastes never silently disappear.
 *
 * Drag/drop should NOT call this - only clipboard pastes go through compression.
 *
 * Note: the returned File has a `.webp` extension and `image/webp` media type
 * when compressed; callers should regenerate any filename derived from media type.
 */
export async function compressClipboardImage(input: File): Promise<CompressResult> {
  const mediaType = resolveMediaType(input);
  if (!isImageMediaType(mediaType)) return { file: input, compressed: false };
  if (SKIP_RECOMPRESS_MEDIA_TYPES.has(mediaType)) return { file: input, compressed: false };
  if (input.size < MIN_COMPRESS_BYTES) return { file: input, compressed: false };

  try {
    const bitmap = await createImageBitmap(input);
    try {
      const needsResize = resolveResizeTarget(bitmap.width, bitmap.height, IMAGE_LONG_EDGE_CAP) !== null;
      if (!needsResize && mediaType === 'image/png') {
        return { file: input, compressed: false };
      }
      const canvas = renderToCanvas(bitmap, IMAGE_LONG_EDGE_CAP);

      let blob: Blob | null = null;
      for (const quality of QUALITY_LADDER) {
        blob = await canvas.convertToBlob({ type: 'image/webp', quality });
        if (blob.size <= TARGET_BYTES) break;
      }
      if (!blob) throw new Error('convertToBlob returned no data');

      if (blob.size > TARGET_BYTES) {
        useToastStore.getState().addToast({
          message: 'Image still large after compression - sending at reduced quality.',
          variant: 'warning',
        });
      }

      const filename = renameToWebp(input.name || 'image.webp');
      const file = new File([blob], filename, { type: 'image/webp', lastModified: Date.now() });
      return { file, compressed: true };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.error('[image-compress] Failed to compress pasted image:', error);
    useToastStore.getState().addToast({
      message: 'Could not compress image - using original.',
      variant: 'warning',
    });
    return { file: input, compressed: false };
  }
}
