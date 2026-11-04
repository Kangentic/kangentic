import fs from 'node:fs';
import path from 'node:path';
import { isConfirmedMissing } from './confirmed-missing';

/**
 * The folders under an agent's projects folder (`~/.claude/projects`, Qwen's
 * `<runtime>/projects`), one per project slug. Claude's transcript search and
 * each adapter's `proveConversationGone` scan them for a conversation's file.
 */

/** Project folders listed or statted at once. */
export const PROJECT_SCAN_BATCH = 32;

/**
 * Every folder under a projects folder that could hold a conversation:
 * directories, and links that may lead to one. Null when the projects folder
 * is not a directory this process can read.
 */
export async function listProjectFolders(projectsRoot: string): Promise<string[] | null> {
  let entries: fs.Dirent[];
  try {
    const rootStat = await fs.promises.stat(projectsRoot);
    if (!rootStat.isDirectory()) return null;
    entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const folders: string[] = [];
  for (const entry of entries) {
    const folderPath = path.join(projectsRoot, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && await mayBeFolder(folderPath))) {
      folders.push(folderPath);
    }
  }
  return folders;
}

/**
 * True only when no folder holds `relativePath`: each candidate is proven
 * missing (`isConfirmedMissing`), `PROJECT_SCAN_BATCH` at a time. One that
 * exists, or one that cannot be proven missing, answers false.
 */
export async function noFolderHolds(folders: ReadonlyArray<string>, relativePath: string): Promise<boolean> {
  const candidates = folders.map((folderPath) => path.join(folderPath, relativePath));
  for (let start = 0; start < candidates.length; start += PROJECT_SCAN_BATCH) {
    const batch = candidates.slice(start, start + PROJECT_SCAN_BATCH);
    const missing = await Promise.all(batch.map(isConfirmedMissing));
    if (missing.includes(false)) return false;
  }
  return true;
}

/**
 * False only for a link whose target is a file, which can hold no
 * conversation: looking inside it would fail ENOTDIR, which is not proof, and
 * would keep every conversation from ever counting as gone. A link to a
 * folder, a dangling link and an unreadable one stay in the scan: a stat
 * inside them answers for itself.
 */
async function mayBeFolder(linkPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(linkPath)).isDirectory();
  } catch {
    return true;
  }
}
