import path from 'node:path';
import { resolveClaudeTranscriptFile } from './transcript-locator';
import { isConfirmedMissing } from '../../shared/confirmed-missing';
import { listProjectFolders, noFolderHolds } from '../../shared/project-folders';
import { hostPathForTarget, isPlainIdName, type CliPlace, type SshCliPlace } from '../../shared/cli-target';

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
  const folders = await listProjectFolders(projectsRoot);
  if (!folders) return false;
  return noFolderHolds(folders, fileName);
}

/** How long the host gets to look. A slow host is no answer, and the resume goes ahead. */
const HOST_CONVERSATION_PROBE_TIMEOUT_MS = 15_000;

/**
 * The host's own look for a Claude conversation's file, one fixed `sh` script with every value an
 * argument (`$1` the projects folder, `$2` the id). It answers one line:
 *
 *  - `KG:unknown` when no folder is given, or the projects folder, or any folder in it, cannot be
 *    read and searched;
 *  - `KG:present` when any project folder holds `<id>.jsonl`, a link included;
 *  - `KG:absent` only when it looked in every one.
 */
const HOST_CONVERSATION_PROBE_SCRIPT = [
  'root=$1',
  'id=$2',
  'if [ -z "$root" ]; then echo KG:unknown; exit 0; fi',
  'if [ ! -d "$root" ] || [ ! -r "$root" ] || [ ! -x "$root" ]; then echo KG:unknown; exit 0; fi',
  'for folder in "$root"/*; do',
  '  if [ ! -d "$folder" ]; then continue; fi',
  '  if [ ! -r "$folder" ] || [ ! -x "$folder" ]; then echo KG:unknown; exit 0; fi',
  '  if [ -e "$folder/$id.jsonl" ] || [ -L "$folder/$id.jsonl" ]; then echo KG:present; exit 0; fi',
  'done',
  'echo KG:absent',
].join('\n');

/**
 * The projects folder a reported host path names: `<root>/projects/<project>/<id>.jsonl`, absolute and
 * with nothing that climbs, so it follows a `CLAUDE_CONFIG_DIR` whatever shell the host's command runner
 * starts (fish and unknown shells run as `sh -lc`, which skips an interactive rc file). A path whose
 * folder two levels up is not named `projects` is not one Claude wrote, and names no folder to search.
 */
function projectsRootOfHostPath(candidate: string, fileName: string): string | null {
  if (!candidate.startsWith('/') || path.posix.basename(candidate) !== fileName) return null;
  if (candidate.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  const projectsRoot = path.posix.dirname(path.posix.dirname(candidate));
  return path.posix.basename(projectsRoot) === 'projects' ? projectsRoot : null;
}

/**
 * Prove a Claude conversation gone on an SSH host, by the host's own look (`HOST_CONVERSATION_PROBE_SCRIPT`
 * through `place.files.runCommand`, a call every helper version answers). This computer's mirror is
 * never read: a copy here is what has arrived so far, never proof (`.claude/rules/ssh-remote.md`).
 *
 * The projects folder comes from a path the agent reported, as on this computer, and with none
 * reported there is no proof. Claude's default folder is never searched: the helper's command runner
 * may skip the rc file that sets the agent's `CLAUDE_CONFIG_DIR`, so an empty default there would
 * replace a resume whose conversation is somewhere else. Anything short of `KG:absent` with exit 0, a
 * failed ask, a timeout or an error included, is false.
 */
export async function proveClaudeConversationGoneOnHost(params: {
  agentSessionId: string;
  reportedHostPaths: ReadonlyArray<string>;
  place: SshCliPlace;
}): Promise<boolean> {
  const files = params.place.files;
  if (!files || !isPlainIdName(params.agentSessionId)) return false;
  const fileName = `${params.agentSessionId}.jsonl`;
  const projectsRoot = params.reportedHostPaths.map((candidate) => projectsRootOfHostPath(candidate, fileName)).find((candidate) => candidate !== null);
  if (!projectsRoot) return false;
  try {
    const result = await files.runCommand({
      file: 'sh',
      args: ['-c', HOST_CONVERSATION_PROBE_SCRIPT, 'kangentic-claude-conversation', projectsRoot, params.agentSessionId],
      timeoutMs: HOST_CONVERSATION_PROBE_TIMEOUT_MS,
    });
    return !result.error && !result.timedOut && result.code === 0 && result.stdout.trim() === 'KG:absent';
  } catch (error) {
    // report-ok: a host that could not be asked (a dropped link, a host that never answered) is no
    // proof, and the resume goes ahead as it always did. The guard reads false as `unknown`.
    console.warn(`[SESSION_LIFECYCLE] Host conversation probe failed for ${params.agentSessionId.slice(0, 8)}: ${error instanceof Error ? error.name : 'unknown'}`);
    return false;
  }
}
