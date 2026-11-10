import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSerialLock } from '../../shared/relocation-utils';
import type { CliPlace } from '../../shared/cli-target';

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

/**
 * Claude's own home on this machine: the folder an inherited `CLAUDE_CONFIG_DIR` names, else
 * `~/.claude`. A user who runs Claude with that variable keeps everything there, so Kangentic
 * reads and writes there too. Read per call, so a test or a user that changes it is not shadowed.
 */
export function claudeHomeDir(): string {
  const inherited = process.env.CLAUDE_CONFIG_DIR?.trim();
  return inherited ? path.resolve(inherited) : path.join(os.homedir(), '.claude');
}

/**
 * True when `home` is `~/.claude` itself. Windows paths compare without case, so a config dir
 * spelled with another drive-letter or folder case is still the default home.
 */
export function isDefaultClaudeHome(home: string): boolean {
  const resolved = path.resolve(home);
  const defaultHome = path.join(os.homedir(), '.claude');
  return process.platform === 'win32' ? resolved.toLowerCase() === defaultHome.toLowerCase() : resolved === defaultHome;
}

/** `~/.claude.json` sits beside `~/.claude`; under a config dir, it sits inside it. */
export function claudeStatePathForHome(home: string): string {
  return isDefaultClaudeHome(home)
    ? path.join(os.homedir(), '.claude.json')
    : path.join(home, '.claude.json');
}

/**
 * The `.claude.json` a Claude CLI reads: this machine's (`~/.claude.json`, or the one inside an
 * inherited `CLAUDE_CONFIG_DIR`), or for a Claude installed in a WSL distro, the distro's,
 * through its share. Claude in the distro locks it with `mkdir` the same way, and a `mkdir`
 * through the share is one in the distro, so the lock below holds across the two.
 *
 * It used to be `~/.claude.json` whatever the variable said, so for a user with their own
 * config dir Kangentic's trust and diff-panel writes landed in a file their Claude never read.
 */
export function claudeJsonPath(place: CliPlace | null = null): string {
  return place ? path.join(place.facts.homeUnc, '.claude.json') : claudeStatePathForHome(claudeHomeDir());
}

export function claudeJsonLockPath(place: CliPlace | null = null): string {
  return `${claudeJsonPath(place)}.lock`;
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
 * operation must do its read INSIDE, never before. `place` names a WSL
 * distro's file instead of this machine's (`claudeJsonPath`); one in-process
 * chain serializes both.
 */
export function withClaudeJsonLock<T>(operation: () => T | Promise<T>, place: CliPlace | null = null): Promise<T> {
  return withClaudeJsonFileLock(claudeJsonPath(place), operation);
}

/**
 * The same two layers for a `.claude.json` at any path. An account folder (task #1057) is a
 * `CLAUDE_CONFIG_DIR`, and Claude keeps that account's state file inside it and locks it at
 * `<file>.lock`, exactly as it locks `~/.claude.json`. One in-process chain serializes every file.
 */
export function withClaudeJsonFileLock<T>(jsonPath: string, operation: () => T | Promise<T>): Promise<T> {
  return inProcessLock(async () => {
    const lockPath = `${jsonPath}.lock`;
    await acquireClaudeJsonFileLock(lockPath);
    try {
      return await operation();
    } finally {
      releaseClaudeJsonFileLock(lockPath);
    }
  });
}
