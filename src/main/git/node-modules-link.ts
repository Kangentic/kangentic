import path from 'node:path';
import fs from 'node:fs';

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
 * node_modules. `removeNodeModulesJunction` avoids this.
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
 * Remove a junction or symlink without following it into the target directory.
 *
 * On Windows, `fs.rmSync(junction, { recursive: true })` traverses the junction
 * and deletes the TARGET directory's contents (e.g. the main repo's node_modules).
 * This helper removes just the link itself using non-recursive rmSync.
 *
 * Exported so resource-cleanup can use it before recursive worktree removal.
 */
export function removeNodeModulesJunction(junctionPath: string): void {
  try {
    fs.lstatSync(junctionPath);
    // Check Windows junction FIRST - lstatSync().isSymbolicLink() can return
    // true for junctions on some Node.js/Windows versions, which would route
    // to rmSync (fails with EISDIR on directory reparse points). rmdirSync
    // calls RemoveDirectoryW which correctly removes the junction link.
    if (process.platform === 'win32' && isJunction(junctionPath)) {
      fs.rmdirSync(junctionPath);
    } else {
      // POSIX symlinks: rmSync works (they're file-like)
      fs.rmSync(junctionPath, { force: true });
    }
  } catch (error) {
    // ENOENT is expected (junction already gone)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[WORKTREE] Failed to remove junction ${junctionPath}: ${(error as Error).message}`);
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
export function linkNodeModules(worktreePath: string, rootPath: string): void {
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
      removeNodeModulesJunction(worktreeModules);
    } else {
      // Real directory (e.g. from a previous npm install). Remove it.
      fs.rmSync(worktreeModules, { recursive: true, force: true });
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
