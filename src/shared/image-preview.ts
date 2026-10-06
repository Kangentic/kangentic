/**
 * Which changed files the Changes panel can show as an image, and the limits
 * on reading them. Shared by main (which reads the bytes) and the renderer
 * (which decides between the image view and the text diff), so the two can
 * never disagree about whether a path is an image.
 *
 * Raster formats are flagged binary by git and have no text form, so they
 * always open in the image view. SVG is text: it opens on its Monaco diff and
 * offers an image preview, unless `.gitattributes` marks it binary, in which
 * case the image view is the only useful one.
 */

export type ImageKind = 'raster' | 'svg';

/** MIME type per lowercase extension. Every entry is a format Chromium decodes in an `<img>`. */
const RASTER_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const SVG_MIME_TYPE = 'image/svg+xml';

/**
 * Per-side cap on what main reads and sends over IPC. A regenerated store
 * screenshot is 0.3 to 3 MB; past this the pane shows the file sizes instead
 * of decoding a huge image in the renderer.
 */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** Git LFS stores a small text pointer in place of the file; its first line is fixed by the spec. */
const GIT_LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/';

/** A pointer file is about 130 bytes; anything much larger cannot be one. */
const GIT_LFS_POINTER_MAX_BYTES = 1024;

function extensionOf(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const baseName = filePath.slice(lastSlash + 1);
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return baseName.slice(dotIndex + 1).toLowerCase();
}

// Object.hasOwn, not `in` or a bare index: a file named `notes.constructor`
// must not match a member the table inherits from Object.prototype.
export function imageKindForPath(filePath: string): ImageKind | null {
  const extension = extensionOf(filePath);
  if (extension === 'svg') return 'svg';
  if (Object.hasOwn(RASTER_IMAGE_MIME_TYPES, extension)) return 'raster';
  return null;
}

export function imageMimeTypeForPath(filePath: string): string | null {
  const extension = extensionOf(filePath);
  if (extension === 'svg') return SVG_MIME_TYPE;
  return Object.hasOwn(RASTER_IMAGE_MIME_TYPES, extension) ? RASTER_IMAGE_MIME_TYPES[extension] : null;
}

/** True when the bytes are a Git LFS pointer file rather than the image it stands for. */
export function isGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.length > GIT_LFS_POINTER_MAX_BYTES || bytes.length < GIT_LFS_POINTER_PREFIX.length) return false;
  for (let index = 0; index < GIT_LFS_POINTER_PREFIX.length; index++) {
    if (bytes[index] !== GIT_LFS_POINTER_PREFIX.charCodeAt(index)) return false;
  }
  return true;
}
