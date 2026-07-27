import { Image as ImageIcon, FileText, FileCode, File as FileIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

/** MIME-to-extension map for generating filenames on paste (not for filtering). */
export const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

/** Filename prefixes for clipboard pastes, which arrive with no usable name. */
export const PASTED_IMAGE_PREFIX = 'pasted-image-';
export const PASTED_FILE_PREFIX = 'pasted-file-';

export function pastedAttachmentPrefix(mediaType: string): string {
  return isImageMediaType(mediaType) ? PASTED_IMAGE_PREFIX : PASTED_FILE_PREFIX;
}

/** Highest index already used by `<prefix><n>.<ext>` names in the list, or 0. */
function highestPastedIndex(prefix: string, existingFilenames: readonly string[]): number {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedPrefix}(\\d+)\\.`);
  let highest = 0;
  for (const filename of existingFilenames) {
    const match = pattern.exec(filename);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Reserve the next index for a pasted attachment's generated filename.
 *
 * Pasting two images in quick succession used to produce two files both called
 * `pasted-image-1.png`. The old scheme counted existing attachments and added an
 * in-flight counter that was decremented once the save resolved - but the
 * attachment list only reflects that save after React re-renders and rebinds the
 * paste callback. A paste landing in the gap between those two saw a decremented
 * counter AND a stale list, so it reissued an index that was already taken.
 *
 * `issuedHighest` is therefore a monotonic high-water mark the caller keeps in a
 * ref and never decrements, so an index cannot be handed out twice no matter how
 * the async saves interleave. It is combined with (not trusted over) the indices
 * already present in `existingFilenames`, so the numbering is still correct when
 * the ref starts at zero on a fresh mount but attachments were loaded from disk.
 * Indices are unique, not necessarily gapless: a failed save burns its number.
 */
export function reserveNextPastedIndex(
  prefix: string,
  existingFilenames: readonly string[],
  issuedHighest: number,
): number {
  return Math.max(highestPastedIndex(prefix, existingFilenames), issuedHighest) + 1;
}

/** Return the appropriate Lucide icon for a given media type. */
export function getFileTypeIcon(mediaType: string): LucideIcon {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType === 'application/pdf') return FileText;
  if (mediaType === 'application/x-ipynb+json') return FileCode;
  if (mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml') return FileText;
  return FileIcon;
}

/** Return a human-readable label for a media type. */
export function getFileTypeLabel(mediaType: string): string {
  if (mediaType.startsWith('image/')) return 'Image';
  if (mediaType === 'application/pdf') return 'PDF Document';
  if (mediaType === 'application/x-ipynb+json') return 'Jupyter Notebook';
  if (mediaType === 'application/json') return 'JSON File';
  if (mediaType === 'application/xml') return 'XML File';
  if (mediaType.startsWith('text/')) return 'Text File';
  return 'File';
}

/**
 * Resolve the correct MIME type for a file.
 * Browsers report .ipynb as application/json or empty string,
 * so we detect by extension and return the canonical type.
 * Falls back to application/octet-stream for unknown empty types.
 */
export function resolveMediaType(file: File): string {
  const extension = getExtension(file.name);
  if (extension === '.ipynb') return 'application/x-ipynb+json';
  if (file.type) return file.type;
  return 'application/octet-stream';
}

/** Extract the file extension (lowercase, including the dot) from a filename.
 *  Module-local: the attachment chips show a type icon rather than an extension
 *  badge, so `resolveMediaType` above is the only caller. */
function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0) return '';
  return filename.slice(dotIndex).toLowerCase();
}
