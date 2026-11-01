import path from 'node:path';

/**
 * Worktree paths whose creation is in flight, keyed by path.
 *
 * A creation runs in two phases (see `ensureTaskWorktree`): the git phase
 * inside the per-project git queue, then the setup phase (copy files, link
 * node_modules, the Post-Worktree Script) after the queue is released. While
 * the script ran inside the queue, every removal of the same path waited
 * behind it. It no longer does, so this registry is what keeps a removal, a
 * sweep, or a second creation for the same task off a worktree that is still
 * being set up. The worktree is recorded on its task only once setup ends, so
 * for that whole window nothing else in the app knows the directory is live.
 *
 * `withTaskLock` cannot play this role: several callers already hold it across
 * `ensureTaskWorktree`, and it is not reentrant.
 *
 * A removal OUTSIDE the git queue waits for the entry to settle
 * (`prepareWorktreeForRemoval`); a removal INSIDE the queue refuses the path
 * instead (`removeWorktreeInternal`), so it never holds the queue while a
 * script runs. An entry settles only once an aborted script's process tree is
 * gone (`spawnWithAbort`), so "settled" means nothing is writing there.
 */
const creationsInFlight = new Map<string, Promise<void>>();

/** Normalize a worktree path for use as a key (Windows is case-insensitive). */
function creationKey(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Run `creation` as the only creation for `worktreePath`. Waits first for any
 * creation already in flight there, then claims the path in the same
 * synchronous step that found it free, so two waiters can never both proceed.
 * `creation` receives whether it had to wait: a caller that waited re-reads
 * whatever the earlier creation may have recorded. An abort of `signal` ends
 * the wait with the signal's reason, before `creation` runs.
 */
export async function runWorktreeCreation<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  creation: (waited: boolean) => Promise<T>,
): Promise<T> {
  const key = creationKey(worktreePath);
  let waited = false;
  let inFlight = creationsInFlight.get(key);
  while (inFlight) {
    waited = true;
    signal?.throwIfAborted();
    await settledOrAborted(inFlight, signal);
    signal?.throwIfAborted();
    inFlight = creationsInFlight.get(key);
  }

  let release: () => void = () => undefined;
  const claim = new Promise<void>((resolve) => { release = resolve; });
  creationsInFlight.set(key, claim);
  try {
    return await creation(waited);
  } finally {
    if (creationsInFlight.get(key) === claim) creationsInFlight.delete(key);
    release();
  }
}

/** True while a creation for `worktreePath` has not settled. */
export function isWorktreeCreationInFlight(worktreePath: string): boolean {
  return creationsInFlight.has(creationKey(worktreePath));
}

/**
 * The controllers of setup scripts that run after their worktree was recorded
 * (the background mode of `ensureTaskWorktree`, where the agent starts on its
 * prompt while the script runs). No caller's signal reaches such a script,
 * since the move that started it has already returned, so a removal stops it
 * here instead of waiting out the install.
 */
const backgroundSetups = new Map<string, AbortController>();

/**
 * Hold `controller` as the stop for the setup script running at
 * `worktreePath` after its worktree was recorded. Returns the release, which
 * the creation calls once the script has settled.
 */
export function registerBackgroundSetup(worktreePath: string, controller: AbortController): () => void {
  const key = creationKey(worktreePath);
  backgroundSetups.set(key, controller);
  return () => {
    if (backgroundSetups.get(key) === controller) backgroundSetups.delete(key);
  };
}

/**
 * Stop the setup script still running at `worktreePath` after its worktree was
 * recorded. Returns whether one was running. The creation's hold ends once the
 * script's process tree is gone (`spawnWithAbort`), so a caller that then waits
 * on `waitForWorktreeCreation` waits only for that, not for the install.
 */
export function abortWorktreeSetup(worktreePath: string): boolean {
  const controller = backgroundSetups.get(creationKey(worktreePath));
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Wait until no creation for `worktreePath` is in flight. For a removal that
 * runs outside the git queue: it waits here rather than deleting a directory a
 * setup script is still writing to. Resolves `true` when it had to wait.
 */
export async function waitForWorktreeCreation(worktreePath: string): Promise<boolean> {
  const key = creationKey(worktreePath);
  let waited = false;
  let inFlight = creationsInFlight.get(key);
  while (inFlight) {
    waited = true;
    await inFlight;
    inFlight = creationsInFlight.get(key);
  }
  return waited;
}

function settledOrAborted(settled: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return settled;
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    void settled.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
