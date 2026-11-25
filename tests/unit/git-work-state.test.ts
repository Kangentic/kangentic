/**
 * A checkout's git work state on real repositories: the Changes button's badge
 * and the actions beside it are decided from it (src/shared/git-work-state.ts).
 *
 * The case the design turns on: a task branch tracks `origin/<base>` and agents
 * push it under another name, so `@{upstream}..HEAD` never clears. Every push
 * here goes to a bare repository on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePorcelainStatus, readGitWorkDetail, readGitWorkState } from '../../src/main/git/work-state';
import { invalidateRemoteUrlsCache } from '../../src/main/git/git-remotes';
import { availableGitActions, commitFileCount, gitNextStep, gitWorkBadge, taskGitBase, type GitWorkState } from '../../src/shared/git-work-state';

let root: string;
let checkout: string;

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(name: string, text: string): void {
  fs.writeFileSync(path.join(checkout, name), text);
}

function commit(name: string): void {
  write(name, name);
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', name);
}

/** A clone of a bare origin on `main`, with a task branch cut from `origin/main` (so it tracks it). */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-work-state-'));
  checkout = path.join(root, 'checkout');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'checkout');
  git(checkout, 'config', 'user.name', 'Dev');
  git(checkout, 'config', 'user.email', 'dev@example.com');
  git(checkout, 'config', 'core.autocrlf', 'false');
  git(checkout, 'config', 'commit.gpgsign', 'false');
  git(checkout, 'checkout', '-q', '-b', 'main');
  commit('base');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(checkout, 'checkout', '-q', '-b', 'task-branch', 'origin/main');
  invalidateRemoteUrlsCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (extra: { pushedBranch?: string; prMerged?: boolean; baseBranch?: string; cutFromBranch?: string } = {}) => readGitWorkDetail({
  projectPath: checkout, baseBranch: 'main', ...extra,
});

describe('readGitWorkDetail', () => {
  it('reads a fresh task branch as clean, pushed and unpublished', async () => {
    expect(git(checkout, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main');
    expect(await read()).toMatchObject({
      branch: 'task-branch', onBaseBranch: false, uncommittedFileCount: 0, unpushedCommitCount: 0,
      aheadOfBaseCount: 0, hasRemote: true, pushTarget: null, pushRemote: 'origin',
    });
  });

  it('counts every changed file, and the staged and conflicted ones among them', async () => {
    write('staged.txt', 'a');
    git(checkout, 'add', 'staged.txt');
    write('base', 'edited');
    fs.mkdirSync(path.join(checkout, 'new'));
    write('new/one.txt', 'a');
    write('new/two.txt', 'a');
    const state = await read();
    expect(state).toMatchObject({ uncommittedFileCount: 4, stagedFileCount: 1, conflictedFileCount: 0 });
    expect(commitFileCount(state)).toBe(1);
  });

  it('counts every changed file when the status listing runs past 1,000,000 characters', async () => {
    // A folder missing from .gitignore lists every file under it. The listing
    // was cut at 1,000,000 characters and parsed as a shorter one, so the
    // Changes button counted about a fifth of the files its panel listed.
    const folder = path.join(checkout, 'vendor');
    fs.mkdirSync(folder);
    const fileCount = 9_000;
    const longName = 'n'.repeat(110);
    for (let index = 0; index < fileCount; index += 1) {
      fs.closeSync(fs.openSync(path.join(folder, `${longName}-${String(index).padStart(5, '0')}`), 'w'));
    }
    // The listing really is past the cut, or this case proves nothing.
    const listing = execFileSync('git', ['status', '--porcelain=v2', '--untracked-files=all', '-z'], {
      cwd: checkout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    expect(listing.length).toBeGreaterThan(1_000_000);

    expect((await read()).uncommittedFileCount).toBe(fileCount);
  }, 60_000);

  it('counts a file with unresolved conflicts', async () => {
    git(checkout, 'checkout', '-q', '-b', 'other');
    write('base', 'theirs');
    git(checkout, 'commit', '-q', '-am', 'theirs');
    git(checkout, 'checkout', '-q', 'task-branch');
    write('base', 'ours');
    git(checkout, 'commit', '-q', '-am', 'ours');
    expect(() => git(checkout, 'merge', 'other')).toThrow();
    expect(await read()).toMatchObject({ conflictedFileCount: 1, uncommittedFileCount: 1 });
  });

  it('counts local commits until they are pushed under any name, not until the upstream has them', async () => {
    commit('one');
    commit('two');
    expect(await read()).toMatchObject({ unpushedCommitCount: 2, aheadOfBaseCount: 2, pushTarget: null });
    git(checkout, 'push', '-q', 'origin', 'HEAD:feature/renamed');
    expect(await read({ pushedBranch: 'feature/renamed' })).toMatchObject({
      unpushedCommitCount: 0, aheadOfBaseCount: 2, pushTarget: 'feature/renamed',
    });
    commit('three');
    expect(await read({ pushedBranch: 'feature/renamed' })).toMatchObject({ unpushedCommitCount: 1, pushTarget: 'feature/renamed' });
  });

  it('finds a branch published under its own name, and its own upstream first', async () => {
    commit('one');
    git(checkout, 'push', '-q', 'origin', 'HEAD:task-branch');
    expect((await read()).pushTarget).toBe('task-branch');
    git(checkout, 'push', '-q', '-u', 'origin', 'HEAD:elsewhere');
    expect((await read()).pushTarget).toBe('elsewhere');
  });

  it('never takes the branch the worktree was cut from for its own, after the task\'s base changed', async () => {
    git(checkout, 'push', '-q', 'origin', 'main:develop');
    git(checkout, 'checkout', '-q', '-b', 'cut-from-develop', 'origin/develop');
    commit('one');
    expect(git(checkout, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/develop');
    expect((await read({ baseBranch: 'main', cutFromBranch: 'develop' })).pushTarget).toBeNull();
  });

  it('offers no pull request for a branch that pushes to a remote pull requests are not created on', async () => {
    git(root, 'init', '-q', '--bare', '-b', 'main', 'fork.git');
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
    git(checkout, 'remote', 'add', 'fork', path.join(root, 'fork.git'));
    invalidateRemoteUrlsCache();
    commit('one');
    expect((await read()).canCreatePullRequest).toBe(true);
    git(checkout, 'push', '-q', '-u', 'fork', 'HEAD:topic');
    expect(await read()).toMatchObject({ pushRemote: 'fork', pushTarget: 'topic', canCreatePullRequest: false });
  });

  it('never takes a branch under another one\'s folder for it', async () => {
    commit('one');
    git(checkout, 'push', '-q', 'origin', 'HEAD:task-branch/child');
    expect((await read()).pushTarget).toBeNull();
  });

  it('reads the base branch as having no pull request to create', async () => {
    git(checkout, 'checkout', '-q', 'main');
    commit('direct');
    expect(await read()).toMatchObject({ onBaseBranch: true, unpushedCommitCount: 1, aheadOfBaseCount: 0, pushTarget: 'main' });
  });

  it('reads nothing unpushed once the pull request is merged and its branch gone', async () => {
    commit('squashed');
    expect((await read({ prMerged: true })).unpushedCommitCount).toBe(0);
  });

  it('reads a detached HEAD as no branch, and offers nothing there', async () => {
    commit('one');
    git(checkout, 'checkout', '-q', '--detach');
    const state = await read();
    expect(state.branch).toBeNull();
    expect(availableGitActions({ state, hasPullRequest: false })).toEqual({ commit: false, push: null, createPullRequest: false });
  });

  it('reads a repository with no remote as nothing to push', async () => {
    git(checkout, 'remote', 'remove', 'origin');
    invalidateRemoteUrlsCache();
    commit('one');
    expect(await read()).toMatchObject({ hasRemote: false, unpushedCommitCount: 0, pushTarget: null, pushRemote: null });
  });

  it('reads a repository with no commit yet', async () => {
    const empty = path.join(root, 'empty');
    git(root, 'init', '-q', '-b', 'main', 'empty');
    fs.writeFileSync(path.join(empty, 'file.txt'), 'a');
    expect(await readGitWorkDetail({ projectPath: empty, baseBranch: 'main' })).toMatchObject({
      branch: 'main', uncommittedFileCount: 1, unpushedCommitCount: 0,
    });
  });

  it('answers null for a folder that is not a repository', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await readGitWorkState({ projectPath: plain, baseBranch: 'main' })).toBeNull();
  });
});

describe('parsePorcelainStatus', () => {
  it('skips a rename\'s old path and takes an upstream only when its ref exists', () => {
    const gone = ['# branch.oid abc', '# branch.head topic', '# branch.upstream origin/topic', '2 R. N... 100644 100644 100644 a b R100 new.txt', '? not-a-file.txt', ''].join('\0');
    expect(parsePorcelainStatus(gone)).toMatchObject({ upstream: null, uncommittedFileCount: 1, stagedFileCount: 1 });
  });
});

const CLEAN: GitWorkState = {
  branch: 'topic', onBaseBranch: false, uncommittedFileCount: 0, stagedFileCount: 0, conflictedFileCount: 0,
  unpushedCommitCount: 0, aheadOfBaseCount: 0, hasRemote: true, pushTarget: 'topic', canCreatePullRequest: true,
};

describe('taskGitBase', () => {
  it('takes the chosen base, then the one the worktree was cut from, then the default', () => {
    expect(taskGitBase({ base_branch: 'release', resolved_base_branch: 'develop' }, 'main')).toBe('release');
    expect(taskGitBase({ base_branch: null, resolved_base_branch: 'develop' }, 'main')).toBe('develop');
    expect(taskGitBase({ base_branch: null, resolved_base_branch: null }, 'main')).toBe('main');
  });
});

describe('gitWorkBadge', () => {
  it('shows one badge: PR problems, then uncommitted, then unpushed', () => {
    const everything = { ...CLEAN, uncommittedFileCount: 1, unpushedCommitCount: 1 };
    expect(gitWorkBadge({ prFixCount: 2, state: everything })).toBe('pr-problems');
    expect(gitWorkBadge({ prFixCount: 0, state: everything })).toBe('uncommitted');
    expect(gitWorkBadge({ prFixCount: 0, state: { ...CLEAN, unpushedCommitCount: 1 } })).toBe('unpushed');
    expect(gitWorkBadge({ prFixCount: 0, state: { ...CLEAN, aheadOfBaseCount: 3 } })).toBeNull();
    expect(gitWorkBadge({ prFixCount: 1, state: null })).toBe('pr-problems');
    expect(gitWorkBadge({ prFixCount: 0, state: null })).toBeNull();
  });
});

describe('gitNextStep', () => {
  it.each([
    ['uncommitted files', { uncommittedFileCount: 1, unpushedCommitCount: 1 }, false, 'commit'],
    ['commits on a branch never published', { unpushedCommitCount: 1, pushTarget: null }, false, 'publish'],
    ['commits on a published branch', { unpushedCommitCount: 1 }, false, 'push'],
    ['pushed, no pull request', { aheadOfBaseCount: 1 }, false, 'create-pull-request'],
    ['pushed, with a pull request', { aheadOfBaseCount: 1 }, true, null],
    ['nothing yet', {}, false, null],
    ['on the base branch', { onBaseBranch: true, aheadOfBaseCount: 0 }, false, null],
    ['a host that cannot create one', { aheadOfBaseCount: 1, canCreatePullRequest: false }, false, null],
    ['commits with no remote', { unpushedCommitCount: 1, hasRemote: false, pushTarget: null, canCreatePullRequest: false }, false, null],
  ])('%s', (_name, change, hasPullRequest, expected) => {
    expect(gitNextStep({ state: { ...CLEAN, ...change }, hasPullRequest })).toBe(expected);
  });
});
