import path from 'node:path';
import fs from './original-fs';
import { gitWorktreeReporter } from './git-worktree-report';
import { removeWithRetry, type RemoveWithRetryOptions } from './rm-with-retry';

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
    // report-ok: readlink throws for a path that is not a link, which is the answer.
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
 *
 * `options.removeOptions` only bounds case 3 (the real-directory recursive
 * removal). A caller on a user-facing path (Done move) passes a collapsed
 * budget so a pinned node_modules fails in seconds instead of grinding for
 * minutes while it holds the git queue. Cases 1, 2, and 4 are already bounded
 * (a reparse point or file-like removal completes in microseconds), so the
 * option does not apply to them.
 *
 * Never throws. Resolves true when a LINK is still at the path afterwards: a
 * junction or a symlink whose removal failed. A recursive delete of the
 * worktree would walk through it into the main checkout's node_modules, so
 * `clearWorktreeLinks` refuses the removal on true. Every other failure
 * resolves false, as nothing leads out of a real directory or a file, and the
 * removal that follows reports its own failure on it.
 */
export async function removeNodeModulesPath(
  targetPath: string,
  options?: { removeOptions?: RemoveWithRetryOptions },
): Promise<boolean> {
  // Set once the path is known to hold a link, just before the link is removed.
  let removingLink = false;
  try {
    const stat = fs.lstatSync(targetPath);
    // Windows junction check MUST come first - lstatSync().isSymbolicLink()
    // can return true OR false for junctions depending on Node.js/Windows
    // version, and .isDirectory() returns true for junctions, so only the
    // readlinkSync probe reliably identifies them. rmdirSync removes the
    // reparse point without following it into the target.
    if (process.platform === 'win32' && isJunction(targetPath)) {
      removingLink = true;
      fs.rmdirSync(targetPath);
    } else if (stat.isSymbolicLink()) {
      // POSIX symlinks (and Windows symlinks, not junctions): file-like,
      // non-recursive rmSync works and doesn't follow the link.
      removingLink = true;
      fs.rmSync(targetPath, { force: true });
    } else if (stat.isDirectory()) {
      // Real directory - e.g. worktree ran `npm install` instead of
      // relying on the junction. Stat-first recursive removal handles
      // EISDIR races inside nested node_modules and gives us an
      // exponential backoff window for Windows file-lock transients
      // instead of Node's opaque maxRetries budget. Reparse points were
      // already handled above.
      await removeWithRetry(targetPath, options?.removeOptions);
    } else {
      // Regular file / fifo / socket. Should be unreachable for a path
      // named node_modules, but handle it defensively.
      fs.rmSync(targetPath, { force: true });
    }
    return false;
  } catch (error) {
    // ENOENT is expected (already gone)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // A link left in place is the failure that can cost the main checkout its
    // node_modules, so it is reported here. A real directory that would not
    // delete is a held folder, which the worktree removal that follows reports
    // itself (`worktreeRemovalReporter`), so it is not reported twice.
    if (removingLink) gitWorktreeReporter.report(error, { tags: { stage: 'link_remove' } });
    console.warn(`[WORKTREE] Failed to remove ${targetPath}: ${(error as Error).message}`);
    return removingLink;
  }
}

/**
 * Remove a worktree path only when it is a link (the junction or symlink of
 * `linkNodeModules` or `git.linkFolders`), and leave a real directory alone. A
 * Done move calls it on the copy it just renamed aside, so the copy holds no
 * link to the project root while it waits for the deleter. Returns whether a
 * link was removed. Never throws.
 */
export function removeLinkOnly(targetPath: string): boolean {
  try {
    const stat = fs.lstatSync(targetPath);
    // The junction check first, for the reason removeNodeModulesPath gives.
    if (process.platform === 'win32' && isJunction(targetPath)) {
      fs.rmdirSync(targetPath);
      return true;
    }
    if (stat.isSymbolicLink()) {
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    return false;
  } catch (error) {
    // report-ok: ENOENT means the link is already gone. After any other failure removeLinks
    // finds the link still there and refuses the removal, and a copy moved aside is safe
    // with it, because its deleter removes a link as a link.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[WORKTREE] Failed to remove the ${targetPath} link: ${(error as Error).message}`);
    }
    return false;
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
      // What was already at the path would not come out, so the link below cannot be
      // made over it. This is the cause: the attempt below only says the path is taken.
      gitWorktreeReporter.report(error, { tags: { stage: 'link_precheck' } });
      console.warn('[WORKTREE] Failed to check existing node_modules, will try to create link:', error);
    }
    // ENOENT means it doesn't exist yet. Will create below.
  }

  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(rootModules, worktreeModules, linkType);
    console.log(`[WORKTREE] Created node_modules ${linkType}: ${worktreeModules} -> ${rootModules}`);
  } catch (error) {
    // The worktree is made with no node_modules, so the agent's first typecheck or test
    // fails on missing packages and nothing on screen says the link is why.
    gitWorktreeReporter.report(error, { tags: { stage: 'link_create' } });
    console.warn('[WORKTREE] Failed to create node_modules link (non-fatal):', error);
  }
}
