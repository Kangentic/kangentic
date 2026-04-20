import fs from 'node:fs';

/**
 * Recursive directory removal with exponential-backoff retry.
 *
 * Thin wrapper over `fs.promises.rm(path, { recursive: true, force: true })`.
 * We delegate the tree walk to Node so junction/symlink semantics stay
 * correct on every platform (Node opens Windows junctions with
 * FILE_FLAG_OPEN_REPARSE_POINT and removes the link, not the target); the
 * only thing this function adds is a longer, exponentially-spaced retry
 * window than Node's `maxRetries`/`retryDelay` options allow.
 *
 * Retry schedule: 0 / 100 / 500 / 2000 ms (total ceiling ~2.6s). This is
 * enough to ride out the common Windows transients (EBUSY/EPERM/ENOTEMPTY
 * from lingering PTY handles, AV scans, and Explorer thumbnailers) without
 * holding the event loop in a single long sleep. EISDIR from a racy tree
 * walk is absorbed by the same retry mechanism - the underlying race
 * resolves within one tick, and the next attempt succeeds.
 *
 * `force: true` already silences ENOENT, so an already-gone path just
 * resolves. Callers that hit the thrown rejection leave `task.worktree_path`
 * populated so the startup retry pass in `resource-cleanup.ts`
 * (`retryFailedDoneCleanups`) can try again on the next project open.
 */

const RETRY_DELAYS_MS = [0, 100, 500, 2000] as const;

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
