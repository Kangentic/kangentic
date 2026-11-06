import path from 'node:path';
import fs from '../git/original-fs';
import { asideTimeOf, deleteTreeWithoutFollowingLinks, moveIntoFolderWithUniqueName } from '../git/removed-worktrees';
import { isShuttingDown } from '../shutdown-state';
import type { VerifiedOwnership } from './project-ownership';

/**
 * Where the orphan sweep puts what it cannot rebuild.
 *
 * A worktree can hold uncommitted work and a task folder holds attachments with
 * no other copy, and "no row names this" is a guess. So the sweep moves them to
 * `.kangentic/set-aside/` and they stay for `SET_ASIDE_RETENTION_MS`, long enough
 * to restore by hand. `removed-worktrees/` cannot serve here: it is drained in
 * full on every pass, so nothing in it outlives the open that put it there.
 */

const SET_ASIDE_FOLDER = 'set-aside';

export const SET_ASIDE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const SET_ASIDE_KINDS = ['worktrees', 'tasks'] as const;

export type SetAsideKind = (typeof SET_ASIDE_KINDS)[number];

function setAsideRootFor(projectPath: string, kind: SetAsideKind): string {
  return path.join(projectPath, '.kangentic', SET_ASIDE_FOLDER, kind);
}

/**
 * Move a folder aside. Null when the rename failed (a process holds it, usually
 * as its working directory), with nothing changed. The caller keeps the folder:
 * there is no fallback delete, so a failed move never loses it.
 */
export async function moveIntoSetAside(
  projectPath: string,
  kind: SetAsideKind,
  folderPath: string,
): Promise<string | null> {
  const root = setAsideRootFor(projectPath, kind);
  try {
    return await moveIntoFolderWithUniqueName(root, folderPath);
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException;
    console.warn(
      `[SET_ASIDE] Could not move ${path.basename(folderPath)} aside `
      + `(code=${errnoError.code ?? 'unknown'}): ${errnoError.message}`,
    );
    return null;
  }
}

/**
 * Delete what has been set aside past its retention. The entry's age comes from
 * its name, because a rename keeps the folder's old mtime. A name that does not
 * parse is kept: it is not one this module wrote. Takes the proof, so an instance
 * that does not own the folder never reaches it. Never rejects: what fails here
 * is retried at the next open.
 */
export async function purgeExpiredSetAside(ownership: VerifiedOwnership, nowMs = Date.now()): Promise<number> {
  let purged = 0;
  for (const kind of SET_ASIDE_KINDS) {
    const root = setAsideRootFor(ownership.projectPath, kind);
    let names: string[];
    try {
      names = await fs.promises.readdir(root);
    } catch {
      continue; // Nothing set aside of this kind.
    }
    for (const name of names) {
      if (isShuttingDown()) return purged;
      const setAsideAt = asideTimeOf(name);
      if (setAsideAt === null || nowMs - setAsideAt < SET_ASIDE_RETENTION_MS) continue;
      try {
        const outcome = await deleteTreeWithoutFollowingLinks(path.join(root, name), {
          beforeBatch: async () => !isShuttingDown(),
          onRemoved: () => {},
        });
        if (outcome === 'deleted') purged += 1;
      } catch (error) {
        console.warn(`[SET_ASIDE] Could not delete ${name}: ${(error as Error).message}`);
      }
    }
  }
  return purged;
}
