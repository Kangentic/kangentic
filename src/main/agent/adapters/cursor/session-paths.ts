import fs from 'node:fs';
import path from 'node:path';
import { cliHomeDir, cliPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * Cursor's project folder name. Taken from cursor-agent 2026.10.22
 * (`workspace-paths.js`): every character that is not a letter or digit
 * becomes `-`, runs of dashes collapse, and dashes at either end drop.
 * Case stays as the working directory was given. `E:\Desktop\kangentic`
 * and `E:/Desktop/kangentic` both become `E-Desktop-kangentic`.
 */
export function cursorProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Absolute path of one conversation's JSONL.
 *
 * `~/.cursor/projects/<slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl`
 *
 * A Cursor running in a WSL distro keeps the file under that distro's home,
 * and the slug is the path the distro was given (`/mnt/e/...`).
 */
export function cursorTranscriptFilePath(
  cwd: string,
  agentSessionId: string,
  place: CliPlace | null = null,
): string {
  const cliCwd = place ? cliPathForTarget(cwd, place) : cwd;
  return path.join(
    cliHomeDir(place),
    '.cursor',
    'projects',
    cursorProjectSlug(cliCwd),
    'agent-transcripts',
    agentSessionId,
    `${agentSessionId}.jsonl`,
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The conversation file when it is already on disk. The path derived from the
 * working directory wins. A path the agent itself reported is the fallback,
 * for a conversation that kept writing somewhere else. Null when neither
 * file is there. `create-chat` writes nothing until the first turn, so a
 * brand-new id is null until Cursor appends a line.
 */
export async function locateCursorTranscriptFile(
  agentSessionId: string,
  cwd: string,
  place: CliPlace | null = null,
  reportedPath?: string | null,
): Promise<string | null> {
  const derived = cursorTranscriptFilePath(cwd, agentSessionId, place);
  if (await fileExists(derived)) return derived;
  if (reportedPath && reportedPath !== derived && await fileExists(reportedPath)) return reportedPath;
  return null;
}
