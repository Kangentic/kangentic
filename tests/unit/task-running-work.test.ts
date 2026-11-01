/**
 * `readTaskRunningWork` and `readWorktreeWork` against a real git repository:
 * what the running-work guard is told a task holds. The guard's own decisions
 * are pinned in `mcp-running-work-guard.test.ts`.
 *
 * Real git because the answers that matter are git's: `--cherry-pick` reading a
 * rebased commit as landed, a base that resolves on neither ref form, a
 * directory that is no repository. The failures must read as "cannot tell",
 * never as "nothing here", or the guard would allow a delete on a git error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readTaskRunningWork, type RunningWorkDeps } from '../../src/main/ipc/helpers/task-running-work';
import { readWorktreeWork } from '../../src/main/git/worktree-head';
import type { Task } from '../../src/shared/types';

describe('reading what a task holds', () => {
  let temporaryRoot: string;
  let repository: string;
  let worktree: string;

  function git(directory: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }

  function commitFile(directory: string, name: string, content: string): void {
    fs.writeFileSync(path.join(directory, name), content);
    git(directory, 'add', name);
    git(directory, 'commit', '-m', `Add ${name}`);
  }

  function taskIn(worktreePath: string | null, overrides: Partial<Task> = {}): Task {
    return { id: 'task-1', worktree_path: worktreePath, resolved_base_branch: 'main', ...overrides } as unknown as Task;
  }

  function depsWith(overrides: Partial<RunningWorkDeps> = {}): RunningWorkDeps {
    return {
      hasLiveOrStartingSession: () => false,
      defaultBaseBranchOf: () => 'main',
      ...overrides,
    };
  }

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-running-work-'));
    repository = path.join(temporaryRoot, 'repository');
    worktree = path.join(temporaryRoot, 'worktree');
    fs.mkdirSync(repository);
    git(repository, 'init', '--initial-branch=main');
    commitFile(repository, 'first.txt', 'first\n');
    git(repository, 'worktree', 'add', '-b', 'task/importer', worktree);
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('readWorktreeWork', () => {
    it('reads nothing for a fresh worktree', async () => {
      await expect(readWorktreeWork(worktree, 'main')).resolves.toEqual({
        branch: 'task/importer',
        commitsNotOnBase: 0,
        uncommittedFiles: 0,
      });
    });

    it('counts the commits the base does not hold', async () => {
      commitFile(worktree, 'second.txt', 'second\n');
      commitFile(worktree, 'third.txt', 'third\n');

      await expect(readWorktreeWork(worktree, 'main')).resolves.toMatchObject({ commitsNotOnBase: 2 });
    });

    it('counts nothing once the same change landed on the base by rebase', async () => {
      commitFile(worktree, 'second.txt', 'second\n');
      const taskCommit = git(worktree, 'rev-parse', 'HEAD');
      git(repository, 'cherry-pick', taskCommit);

      await expect(readWorktreeWork(worktree, 'main')).resolves.toMatchObject({ commitsNotOnBase: 0 });
    });

    it('prefers origin/<base> over a local base left behind', async () => {
      // The branch's commit is on origin/main, and the local main never saw it.
      commitFile(worktree, 'second.txt', 'second\n');
      git(repository, 'update-ref', 'refs/remotes/origin/main', git(worktree, 'rev-parse', 'HEAD'));

      await expect(readWorktreeWork(worktree, 'main')).resolves.toMatchObject({ commitsNotOnBase: 0 });
    });

    it('counts modified and untracked files as uncommitted', async () => {
      fs.writeFileSync(path.join(worktree, 'first.txt'), 'changed\n');
      fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new\n');

      await expect(readWorktreeWork(worktree, 'main')).resolves.toMatchObject({ uncommittedFiles: 2, commitsNotOnBase: 0 });
    });

    it('reports a detached HEAD as no branch', async () => {
      git(worktree, 'checkout', '--detach');

      await expect(readWorktreeWork(worktree, 'main')).resolves.toMatchObject({ branch: null });
    });

    it('answers a null commit count for a base that resolves on neither ref form, never zero', async () => {
      commitFile(worktree, 'second.txt', 'second\n');

      await expect(readWorktreeWork(worktree, 'no-such-branch')).resolves.toEqual({
        branch: 'task/importer',
        commitsNotOnBase: null,
        uncommittedFiles: 0,
      });
    });

    it('still reports the branch and the uncommitted files when the base does not resolve', async () => {
      fs.writeFileSync(path.join(worktree, 'first.txt'), 'changed\n');
      fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new\n');

      await expect(readWorktreeWork(worktree, 'no-such-branch')).resolves.toEqual({
        branch: 'task/importer',
        commitsNotOnBase: null,
        uncommittedFiles: 2,
      });
    });

    it('answers null for a directory that is not a repository', async () => {
      const plainDirectory = path.join(temporaryRoot, 'plain');
      fs.mkdirSync(plainDirectory);

      await expect(readWorktreeWork(plainDirectory, 'main')).resolves.toBeNull();
    });

    it('counts no commits for an option-shaped or empty base, hands it to git never, and still reads the status', async () => {
      const marker = path.join(temporaryRoot, 'created-by-git');
      fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new\n');
      const unreadBase = { branch: 'task/importer', commitsNotOnBase: null, uncommittedFiles: 1 };

      await expect(readWorktreeWork(worktree, `--output=${marker}`)).resolves.toEqual(unreadBase);
      await expect(readWorktreeWork(worktree, '')).resolves.toEqual(unreadBase);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe('readTaskRunningWork', () => {
    it('reads a task with no worktree as holding none, with no git read', async () => {
      await expect(readTaskRunningWork(taskIn(null), depsWith())).resolves.toEqual({ liveAgent: false, worktree: null });
    });

    it('reads a worktree that is gone from disk, with no branch recorded, as holding none', async () => {
      const gone = path.join(temporaryRoot, 'gone');

      await expect(readTaskRunningWork(taskIn(gone, { branch_name: null }), depsWith())).resolves.toEqual({ liveAgent: false, worktree: null });
    });

    it('reads a worktree gone from disk whose row still names a branch as holding that branch, commits uncounted', async () => {
      const gone = path.join(temporaryRoot, 'gone');
      const defaultBaseBranchOf = vi.fn(() => 'trunk');

      // A recorded cut wins over the default.
      await expect(readTaskRunningWork(taskIn(gone, { branch_name: 'task/removed' }), depsWith({ defaultBaseBranchOf }))).resolves.toEqual({
        liveAgent: false,
        worktree: { readable: true, branch: 'task/removed', baseBranch: 'main', commitsNotOnBase: null, uncommittedFiles: 0 },
      });
      // With no recorded cut the default base is named.
      await expect(readTaskRunningWork(taskIn(gone, { branch_name: 'task/removed', resolved_base_branch: null }), depsWith({ defaultBaseBranchOf }))).resolves.toEqual({
        liveAgent: false,
        worktree: { readable: true, branch: 'task/removed', baseBranch: 'trunk', commitsNotOnBase: null, uncommittedFiles: 0 },
      });
    });

    it('reads a base that does not resolve in a live worktree as readable with an uncounted branch', async () => {
      fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new\n');

      await expect(readTaskRunningWork(taskIn(worktree, { resolved_base_branch: 'no-such-branch' }), depsWith())).resolves.toEqual({
        liveAgent: false,
        worktree: { readable: true, branch: 'task/importer', baseBranch: 'no-such-branch', commitsNotOnBase: null, uncommittedFiles: 1 },
      });
    });

    it('reads the commits and files in the worktree, naming the base', async () => {
      commitFile(worktree, 'second.txt', 'second\n');
      fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new\n');

      await expect(readTaskRunningWork(taskIn(worktree), depsWith())).resolves.toEqual({
        liveAgent: false,
        worktree: { readable: true, branch: 'task/importer', baseBranch: 'main', commitsNotOnBase: 1, uncommittedFiles: 1 },
      });
    });

    it('prefers the base the worktree was cut from over the default', async () => {
      git(repository, 'branch', 'develop');
      const defaultBaseBranchOf = vi.fn(() => 'main');

      const work = await readTaskRunningWork(taskIn(worktree, { resolved_base_branch: 'develop' }), depsWith({ defaultBaseBranchOf }));

      expect(work.worktree).toMatchObject({ baseBranch: 'develop' });
      expect(defaultBaseBranchOf).not.toHaveBeenCalled();
    });

    it('falls back to the default base with no recorded cut', async () => {
      const work = await readTaskRunningWork(taskIn(worktree, { resolved_base_branch: null }), depsWith());

      expect(work.worktree).toMatchObject({ baseBranch: 'main' });
    });

    it('reports a worktree git cannot read as unreadable, never as empty', async () => {
      // A folder that exists but is no repository, so git has nothing to read.
      const plainDirectory = path.join(temporaryRoot, 'plain');
      fs.mkdirSync(plainDirectory);

      const work = await readTaskRunningWork(taskIn(plainDirectory), depsWith());

      expect(work.worktree).toEqual({ readable: false });
    });

    it('asks the registry for the agent, whatever the row says', async () => {
      const hasLiveOrStartingSession = vi.fn((taskId: string) => taskId === 'task-1');

      const work = await readTaskRunningWork(taskIn(null, { session_id: null }), depsWith({ hasLiveOrStartingSession }));

      expect(work.liveAgent).toBe(true);
    });

    it('reads a stale session pointer as no agent', async () => {
      const work = await readTaskRunningWork(taskIn(null, { session_id: 'exited-long-ago' }), depsWith());

      expect(work.liveAgent).toBe(false);
    });

    it('reads the session after the base lookup that starts the worktree read', async () => {
      const order: string[] = [];
      const hasLiveOrStartingSession = vi.fn(() => {
        order.push('session');
        return false;
      });
      const defaultBaseBranchOf = vi.fn(() => {
        order.push('base');
        return 'main';
      });

      await readTaskRunningWork(taskIn(worktree, { resolved_base_branch: null }), depsWith({ hasLiveOrStartingSession, defaultBaseBranchOf }));

      expect(order).toEqual(['base', 'session']);
    });
  });
});
