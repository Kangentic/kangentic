import path from 'node:path';
import originalFs from '../git/original-fs';

/**
 * Cross-platform directory move engine for project relocation.
 *
 * `moveDirectory` relocates a directory tree from `sourcePath` to
 * `destinationPath`. It prefers an atomic `rename` (instant, same-volume) and
 * falls back to a recursive copy when the destination is on a different volume
 * (the OS reports `EXDEV`). It deliberately does NOT delete the source after a
 * copy: the caller owns that decision so the source survives until the work
 * that depends on the new location has succeeded.
 *
 * Everything runs through `original-fs` (the unpatched Node `fs`, not
 * Electron's asar-aware patch) and via the async `fs.promises.*` API so the
 * main-process event loop stays responsive during a long copy. See
 * `src/main/git/original-fs.ts` for why the patched `fs` would EBUSY on a tree
 * containing `.asar` files (a project's `node_modules` can hold them).
 */

/** Progress emitted while the cross-volume copy fallback runs. */
export interface DirectoryCopyProgress {
  copiedEntries: number;
  totalEntries: number;
}

export interface MoveDirectoryOptions {
  /**
   * Called as the copy fallback advances. Never called for the atomic-rename
   * strategy (which is instant). Emissions are throttled to ~100ms plus a
   * forced final emission at completion.
   */
  onCopyProgress?: (progress: DirectoryCopyProgress) => void;
}

export type MoveDirectoryResult =
  | { strategy: 'rename' }
  | { strategy: 'copy'; totalEntries: number };

/**
 * Windows releases handles (anti-virus scanners, a file watcher that was just
 * closed) asynchronously, so a rename or a delete can transiently fail with
 * EBUSY/EPERM even after we released our own handles. These codes are retried
 * with backoff before giving up, by `renameWithRetry` here and by the Done
 * move's deleter (`src/main/git/removed-worktrees.ts`).
 */
export const TRANSIENT_HANDLE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const MAX_RENAME_ATTEMPTS = 5;
const COPY_PROGRESS_THROTTLE_MS = 100;

/**
 * Windows-aware recursive-remove options: `force` swallows already-gone paths
 * and read-only files, `recursive` removes children, and `maxRetries` /
 * `retryDelay` ride out transient AV/indexer locks. Shared by the cross-volume
 * copy rollback and `removeDirectoryTree`.
 */
const WINDOWS_RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 200 } as const;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Count every entry (directories and files) under `directoryPath`, recursively.
 * Used as the copy denominator so the per-entry progress filter and the total
 * are derived the same way and end exactly equal.
 */
async function countEntries(directoryPath: string): Promise<number> {
  let total = 0;
  const entries = await originalFs.promises.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    total += 1;
    if (entry.isDirectory()) {
      total += await countEntries(path.join(directoryPath, entry.name));
    }
  }
  return total;
}

/**
 * Rename `sourcePath` to `destinationPath`, retrying the transient Windows
 * handle holds above with a 100, 200, 400, 800 ms backoff. Any other failure,
 * EXDEV included, is thrown at once, and so is the last retryable one.
 */
export async function renameWithRetry(sourcePath: string, destinationPath: string): Promise<void> {
  let lastRenameError: unknown;
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await originalFs.promises.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (!code || !TRANSIENT_HANDLE_CODES.has(code)) throw error;
      lastRenameError = error;
      if (attempt < MAX_RENAME_ATTEMPTS - 1) await delay(100 * 2 ** attempt);
    }
  }
  throw lastRenameError;
}

export async function moveDirectory(
  sourcePath: string,
  destinationPath: string,
  options: MoveDirectoryOptions = {},
): Promise<MoveDirectoryResult> {
  // Strategy 1: atomic rename, with retry for transient Windows handle holds.
  try {
    await renameWithRetry(sourcePath, destinationPath);
    return { strategy: 'rename' };
  } catch (error) {
    // EXDEV means the destination is on a different volume; no number of
    // retries will help. Switch to the copy fallback.
    if (errorCode(error) === 'EXDEV') {
      return copyDirectory(sourcePath, destinationPath, options);
    }
    throw error;
  }
}

/**
 * Cross-volume fallback: recursive copy with progress, leaving the source in
 * place. On any failure the partially-written destination is removed before
 * the original error is rethrown, so the caller is left with nothing changed.
 */
async function copyDirectory(
  sourcePath: string,
  destinationPath: string,
  options: MoveDirectoryOptions,
): Promise<MoveDirectoryResult> {
  const totalEntries = await countEntries(sourcePath);
  let copiedEntries = 0;
  let lastEmit = 0;

  const emit = (force: boolean): void => {
    if (!options.onCopyProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < COPY_PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    options.onCopyProgress({ copiedEntries, totalEntries });
  };

  emit(true);

  try {
    await originalFs.promises.cp(sourcePath, destinationPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      preserveTimestamps: true,
      filter: (source: string): boolean => {
        // `cp` invokes the filter for the source dir itself plus every child;
        // `countEntries` counts children only, so skip the root to keep the
        // tally aligned. `path.relative(...) === ''` is separator- and
        // case-robust (unlike a strict string compare) should a caller ever
        // pass a differently-cased or mixed-separator sourcePath.
        if (path.relative(sourcePath, source) !== '') {
          copiedEntries += 1;
          emit(false);
        }
        return true;
      },
    });
  } catch (error) {
    // Roll back the partial copy. force+recursive so a partially-written tree
    // (including read-only files on Windows) is fully removed; retryDelay gives
    // Windows AV/indexer handles time to release. Best-effort.
    await originalFs.promises
      .rm(destinationPath, WINDOWS_RM_OPTIONS)
      .catch(() => undefined);
    throw error;
  }

  emit(true);
  return { strategy: 'copy', totalEntries };
}

/**
 * Recursively remove a directory tree. Windows-aware: `force` swallows
 * already-gone paths, `recursive` removes children, and `maxRetries` rides out
 * transient locks. Used by the relocation flow to delete the source AFTER a
 * cross-volume copy plus the dependent relocation work has succeeded.
 */
export async function removeDirectoryTree(targetPath: string): Promise<void> {
  await originalFs.promises.rm(targetPath, WINDOWS_RM_OPTIONS);
}
