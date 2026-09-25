import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSerialLock } from '../../shared/relocation-utils';

/**
 * The lock every Kangentic read-modify-write of `~/.claude.json` runs under.
 *
 * Two layers, because two kinds of writer race on that file:
 *
 * 1. Kangentic's own writers (worktree trust, MCP server trust, the diff-panel
 *    key, project relocation) are serialized in-process by a promise chain, so
 *    two spawns in the same tick cannot interleave their reads and writes.
 * 2. Claude Code itself writes the same file from every running session, under
 *    `~/.claude.json.lock` (proper-lockfile semantics: a directory made with
 *    `mkdir`, stale after 10 s). One of those writes is the withdrawal of the
 *    fullscreen boot canary (`fullscreenBootPending[pid]`) on a graceful exit.
 *    A Kangentic write that read the file before that withdrawal and wrote
 *    after it resurrects the record, and a resurrected record for a pid that
 *    is gone at the next launch is a strike against the fullscreen renderer.
 *    So the in-process chain takes Claude's lock too, and every writer reads
 *    inside it.
 *
 * `proper-lockfile` itself is not a runtime dependency (it reaches
 * node_modules only through electron-builder), so the protocol is
 * reimplemented here: `mkdirSync` acquires; on `EEXIST` a lock older than
 * `CLAUDE_JSON_LOCK_STALE_MS` is removed as abandoned and retried at once,
 * otherwise the caller waits a short ladder and retries until the budget is
 * spent, which is sized so any abandoned lock ages past stale before it runs
 * out. On the budget the writer gets an `ELOCKED` error and skips its write,
 * which is Claude's own policy on a final `ELOCKED`: one trust prompt or one
 * open diff panel in that session costs less than the lost update.
 */

export const CLAUDE_JSON_LOCK_STALE_MS = 10_000;
export const CLAUDE_JSON_LOCK_BUDGET_MS = 12_000;
const RETRY_LADDER_MS = [50, 100, 200, 400, 800];
const RETRY_CAP_MS = 1000;

export class ClaudeJsonLockError extends Error {
  readonly code = 'ELOCKED';
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Lock file is already being held: ${lockPath}`);
    this.name = 'ClaudeJsonLockError';
    this.lockPath = lockPath;
  }
}

export function isClaudeJsonLockError(error: unknown): error is ClaudeJsonLockError {
  return error instanceof ClaudeJsonLockError;
}

export function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

export function claudeJsonLockPath(): string {
  return `${claudeJsonPath()}.lock`;
}

export interface ClaudeJsonFileLockOptions {
  staleMs?: number;
  budgetMs?: number;
}

function retryDelayMs(attempt: number): number {
  return attempt < RETRY_LADDER_MS.length ? RETRY_LADDER_MS[attempt] : RETRY_CAP_MS;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isStaleLock(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    // Released between the failed mkdir and the stat: not stale, just gone.
    return false;
  }
}

/**
 * Take `~/.claude.json.lock`. Resolves holding it; rejects with
 * `ClaudeJsonLockError` when the budget runs out while a live holder keeps it.
 */
export async function acquireClaudeJsonFileLock(
  lockPath: string,
  options: ClaudeJsonFileLockOptions = {},
): Promise<void> {
  const staleMs = options.staleMs ?? CLAUDE_JSON_LOCK_STALE_MS;
  const budgetMs = options.budgetMs ?? CLAUDE_JSON_LOCK_BUDGET_MS;
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (isStaleLock(lockPath, staleMs)) {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      } catch {
        // Could not break it (Windows: held open elsewhere). Wait like a live lock.
      }
    }
    if (Date.now() - startedAt >= budgetMs) throw new ClaudeJsonLockError(lockPath);
    await delay(retryDelayMs(attempt));
    attempt += 1;
  }
}

export function releaseClaudeJsonFileLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[CLAUDE_JSON_LOCK] Could not release ${lockPath}:`, error);
  }
}

const inProcessLock = createSerialLock();

/**
 * Run one read-modify-write of `~/.claude.json` under both layers. The
 * operation must do its read INSIDE, never before.
 */
export function withClaudeJsonLock<T>(operation: () => T | Promise<T>): Promise<T> {
  return inProcessLock(async () => {
    const lockPath = claudeJsonLockPath();
    await acquireClaudeJsonFileLock(lockPath);
    try {
      return await operation();
    } finally {
      releaseClaudeJsonFileLock(lockPath);
    }
  });
}
