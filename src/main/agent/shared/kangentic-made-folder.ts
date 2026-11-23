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
