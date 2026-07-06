import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { ModelFileSpec } from './model-registry';

/** Minimal shape `downloadModelFiles` needs. Any `ModelDef` satisfies it, and
 *  the conversation-memory embedding model reuses the same downloader. */
export interface DownloadableModel {
  files: ModelFileSpec[];
  approxSizeMb: number;
}

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

/**
 * Download one URL to `destPath`, following redirects (HuggingFace 302s to a
 * CDN). Streams to a `.part` file and atomically renames on success. Calls
 * `onChunk` with the byte delta of each received chunk.
 */
function downloadFileTo(
  url: string,
  destPath: string,
  onChunk: (deltaBytes: number) => void,
  redirectsLeft = MAX_REDIRECTS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const protocol = url.startsWith('http://') ? http : https;
    const partPath = `${destPath}.part`;

    const request = protocol.get(url, { timeout: REQUEST_TIMEOUT_MS }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;

      // Follow redirects.
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects downloading ${url}`));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadFileTo(nextUrl, destPath, onChunk, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed (${status}) for ${url}`));
        return;
      }

      const fileStream = fs.createWriteStream(partPath);
      response.on('data', (chunk: Buffer) => onChunk(chunk.length));
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          try {
            fs.renameSync(partPath, destPath);
            resolve();
          } catch (renameError) {
            // Windows can briefly lock a just-closed file (AV scan), failing the
            // rename with EPERM/EBUSY. Clean up the partial like the stream- and
            // request-error paths so a stale `.part` is not left behind.
            fs.rm(partPath, { force: true }, () => reject(renameError));
          }
        });
      });
      fileStream.on('error', (streamError) => {
        fs.rm(partPath, { force: true }, () => reject(streamError));
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
    request.on('error', (requestError) => {
      fs.rm(partPath, { force: true }, () => reject(requestError));
    });
  });
}

/**
 * Download every file of a model into `destDir`, skipping files already present
 * (resume-friendly). Reports cumulative progress against an estimated total.
 */
export async function downloadModelFiles(
  model: DownloadableModel,
  destDir: string,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const totalBytes = Math.max(1, Math.round(model.approxSizeMb * 1024 * 1024));
  let downloadedBytes = 0;

  for (const fileSpec of model.files) {
    const destPath = path.join(destDir, fileSpec.file);
    if (fs.existsSync(destPath)) {
      continue;
    }
    // Nested file paths (e.g. `<model-id>/onnx/model_quantized.onnx`) need their
    // parent created; dictation models are flat, so this is a no-op for them.
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await downloadFileTo(fileSpec.url, destPath, (delta) => {
      downloadedBytes += delta;
      onProgress({ downloadedBytes, totalBytes });
    });
  }

  onProgress({ downloadedBytes: totalBytes, totalBytes });
}
