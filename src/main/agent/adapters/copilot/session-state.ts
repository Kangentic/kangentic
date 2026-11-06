import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectRoot } from '../../../../shared/git-utils';
import { copilotHomeDir } from './copilot-home';
import type { CliPlace } from '../../shared/cli-target';

/**
 * Where Copilot keeps a session, and how a Kangentic resume reaches it.
 *
 * GitHub's config directory reference
 * (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference):
 * `session-state/` holds "one subdirectory per session ID", each with an event
 * log (`events.jsonl`) and workspace artifacts, which "enables `--resume` and
 * `--continue`". `COPILOT_HOME` (and the legacy `--config-dir`) replaces the
 * whole `~/.copilot`, session state included.
 *
 * Kangentic passes every session its own config home,
 * `.kangentic/sessions/<session record id>/copilot-config`, and every spawn,
 * a resume included, gets a new record id. So a resume's home starts with no
 * `session-state/<id>`. The command reference says `--session-id` with an
 * unseen valid UUID creates a new session, so the resume opened an empty
 * conversation under the old id. `seedResumedSessionState` brings the
 * session's folder into the new home first.
 *
 * The `session-state/<id>/events.jsonl` layout matches a user's own
 * `~/.copilot` on Copilot 1.0.24 through 1.0.98. The seeding itself has not
 * run against a real Copilot CLI.
 */

/** The folder of Kangentic's per-session config home, beside events.jsonl. */
export const SESSION_CONFIG_DIR_NAME = 'copilot-config';
const SESSION_STATE_DIR_NAME = 'session-state';
const EVENTS_FILE_NAME = 'events.jsonl';

/** A config home's `session-state/`, one subfolder per session id. */
export function sessionStateRoot(configHome: string): string {
  return path.join(configHome, SESSION_STATE_DIR_NAME);
}

/**
 * Whether a session id names one folder. The id becomes a path segment of the
 * copy and of every stat, so an id holding a separator or `..` would reach
 * outside `session-state/`. Kangentic's ids are UUIDs; this keeps any other
 * value from being read as a path.
 */
export function isSessionFolderName(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId !== '.' && sessionId !== '..' && path.basename(sessionId) === sessionId;
}

/** A session's folder inside a config home. */
export function sessionStateDir(configHome: string, sessionId: string): string {
  return path.join(sessionStateRoot(configHome), sessionId);
}

/** A session's event log inside a config home. */
export function sessionEventsFile(configHome: string, sessionId: string): string {
  return path.join(sessionStateDir(configHome, sessionId), EVENTS_FILE_NAME);
}

/** A session folder found in one config home. */
interface SessionFolder {
  folder: string;
  /** Last write time of its event log, or of the folder when it has none. */
  mtime: number;
  hasEvents: boolean;
}

/**
 * Folders that hold an event log first, then the newest first. A folder
 * Copilot made and never wrote a log to never outranks one that holds the
 * conversation.
 */
function rankSessionFolders(found: SessionFolder[]): string[] {
  return found
    .sort((first, second) => Number(second.hasEvents) - Number(first.hasEvents) || second.mtime - first.mtime)
    .map((entry) => entry.folder);
}

/**
 * The session folder's stats, or null when it is not there. The folder is
 * checked first, so a record of another agent costs one failed stat.
 */
function statSessionFolder(folder: string): SessionFolder | null {
  let folderMtime: number;
  try {
    folderMtime = fs.statSync(folder).mtimeMs;
  } catch {
    return null;
  }
  try {
    return { folder, mtime: fs.statSync(path.join(folder, EVENTS_FILE_NAME)).mtimeMs, hasEvents: true };
  } catch {
    return { folder, mtime: folderMtime, hasEvents: false };
  }
}

/** `statSessionFolder` without blocking the event loop. */
async function statSessionFolderAsync(folder: string): Promise<SessionFolder | null> {
  let folderMtime: number;
  try {
    folderMtime = (await fs.promises.stat(folder)).mtimeMs;
  } catch {
    return null;
  }
  try {
    return { folder, mtime: (await fs.promises.stat(path.join(folder, EVENTS_FILE_NAME))).mtimeMs, hasEvents: true };
  } catch {
    return { folder, mtime: folderMtime, hasEvents: false };
  }
}

/**
 * Whether `sessionsDir` is Kangentic's own `.kangentic/sessions`, the only
 * folder whose children are session records. Every spawn path names a
 * session's folder `<project>/.kangentic/sessions/<record id>`; any other
 * parent (a caller's temp folder) is never scanned.
 */
function isKangenticSessionsDir(sessionsDir: string): boolean {
  return path.basename(sessionsDir) === 'sessions' && path.basename(path.dirname(sessionsDir)) === '.kangentic';
}

/**
 * The config home of every session record under `sessionsDir`
 * (`.kangentic/sessions`), whether or not Copilot ever ran there. Empty for
 * any other folder or one that cannot be read.
 */
export function kangenticConfigHomes(sessionsDir: string): string[] {
  if (!isKangenticSessionsDir(sessionsDir)) return [];
  try {
    return configHomesOf(sessionsDir, fs.readdirSync(sessionsDir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

/**
 * `kangenticConfigHomes` without blocking the event loop, for the locator: the
 * folder holds one record per spawn the project ever made.
 */
async function kangenticConfigHomesAsync(sessionsDir: string): Promise<string[]> {
  if (!isKangenticSessionsDir(sessionsDir)) return [];
  try {
    return configHomesOf(sessionsDir, await fs.promises.readdir(sessionsDir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

function configHomesOf(sessionsDir: string, recordDirs: fs.Dirent[]): string[] {
  return recordDirs
    .filter((recordDir) => recordDir.isDirectory())
    .map((recordDir) => path.join(sessionsDir, recordDir.name, SESSION_CONFIG_DIR_NAME));
}

/**
 * Every Kangentic config home under `sessionsDir` that holds this session,
 * ranked by `rankSessionFolders`. `excludeConfigHome` leaves out the home of
 * the session being built.
 */
export function kangenticSessionFolders(
  sessionsDir: string,
  sessionId: string,
  excludeConfigHome: string | null = null,
): string[] {
  const excluded = excludeConfigHome ? path.resolve(excludeConfigHome) : null;
  const found: SessionFolder[] = [];
  for (const configHome of kangenticConfigHomes(sessionsDir)) {
    if (excluded && path.resolve(configHome) === excluded) continue;
    const entry = statSessionFolder(sessionStateDir(configHome, sessionId));
    if (entry) found.push(entry);
  }
  return rankSessionFolders(found);
}

/** `.kangentic/sessions` of the project a working directory belongs to (a worktree resolves to its project). */
export function projectSessionsDir(cwd: string): string {
  return path.join(resolveProjectRoot(cwd), '.kangentic', 'sessions');
}

/** How long to wait before each retry of a rename Windows refused: 100 ms of blocked main at most. */
const RENAME_RETRY_DELAYS_MS = [25, 75];
const RENAME_HELD_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** A cell nobody notifies, so `Atomics.wait` on it is a plain synchronous sleep. */
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Rename the finished copy into place, retrying while Windows refuses because a
 * scanner still holds a file it just saw copied. Not `safe-write.ts`'s retry:
 * this module reaches the retrieval worker, which carries no analytics import,
 * and `safe-write.ts` reports through one. Throws the last error.
 */
function renameCopyIntoPlace(fromPath: string, toPath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(fromPath, toPath);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      const held = process.platform === 'win32' && RENAME_HELD_CODES.has((error as NodeJS.ErrnoException).code ?? '');
      if (delayMs === undefined || !held) throw error;
      Atomics.wait(sleepCell, 0, 0, delayMs);
    }
  }
}

/**
 * Bring a resumed session's folder into the config home it is about to start
 * in. Looks in the other Kangentic config homes of the project first (ranked
 * by `rankSessionFolders`), then in the user's own Copilot home.
 *
 * Always a copy, never a move. The command is built before the session's
 * record is saved, and a spawn abandoned in between leaves a record folder no
 * row names, which the cold-open sweep deletes (`pruneOrphanedDirectories`,
 * resource-cleanup.ts). A moved folder would go with it. The copy's event log
 * is stamped with the time of the copy, so the locator reads it, the one the
 * resumed run appends to.
 *
 * The copy fills a staging folder in the config home and takes the session's
 * name only once it is whole. A copy that failed partway would otherwise
 * leave a folder every later build of this home takes for a finished one.
 *
 * Synchronous, because `buildCommand` is, and it runs once per resume. For a
 * Copilot in a WSL distro the user's home is read over the distro's share, so
 * a large session folder, or a distro that has to start, makes it slower.
 *
 * Never throws: a failure warns and the resume starts as it did before this,
 * on an empty session under the same id.
 */
export function seedResumedSessionState(options: {
  configHome: string;
  sessionId: string;
  /** `.kangentic/sessions`, the parent of every session record's folder. */
  sessionsDir: string;
  place: CliPlace | null;
}): void {
  const { configHome, sessionId, sessionsDir, place } = options;
  if (!isSessionFolderName(sessionId)) return;
  const target = sessionStateDir(configHome, sessionId);
  // In the config home, outside `session-state/`, which Copilot lists as sessions.
  const staging = path.join(configHome, `.seeding-${randomUUID()}`);
  try {
    if (fs.existsSync(target)) return;
    const userSource = sessionStateDir(copilotHomeDir(place), sessionId);
    const source = kangenticSessionFolders(sessionsDir, sessionId, configHome)[0]
      ?? (fs.existsSync(userSource) ? userSource : null);
    if (!source) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, staging, { recursive: true });
    renameCopyIntoPlace(staging, target);
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A staging folder left behind is never read as a session.
    }
    console.warn(`[copilot] could not bring session ${sessionId.slice(0, 8)} into its new config home; it resumes empty:`, error);
    return;
  }
  // A copy may keep the source's write time (Windows' does), which would tie
  // the two logs for the newest-first readers. The copy is the live one. The
  // session is in place either way, so a failure here only warns.
  const copiedEvents = path.join(target, EVENTS_FILE_NAME);
  try {
    if (fs.existsSync(copiedEvents)) {
      const now = new Date();
      fs.utimesSync(copiedEvents, now, now);
    }
  } catch (error) {
    console.warn(`[copilot] brought session ${sessionId.slice(0, 8)} into its new config home but could not restamp its event log:`, error);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The event log of a Copilot session: the path the agent reported when it
 * still exists, else the newest one in the project's Kangentic config homes,
 * else the user's own Copilot home. Null when none exists.
 *
 * The listing and the stats run without blocking the event loop: the workflow
 * hang check locates a running session's log every minute, and a project
 * keeps one record folder per spawn.
 */
export async function locateCopilotEventsFile(
  agentSessionId: string,
  cwd: string,
  place?: CliPlace | null,
  reportedPath?: string | null,
): Promise<string | null> {
  if (reportedPath && await pathExists(reportedPath)) return reportedPath;
  if (!isSessionFolderName(agentSessionId)) return null;
  const configHomes = await kangenticConfigHomesAsync(projectSessionsDir(cwd));
  const found = await Promise.all(
    configHomes.map((configHome) => statSessionFolderAsync(sessionStateDir(configHome, agentSessionId))),
  );
  const withEvents = found.filter((entry): entry is SessionFolder => entry !== null && entry.hasEvents);
  const newest = rankSessionFolders(withEvents)[0];
  if (newest) return path.join(newest, EVENTS_FILE_NAME);
  const userEvents = sessionEventsFile(copilotHomeDir(place ?? null), agentSessionId);
  return (await pathExists(userEvents)) ? userEvents : null;
}
