import fs from 'node:fs';
import path from 'node:path';
import { isConfirmedMissing } from '../../shared/confirmed-missing';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';
import { geminiChatFilePattern } from './session-history-parser';
import { locateGeminiTranscriptFile } from './transcript-parser';

/** Project folders listed at once while searching for the conversation's file. */
const FOLDER_SCAN_BATCH = 32;

/**
 * Prove that Gemini can no longer resume a conversation: its chat file is gone
 * from every place Gemini could keep it. Gemini deletes chats older than
 * `general.sessionRetention.maxAge` (30 days by default,
 * https://geminicli.com/docs/cli/session-management), and a `--resume` of
 * one then fails.
 *
 * The reported path is the SessionStart hook's `transcript_path` (every
 * Gemini hook carries it, https://geminicli.com/docs/hooks/reference/), which
 * the resume guard reads from the session's events file. Every step returns
 * false on anything short of proof, which resumes exactly as before:
 *
 *  1. A reported path is absolute, sits in a `chats` folder under Gemini's
 *     `tmp`, and is named for this conversation: `session-<time>-<first 8 of
 *     the id>.jsonl` (chatRecordingService.ts at v0.66.0), or the legacy
 *     `.json`. A path that names another id says nothing about this one.
 *  2. That path fails with ENOENT. Any other error is not proof.
 *  3. The folder Kangentic's own reader looks in holds no file for the id.
 *  4. Gemini's `tmp` folder above the reported path is a directory this
 *     process can read, and no project's `chats` folder in it holds a file for
 *     the id. A folder that cannot be read is not proof. A file under another
 *     project's folder (a renamed worktree, a project that moved) means resume.
 *
 * Files are matched by the id's first eight characters, as Gemini names them,
 * so another conversation sharing that prefix keeps this one resumable: the
 * safe direction.
 *
 * Built from the CLI's docs and source, not yet run against a real expired
 * chat.
 */
export async function proveGeminiConversationGone(params: {
  agentSessionId: string;
  reportedPaths: ReadonlyArray<string>;
  cwd: string;
  place?: CliPlace | null;
}): Promise<boolean> {
  const place = params.place ?? null;
  const fileName = geminiChatFilePattern(params.agentSessionId);
  const reportedPath = params.reportedPaths
    .map((candidate) => hostPathForTarget(candidate, place))
    .find((candidate) => path.isAbsolute(candidate)
      && fileName.test(path.basename(candidate))
      && path.basename(path.dirname(candidate)) === 'chats'
      && path.basename(path.dirname(path.dirname(path.dirname(candidate)))) === 'tmp');
  if (!reportedPath) return false;

  if (!(await isConfirmedMissing(reportedPath))) return false;
  if (locateGeminiTranscriptFile(params.agentSessionId, params.cwd, place)) return false;

  const tmpRoot = path.dirname(path.dirname(path.dirname(reportedPath)));
  let projectFolders: fs.Dirent[];
  try {
    projectFolders = await fs.promises.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  const chatFolders = projectFolders
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(tmpRoot, entry.name, 'chats'));
  for (let start = 0; start < chatFolders.length; start += FOLDER_SCAN_BATCH) {
    const batch = chatFolders.slice(start, start + FOLDER_SCAN_BATCH);
    const verdicts = await Promise.all(batch.map((folder) => folderHoldsNoChat(folder, fileName)));
    if (verdicts.includes(false)) return false;
  }
  return true;
}

/**
 * True when the folder holds no chat for the id, or is not there (a project
 * folder with no chats yet). False when it holds one, or cannot be read.
 */
async function folderHoldsNoChat(folder: string, fileName: RegExp): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.promises.readdir(folder);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
  return !names.some((name) => fileName.test(name));
}
