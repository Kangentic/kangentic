import fs from 'node:fs';
import path from 'node:path';
import { locateClaudeTranscriptFile } from './transcript-parser';
import { isConfirmedMissing } from '../../shared/confirmed-missing';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

/** Project folders statted at once by the folder scan. */
const SCAN_BATCH = 32;

/**
 * Prove that Claude can no longer resume a conversation: its transcript is
 * gone from every place Claude could look. Claude Code deletes transcripts
 * older than `cleanupPeriodDays` (30 by default), and a `--resume` of one then
 * prints "No conversation found" and exits.
 *
 * Every step returns false on anything short of proof, which resumes exactly
 * as before:
 *
 *  1. One of the reported paths is absolute and names this conversation's
 *     file (`<id>.jsonl`). A path from before a `/clear` fork names another id,
 *     and a relative one would resolve against Kangentic's own working folder.
 *  2. That path and the locator's path for the current cwd both fail with
 *     ENOENT. Any other error (permission, a locked file) is not proof.
 *  3. The projects folder two levels above the reported path is a directory
 *     this process can read. A WSL session reports a Linux path, which on the
 *     Windows side resolves to nothing, so this is where it stops. The
 *     immediate parent is not required: Claude removes an emptied project
 *     folder, as it did in the case this was built for.
 *  4. No folder under that projects folder holds `<id>.jsonl`. A file under a
 *     renamed or sibling worktree's folder means resume, whether or not the CLI
 *     would have searched there. A symlinked or junctioned folder is searched
 *     too: its entry reads as a link, not a directory, and the stat follows
 *     it. The root comes from the reported path, so it
 *     follows a `CLAUDE_CONFIG_DIR` the locator does not know about. Measured at
 *     16 to 22 ms over 617 folders, and reached only once 1 to 3 hold.
 *
 * For a Claude installed in a WSL distro (`place`), a Linux path it reported is
 * read through the distro's share, and the locator looks in the distro's home,
 * so the same proof holds there.
 */
export async function proveClaudeConversationGone(params: {
  agentSessionId: string;
  reportedPaths: ReadonlyArray<string>;
  cwd: string;
  place?: CliPlace | null;
}): Promise<boolean> {
  const place = params.place ?? null;
  const fileName = `${params.agentSessionId}.jsonl`;
  const reportedPath = params.reportedPaths
    .map((candidate) => hostPathForTarget(candidate, place))
    .find((candidate) => path.isAbsolute(candidate) && path.basename(candidate) === fileName);
  if (!reportedPath) return false;

  if (!(await isConfirmedMissing(reportedPath))) return false;
  if (!(await isConfirmedMissing(locateClaudeTranscriptFile(params.agentSessionId, params.cwd, place)))) return false;

  const projectsRoot = path.dirname(path.dirname(reportedPath));
  let folders: fs.Dirent[];
  try {
    const rootStat = await fs.promises.stat(projectsRoot);
    if (!rootStat.isDirectory()) return false;
    folders = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return false;
  }

  const candidates: string[] = [];
  for (const folder of folders) {
    const folderPath = path.join(projectsRoot, folder.name);
    if (folder.isDirectory() || (folder.isSymbolicLink() && await mayBeFolder(folderPath))) {
      candidates.push(path.join(folderPath, fileName));
    }
  }
  for (let start = 0; start < candidates.length; start += SCAN_BATCH) {
    const batch = candidates.slice(start, start + SCAN_BATCH);
    const missing = await Promise.all(batch.map(isConfirmedMissing));
    if (missing.includes(false)) return false;
  }
  return true;
}

/**
 * False only for a link whose target is a file, which can hold no transcript;
 * looking inside it would fail ENOTDIR, which is not proof, and so would keep
 * every conversation of the profile from ever counting as gone. A link to a
 * folder, a dangling link and an unreadable one stay in the scan.
 */
async function mayBeFolder(linkPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(linkPath)).isDirectory();
  } catch {
    return true;
  }
}
