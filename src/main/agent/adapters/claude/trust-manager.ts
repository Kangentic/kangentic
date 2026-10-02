import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { toForwardSlash } from '../../../../shared/paths';
import { claudeJsonPath, isClaudeJsonLockError, withClaudeJsonLock } from './claude-json-lock';
import { applyDiffPanelClosed } from './diff-panel';

// Every ~/.claude.json read-modify-write in this adapter runs under one lock:
// an in-process chain against our own writers, plus Claude's own
// `~/.claude.json.lock` against the CLI's writes. Lives in claude-json-lock.ts;
// re-exported so the other writers (diff-panel, project-relocation) keep their
// import.
export { withClaudeJsonLock };

const LOG_TAG = '[CLAUDE_TRUST]';

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

/**
 * Read ~/.claude.json for a read-modify-write. A missing file reads as empty,
 * since there is nothing to wipe. Null means leave the file untouched: it
 * could not be read, or it does not parse as a JSON object. It holds the
 * user's auth and MCP state, and a torn read (the CLI mid-write) must never be
 * written back as `{}`. The session then shows a trust prompt instead.
 */
async function readClaudeJsonForWrite(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.warn(`${LOG_TAG} Could not read ${filePath}; leaving it untouched:`, error);
    return null;
  }
  const parsed = parseObject(raw);
  if (!parsed) console.warn(`${LOG_TAG} ${filePath} is not a JSON object; leaving it untouched`);
  return parsed;
}

/**
 * Write ~/.claude.json through a temp file and a rename, so the CLI never
 * reads a torn file. Renamed onto the link's target, so a symlinked
 * ~/.claude.json stays a link, and written with the file's own mode, so a 0600
 * file holding the user's auth does not come back with the umask's default.
 * A failure throws: the spawn preamble reports it and notifies.
 */
async function writeClaudeJson(filePath: string, data: Record<string, unknown>): Promise<void> {
  const targetPath = await fsPromises.realpath(filePath).catch(() => filePath);
  const mode = await fsPromises.stat(targetPath).then((stats) => stats.mode & 0o777, () => 0o600);
  const temporaryPath = `${targetPath}.kangentic-${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2);
  let keepTemporary = false;
  try {
    await fsPromises.writeFile(temporaryPath, text, { encoding: 'utf-8', mode });
    if (!await renameRetryingWhileHeld(temporaryPath, targetPath)) {
      // Still held after the retries: written in place, as every write of
      // this file was before the temp-file rename. That risks a torn read;
      // throwing here would block the spawn outright.
      try {
        await fsPromises.writeFile(targetPath, text, 'utf-8');
      } catch (error) {
        // A write refused at open (the file held open, the usual Windows case)
        // left the file as it was, and a copy of the user's auth would only be
        // left behind for nothing. One that failed part way left it short: the
        // temp file is then the one complete copy, so it is kept and named.
        if (await isIntact(targetPath)) {
          throw new Error(`Could not write ${targetPath}`, { cause: error });
        }
        keepTemporary = true;
        sweptTargets.delete(targetPath);
        throw new Error(`Could not write ${targetPath}; its complete contents are in ${temporaryPath}`, { cause: error });
      }
    }
    // Written whole: a copy an earlier failed write kept, from this run or an
    // earlier one (another pid), holds nothing the file does not.
    if (!sweptTargets.has(targetPath)) {
      await removeKeptCopies(targetPath);
      sweptTargets.add(targetPath);
    }
  } finally {
    if (!keepTemporary) await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Files whose kept copies this run has already swept, so the directory is read
 *  on the first successful write of a run, and again only after a failed write
 *  kept a copy, not on every spawn. */
const sweptTargets = new Set<string>();

/** Whether ~/.claude.json still reads as whole: a JSON object, or no file at
 *  all, which a failed write cannot have made from one that existed. */
async function isIntact(targetPath: string): Promise<boolean> {
  try {
    return parseObject(await fsPromises.readFile(targetPath, 'utf-8')) !== null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Remove the temp copies failed writes kept beside ~/.claude.json
 * (`<name>.kangentic-<pid>.tmp`). Runs under the file's lock, which every
 * Kangentic writer of it holds, so none is another writer's file mid-write.
 */
async function removeKeptCopies(targetPath: string): Promise<void> {
  const directory = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.kangentic-`;
  const names = await fsPromises.readdir(directory).catch(() => [] as string[]);
  await Promise.all(names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    .map((name) => fsPromises.rm(path.join(directory, name), { force: true }).catch(() => undefined)));
}

/**
 * One locked read-modify-write of ~/.claude.json: `apply` mutates the parsed
 * file and says whether it changed anything, and only a change is written. A
 * lock that stays held past the budget skips the write (Claude's own policy
 * on a final ELOCKED): the session then shows one trust prompt, which costs
 * less than a write that could resurrect a withdrawn boot-canary record.
 */
async function updateClaudeJson(purpose: string, apply: (data: Record<string, unknown>) => boolean): Promise<void> {
  try {
    await withClaudeJsonLock(async () => {
      const filePath = claudeJsonPath();
      const data = await readClaudeJsonForWrite(filePath);
      if (!data || !apply(data)) return;
      await writeClaudeJson(filePath, data);
    });
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`${LOG_TAG} Skipping the ${purpose} write; ${error.message}`);
  }
}

/**
 * Pre-populate Claude Code's trust entry for a worktree path so the
 * "Is this a project you trust?" prompt is skipped when spawning an agent.
 *
 * Claude Code stores per-directory trust in ~/.claude.json under
 * `projects[<resolved-path>].hasTrustDialogAccepted`.
 *
 * A spawn goes through `ensureClaudeSpawnConfig` instead, which does this and
 * the other per-spawn changes in one pass.
 */
export async function ensureWorktreeTrust(worktreePath: string): Promise<void> {
  await updateClaudeJson('worktree trust', (data) => applyWorktreeTrust(data, worktreePath));
}

/**
 * Ensure the "kangentic" MCP server is listed in enabledMcpjsonServers
 * for a project path so Claude Code auto-enables it without prompting.
 */
export async function ensureMcpServerTrust(projectPath: string): Promise<void> {
  await updateClaudeJson('MCP server trust', (data) => applyMcpServerTrust(data, projectPath));
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
 * A file that exists but does not parse as a JSON object is left untouched,
 * as it is by the two single-purpose writers above.
 */
export async function ensureClaudeSpawnConfig(workingDirectory: string): Promise<void> {
  await updateClaudeJson('spawn config', (data) => {
    // Every change applied, then one write if any changed.
    const changes = [
      applyWorktreeTrust(data, workingDirectory),
      applyMcpServerTrust(data, workingDirectory),
      applyDiffPanelClosed(data),
    ];
    return changes.some(Boolean);
  });
}

/** How Windows refuses to replace a file another process holds open: a
 *  scanner or indexer, or a sibling Claude rewriting it. Usually for a moment. */
const RENAME_HELD_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_STEP_MS = 50;

/** Rename `from` onto `to`, retrying while `to` is held open. False when it is
 *  still held after the last attempt; any other failure throws. */
async function renameRetryingWhileHeld(from: string, to: string): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsPromises.rename(from, to);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RENAME_HELD_CODES.has(code)) throw error;
      if (attempt >= RENAME_ATTEMPTS) return false;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_STEP_MS * attempt));
    }
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
