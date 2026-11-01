import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from './original-fs';
import { renameWithRetry, TRANSIENT_HANDLE_CODES } from '../fs/directory-move';
import { isAnyInitScriptRunning, whenNoInitScriptRuns } from './run-init-script';
import { isShuttingDown } from '../shutdown-state';

/**
 * Worktrees a Done move set aside, and the deleter that empties them.
 *
 * A Done move used to delete its worktree in place: the node_modules first,
 * outside the git queue, then the checkout inside it. A pnpm worktree's
 * node_modules is tens of thousands of files, and that delete shared the disk
 * with the next task's install and slowed it. The delete often starts before
 * the install does, so checking for a running install only when the delete
 * starts would change nothing.
 *
 * So the move renames the worktree into
 * `<project>/.kangentic/removed-worktrees/` at once. git and the board see it
 * gone (`WorktreeManager.moveWorktreeAside`). This module then deletes the
 * folder in small batches, and before each batch it waits while any
 * Post-Worktree Script runs (`whenNoInitScriptRuns`). A script that starts
 * mid-delete therefore shares the disk with one batch at most.
 *
 * Restart: nothing here is persisted but the folder itself. Every project open
 * calls `scheduleRemovedWorktreeDeletion` (from `cleanupStaleResourcesAsync`),
 * so a copy a quit left behind is deleted on the next open. A quit never
 * waits for the deleter (`.claude/rules/synchronous-shutdown.md`): it stops
 * between batches once `isShuttingDown()` says so.
 */

/** The folder under `.kangentic/` that holds worktrees moved aside for deletion. */
export const REMOVED_WORKTREES_FOLDER = 'removed-worktrees';

/**
 * Entries removed together between two looks at the gate. A script that starts
 * mid-delete shares the disk with at most this many unlinks, plus the
 * directories they finish emptying. Measured on Windows over 6,239 entries of
 * real npm packages: this walker took 2.2 to 2.5 s against 1.5 to 1.7 s for
 * `fs.promises.rm`, which keeps the whole libuv pool busy. Slower is fine for
 * a delete nothing waits on, and it leaves the disk more room.
 */
const DELETE_BATCH_SIZE = 8;

export function removedWorktreesRootFor(projectPath: string): string {
  return path.join(projectPath, '.kangentic', REMOVED_WORKTREES_FOLDER);
}

/**
 * Refuse to delete anything that is not a direct child of this project's
 * removed-worktrees folder, as `assertRemovableWorktreePath` does for the
 * worktrees folder.
 */
export function assertRemovedWorktreeEntry(projectPath: string, entryPath: string): void {
  const root = path.resolve(removedWorktreesRootFor(projectPath));
  const relative = path.relative(root, path.resolve(entryPath));
  // The separator checks below already refuse anything deeper, so only `..`
  // itself is left to refuse here, never a child whose name starts with dots.
  const isDirectChild = relative !== ''
    && relative !== '..'
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep)
    && !relative.includes('/');
  if (!isDirectChild) {
    throw new Error(`Refusing to delete ${entryPath}: it is not a direct child of ${root}.`);
  }
}

/**
 * Rename `worktreePath` into the removed-worktrees folder. The name is unique
 * per move, because a task can reach Done again before its first copy is gone.
 * Returns the new path, or null when the rename failed: a process still holds
 * the directory (Windows refuses to rename a directory with a file open in
 * it), or the folders are on different volumes. On null nothing moved.
 */
export async function moveIntoRemovedWorktrees(projectPath: string, worktreePath: string): Promise<string | null> {
  const root = removedWorktreesRootFor(projectPath);
  const uniqueName = `${path.basename(worktreePath)}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const destination = path.join(root, uniqueName);
  try {
    await fs.promises.mkdir(root, { recursive: true });
    await renameWithRetry(worktreePath, destination);
    return destination;
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException;
    console.warn(
      `[REMOVED-WORKTREES] Could not move ${worktreePath} aside `
      + `(code=${errnoError.code ?? 'unknown'}): ${errnoError.message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Link-safe tree delete
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Retry the codes Windows returns for a moment while antivirus or the search
 * indexer still holds a handle (`TRANSIENT_HANDLE_CODES`): a parent's `rmdir`
 * right after its children went can read ENOTEMPTY. The in-place removal this
 * replaced retried them too (`rm-with-retry.ts`); without a retry one such
 * moment would leave the whole copy for the next project open.
 */
const TRANSIENT_RETRY_DELAYS_MS = [100, 200, 400] as const;

async function retryTransient(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = errorCode(error);
      if (!code || !TRANSIENT_HANDLE_CODES.has(code) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Run `operation`, and on macOS and Linux, when it fails because the parent
 * directory is read-only, make the parent writable once and run it again.
 * Removing an entry needs write access to its directory there, and some tools
 * leave their folders read-only (Go's module cache sets 0o555). Windows has no
 * such bit on a directory, so it never gets here.
 */
async function withWritableParent(entryPath: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const code = errorCode(error);
    if (process.platform === 'win32' || (code !== 'EACCES' && code !== 'EPERM')) throw error;
    await fs.promises.chmod(path.dirname(entryPath), 0o700);
    await operation();
  }
}

/**
 * True for a symlink, and on Windows for a junction. Windows `lstat` can call
 * a junction a directory, so a `readlink` probe decides there, as
 * `isJunction` in `node-modules-link.ts` does. Unlike that one it fails
 * closed: only EINVAL (libuv's answer for a directory that is not a reparse
 * point) means a real directory. Any other error leaves the walker unable to
 * tell, and entering a junction would delete what it points at, so it throws
 * and the copy is left for the next project open.
 */
async function isLink(entryPath: string, stats: Stats): Promise<boolean> {
  if (stats.isSymbolicLink()) return true;
  if (process.platform !== 'win32' || !stats.isDirectory()) return false;
  try {
    await fs.promises.readlink(entryPath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EINVAL') return false;
    throw error;
  }
}

/** Remove a link itself, never what it points at. */
async function removeLink(entryPath: string, stats: Stats): Promise<void> {
  await retryTransient(() => withWritableParent(entryPath, async () => {
    // A junction `lstat` reported as a directory: rmdir removes the reparse
    // point and leaves the target alone.
    if (process.platform === 'win32' && stats.isDirectory()) {
      await fs.promises.rmdir(entryPath);
      return;
    }
    try {
      await fs.promises.unlink(entryPath);
    } catch (error) {
      // A directory symlink on Windows, on a Node that refuses to unlink one.
      if (process.platform === 'win32' && errorCode(error) === 'EPERM') {
        await fs.promises.rmdir(entryPath);
        return;
      }
      throw error;
    }
  }));
}

async function removeFile(entryPath: string): Promise<void> {
  await retryTransient(() => withWritableParent(entryPath, async () => {
    try {
      await fs.promises.unlink(entryPath);
    } catch (error) {
      // Windows refuses to unlink a read-only file until the attribute is cleared.
      if (process.platform === 'win32' && errorCode(error) === 'EPERM') {
        await fs.promises.chmod(entryPath, 0o666);
        await fs.promises.unlink(entryPath);
        return;
      }
      throw error;
    }
  }));
}

interface TreeDeletion {
  /** Resolves false to stop before the next batch. */
  beforeBatch: () => Promise<boolean>;
  onRemoved: () => void;
}

/**
 * Remove one entry that is not a real directory: a link, a file, or a path
 * already gone. Returns 'directory' for a real directory, which the caller
 * empties and removes itself.
 */
async function removeUnlessDirectory(entryPath: string): Promise<'removed' | 'directory'> {
  let stats: Stats;
  try {
    stats = await fs.promises.lstat(entryPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'removed';
    throw error;
  }
  try {
    if (await isLink(entryPath, stats)) {
      await removeLink(entryPath, stats);
      return 'removed';
    }
    if (stats.isDirectory()) return 'directory';
    await removeFile(entryPath);
    return 'removed';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'removed';
    throw error;
  }
}

async function removeEmptyDirectory(directoryPath: string): Promise<void> {
  try {
    await retryTransient(() => withWritableParent(directoryPath, () => fs.promises.rmdir(directoryPath)));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/** Empty `directoryPath`, batch by batch. Returns false when told to stop. */
async function deleteDirectoryContents(directoryPath: string, deletion: TreeDeletion): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.promises.readdir(directoryPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
  for (let batchStart = 0; batchStart < names.length; batchStart += DELETE_BATCH_SIZE) {
    if (!(await deletion.beforeBatch())) return false;
    const batch = names.slice(batchStart, batchStart + DELETE_BATCH_SIZE);
    // Counted the moment each one goes, whatever order `readdir` returned
    // them in, so a stop or a look at the count mid-tree sees every removal.
    // allSettled, so a failed entry ends the delete only once its siblings
    // have settled: nothing of the batch is still running when a stop
    // resolves or the drain moves on.
    const outcomes = await Promise.allSettled(batch.map(async (name) => {
      const entryPath = path.join(directoryPath, name);
      if (await removeUnlessDirectory(entryPath) === 'removed') {
        deletion.onRemoved();
        return null;
      }
      return entryPath;
    }));
    const subdirectories: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
      if (outcome.value !== null) subdirectories.push(outcome.value);
    }
    for (const subdirectory of subdirectories) {
      if (!(await deleteDirectoryContents(subdirectory, deletion))) return false;
      await removeEmptyDirectory(subdirectory);
      deletion.onRemoved();
    }
  }
  return true;
}

/**
 * Delete `rootPath` and everything under it, without ever entering a link.
 * After a task is moved out of Done, links in its removed copy point into live
 * code: pnpm's junctions name their absolute targets under the worktree's old
 * path, which the restored worktree re-creates. `fs.rm({ recursive })` gives no
 * promise about junctions on Windows, so this walks the tree itself: it `lstat`s
 * every entry, removes a link as a link, and enters only real directories.
 * Returns 'stopped' when `beforeBatch` said to stop, with the rest left on disk.
 */
export async function deleteTreeWithoutFollowingLinks(
  rootPath: string,
  deletion: TreeDeletion,
): Promise<'deleted' | 'stopped'> {
  if (await removeUnlessDirectory(rootPath) === 'removed') return 'deleted';
  if (!(await deleteDirectoryContents(rootPath, deletion))) return 'stopped';
  await removeEmptyDirectory(rootPath);
  return 'deleted';
}

// ---------------------------------------------------------------------------
// Per-project drain
// ---------------------------------------------------------------------------

export type RemovedWorktreeDeletionPhase = 'idle' | 'deleting' | 'waiting-for-init-script';

interface ProjectDrain {
  projectPath: string;
  phase: RemovedWorktreeDeletionPhase;
  /** Entries removed by this drain so far, for the tests and the log. */
  removedEntries: number;
  /** A schedule arrived while this drain ran: list the folder again before ending. */
  rerun: boolean;
  /**
   * Entries that failed in this drain. A rerun skips them instead of walking
   * them again for each Done move that lands; the next project open retries.
   */
  failedNames: Set<string>;
  stopRequested: boolean;
  resolveStop: () => void;
  stopped: Promise<void>;
  done: Promise<void>;
}

const drains = new Map<string, ProjectDrain>();

/** Test seam: awaited before every batch, so a test can hold the deleter mid-delete. */
let batchHookForTests: (() => Promise<void>) | null = null;

function drainKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Delete every folder in this project's removed-worktrees folder, in the
 * background. Idempotent: a call while the project's drain runs makes that
 * drain list the folder once more before it ends. Never throws.
 */
export function scheduleRemovedWorktreeDeletion(projectPath: string): void {
  const key = drainKey(projectPath);
  const existing = drains.get(key);
  if (existing && !existing.stopRequested) {
    existing.rerun = true;
    return;
  }
  // A drain told to stop is ending because its project folder is about to
  // move or go (`stopRemovedWorktreeDeletion`). Starting another after it
  // would put a deleter back inside that folder. The copy this call wanted
  // deleted waits for the next project open, which sweeps the folder.
  if (existing) return;
  let resolveStop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const drain: ProjectDrain = {
    projectPath,
    phase: 'deleting',
    removedEntries: 0,
    rerun: false,
    failedNames: new Set(),
    stopRequested: false,
    resolveStop,
    stopped,
    done: Promise.resolve(),
  };
  drains.set(key, drain);
  drain.done = runDrain(drain, key)
    .catch((error: unknown) => {
      console.warn('[REMOVED-WORKTREES] Deleter stopped on an error (non-fatal):', error);
    })
    .finally(() => {
      drain.phase = 'idle';
      // A drain that ended normally already left the map (see runDrain); this
      // covers a stop, a quit and an error.
      if (drains.get(key) === drain) drains.delete(key);
    });
}

/**
 * Stop this project's deleter after the batch in flight, and resolve once it
 * has stopped. For a project folder about to move or go: a handle the deleter
 * holds inside it would fail the move on Windows. A schedule that arrives
 * while it stops starts nothing (see `scheduleRemovedWorktreeDeletion`).
 */
export async function stopRemovedWorktreeDeletion(projectPath: string): Promise<void> {
  const drain = drains.get(drainKey(projectPath));
  if (!drain) return;
  drain.stopRequested = true;
  drain.resolveStop();
  await drain.done;
}

/**
 * Delete this project's removed worktrees now, without waiting for init
 * scripts, and resolve when done. For a project delete, which removes the whole
 * `.kangentic/` folder next and must not leave that to a synchronous delete
 * that may follow links.
 */
export async function deleteRemovedWorktreesNow(projectPath: string): Promise<void> {
  await stopRemovedWorktreeDeletion(projectPath);
  const root = removedWorktreesRootFor(projectPath);
  for (const name of await listRemovedWorktrees(root)) {
    const entryPath = path.join(root, name);
    try {
      assertRemovedWorktreeEntry(projectPath, entryPath);
      await deleteTreeWithoutFollowingLinks(entryPath, { beforeBatch: async () => true, onRemoved: () => undefined });
    } catch (error) {
      console.warn(`[REMOVED-WORKTREES] Could not delete ${name} (code=${errorCode(error) ?? 'unknown'}): ${(error as Error).message}`);
    }
  }
}

/** The folder's entries, or none when it is missing or cannot be read. */
async function listRemovedWorktrees(root: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(root);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      console.warn(`[REMOVED-WORKTREES] Could not list ${root} (code=${errorCode(error) ?? 'unknown'})`);
    }
    return [];
  }
}

async function runDrain(drain: ProjectDrain, key: string): Promise<void> {
  const root = removedWorktreesRootFor(drain.projectPath);
  for (;;) {
    drain.rerun = false;
    for (const name of await listRemovedWorktrees(root)) {
      if (drain.stopRequested || isShuttingDown()) return;
      if (drain.failedNames.has(name)) continue;
      await deleteOneEntry(drain, path.join(root, name), name);
    }
    if (drain.stopRequested || isShuttingDown()) return;
    // Nothing awaits between this check and leaving the map. A schedule that
    // came before it set `rerun`, and the folder is listed again. One that
    // comes after it finds no drain and starts its own. So no schedule lands
    // on a drain that has already ended and loses its copy until the next
    // project open.
    if (!drain.rerun) {
      if (drains.get(key) === drain) drains.delete(key);
      return;
    }
  }
}

async function deleteOneEntry(drain: ProjectDrain, entryPath: string, name: string): Promise<void> {
  const startedAt = Date.now();
  const removedBefore = drain.removedEntries;
  let waitedMs = 0;
  const shouldStop = (): boolean => drain.stopRequested || isShuttingDown();
  const beforeBatch = async (): Promise<boolean> => {
    if (batchHookForTests) await batchHookForTests();
    if (shouldStop()) return false;
    if (isAnyInitScriptRunning()) {
      drain.phase = 'waiting-for-init-script';
      const waitStartedAt = Date.now();
      console.log(`[REMOVED-WORKTREES] Waiting for init scripts to finish before deleting more of ${name}`);
      // A script can start the moment the last one ends, so ask again after each wait.
      while (isAnyInitScriptRunning() && !shouldStop()) {
        await Promise.race([whenNoInitScriptRuns(), drain.stopped]);
      }
      waitedMs += Date.now() - waitStartedAt;
      drain.phase = 'deleting';
    }
    return !shouldStop();
  };
  try {
    assertRemovedWorktreeEntry(drain.projectPath, entryPath);
    const outcome = await deleteTreeWithoutFollowingLinks(entryPath, {
      beforeBatch,
      onRemoved: () => { drain.removedEntries += 1; },
    });
    if (outcome === 'deleted') {
      console.log(
        `[REMOVED-WORKTREES] Deleted ${name}: ${drain.removedEntries - removedBefore} entries `
        + `in ${Date.now() - startedAt}ms (waited ${waitedMs}ms for init scripts)`,
      );
    }
  } catch (error) {
    // Left for the next project open, which lists the folder again. This
    // drain's reruns skip it.
    drain.failedNames.add(name);
    console.warn(
      `[REMOVED-WORKTREES] Could not delete ${name} (code=${errorCode(error) ?? 'unknown'}), `
      + `will retry on next project open: ${(error as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** What this project's deleter is doing, and how many entries it has removed. Tests only. */
export function _removedWorktreeDeletionStateForTests(projectPath: string): { phase: RemovedWorktreeDeletionPhase; removedEntries: number } {
  const drain = drains.get(drainKey(projectPath));
  return drain ? { phase: drain.phase, removedEntries: drain.removedEntries } : { phase: 'idle', removedEntries: 0 };
}

/** Resolves when this project's deleter has nothing left to do. Tests only. */
export async function _whenRemovedWorktreeDeletionIdleForTests(projectPath: string): Promise<void> {
  for (;;) {
    const drain = drains.get(drainKey(projectPath));
    if (!drain) return;
    await drain.done;
  }
}

/** Awaited before every batch while set. Tests only. */
export function _setRemovedWorktreeBatchHookForTests(hook: (() => Promise<void>) | null): void {
  batchHookForTests = hook;
}

/** Forget every drain, as a restart does. Tests only. */
export function _resetRemovedWorktreeDeletionForTests(): void {
  for (const drain of drains.values()) {
    drain.stopRequested = true;
    drain.resolveStop();
  }
  drains.clear();
  batchHookForTests = null;
}
