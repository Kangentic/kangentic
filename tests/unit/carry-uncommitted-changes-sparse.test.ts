/**
 * Real git, real files: carrying uncommitted changes into a new worktree must
 * not bring back the directory the worktree's sparse-checkout leaves out.
 *
 * Measured before the fix: `git apply --3way` applied a change to
 * `.claude/commands/review.md` cleanly, which put the excluded file back on
 * disk in the worktree and staged it there, so the agent saw every command
 * twice again and the edit could land on the task's branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// task-branch.ts registers IPC handlers and reads the project database; none of
// that runs here, but the imports have to resolve outside Electron.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '0.0.0'), isPackaged: false, getLocale: vi.fn(() => 'en') },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: vi.fn() }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskSession: vi.fn(),
  cleanupTaskResources: vi.fn(),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn(), refineTranscriptTokens: vi.fn(), refineTranscriptToolCounts: vi.fn() }));

import { carryUncommittedChanges } from '../../src/main/ipc/handlers/task-branch';
import { WorktreeManager } from '../../src/main/git/worktree-manager';

let repo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf-8' });
}

function write(root: string, relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-carry-sparse-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'dev@example.com']);
  git(repo, ['config', 'user.name', 'Dev']);
  // Hermetic: the host's global ignore file must not hide the fixtures, and a
  // global core.autocrlf must not rewrite the line endings the asserts compare.
  git(repo, ['config', 'core.excludesFile', path.join(repo, 'no-global-excludes')]);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(repo, 'src/app.txt', 'app v1\n');
  write(repo, '.claude/commands/review.md', '# review v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
});

afterEach(async () => {
  try { git(repo, ['worktree', 'prune']); } catch { /* repo already gone */ }
  await fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('carryUncommittedChanges into a sparse worktree (real git)', () => {
  it('carries the app change and leaves .claude/commands/ changes in the main checkout', async () => {
    const { worktreePath } = await new WorktreeManager(repo).createWorktree({ id: 'aaaaaaaa-carry', title: 'Carry test', display_id: 3 }, 'main');
    // Uncommitted work in the main checkout: tracked edits on both sides of the
    // exclusion, and an untracked file on each side.
    write(repo, 'src/app.txt', 'app v2 (user edit)\n');
    write(repo, '.claude/commands/review.md', '# review v2 (user edit)\n');
    write(repo, 'src/new-util.txt', 'new util\n');
    write(repo, '.claude/commands/new-command.md', '# new command\n');

    const result = await carryUncommittedChanges(repo, worktreePath, 'aaaaaaaa');

    expect(result.applyFailed).toBe(false);
    expect(result.carriedTracked).toBe(true);
    expect(result.carriedUntracked).toEqual(['src/new-util.txt']);
    expect(fs.readFileSync(path.join(worktreePath, 'src/app.txt'), 'utf-8')).toBe('app v2 (user edit)\n');
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'commands'))).toBe(false);
    const worktreeStatus = git(worktreePath, ['status', '--porcelain']).split('\n').filter(Boolean).map((line) => line.slice(3));
    expect(worktreeStatus.sort()).toEqual(['src/app.txt', 'src/new-util.txt']);
    // The main checkout keeps its command edits, where the worktree's agent finds them.
    expect(fs.readFileSync(path.join(repo, '.claude/commands/review.md'), 'utf-8')).toBe('# review v2 (user edit)\n');
  });
});
