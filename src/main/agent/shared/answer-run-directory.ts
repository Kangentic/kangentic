/**
 * A fresh, empty working directory for one Memory Graph answer run.
 *
 * Why not the project: an agent CLI loads its project instructions from the
 * directory it starts in, and an answer needs none of them. Measured on this
 * repo: Claude loaded 18,700 tokens of CLAUDE.md and rules per question, and
 * Grok loaded 54 instruction files, about 100k tokens, to answer "PONG". The
 * prompt already carries everything the answer may use.
 *
 * Why not the bare temp directory: runs write into their cwd. A prompt file
 * (`promptVia: 'file'`), a per-run MCP config carrying the live server token,
 * and whatever the CLI keeps beside them (Aider's chat history) all land here,
 * and two concurrent answers in one shared directory would overwrite each
 * other's prompt. One directory per run, removed when the run ends, keeps all
 * of that scoped to the question that made it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The prefix every answer run directory carries under `os.tmpdir()`. */
export const ANSWER_RUN_DIRECTORY_PREFIX = 'kangentic-answer-';

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
  for (const name of names) {
    if (!name.startsWith(ANSWER_RUN_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, name);
    try {
      const stats = await fs.promises.stat(directory);
      if (!stats.isDirectory() || nowMs - stats.mtimeMs < STALE_ANSWER_RUN_DIRECTORY_MS) continue;
      await fs.promises.rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // In use, or gone already.
    }
  }
  return removed;
}

/**
 * Run `work` with a new empty directory and remove the directory afterwards,
 * whether `work` resolved or threw. Removal is best-effort: Windows can hold a
 * handle for a beat after a child exits, and a leftover temp directory is not
 * worth failing an answer over.
 */
export async function withAnswerRunDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), ANSWER_RUN_DIRECTORY_PREFIX));
  try {
    return await work(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
