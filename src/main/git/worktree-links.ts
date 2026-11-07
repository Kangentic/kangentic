import path from 'node:path';
import { randomBytes } from 'node:crypto';
import fs from './original-fs';
import { ensureLocalGitExcludes, resolveGitDir } from '../agent/shared/git-exclude';
import { renameWithRetry } from '../fs/directory-move';
import { gitAt } from './git-client';
import { hasLinkOnPath, mayBeLink } from './link-check';
import { removeLinkOnly, removeNodeModulesPath } from './node-modules-link';
import type { RemoveWithRetryOptions } from './rm-with-retry';
import { absolutePath, hasGlobMagic, isAtOrUnder, normalizeEntry } from './worktree-copy/entry-path';

/**
 * Folders a worktree shares with the project through a link (`git.linkFolders`),
 * and what keeps a removal out of them.
 *
 * A link here is a junction on Windows, and a recursive delete follows one.
 * Measured on Windows 11 with a sentinel file in the junction's target:
 * `git worktree remove --force` deleted the target's contents, and so did
 * `fs.rmSync` on Electron 45's Node 24.22.1 (not on plain Node 24.15). So every
 * removal clears a worktree's links first, through `clearWorktreeLinks`.
 *
 * What it clears comes from a record of what was linked, never from the current
 * setting: an entry taken out of Settings still has its link in every worktree
 * made before. The record is `kangentic-links.json` in the worktree's private
 * git folder (`.git/worktrees/<id>/`), written before the link is made. It ends
 * with the worktree, and nothing else touches it. It is not in the worktree's
 * own `.kangentic/`, which a preview or a UI test run wipes, and a junction with
 * no record is what this exists to prevent.
 *
 * A record that cannot be read is not an empty one. It refuses the removal,
 * because the record is the only thing that says a recursive delete is safe.
 * That covers a read error, a file that is not a list, and a `.git` file naming
 * a git folder that is gone. A removal a locked file stopped takes both the git
 * folder and the `.git` file, so that leftover has no `.git` and reads as having
 * no links: measured on Windows, and its links went before the removal began.
 */

const LINK_RECORD_FILE = 'kangentic-links.json';

function linkRecordPath(worktreePath: string): string | null {
  const gitDir = resolveGitDir(worktreePath);
  return gitDir ? path.join(gitDir, LINK_RECORD_FILE) : null;
}

/** The folders this worktree recorded, or null when that cannot be known. Never throws. */
async function readLinkRecord(worktreePath: string): Promise<string[] | null> {
  const gitDir = resolveGitDir(worktreePath);
  if (!gitDir) return (await pathExists(path.join(worktreePath, '.git'))) ? null : [];
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(gitDir, LINK_RECORD_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    return (await pathExists(gitDir)) ? [] : null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((entry) => {
      const folder = typeof entry === 'string' ? normalizeEntry(entry) : null;
      return folder ? [folder] : [];
    });
  } catch {
    return null;
  }
}

async function writeLinkRecord(recordPath: string, folders: string[]): Promise<void> {
  const temporaryPath = `${recordPath}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, JSON.stringify(folders, null, 2));
    await renameWithRetry(temporaryPath, recordPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * `git check-ignore` prints a path it ignores. Read from its output, because
 * `gitAt` resolves an exit 1 with an empty stderr, which is its "not ignored".
 * A failure reads as not ignored, the safe direction.
 */
async function isIgnoredInProject(rootPath: string, folder: string): Promise<boolean> {
  try {
    return (await gitAt(rootPath).raw(['check-ignore', '--', folder])).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Link each folder of `entries` into the worktree. A folder links only when the
 * project has it, git ignores it there, and the worktree has nothing at its
 * path: unlike `linkNodeModules`, this deletes nothing, because a real folder
 * there is the branch's own checkout or its setup script's output. So a spare's
 * claim can run it again.
 *
 * Git sees a link as a file, which a `.gitignore` line ending in `/` does not
 * match, so each link is excluded too, or `git add -A` commits it. That exclude
 * is the repository's shared `info/exclude`, so it also reaches the main
 * checkout, which is why a folder git does not ignore stays unlinked: the line
 * changes nothing for a folder already ignored, and would hide a user's
 * untracked files in one that is not.
 *
 * Non-fatal, as the node_modules link is: a worktree without a shared folder
 * still runs. Nothing links when the record cannot be written.
 */
export async function linkWorktreeFolders(worktreePath: string, rootPath: string, entries: string[]): Promise<void> {
  const folders: string[] = [];
  for (const entry of entries) {
    const folder = normalizeEntry(entry);
    if (!folder || hasGlobMagic(folder) || isAtOrUnder(folder, 'node_modules') || folders.includes(folder)) {
      console.warn(`[WORKTREE] Skipped a link entry: ${entry}`);
      continue;
    }
    if (!(await isDirectory(absolutePath(rootPath, folder)))) continue;
    if (await hasLinkOnPath(worktreePath, path.posix.dirname(folder))) {
      console.warn(`[WORKTREE] Skipped a link entry under another link: ${entry}`);
      continue;
    }
    if (await pathExists(absolutePath(worktreePath, folder))) continue;
    if (!(await isIgnoredInProject(rootPath, folder))) {
      console.warn(`[WORKTREE] Skipped a link entry git does not ignore: ${entry}`);
      continue;
    }
    folders.push(folder);
  }
  if (folders.length === 0) return;

  const recordPath = linkRecordPath(worktreePath);
  if (!recordPath) {
    console.warn(`[WORKTREE] No git folder for ${worktreePath}, so its folders stay unlinked`);
    return;
  }
  const recorded = await readLinkRecord(worktreePath);
  if (!recorded) {
    console.warn(`[WORKTREE] Could not read the link record of ${worktreePath}, so its folders stay unlinked`);
    return;
  }
  try {
    await writeLinkRecord(recordPath, [...new Set([...recorded, ...folders])]);
  } catch (error) {
    console.warn('[WORKTREE] Could not record the linked folders, so they stay unlinked:', error);
    return;
  }

  ensureLocalGitExcludes(worktreePath, folders.map((folder) => `/${folder}`));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const folder of folders) {
    const destination = absolutePath(worktreePath, folder);
    try {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.symlink(absolutePath(rootPath, folder), destination, linkType);
      console.log(`[WORKTREE] Linked ${folder}: ${linkType}`);
    } catch (error) {
      console.warn(`[WORKTREE] Failed to link ${folder} (non-fatal):`, error);
    }
  }
}

/**
 * Remove each folder as a link. Returns false when one is still there, so the
 * caller must not delete the worktree recursively. Never throws.
 */
async function removeLinks(worktreePath: string, folders: string[]): Promise<boolean> {
  let cleared = true;
  for (const folder of folders) {
    const linkPath = absolutePath(worktreePath, folder);
    removeLinkOnly(linkPath);
    if (await mayBeLink(linkPath)) cleared = false;
  }
  return cleared;
}

/**
 * Clear what a worktree holds that a recursive delete must not walk into: its
 * recorded links, then its node_modules in whatever form it takes. Every removal
 * of a worktree goes through this. Returns false when a link would not come out
 * or the record cannot be read, and the caller then leaves the worktree where it
 * is. Never throws.
 */
export async function clearWorktreeLinks(
  worktreePath: string,
  options?: { removeOptions?: RemoveWithRetryOptions },
): Promise<boolean> {
  const recorded = await readLinkRecord(worktreePath);
  if (!recorded) console.warn(`[WORKTREE] Could not read the link record of ${worktreePath}`);
  const cleared = recorded !== null && await removeLinks(worktreePath, recorded);
  await removeNodeModulesPath(path.join(worktreePath, 'node_modules'), options);
  return cleared;
}

/**
 * `clearWorktreeLinks` for a copy moved aside, where a real node_modules stays
 * for the batched deleter. Read through the copy's `.git` file, so it runs
 * before that goes. A link it leaves is still safe there: the deleter never
 * enters one.
 */
export async function clearMovedWorktreeLinks(movedPath: string): Promise<void> {
  await removeLinks(movedPath, (await readLinkRecord(movedPath)) ?? []);
  removeLinkOnly(path.join(movedPath, 'node_modules'));
}
