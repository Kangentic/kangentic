import { promises as fsPromises } from 'node:fs';

/**
 * A folder Kangentic made and later removes: a task's worktree
 * (`<project>/.kangentic/worktrees/<slug>`), or a dev preview's project
 * (`<checkout>/.kangentic/data/preview-projects/<name>`), and anything under one.
 * An adapter's removed-folder sweep (`sweepRemovedFolderTrust`) drops entries only
 * for these, so a folder the user opened an agent in is never touched.
 */
const KANGENTIC_MADE_FOLDER = /\/\.kangentic\/(?:worktrees|data\/preview-projects)\/[^/]+/i;

/** Whether `folderPath`, in either slash, names a folder Kangentic made. */
export function isKangenticMadeFolder(folderPath: string): boolean {
  return KANGENTIC_MADE_FOLDER.test(folderPath.replace(/\\/g, '/'));
}

/**
 * The project or checkout whose `.kangentic` folder holds a Kangentic-made
 * folder, in the path's own separators, or null when `folderPath` is not one.
 * A sweep drops a gone folder's entry only while its owner exists: Windows
 * answers "not found" for a drive that is not mounted, so the folder alone
 * cannot tell a removed worktree from an unplugged disk.
 */
export function kangenticMadeFolderOwner(folderPath: string): string | null {
  const match = KANGENTIC_MADE_FOLDER.exec(folderPath.replace(/\\/g, '/'));
  return match ? folderPath.slice(0, match.index) : null;
}

/**
 * Whether a folder exists. Only a clean "not found" counts as gone, so a folder
 * that cannot be read keeps its entries. A drive that is not mounted answers
 * "not found" too, which `kangenticMadeFolderOwner` covers.
 */
export async function folderExists(folderPath: string): Promise<boolean> {
  try {
    await fsPromises.stat(folderPath);
    return true;
  } catch (error) {
    // report-ok: a missing folder is the answer; any other failure keeps the entry.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * The Kangentic-made folders among `folders` that are gone while their owner
 * (`kangenticMadeFolderOwner`) exists. A folder whose owner is gone too is left
 * out, since that is also what a drive that is not mounted looks like. One
 * folder at a time, with each owner checked once: an adapter's sweep runs this
 * over thousands of entries, and it is not in a hurry.
 */
export async function goneKangenticMadeFolders(
  folders: Iterable<string>,
  exists: (folderPath: string) => Promise<boolean> = folderExists,
): Promise<string[]> {
  const ownerPresent = new Map<string, boolean>();
  const gone: string[] = [];
  for (const folder of folders) {
    if (await exists(folder)) continue;
    const owner = kangenticMadeFolderOwner(folder);
    if (owner === null) continue;
    if (!ownerPresent.has(owner)) ownerPresent.set(owner, await exists(owner));
    if (ownerPresent.get(owner)) gone.push(folder);
  }
  return gone;
}

/**
 * The folders of `gone` still gone. A sweep asks this under its file's lock,
 * just before it writes: a worktree recreated at a gone folder's path after the
 * first look is trusted again by its spawn, which takes the same lock, so this
 * sees the folder and the sweep keeps the entry the spawn needs.
 */
export async function stillGone(
  gone: readonly string[],
  exists: (folderPath: string) => Promise<boolean> = folderExists,
): Promise<string[]> {
  const present = await Promise.all(gone.map((folder) => exists(folder)));
  return gone.filter((_folder, index) => !present[index]);
}
