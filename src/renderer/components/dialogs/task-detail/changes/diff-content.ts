import type { GitFileContentInput, GitFileContentResult, GitImageSide } from '../../../../../shared/types';
import { imageKindForPath, imageMimeTypeForPath } from '../../../../../shared/image-preview';

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
 * `fingerprint` is main's name for the bytes, sent back on the next fetch of
 * the same file so main can answer that the side has not changed.
 */
export type DiffImageSide =
  | { kind: 'image'; size: number; dataUrl: string; width: number; height: number; fingerprint: string }
  | { kind: 'too-large'; size: number; fingerprint: string }
  | { kind: 'lfs-pointer'; size: number; fingerprint: string }
  | { kind: 'undecodable'; size: number; fingerprint: string }
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

/**
 * Fetch what the diff pane shows for one file. A raster image reads bytes only
 * (it has no text form). A binary file that is not an image needs neither
 * read, since its pane shows the binary placeholder. Everything else reads
 * text, and an SVG also reads its bytes for the image view, including an SVG
 * `.gitattributes` marks binary (its markup is still a valid image). Reading
 * the bytes rather than reusing the text keeps a failed read apart from an
 * empty file, and reports the file's real byte size.
 *
 * `previous` is content already fetched for this same file and scope. Its
 * image sides' fingerprints go to main, and a side main answers `unchanged`
 * is that same side object, so a refresh that changed nothing neither resends
 * nor re-decodes an image, and the pixel diff's cache, keyed on side
 * identity, still hits.
 */
export async function fetchDiffContent(
  input: GitFileContentInput,
  binary: boolean,
  previous: DiffContent | null = null,
): Promise<DiffContent> {
  const imageKind = imageKindForPath(input.filePath);
  if (binary && imageKind === null) return EMPTY_DIFF_CONTENT;

  const previousImage = previous?.image ?? null;
  if (imageKind === 'raster') return { text: EMPTY_DIFF_TEXT, image: await fetchImageSides(input, previousImage) };
  if (imageKind === 'svg') {
    // The image half settles on its own: an SVG is first of all a text diff,
    // and a failed image read must not take the text down with it. A null
    // image then shows as a failed read in the preview alone.
    const [text, image] = await Promise.all([
      window.electronAPI.git.fileContent(input),
      fetchImageSides(input, previousImage).catch(() => null),
    ]);
    return { text, image };
  }
  return { text: await window.electronAPI.git.fileContent(input), image: null };
}

function fingerprintOf(side: DiffImageSide | null): string | undefined {
  return side === null || side.kind === 'unreadable' ? undefined : side.fingerprint;
}

async function fetchImageSides(input: GitFileContentInput, previous: DiffImageContent | null): Promise<DiffImageContent> {
  const previousOriginal = previous?.original ?? null;
  const previousModified = previous?.modified ?? null;
  const result = await window.electronAPI.git.fileImage({
    ...input,
    knownFingerprints: { original: fingerprintOf(previousOriginal), modified: fingerprintOf(previousModified) },
  });
  const mimeType = imageMimeTypeForPath(input.filePath) ?? 'application/octet-stream';
  const [original, modified] = await Promise.all([
    prepareImageSide(result.original, previousOriginal, mimeType),
    prepareImageSide(result.modified, previousModified, mimeType),
  ]);
  return { original, modified };
}

async function prepareImageSide(
  side: GitImageSide | null,
  previous: DiffImageSide | null,
  mimeType: string,
): Promise<DiffImageSide | null> {
  if (side === null) return null;
  if (side.kind === 'unreadable') return { kind: 'unreadable' };
  if (side.kind === 'unchanged') {
    // Main matched the fingerprint this fetch sent, which came from `previous`.
    // A mismatch here would mean main answered for a side this caller never
    // held; showing nothing is safer than showing the wrong image.
    if (previous !== null && previous.kind !== 'unreadable' && previous.fingerprint === side.fingerprint) return previous;
    return { kind: 'unreadable' };
  }
  if (side.kind !== 'bytes') return { kind: side.kind, size: side.size, fingerprint: side.fingerprint };
  const dataUrl = await readAsDataUrl(new Blob([arrayBufferBacked(side.bytes)], { type: mimeType }));
  return decodeSide(dataUrl, side.size, side.fingerprint);
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
async function decodeSide(dataUrl: string, size: number, fingerprint: string): Promise<DiffImageSide> {
  let image: HTMLImageElement;
  try {
    image = await loadImage(dataUrl);
  } catch {
    return { kind: 'undecodable', size, fingerprint };
  }
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return { kind: 'undecodable', size, fingerprint };
  return { kind: 'image', size, dataUrl, width: image.naturalWidth, height: image.naturalHeight, fingerprint };
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
 * as changed. A side main answered `unchanged` is the previous side itself,
 * whose data URL is the same string, so that comparison is immediate.
 */
export function diffContentEqual(first: DiffContent, second: DiffContent): boolean {
  if (first.text.original !== second.text.original) return false;
  if (first.text.modified !== second.text.modified) return false;
  if (first.text.language !== second.text.language) return false;
  if (first.image === null || second.image === null) return first.image === second.image;
  return imageSideEqual(first.image.original, second.image.original)
    && imageSideEqual(first.image.modified, second.image.modified);
}

/**
 * The cache budget's weight for one entry: the length of its sides' data
 * URLs. That is the memory a cached entry holds for certain. Its decoded
 * pixels are not counted, because Chromium may drop them for an image that
 * is off screen and decodes again on demand. The Diff mode's masks are not
 * counted either: they are cached against side identity and are freed with
 * the entry.
 */
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

export type ImageCompareMode = 'side-by-side' | 'slider' | 'overlay' | 'diff';

export interface ImageCompareState {
  /** Both sides decoded, so Slider, Overlay and Diff can draw them on one canvas. */
  comparable: boolean;
  /** The chosen mode, or Side by side when the sides cannot be compared. */
  effectiveMode: ImageCompareMode;
  /** Both sides exist and at least one decoded, so the mode row has something to switch. */
  showsModeRow: boolean;
  /** The diff toolbar's split/stacked toggle applies: the mode row shows and lays the images out side by side. */
  showsLayoutToggle: boolean;
}

/**
 * Which comparison an image pair supports. One function for the image view
 * and the diff toolbar, so the toolbar's layout toggle can never disagree
 * with the mode the view actually draws.
 */
export function imageCompareState(image: DiffImageContent, mode: ImageCompareMode): ImageCompareState {
  const { original, modified } = image;
  const comparable = original?.kind === 'image' && modified?.kind === 'image';
  const effectiveMode = comparable ? mode : 'side-by-side';
  const showsModeRow = original !== null && modified !== null && (original.kind === 'image' || modified.kind === 'image');
  return { comparable, effectiveMode, showsModeRow, showsLayoutToggle: showsModeRow && effectiveMode === 'side-by-side' };
}
