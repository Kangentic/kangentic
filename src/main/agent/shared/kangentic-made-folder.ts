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
 * Whether a folder exists. Only a clean "not found" counts as gone, so a drive
 * that is not mounted or a share that cannot be read keeps its entries.
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
