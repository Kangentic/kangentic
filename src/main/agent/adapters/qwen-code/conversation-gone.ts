import path from 'node:path';
import { isConfirmedMissing } from '../../shared/confirmed-missing';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';
import { listProjectFolders, noFolderHolds } from '../../shared/project-folders';
import { locateQwenTranscriptFile } from './transcript-parser';

/**
 * Prove that Qwen Code can no longer resume a conversation: its chat file is
 * gone from every place Qwen could look. `qwen --resume <uuid>` with no saved
 * chat exits 1 with "No saved session found with ID <id>"
 * (https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/cli/src/config/config.ts),
 * so a resume of a deleted chat
 * (a user's own delete, or a cleared runtime directory) fails rather than
 * starting fresh. Proven gone, the resume starts a new conversation from a
 * recap instead.
 *
 * Every step returns false on anything short of proof, which resumes as
 * before. The same proof as Claude's (`claude/conversation-gone.ts`) over
 * Qwen's layout, `<runtime>/projects/<slug>/chats/<id>.jsonl`:
 *
 *  1. A reported path is absolute and names this conversation's file
 *     (`<id>.jsonl`). Reported paths come from the SessionStart hook's
 *     `transcript_path`, so they follow a `QWEN_RUNTIME_DIR` or
 *     `advanced.runtimeOutputDir` Kangentic would not know about.
 *  2. That path and the reader's (`locateQwenTranscriptFile`) both fail with
 *     ENOENT.
 *  3. The `projects` folder three levels above the reported path is a
 *     directory this process can read. A Linux path a WSL session reported
 *     is read through the distro's share; a distro not running stops here.
 *  4. No folder under `projects` holds `chats/<id>.jsonl`.
 *
 * Built from Qwen's source, not yet run against a real Qwen.
 */
export async function proveQwenConversationGone(params: {
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
  if (!(await isConfirmedMissing(locateQwenTranscriptFile(params.agentSessionId, params.cwd, place)))) return false;

  const chatsDirectory = path.dirname(reportedPath);
  if (path.basename(chatsDirectory) !== 'chats') return false;
  const projectsRoot = path.dirname(path.dirname(chatsDirectory));
  // Not Qwen's layout: there is no projects folder to search.
  if (path.basename(projectsRoot) !== 'projects') return false;
  // A link to a file is left out of the folders; an unreadable link stays in,
  // where the stat inside it is not proof (`listProjectFolders`).
  const folders = await listProjectFolders(projectsRoot);
  if (!folders) return false;
  return noFolderHolds(folders, path.join('chats', fileName));
}
