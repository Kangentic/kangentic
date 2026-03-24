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

/** Extract the file extension (lowercase, including the dot) from a filename. */
export function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0) return '';
  return filename.slice(dotIndex).toLowerCase();
}
