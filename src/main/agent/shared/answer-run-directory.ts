/**
 * Where a Knowledge Graph answer run starts, and where it keeps its own files.
 *
 * Two directories, for two different reasons.
 *
 * The WORKING directory is one stable, empty folder every answer run starts
 * in: the answer home. Not the project, because an agent CLI loads its project
 * instructions from the directory it starts in and an answer needs none of
 * them (measured on this repo: Claude loaded 18,700 tokens of CLAUDE.md and
 * rules per question; Grok loaded 54 instruction files, about 100k tokens, to
 * answer "PONG"). And not a fresh folder per run, which is what it was: nearly
 * every agent CLI keys state by working directory, so each question left a new
 * entry behind in the user's own tools. Found on one developer machine after a
 * few days of probing: 29 session folders in Grok's store, 27 in Droid's, 25
 * Copilot sessions, 11 in Gemini's, 13 project folders in Claude's. One stable
 * folder leaves each CLI at most one, and trust-gated CLIs (Grok) need one
 * trust entry for it, not one per question.
 *
 * The RUN directory is fresh per run, and holds what the run writes and passes
 * by path: a prompt file, an MCP config carrying the live server token. It is
 * removed when the run ends, so no token outlives its question.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The prefix every answer run directory carries under `os.tmpdir()`. */
export const ANSWER_RUN_DIRECTORY_PREFIX = 'kangentic-answer-';

/**
 * The answer home's folder name under `os.tmpdir()`. Deliberately NOT under
 * the run-directory prefix, which the stale sweep removes.
 */
export const ANSWER_HOME_DIRECTORY_NAME = 'kangentic-ask-home';

/** This user's id where the platform has one (not Windows). */
function currentUserId(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * The one working directory every answer run starts in. Windows gives each user
 * a temp folder of their own; Linux shares `/tmp` between users, so there the
 * name carries the user id and `ensureAnswerHomeDirectory` checks the folder
 * before use.
 */
export function answerHomeDirectory(root: string = os.tmpdir()): string {
  const userId = currentUserId();
  return path.join(root, userId === null ? ANSWER_HOME_DIRECTORY_NAME : `${ANSWER_HOME_DIRECTORY_NAME}-${userId}`);
}

/** A private home used instead of a fixed one someone else controls, one per launch. */
const fallbackHomes = new Map<string, Promise<string>>();

/**
 * The answer home, created if a temp cleaner removed it.
 *
 * In a temp folder other users can write to, the fixed name can be taken first:
 * another user creates it, plants a CLI's workspace config in it, and every
 * answer run starts there. So on POSIX the home is made private to this user
 * (0700), and an existing one is used only when it is a real directory, owned
 * by this user and writable by no one else. One that fails that is never used;
 * a fresh private folder takes its place for the rest of the launch, so each
 * CLI still keeps one state entry per launch, not one per question.
 *
 * Returned as its real path. macOS's temp folder sits behind a link (`/var` is
 * `/private/var`), and a CLI that resolves its working directory keys its trust
 * and its saved chats by the real path, so a trust entry or a cleanup written
 * for the linked one would miss.
 */
export async function ensureAnswerHomeDirectory(options: { root?: string } = {}): Promise<string> {
  const directory = answerHomeDirectory(options.root);
  if (currentUserId() === null) {
    await fs.promises.mkdir(directory, { recursive: true });
    return fs.promises.realpath(directory);
  }
  if (await isPrivateToThisUser(directory)) return fs.promises.realpath(directory);
  let fallback = fallbackHomes.get(directory);
  if (!fallback) {
    fallback = fs.promises.mkdtemp(`${directory}-`).then((created) => fs.promises.realpath(created));
    fallbackHomes.set(directory, fallback);
  }
  return fallback;
}

/**
 * Create `directory` private to this user, or confirm an existing one is. A
 * directory only its owner can write to holds nothing anyone else put there, so
 * one this user made with looser read bits is closed and kept; one another user
 * owns, a link, or one others can write to is refused.
 */
async function isPrivateToThisUser(directory: string): Promise<boolean> {
  try {
    await fs.promises.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) return false;
  }
  try {
    const stats = await fs.promises.lstat(directory);
    if (!stats.isDirectory() || stats.uid !== currentUserId()) return false;
    if ((stats.mode & 0o022) !== 0) return false;
    if ((stats.mode & 0o077) !== 0) await fs.promises.chmod(directory, 0o700);
    return true;
  } catch {
    return false;
  }
}

/** A run directory untouched this long belongs to no live run: a session's
 *  files are written once at its start, and an idle one ends in 10 minutes. */
export const STALE_ANSWER_RUN_DIRECTORY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove run directories a previous launch left behind. A quit or a crash can
 * kill a run before its `finally` removes the directory, and on Windows a
 * directory cannot be removed while a process still has it as its working
 * directory, so some are always left. Found: 70 in one developer's temp folder,
 * some holding a per-run MCP config with a server token. Async and best-effort;
 * a directory still in use fails to remove and is left for a later sweep.
 */
export async function sweepStaleAnswerRunDirectories(
  options: { root?: string; nowMs?: number } = {},
): Promise<number> {
  const root = options.root ?? os.tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  let removed = 0;
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return 0;
  }
  const userId = currentUserId();
  for (const name of names) {
    if (!name.startsWith(ANSWER_RUN_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, name);
    try {
      // `lstat`, and only this user's own: in a temp folder users share, an
      // entry with the prefix may be another user's run, or a link to anywhere.
      const stats = await fs.promises.lstat(directory);
      if (!stats.isDirectory() || (userId !== null && stats.uid !== userId)) continue;
      if (nowMs - stats.mtimeMs < STALE_ANSWER_RUN_DIRECTORY_MS) continue;
      await fs.promises.rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // In use, or gone already.
    }
  }
  return removed;
}

/**
 * Run `work` with a new empty run directory and remove it afterwards,
 * whether `work` resolved or threw. Removal is best-effort: Windows can hold a
 * handle for a beat after a child exits, and a leftover temp directory is not
 * worth failing an answer over.
 */
export async function withAnswerRunDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  // The real path, as for the home: see `ensureAnswerHomeDirectory`.
  const directory = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), ANSWER_RUN_DIRECTORY_PREFIX)));
  try {
    return await work(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
