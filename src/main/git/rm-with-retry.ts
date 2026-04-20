import fs from './original-fs';

/**
 * Recursive directory removal with short retry for Windows transients.
 *
 * Uses `original-fs` so the walk doesn't trigger Electron's asar
 * interception (see `original-fs.ts`). Retries cover real transients only:
 * PTY handle release after process exit, brief AV scans, Explorer
 * thumbnailers. Each settles in <500ms; if a path is still locked after
 * 600ms of retries, something else is holding it and waiting longer
 * doesn't help.
 *
 * `force: true` silences ENOENT.
 */

const RETRY_DELAYS_MS = [0, 100, 500] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function removeWithRetry(targetPath: string): Promise<void> {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`removeWithRetry exhausted retries for ${targetPath}`);
}
