import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { toForwardSlash } from '../../../../shared/paths';
import { isClaudeJsonLockError, withClaudeJsonLock } from './claude-json-lock';
import { applyDiffPanelClosed } from './diff-panel';

// Every ~/.claude.json read-modify-write in this adapter runs under one lock:
// an in-process chain against our own writers, plus Claude's own
// `~/.claude.json.lock` against the CLI's writes. Lives in claude-json-lock.ts;
// re-exported so the other writers (diff-panel, project-relocation) keep their
// import.
export { withClaudeJsonLock };

const LOG_TAG = '[CLAUDE_TRUST]';

function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Mark a worktree trusted in a parsed ~/.claude.json, copying MCP server
 * approvals from its parent project entry. True when it changed anything.
 */
function applyWorktreeTrust(data: Record<string, unknown>, worktreePath: string): boolean {
  const resolvedPath = toForwardSlash(path.resolve(worktreePath));
  if (!data.projects || typeof data.projects !== 'object') {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;

  // Already trusted - nothing to do
  if (projects[resolvedPath]?.hasTrustDialogAccepted === true) {
    return false;
  }

  // Copy MCP server approvals from the parent project entry if it exists.
  // The parent project is the repo root (worktree paths live under .kangentic/worktrees/).
  let parentMcpServers: string[] = [];
  const markerIdx = resolvedPath.indexOf('/.kangentic/worktrees/');
  if (markerIdx !== -1) {
    const parentPath = resolvedPath.substring(0, markerIdx);
    const parentEntry = projects[parentPath];
    if (parentEntry && Array.isArray(parentEntry.enabledMcpjsonServers)) {
      parentMcpServers = parentEntry.enabledMcpjsonServers as string[];
    }
  }

  projects[resolvedPath] = {
    allowedTools: [],
    enabledMcpjsonServers: parentMcpServers,
    disabledMcpjsonServers: [],
    ...(projects[resolvedPath] || {}),
    hasTrustDialogAccepted: true,
  };
  return true;
}

/** List the "kangentic" MCP server as enabled for a project in a parsed
 *  ~/.claude.json. True when it changed anything. */
function applyMcpServerTrust(data: Record<string, unknown>, projectPath: string): boolean {
  const resolvedPath = toForwardSlash(path.resolve(projectPath));
  if (!data.projects || typeof data.projects !== 'object') {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;
  if (!projects[resolvedPath]) {
    projects[resolvedPath] = {};
  }
  const entry = projects[resolvedPath];
  const enabledServers = Array.isArray(entry.enabledMcpjsonServers)
    ? entry.enabledMcpjsonServers as string[]
    : [];
  if (enabledServers.includes('kangentic')) {
    return false; // Already trusted
  }
  entry.enabledMcpjsonServers = [...enabledServers, 'kangentic'];
  return true;
}

/** Read and parse ~/.claude.json; a missing or unreadable file reads as empty. */
async function readClaudeJsonOrEmpty(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fsPromises.readFile(claudeJsonPath(), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Pre-populate Claude Code's trust entry for a worktree path so the
 * "Is this a project you trust?" prompt is skipped when spawning an agent.
 *
 * Claude Code stores per-directory trust in ~/.claude.json under
 * `projects[<resolved-path>].hasTrustDialogAccepted`.
 *
 * A lock that stays held past the budget skips the write (Claude's own policy
 * on a final ELOCKED): the session then shows one trust prompt, which costs
 * less than a write that could resurrect a withdrawn boot-canary record.
 *
 * A spawn goes through `ensureClaudeSpawnConfig` instead, which does this and
 * the other per-spawn changes in one pass.
 */
export async function ensureWorktreeTrust(worktreePath: string): Promise<void> {
  try {
    await withClaudeJsonLock(async () => {
      const data = await readClaudeJsonOrEmpty();
      if (!applyWorktreeTrust(data, worktreePath)) return;
      // This must throw, not degrade - a swallowed failure here would spawn
      // Claude into a trust prompt neither the CLI nor the user is ready for.
      // The caller reports and notifies on throw; only a claude-json-lock
      // timeout, a distinct failure class, is swallowed.
      await fsPromises.writeFile(claudeJsonPath(), JSON.stringify(data, null, 2), 'utf-8');
    });
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`${LOG_TAG} Skipping the worktree trust write; ${error.message}`);
  }
}

/**
 * Ensure the "kangentic" MCP server is listed in enabledMcpjsonServers
 * for a project path so Claude Code auto-enables it without prompting.
 */
export async function ensureMcpServerTrust(projectPath: string): Promise<void> {
  try {
    await withClaudeJsonLock(async () => {
      const data = await readClaudeJsonOrEmpty();
      if (!applyMcpServerTrust(data, projectPath)) return;
      // Same reason as ensureWorktreeTrust's write above - must throw, not
      // degrade, so the spawn preamble can report and notify.
      await fsPromises.writeFile(claudeJsonPath(), JSON.stringify(data, null, 2), 'utf-8');
    });
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`${LOG_TAG} Skipping the MCP server trust write; ${error.message}`);
  }
}

/**
 * Everything a Claude spawn needs in ~/.claude.json, in ONE read-modify-write
 * under the lock: the working directory trusted, the "kangentic" MCP server
 * enabled for it, and the fullscreen diff panel closed (`diff-panel.ts`).
 *
 * It used to be three passes per spawn, each reading, parsing, stringifying
 * and rewriting the whole file (1.5 MB on a dogfooding machine, about 7 ms of
 * parse and stringify on main per pass). The read and the write are
 * asynchronous, and an unchanged file is not written.
 *
 * A file that exists but does not parse as a JSON object is left untouched
 * (the session then shows a trust prompt) rather than replaced: it holds the
 * user's auth and MCP state, and a torn read must never be written back as
 * `{}`. A write that fails throws, so the spawn preamble reports it; a lock
 * held past its budget skips, as Claude itself does on a final ELOCKED.
 */
export async function ensureClaudeSpawnConfig(workingDirectory: string): Promise<void> {
  try {
    await withClaudeJsonLock(async () => {
      const filePath = claudeJsonPath();
      let raw: string | null;
      try {
        raw = await fsPromises.readFile(filePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`${LOG_TAG} Could not read ${filePath}; leaving it untouched:`, error);
          return;
        }
        raw = null;
      }
      let data: Record<string, unknown> = {};
      if (raw !== null) {
        const parsed = parseObject(raw);
        if (!parsed) {
          console.warn(`${LOG_TAG} ${filePath} is not a JSON object; leaving it untouched`);
          return;
        }
        data = parsed;
      }
      // Every change applied, then one write if any changed.
      const changes = [
        applyWorktreeTrust(data, workingDirectory),
        applyMcpServerTrust(data, workingDirectory),
        applyDiffPanelClosed(data),
      ];
      if (!changes.some(Boolean)) return;
      // Temp file + rename, so the CLI never reads a torn file. Renamed onto
      // the link's target, so a symlinked ~/.claude.json stays a link, and
      // written with the file's own mode, so a 0600 file holding the user's
      // auth does not come back with the umask's default.
      const targetPath = await fsPromises.realpath(filePath).catch(() => filePath);
      const mode = await fsPromises.stat(targetPath).then((stats) => stats.mode & 0o777, () => 0o600);
      const temporaryPath = `${targetPath}.kangentic-${process.pid}.tmp`;
      try {
        await fsPromises.writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode });
        await fsPromises.rename(temporaryPath, targetPath);
      } catch (error) {
        await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`${LOG_TAG} Skipping the spawn config write; ${error.message}`);
  }
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
