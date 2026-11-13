import fs from 'node:fs';
import path from 'node:path';
import { RefusalError } from '../../../shared/refusal';

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.log': 'text/plain',
};

export interface ReadFileResult {
  filename: string;
  base64Data: string;
  mediaType: string;
  sizeBytes: number;
}

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

export function attachmentTooLargeMessage(sizeBytes: number): string {
  return `File too large (${Math.round(sizeBytes / 1024 / 1024)}MB). Maximum attachment size is ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB.`;
}

/**
 * A file's bytes as an attachment. `namedPath` gives its name and type, and is a host's path for a file that came
 * from one, so it is split on either separator rather than this computer's.
 */
export function attachmentFromBytes(bytes: Buffer, namedPath: string, overrideFilename?: string): ReadFileResult {
  const baseName = namedPath.split(/[\\/]/).pop() ?? namedPath;
  const extension = path.extname(baseName).toLowerCase();
  return {
    filename: overrideFilename ?? baseName,
    base64Data: bytes.toString('base64'),
    mediaType: EXTENSION_MEDIA_TYPES[extension] ?? 'application/octet-stream',
    sizeBytes: bytes.length,
  };
}

/**
 * Read a file from disk and return it as base64 with metadata.
 * Used by MCP command handlers to attach files from absolute paths.
 */
export function readFileAsAttachment(filePath: string, overrideFilename?: string): ReadFileResult {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new RefusalError(attachmentTooLargeMessage(stat.size));
  return attachmentFromBytes(fs.readFileSync(filePath), filePath, overrideFilename ?? path.basename(filePath));
}
