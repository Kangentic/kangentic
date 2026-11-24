/**
 * How a checkout's git work state names the base and the remote a push goes to
 * (src/main/git/work-state.ts), beside git-work-state.test.ts: a base written as a
 * remote-tracking name, a pushed-branch memory that is the base or cannot be a
 * branch, which name wins, the local base standing in for a missing remote one, and
 * a remote whose name holds another's. Real repositories, bare remotes on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGitWorkDetail } from '../../src/main/git/work-state';
import { invalidateRemoteUrlsCache } from '../../src/main/git/git-remotes';

let root: string;
let checkout: string;

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(name: string): void {
  fs.writeFileSync(path.join(checkout, name), name);
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', name);
}

/** A clone of a bare origin on `main`, with a task branch cut from `origin/main` (so it tracks it). */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-work-remotes-'));
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

const read = (extra: { pushedBranch?: string; baseBranch?: string } = {}) => readGitWorkDetail({
  projectPath: checkout, baseBranch: 'main', ...extra,
});

describe('a base written as a remote-tracking name', () => {
  it('reads the checkout of that branch as on the base', async () => {
    git(checkout, 'checkout', '-q', 'main');
    commit('direct');
    expect(await read({ baseBranch: 'origin/main' })).toMatchObject({ onBaseBranch: true, aheadOfBaseCount: 0, pushTarget: 'main' });
  });

  it('never takes the branch it tracks for where a task branch was published', async () => {
    commit('one');
    expect(git(checkout, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main');
    expect(await read({ baseBranch: 'origin/main' })).toMatchObject({ onBaseBranch: false, pushTarget: null });
  });
});

describe('the pushed branch a task remembers', () => {
  it('is ignored when it is the base', async () => {
    commit('one');
    expect((await read({ pushedBranch: 'main' })).pushTarget).toBeNull();
  });

  it('is dropped when it is shaped like an option, even where a remote ref of that name exists', async () => {
    commit('one');
    git(checkout, 'push', '-q', 'origin', 'HEAD:task-branch');
    git(checkout, 'update-ref', 'refs/remotes/origin/-evil', 'HEAD');
    expect((await read({ pushedBranch: '-evil' })).pushTarget).toBe('task-branch');
  });

  it('wins over the branch\'s own name when both are on the remote', async () => {
    commit('one');
    git(checkout, 'push', '-q', 'origin', 'HEAD:task-branch');
    git(checkout, 'push', '-q', 'origin', 'HEAD:renamed');
    expect((await read()).pushTarget).toBe('task-branch');
    expect((await read({ pushedBranch: 'renamed' })).pushTarget).toBe('renamed');
  });
});

describe('the base work is counted against', () => {
  it('falls back to the local base when the remote has none', async () => {
    git(checkout, 'branch', 'local-only', 'main');
    commit('one');
    commit('two');
    expect(git(checkout, 'branch', '-r', '--list', 'origin/local-only')).toBe('');
    expect((await read({ baseBranch: 'local-only' })).aheadOfBaseCount).toBe(2);
  });

  it('prefers the remote\'s copy of the base over a local one that is behind', async () => {
    git(checkout, 'branch', 'stale', 'main');
    commit('one');
    git(checkout, 'push', '-q', 'origin', 'HEAD:stale');
    commit('two');
    // origin/stale holds `one`, so only `two` is ahead of it; the local `stale` is at the base, which would count two.
    expect((await read({ baseBranch: 'stale' })).aheadOfBaseCount).toBe(1);
  });
});

describe('a remote whose name holds another remote\'s', () => {
  it('owns an upstream under its own name, not the shorter remote', async () => {
    git(root, 'init', '-q', '--bare', '-b', 'main', 'fork.git');
    // `git remote add` refuses a name inside another's, but a config file can hold one.
    git(checkout, 'config', 'remote.origin/fork.url', path.join(root, 'fork.git'));
    git(checkout, 'config', 'remote.origin/fork.fetch', '+refs/heads/*:refs/remotes/origin/fork/*');
    invalidateRemoteUrlsCache();
    commit('one');
    git(checkout, 'push', '-q', '-u', 'origin/fork', 'HEAD:topic');
    expect(git(checkout, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/fork/topic');
    expect(await read()).toMatchObject({ pushRemote: 'origin/fork', pushTarget: 'topic' });
  });
});
