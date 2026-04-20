import path from 'node:path';
import fs from 'node:fs';
import { removeWithRetry } from './rm-with-retry';

/**
 * node_modules junction (Windows) / symlink (POSIX) management for
 * worktree checkouts.
 *
 * Instead of running `npm install` in every worktree, we create a
 * junction/symlink from `<worktree>/node_modules` to the main repo's
 * `<root>/node_modules`. This gives worktree agents instant access to
 * all dependencies without duplicating gigabytes of node_modules.
 *
 * Windows junctions vs POSIX symlinks behave differently for both
 * creation and removal, so each operation has platform-specific logic.
 * Removal in particular is subtle: `fs.rmSync(junction, { recursive:
 * true })` traverses the junction on Windows and deletes the TARGET
 * directory's contents - i.e. it would nuke the main repo's
 * node_modules. `removeNodeModulesPath` avoids this.
 */

/** Check whether a path is a junction (Windows) by attempting readlink. */
function isJunction(targetPath: string): boolean {
  try {
    fs.readlinkSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove `<worktree>/node_modules` in whatever form it takes, without
 * ever traversing into a junction's target.
 *
 * Handles four cases, in order:
 *   1. Windows junction  -> rmdirSync (removes just the reparse point; fast)
 *   2. POSIX symlink     -> rmSync (symlinks are file-like; fast)
 *   3. Real directory    -> fs.promises.rm recursive (worktree ran `npm install`;
 *                           potentially thousands of files, so async to keep
 *                           the event loop responsive during bulk cleanup)
 *   4. Regular file      -> rmSync (defensive; fast)
 *
 * The junction check comes FIRST on Windows because `fs.rm(junction,
 * { recursive: true })` traverses the reparse point and deletes the
 * TARGET's contents (e.g. the main repo's node_modules). `rmdirSync`
 * calls RemoveDirectoryW which correctly removes the link only.
 *
 * Cases 1, 2, and 4 stay synchronous because they're bounded: a reparse
 * point or file-like removal completes in microseconds and the value of
 * returning a promise for them doesn't offset the cost of the extra tick.
 * Only Case 3 is unbounded (scales with the directory contents), so only
 * that path awaits.
 *
 * Exported so resource-cleanup and worktree-manager can use it before
 * recursive worktree removal.
 */
export async function removeNodeModulesPath(targetPath: string): Promise<void> {
  try {
    const stat = fs.lstatSync(targetPath);
    // Windows junction check MUST come first - lstatSync().isSymbolicLink()
    // can return true OR false for junctions depending on Node.js/Windows
    // version, and .isDirectory() returns true for junctions, so only the
    // readlinkSync probe reliably identifies them. rmdirSync removes the
    // reparse point without following it into the target.
    if (process.platform === 'win32' && isJunction(targetPath)) {
      fs.rmdirSync(targetPath);
    } else if (stat.isSymbolicLink()) {
      // POSIX symlinks (and Windows symlinks, not junctions): file-like,
      // non-recursive rmSync works and doesn't follow the link.
      fs.rmSync(targetPath, { force: true });
    } else if (stat.isDirectory()) {
      // Real directory - e.g. worktree ran `npm install` instead of
      // relying on the junction. Stat-first recursive removal handles
      // EISDIR races inside nested node_modules and gives us an
      // exponential backoff window for Windows file-lock transients
      // instead of Node's opaque maxRetries budget. Reparse points were
      // already handled above.
      await removeWithRetry(targetPath);
    } else {
      // Regular file / fifo / socket. Should be unreachable for a path
      // named node_modules, but handle it defensively.
      fs.rmSync(targetPath, { force: true });
    }
  } catch (error) {
    // ENOENT is expected (already gone)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[WORKTREE] Failed to remove ${targetPath}: ${(error as Error).message}`);
    }
  }
}

/**
 * Create a filesystem junction (Windows) or symlink (Unix) from
 * `<worktree>/node_modules` to `<root>/node_modules` so the worktree gets
 * instant access to dependencies without running `npm install`.
 *
 * Non-fatal: logs a warning on failure but never throws.
 */
export async function linkNodeModules(worktreePath: string, rootPath: string): Promise<void> {
  const rootModules = path.join(rootPath, 'node_modules');
  const worktreeModules = path.join(worktreePath, 'node_modules');

  // Not a Node project (or deps not installed yet). Skip silently.
  if (!fs.existsSync(rootModules)) return;

  try {
    const stat = fs.lstatSync(worktreeModules);
    const isLink = stat.isSymbolicLink()
      || (process.platform === 'win32' && stat.isDirectory() && isJunction(worktreeModules));

    if (isLink) {
      const target = fs.realpathSync(worktreeModules);
      const rootReal = fs.realpathSync(rootModules);
      if (target === rootReal) return; // Already correct
      // Points elsewhere. Remove just the link (not recursive - avoids
      // traversing into the target and deleting the main repo's modules).
      await removeNodeModulesPath(worktreeModules);
    } else {
      // Real directory (e.g. from a previous npm install). Stat-first
      // removal with exponential backoff so a large existing node_modules
      // doesn't stall or silently fail during worktree creation.
      await removeWithRetry(worktreeModules);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[WORKTREE] Failed to check existing node_modules, will try to create link:', error);
    }
    // ENOENT means it doesn't exist yet. Will create below.
  }

  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(rootModules, worktreeModules, linkType);
    console.log(`[WORKTREE] Created node_modules ${linkType}: ${worktreeModules} -> ${rootModules}`);
  } catch (error) {
    console.warn('[WORKTREE] Failed to create node_modules link (non-fatal):', error);
  }
}
