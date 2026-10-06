import type { GitDiffStatus, GitFileContentInput, GitFileContentResult, GitImageSide } from '../../../../../shared/types';
import { IMAGE_PREVIEW_MAX_BYTES, SVG_MIME_TYPE, imageKindForPath, imageMimeTypeForPath } from '../../../../../shared/image-preview';

/**
 * What the Changes panel fetches for one selected file, shared by its two
 * hosts (the in-app ChangesPanel and the per-file pop-out) so both decide the
 * same way which reads a file needs and prepare images the same way.
 */

/**
 * One side of an image, prepared for display. Everything a render needs is
 * worked out here, in the async fetch path, so the image view itself holds no
 * effect-driven state: a data URL (no object URL to revoke), and the natural
 * size from a real decode, which also catches bytes the browser cannot read.
 */
export type DiffImageSide =
  | { kind: 'image'; size: number; dataUrl: string; width: number; height: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'lfs-pointer'; size: number }
  | { kind: 'undecodable'; size: number }
  | { kind: 'unreadable' };

/** Both sides of a changed image. A side is null when the file's status has none. */
export interface DiffImageContent {
  original: DiffImageSide | null;
  modified: DiffImageSide | null;
}

export interface DiffContent {
  text: GitFileContentResult;
  /** Set for raster images and SVG, null for every other file. */
  image: DiffImageContent | null;
}

export const EMPTY_DIFF_TEXT: GitFileContentResult = { original: '', modified: '', language: 'plaintext' };

export const EMPTY_DIFF_CONTENT: DiffContent = { text: EMPTY_DIFF_TEXT, image: null };

/**
 * Prepared image payloads the in-app panel keeps cached across file switches.
 * Past this, the least recently viewed image entries are dropped: a branch of
 * regenerated screenshots would otherwise keep every one resident.
 */
export const IMAGE_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** Added and Untracked files have no original side; Deleted files have no modified side. */
export function statusHasOriginal(status: GitDiffStatus): boolean {
  return status !== 'A' && status !== 'U';
}

export function statusHasModified(status: GitDiffStatus): boolean {
  return status !== 'D';
}

/**
 * Fetch what the diff pane shows for one file. A raster image reads bytes only
 * (it has no text form). A binary file that is not an image needs neither
 * read, since its pane shows the binary placeholder. Everything else reads
 * text, and an SVG also gets image sides built from that text, including an
 * SVG `.gitattributes` marks binary (its text is still valid markup).
 */
export async function fetchDiffContent(input: GitFileContentInput, binary: boolean): Promise<DiffContent> {
  const imageKind = imageKindForPath(input.filePath);

  if (imageKind === 'raster') {
    const result = await window.electronAPI.git.fileImage(input);
    const mimeType = imageMimeTypeForPath(input.filePath) ?? 'application/octet-stream';
    const [original, modified] = await Promise.all([
      prepareRasterSide(result.original, mimeType),
      prepareRasterSide(result.modified, mimeType),
    ]);
    return { text: EMPTY_DIFF_TEXT, image: { original, modified } };
  }

  if (binary && imageKind === null) return EMPTY_DIFF_CONTENT;

  const text = await window.electronAPI.git.fileContent(input);
  if (imageKind !== 'svg') return { text, image: null };

  const [original, modified] = await Promise.all([
    statusHasOriginal(input.status) ? prepareSvgSide(text.original) : null,
    statusHasModified(input.status) ? prepareSvgSide(text.modified) : null,
  ]);
  return { text, image: { original, modified } };
}

async function prepareRasterSide(side: GitImageSide | null, mimeType: string): Promise<DiffImageSide | null> {
  if (side === null) return null;
  if (side.kind === 'unreadable') return { kind: 'unreadable' };
  if (side.kind !== 'bytes') return { kind: side.kind, size: side.size };
  const dataUrl = await readAsDataUrl(new Blob([arrayBufferBacked(side.bytes)], { type: mimeType }));
  return decodeSide(dataUrl, side.size);
}

async function prepareSvgSide(text: string): Promise<DiffImageSide> {
  // An empty string is what the text reader returns for a side it could not read.
  if (text.length === 0) return { kind: 'unreadable' };
  const size = new Blob([text]).size;
  if (size > IMAGE_PREVIEW_MAX_BYTES) return { kind: 'too-large', size };
  return decodeSide(`data:${SVG_MIME_TYPE};charset=utf-8,${encodeURIComponent(text)}`, size);
}

/**
 * Load an image from a data URL. Waits for the `load` event rather than
 * `HTMLImageElement.decode()`: Chromium never settles `decode()` while the
 * document is hidden (a minimized window, a covered pop-out), which left a
 * file selected or refreshed there on a spinner, while `load` and `error`
 * fire either way. A byte stream that is not an image fires `error`.
 */
export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Not image data'));
    image.src = dataUrl;
  });
}

/** Load once up front: the result carries the natural size, and a failure means the bytes are not an image. */
async function decodeSide(dataUrl: string, size: number): Promise<DiffImageSide> {
  let image: HTMLImageElement;
  try {
    image = await loadImage(dataUrl);
  } catch {
    return { kind: 'undecodable', size };
  }
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return { kind: 'undecodable', size };
  return { kind: 'image', size, dataUrl, width: image.naturalWidth, height: image.naturalHeight };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image bytes'));
    reader.readAsDataURL(blob);
  });
}

/** IPC's structured clone always hands the renderer an ArrayBuffer-backed view; copy only if it did not. */
function arrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(bytes);
}

function imageSideEqual(first: DiffImageSide | null, second: DiffImageSide | null): boolean {
  if (first === null || second === null) return first === second;
  if (first.kind === 'unreadable' || second.kind === 'unreadable') return first.kind === second.kind;
  if (first.kind === 'image' || second.kind === 'image') {
    return first.kind === 'image' && second.kind === 'image'
      && first.size === second.size && first.dataUrl === second.dataUrl;
  }
  return first.kind === second.kind && first.size === second.size;
}

/**
 * Whether a background refresh produced anything the pane would draw
 * differently. Text compares as strings and images compare by their data URL,
 * which encodes every byte, so a regenerated PNG of the same size still counts
 * as changed.
 */
export function diffContentEqual(first: DiffContent, second: DiffContent): boolean {
  if (first.text.original !== second.text.original) return false;
  if (first.text.modified !== second.text.modified) return false;
  if (first.text.language !== second.text.language) return false;
  if (first.image === null || second.image === null) return first.image === second.image;
  return imageSideEqual(first.image.original, second.image.original)
    && imageSideEqual(first.image.modified, second.image.modified);
}

/** Approximate memory an entry's prepared images hold, for the cache budget. */
export function diffContentImageBytes(content: DiffContent): number {
  if (content.image === null) return 0;
  let total = 0;
  for (const side of [content.image.original, content.image.modified]) {
    if (side !== null && side.kind === 'image') total += side.dataUrl.length;
  }
  return total;
}

/**
 * Drop the least recently used image entries until the cache's images fit the
 * budget. Relies on Map insertion order, so a cache hit must re-insert its key
 * to count as recently used. Text-only entries are never evicted here, and
 * neither is the newest entry, which is the file on screen.
 */
export function trimImageCache<Entry extends { result: DiffContent }>(
  cache: Map<string, Entry>,
  budgetBytes: number = IMAGE_CACHE_BUDGET_BYTES,
): void {
  let total = 0;
  let newestKey: string | null = null;
  for (const [key, entry] of cache) {
    total += diffContentImageBytes(entry.result);
    newestKey = key;
  }
  for (const [key, entry] of cache) {
    if (total <= budgetBytes || key === newestKey) return;
    const weight = diffContentImageBytes(entry.result);
    if (weight === 0) continue;
    cache.delete(key);
    total -= weight;
  }
}
