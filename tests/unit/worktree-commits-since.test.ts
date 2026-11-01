/**
 * The commits an isolated column's session added, as its return recap lists
 * them (`readCommitsSince`, src/main/git/worktree-head.ts, task #952). Real
 * repositories under the OS temp directory, driven by the real git, since the
 * range, the first-parent walk, the limit and the order are the behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCommitsSince } from '../../src/main/git/worktree-head';

/** The developer's own git config stays out: a global `commit.gpgsign` or `core.hooksPath` would fail a commit here. */
const GIT_ISOLATION = [
  '-c', 'user.name=dev', '-c', 'user.email=dev@example.com', '-c', 'core.autocrlf=false',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=',
];

let repository = '';

function git(...args: string[]): string {
  return execFileSync('git', [...GIT_ISOLATION, ...args], { cwd: repository, encoding: 'utf8', timeout: 30_000 }).trim();
}

let commitCount = 0;

/** A commit of its own file, so branches merge without a conflict. */
function commit(subject: string): string {
  commitCount += 1;
  fs.writeFileSync(path.join(repository, `note-${commitCount}.md`), `${subject}\n`);
  git('add', '.');
  git('commit', '-q', '-m', subject);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-commits-since-'));
  git('init', '-q', '-b', 'main');
});

afterEach(() => {
  fs.rmSync(repository, { recursive: true, force: true });
});

describe('readCommitsSince', () => {
  it('lists the commits after the start, oldest first, with HEAD now', async () => {
    const start = commit('first');
    commit('fix(review): drop the unused export');
    const head = commit('chore(review): record the pass');

    const result = await readCommitsSince(repository, start, 20);

    expect(result?.commits.map((entry) => entry.subject)).toEqual(['fix(review): drop the unused export', 'chore(review): record the pass']);
    expect(head.startsWith(result?.head ?? 'none')).toBe(true);
    expect(result?.omitted).toBe(0);
  });

  it('keeps the newest commits past the limit, oldest first, and counts the rest', async () => {
    const start = commit('first');
    for (const subject of ['one', 'two', 'three', 'four']) commit(subject);

    const result = await readCommitsSince(repository, start, 2);

    expect(result?.commits.map((entry) => entry.subject)).toEqual(['three', 'four']);
    expect(result?.omitted).toBe(2);
  });

  it('says no commits when HEAD has not moved', async () => {
    const start = commit('first');
    await expect(readCommitsSince(repository, start, 20)).resolves.toMatchObject({ commits: [], omitted: 0 });
  });

  it('reads a merge of the base branch as one commit, not everything the base gained', async () => {
    commit('first');
    git('checkout', '-q', '-b', 'task');
    const start = commit('task work');
    git('checkout', '-q', 'main');
    commit('main one');
    commit('main two');
    git('checkout', '-q', 'task');
    git('merge', '-q', '--no-ff', '-m', 'Merge main into task', 'main');

    const result = await readCommitsSince(repository, start, 20);

    expect(result?.commits.map((entry) => entry.subject)).toEqual(['Merge main into task']);
  });

  it('refuses a start that is not a plain object name, and answers null on a git error', async () => {
    commit('first');
    await expect(readCommitsSince(repository, '--output=x', 20)).resolves.toBeNull();
    await expect(readCommitsSince(repository, 'abcdef1234567', 20)).resolves.toBeNull();
    await expect(readCommitsSince(path.join(repository, 'missing'), 'abcdef1234567', 20)).resolves.toBeNull();
  });
});
