import fs from './original-fs';

/**
 * Recursive directory removal with retry for Windows transients.
 *
 * Uses `original-fs` so the walk doesn't trigger Electron's asar
 * interception (see `original-fs.ts`).
 *
 * Two modes, chosen by whether the caller passes `budgetMs`:
 *
 * UNBUDGETED (the historical default). Two layers of retry, sized to outlast
 * the documented 1500ms ConPTY handle-release grace window plus AV / search-
 * indexer / thumbnailer scans:
 *
 *   Inner (Node built-in, per-file): { maxRetries: 10, retryDelay: 200 }
 *     Node retries individual unlink/rmdir calls on EBUSY/ENOTEMPTY/EPERM/
 *     EMFILE/ENFILE. ~2s budget per locked path, fine-grained.
 *
 *   Outer (this loop, per-tree): [0, 200, 500, 1000, 2000] ms between
 *     attempts. Backstop for failures that escape the inner retry (e.g.
 *     re-locks during the tree walk). ~3.7s additional wall-clock budget.
 *
 *   The catch, and the reason the budgeted mode exists: Node applies the inner
 *   ladder PER LOCKED PATH, so the real ceiling scales with the tree, not with
 *   the clock. A worktree pinned by a live process ground for 402716ms in one
 *   observed incident while it held the per-project git queue.
 *
 * BUDGETED (`budgetMs` set). One wall clock owns the whole call. Node's
 * per-path retry is turned OFF (`maxRetries: 0`) and this loop drives every
 * retry, walking the same delay ladder and saturating at its last value until
 * the deadline. That is what makes the bound hard: with no inner ladder, a
 * pass over a locked tree rejects at the first EPERM, so the worst case is one
 * fast tree walk past the deadline instead of a multi-second grind per path.
 *
 * The retry coverage is not lost. A 30s budget with the ladder saturating at
 * 2s gives roughly 15 passes, well past the ConPTY grace window the two-layer
 * shape was sized for. Per-path retry only buys "do not restart the walk for
 * one transient", which is a nicety on a clean tree and worthless on a locked
 * one.
 *
 * `force: true` silences ENOENT in both modes, so a partially-removed tree on
 * the previous attempt does not fail the next.
 */

const RETRY_DELAYS_MS = [0, 200, 500, 1000, 2000] as const;
const INNER_MAX_RETRIES = 10;
const INNER_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown by a budgeted `removeWithRetry` that ran out of wall clock. Distinct
 * from a plain errno failure so the caller can report "still locked, gave up"
 * rather than blaming the last transient. `cause` carries the final errno
 * error, which is the actual diagnostic.
 */
export class WorktreeRemovalTimeoutError extends Error {
  readonly budgetMs: number;
  readonly elapsedMs: number;

  constructor(targetPath: string, budgetMs: number, elapsedMs: number, cause?: unknown) {
    super(
      `removeWithRetry gave up on ${targetPath} after ${elapsedMs}ms (budget ${budgetMs}ms)`,
      { cause },
    );
    this.name = 'WorktreeRemovalTimeoutError';
    this.budgetMs = budgetMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Guard for the above. Checks the name as well as the prototype so a value that
 * crossed a module realm (a re-bundled copy, a test double) still classifies,
 * mirroring `isGitTimeoutError` in `git-spawn.ts`.
 */
export function isRemovalTimeoutError(error: unknown): error is WorktreeRemovalTimeoutError {
  return error instanceof WorktreeRemovalTimeoutError
    || (error instanceof Error && error.name === 'WorktreeRemovalTimeoutError');
}

/**
 * Tunes the retry budget. A best-effort/background caller can collapse the
 * unbudgeted mode by passing `{ delays: [0], innerMaxRetries: 0 }` to attempt
 * removal exactly once with no backoff (outer) and no per-file retry (inner).
 *
 * `budgetMs` switches to the deadline-driven mode described in the module
 * header and is the only option that bounds the call by the CLOCK rather than
 * by the tree. It supersedes `innerMaxRetries` and `innerRetryDelayMs`, which
 * are ignored while it is set.
 */
export interface RemoveWithRetryOptions {
  delays?: readonly number[];
  innerMaxRetries?: number;
  innerRetryDelayMs?: number;
  /** Wall-clock ceiling in ms. Absent means the historical tree-scaled budget. */
  budgetMs?: number;
}

export async function removeWithRetry(
  targetPath: string,
  options?: RemoveWithRetryOptions,
): Promise<void> {
  const delays = options?.delays?.length ? options.delays : RETRY_DELAYS_MS;
  if (options?.budgetMs !== undefined) {
    return removeUntilDeadline(targetPath, delays, options.budgetMs);
  }

  const maxRetries = options?.innerMaxRetries ?? INNER_MAX_RETRIES;
  const retryDelay = options?.innerRetryDelayMs ?? INNER_RETRY_DELAY_MS;
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      await fs.promises.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries,
        retryDelay,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`removeWithRetry exhausted retries for ${targetPath}`);
}

/**
 * Retry until the tree is gone or the deadline passes. The first attempt always
 * runs, however small the budget, so a zero budget still means "try once".
 */
async function removeUntilDeadline(
  targetPath: string,
  delays: readonly number[],
  budgetMs: number,
): Promise<void> {
  const startedAt = Date.now();
  const expiresAt = startedAt + budgetMs;
  let lastError: unknown;
  let attempt = 0;

  for (;;) {
    const delay = delays[Math.min(attempt, delays.length - 1)];
    if (delay > 0) {
      // Never sleep past the deadline: waiting it out and then reporting a
      // timeout wastes the whole remainder of the budget.
      if (Date.now() + delay >= expiresAt) break;
      await sleep(delay);
    }
    if (attempt > 0 && Date.now() >= expiresAt) break;

    try {
      // maxRetries: 0 is deliberate. This loop owns every retry, so a pass over
      // a locked tree rejects at the first EPERM instead of grinding Node's
      // per-path ladder for seconds on each one.
      await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
    }
    attempt += 1;
  }

  throw new WorktreeRemovalTimeoutError(targetPath, budgetMs, Date.now() - startedAt, lastError);
}
