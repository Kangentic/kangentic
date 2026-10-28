import path from 'node:path';
import { listClaudeProjectFolders, PROJECT_SCAN_BATCH, resolveClaudeTranscriptFile } from './transcript-locator';
import { isConfirmedMissing } from '../../shared/confirmed-missing';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

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
 *  2. That path and the path every reader would open (`resolveClaudeTranscriptFile`,
 *     which finds a conversation filed under a parent folder's slug or any
 *     other project folder) both fail with ENOENT. Any other error
 *     (permission, a locked file) is not proof.
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
  // The path every reader would open. A conversation it finds anywhere (a
  // parent folder's slug, another project folder) is not gone; one found
  // nowhere resolves to the cwd path, which must then be missing too.
  const readerPath = await resolveClaudeTranscriptFile({ agentSessionId: params.agentSessionId, cwd: params.cwd, place });
  if (!(await isConfirmedMissing(readerPath))) return false;

  const projectsRoot = path.dirname(path.dirname(reportedPath));
  // A link whose target is a file is left out: looking inside it would fail
  // ENOTDIR, which is not proof, and would keep every conversation of the
  // profile from ever counting as gone.
  const folders = await listClaudeProjectFolders(projectsRoot);
  if (!folders) return false;

  const candidates = folders.map((folderPath) => path.join(folderPath, fileName));
  for (let start = 0; start < candidates.length; start += PROJECT_SCAN_BATCH) {
    const batch = candidates.slice(start, start + PROJECT_SCAN_BATCH);
    const missing = await Promise.all(batch.map(isConfirmedMissing));
    if (missing.includes(false)) return false;
  }
  return true;
}
