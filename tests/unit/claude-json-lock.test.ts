/**
 * The cross-process lock every Kangentic read-modify-write of ~/.claude.json
 * takes (src/main/agent/adapters/claude/claude-json-lock.ts): Claude Code's own
 * `~/.claude.json.lock` (a mkdir directory, stale after 10 s), so a write can
 * never straddle the CLI's locked withdrawal of its fullscreen boot canary.
 *
 * Same temp-home pattern as trust-manager.test.ts: os.homedir() is mocked to a
 * fresh temp directory per test, and every path derives from it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

import {
  acquireClaudeJsonFileLock,
  claudeJsonLockPath,
  CLAUDE_JSON_LOCK_BUDGET_MS,
  CLAUDE_JSON_LOCK_STALE_MS,
  isClaudeJsonLockError,
  withClaudeJsonLock,
} from '../../src/main/agent/adapters/claude/claude-json-lock';
import { ensureWorktreeTrust, ensureMcpServerTrust } from '../../src/main/agent/adapters/claude/trust-manager';
import { ensureDiffPanelClosed } from '../../src/main/agent/adapters/claude/diff-panel';
import { migrateClaudeProjectData } from '../../src/main/agent/adapters/claude/project-relocation';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';

function claudeJsonPath(): string {
  return path.join(tmpHome, '.claude.json');
}

/** Emulate another process holding the lock, with the mtime a caller would see. */
function holdLock(mtime: Date): string {
  const lockPath = claudeJsonLockPath();
  fs.mkdirSync(lockPath);
  fs.utimesSync(lockPath, mtime, mtime);
  return lockPath;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-json-lock-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('withClaudeJsonLock', () => {
  it('holds ~/.claude.json.lock for the operation and releases it after', async () => {
    const lockPath = claudeJsonLockPath();
    expect(lockPath).toBe(`${claudeJsonPath()}.lock`);

    const result = await withClaudeJsonLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'done';
    });

    expect(result).toBe('done');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the operation throws', async () => {
    await expect(withClaudeJsonLock(() => {
      throw new Error('writer failed');
    })).rejects.toThrow('writer failed');
    expect(fs.existsSync(claudeJsonLockPath())).toBe(false);
  });

  it('waits while a live holder keeps the lock and proceeds once it is released', async () => {
    vi.useFakeTimers();
    const lockPath = holdLock(new Date());
    const operation = vi.fn(() => 'ran');

    let settled: string | null = null;
    const pending = withClaudeJsonLock(operation).then((value) => { settled = value; });

    // Held: the retry ladder is still waiting.
    await vi.advanceTimersByTimeAsync(60);
    expect(operation).not.toHaveBeenCalled();

    // The holder lets go; the next retry takes it.
    fs.rmSync(lockPath, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(400);
    await pending;

    expect(operation).toHaveBeenCalledTimes(1);
    expect(settled).toBe('ran');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('breaks a lock whose holder died (mtime older than the stale window)', async () => {
    const lockPath = holdLock(new Date(Date.now() - CLAUDE_JSON_LOCK_STALE_MS - 10_000));
    const operation = vi.fn(() => 'ran');

    // No timers needed: the abandoned lock is removed and retaken at once.
    await expect(withClaudeJsonLock(operation)).resolves.toBe('ran');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent callers in order, so no two operations overlap', async () => {
    const timeline: string[] = [];
    const operation = (name: string) => async () => {
      timeline.push(`${name}:enter`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      timeline.push(`${name}:exit`);
    };

    await Promise.all([
      withClaudeJsonLock(operation('a')),
      withClaudeJsonLock(operation('b')),
      withClaudeJsonLock(operation('c')),
    ]);

    expect(timeline).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit', 'c:enter', 'c:exit']);
    expect(fs.existsSync(claudeJsonLockPath())).toBe(false);
  });
});

describe('acquireClaudeJsonFileLock', () => {
  it('rejects with ELOCKED once the budget is spent on a holder that keeps the lock fresh', async () => {
    vi.useFakeTimers();
    // An mtime in the future can never read as stale, however far the fake
    // clock advances: this is a live holder, not an abandoned lock.
    const lockPath = holdLock(new Date(Date.now() + 60 * 60 * 1000));

    let failure: unknown = null;
    const pending = acquireClaudeJsonFileLock(lockPath).catch((error: unknown) => { failure = error; });

    await vi.advanceTimersByTimeAsync(CLAUDE_JSON_LOCK_BUDGET_MS + 2_000);
    await pending;

    expect(isClaudeJsonLockError(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe('ELOCKED');
    expect((failure as Error).message).toContain(lockPath);
    // Never touched the holder's lock.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('propagates a mkdir failure that is not EEXIST', async () => {
    // The parent directory does not exist, so mkdir fails with ENOENT.
    const lockPath = path.join(tmpHome, 'missing', '.claude.json.lock');
    await expect(acquireClaudeJsonFileLock(lockPath, { budgetMs: 10 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('a writer whose lock never arrives', () => {
  it('ensureWorktreeTrust skips the write and warns instead of writing unlocked', async () => {
    vi.useFakeTimers();
    holdLock(new Date(Date.now() + 60 * 60 * 1000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let settled = false;
    const pending = ensureWorktreeTrust('/projects/myrepo/.kangentic/worktrees/task-1').then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(CLAUDE_JSON_LOCK_BUDGET_MS + 2_000);
    await pending;

    expect(settled).toBe(true);
    // Claude's own policy on a final ELOCKED: no write at all, never an unlocked one.
    expect(fs.existsSync(claudeJsonPath())).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping the worktree trust write'));
  });

  it('ensureDiffPanelClosed skips the write and warns', async () => {
    vi.useFakeTimers();
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ diffSidebarOpen: true }));
    holdLock(new Date(Date.now() + 60 * 60 * 1000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let settled = false;
    const pending = ensureDiffPanelClosed().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(CLAUDE_JSON_LOCK_BUDGET_MS + 2_000);
    await pending;

    expect(settled).toBe(true);
    expect(JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf-8')).diffSidebarOpen).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping the diff panel write'));
  });

  it('ensureMcpServerTrust skips the write and warns', async () => {
    vi.useFakeTimers();
    holdLock(new Date(Date.now() + 60 * 60 * 1000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let settled = false;
    const pending = ensureMcpServerTrust('/projects/myrepo').then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(CLAUDE_JSON_LOCK_BUDGET_MS + 2_000);
    await pending;

    expect(settled).toBe(true);
    expect(fs.existsSync(claudeJsonPath())).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping the MCP server trust write'));
  });

  it('migrateClaudeProjectData skips both the ~/.claude.json rewrite and the transcript rename', async () => {
    vi.useFakeTimers();

    const oldProjectPath = '/projects/myrepo';
    const newProjectPath = '/projects/myrepo-renamed';
    const oldResolved = path.resolve(oldProjectPath);
    const newResolved = path.resolve(newProjectPath);

    // Seed a minimal ~/.claude.json with an entry keyed by the resolved old
    // path, so an unlocked rewrite would be observable as a changed file.
    const seededClaudeJson = JSON.stringify({
      projects: { [oldResolved]: { hasTrustDialogAccepted: true } },
    });
    fs.writeFileSync(claudeJsonPath(), seededClaudeJson);

    // Seed the transcript directory the migration would rename if it ran.
    // migrateClaudeProjectDataSync renames the transcript directory and
    // rewrites ~/.claude.json inside the SAME withClaudeJsonLock operation,
    // so an ELOCKED skip at acquire time (before operation() ever runs)
    // takes both with it, not just the JSON rewrite.
    const transcriptsRoot = path.join(tmpHome, '.claude', 'projects');
    const oldTranscriptDir = path.join(transcriptsRoot, claudeProjectSlug(oldResolved));
    fs.mkdirSync(oldTranscriptDir, { recursive: true });
    fs.writeFileSync(path.join(oldTranscriptDir, 'session.jsonl'), '{}\n');

    holdLock(new Date(Date.now() + 60 * 60 * 1000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let settled = false;
    const pending = migrateClaudeProjectData(oldProjectPath, newProjectPath).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(CLAUDE_JSON_LOCK_BUDGET_MS + 2_000);
    await pending;

    expect(settled).toBe(true);
    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(seededClaudeJson);
    const newTranscriptDir = path.join(transcriptsRoot, claudeProjectSlug(newResolved));
    expect(fs.existsSync(oldTranscriptDir)).toBe(true);
    expect(fs.existsSync(newTranscriptDir)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping the ~/.claude.json migration'));
  });
});
