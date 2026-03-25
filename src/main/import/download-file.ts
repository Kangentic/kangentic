import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import type { DownloadedAttachment } from './importer';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
export const DOWNLOAD_CONCURRENCY = 3;

const MAX_REDIRECTS = 3;

export function mediaTypeFromFilename(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
  };
  return mimeTypes[extension ?? ''] ?? 'application/octet-stream';
}

/** Download a file from a URL, returning base64 data. Returns null if too large or failed. */
export async function downloadFile(
  url: string,
  filename: string,
  options?: { headers?: Record<string, string> },
  remainingRedirects = MAX_REDIRECTS,
): Promise<DownloadedAttachment | null> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https://') ? https : http;
    const requestOptions: https.RequestOptions = {
      timeout: 30_000,
      headers: options?.headers,
    };
    const request = protocol.get(url, requestOptions, (response) => {
      // Follow redirects with depth limit
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        request.destroy();
        if (remainingRedirects <= 0) {
          resolve(null);
          return;
        }
        // Drop auth headers on cross-origin redirects (e.g. Azure DevOps -> Azure Blob Storage)
        const redirectUrl = response.headers.location;
        let redirectOptions = options;
        if (options?.headers && redirectUrl.startsWith('http')) {
          try {
            const originalHost = new URL(url).host;
            const redirectHost = new URL(redirectUrl).host;
            if (originalHost !== redirectHost) {
              const filteredHeaders = Object.fromEntries(
                Object.entries(options.headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
              );
              redirectOptions = { headers: Object.keys(filteredHeaders).length > 0 ? filteredHeaders : undefined };
            }
          } catch { /* keep original options on URL parse failure */ }
        }
        downloadFile(redirectUrl, filename, redirectOptions, remainingRedirects - 1).then(resolve).catch(() => resolve(null));
        return;
      }

      if (response.statusCode !== 200) {
        request.destroy();
        resolve(null);
        return;
      }

      // Check content-length header first
      const contentLength = parseInt(response.headers['content-length'] ?? '0', 10);
      if (contentLength > MAX_ATTACHMENT_SIZE) {
        request.destroy();
        resolve(null);
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      let aborted = false;

      response.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_ATTACHMENT_SIZE) {
          aborted = true;
          request.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (aborted) return;
        const buffer = Buffer.concat(chunks);
        resolve({
          filename,
          data: buffer.toString('base64'),
          mediaType: mediaTypeFromFilename(filename),
          sizeBytes: buffer.length,
          sourceUrl: url,
        });
      });

      response.on('error', () => {
        if (!aborted) resolve(null);
      });
    });

    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}
