import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { pipeline } from 'node:stream';
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

/** Calls `callback` once `stream` has released its descriptor. */
function whenClosed(stream: fs.WriteStream, callback: () => void): void {
  if (stream.closed) {
    callback();
    return;
  }
  stream.once('close', callback);
}

/**
 * The host or the network did not serve a model file: the request timed out, or
 * the server answered that it is busy or failing (408, 429, any 5xx). It is an
 * expected class (`EXPECTED_FAILURE_NAMES` in `analytics/handled-report.ts`), so
 * no reporter files it, and the user sees its message as before. Every other
 * status, a 404 above all, stays a plain `Error` and does report: a URL this
 * build ships is wrong or gone, and only a release fixes that.
 */
export class ModelDownloadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDownloadUnavailableError';
  }
}

/** A status a later try may not get: the server is busy, slow or failing. */
function isUnavailableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Download one URL to `destPath`, following redirects (HuggingFace 302s to a
 * CDN). Streams to a `.part` file and atomically renames on success. Calls
 * `onChunk` with the byte delta of each received chunk.
 *
 * The body goes through `pipeline`, which destroys both streams when either
 * fails. `response.pipe` did not: a response that errored or was cut off
 * mid-body (a dropped connection, or the timeout below after the headers)
 * left the `.part` file's descriptor open for the life of the process (Sentry
 * DESKTOP-59), and the promise never settled, since a socket failure after the
 * headers reaches the response and not the request.
 *
 * Settles once. A failure removes the `.part` file only after its descriptor
 * is closed, and a success renames only then, because Windows refuses to
 * rename a file that is still open.
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
    let settled = false;
    let fileStream: fs.WriteStream | null = null;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      const removePart = (): void => fs.rm(partPath, { force: true }, () => reject(error));
      if (fileStream) whenClosed(fileStream, removePart);
      else removePart();
    };

    const request = protocol.get(url, { timeout: REQUEST_TIMEOUT_MS }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;

      // Follow redirects. The next request owns the outcome from here, so a
      // late error on this one must not settle it or remove the next one's part.
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        settled = true;
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
        settled = true;
        const message = `Download failed (${status}) for ${url}`;
        reject(isUnavailableStatus(status) ? new ModelDownloadUnavailableError(message) : new Error(message));
        return;
      }

      const partStream = fs.createWriteStream(partPath);
      fileStream = partStream;
      response.on('data', (chunk: Buffer) => onChunk(chunk.length));
      pipeline(response, partStream, (pipelineError) => {
        if (pipelineError) {
          fail(pipelineError);
          return;
        }
        whenClosed(partStream, () => {
          if (settled) return;
          try {
            fs.renameSync(partPath, destPath);
            settled = true;
            resolve();
          } catch (renameError) {
            // Windows can briefly lock a just-closed file (AV scan), failing the
            // rename with EPERM/EBUSY. Clean up the partial like the stream- and
            // request-error paths so a stale `.part` is not left behind.
            fail(renameError);
          }
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(new ModelDownloadUnavailableError(`Timed out downloading ${url}`));
    });
    request.on('error', fail);
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
  // sync-write-ok: this must throw, not degrade - a model directory that
  // cannot be created leaves nowhere for the download below to land. Both of
  // transcription-service.ts's callers (buildAndLoad, prewarm) already wrap
  // their ensureModels() call in a try/catch that emits a `status: 'error'`
  // model-progress event (surfaced in the Dictation settings tab) and
  // re-throws.
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
    // sync-write-ok: same reason as the mkdir above.
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await downloadFileTo(fileSpec.url, destPath, (delta) => {
      downloadedBytes += delta;
      onProgress({ downloadedBytes, totalBytes });
    });
  }

  onProgress({ downloadedBytes: totalBytes, totalBytes });
}
