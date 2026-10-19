/**
 * `gitAt` (src/main/git/git-client.ts) runs the task lifecycle's git commands
 * through `execFileAsync`, so with a pty host registered the child starts there
 * and not on main, where simple-git started it.
 *
 * Pinned in two halves:
 * - Routing: every method goes to the registered executor as an execFile of
 *   `git` with the directory as cwd and an output cap far past execFile's
 *   1 MiB default, and nothing runs here.
 * - Parity: against real repositories, each method gives what simple-git gave
 *   for the same command, including simple-git's success rule (a non-zero exit
 *   fails only when stderr has text) and its error message (stdout then
 *   stderr). simple-git stays a dependency for the panels, so it is the oracle.
 *
 * Tier: Unit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import simpleGit from 'simple-git';
import { gitAt, GIT_OUTPUT_MAX_BUFFER, parseDiffStatSummary, parseStatusSummary } from '../../src/main/git/git-client';
import { setOffMainExecutor, type OffMainExecutor } from '../../src/main/utility-process/off-main-exec';

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-git-client-'));
});

afterAll(async () => {
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

describe('gitAt routing', () => {
  afterEach(() => {
    setOffMainExecutor(null);
  });

  it('runs every command in the registered host, as an execFile of git in the directory', async () => {
    const executor = vi.fn<OffMainExecutor>(async () => ({ ok: true, stdout: '  abc123\n', stderr: '' }));
    setOffMainExecutor(executor);
    const client = gitAt(workspace);

    await client.raw(['worktree', 'add', '-b', 'feature', path.join(workspace, 'wt'), 'origin/main']);
    await client.revparse(['--abbrev-ref', 'HEAD']);
    await client.status();
    await client.diffSummary(['abc123']);
    await client.diff(['--name-status', 'abc123']);
    await client.show(['HEAD:README.md']);
    await client.checkout('feature');
    await client.merge(['origin/main', '--ff-only']);

    const requests = executor.mock.calls.map(([request]) => request);
    expect(requests.map((request) => (request.kind === 'execFile' ? [request.file, ...request.args] : []))).toEqual([
      ['git', 'worktree', 'add', '-b', 'feature', path.join(workspace, 'wt'), 'origin/main'],
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['git', 'status', '--porcelain', '-b', '-u', '--null'],
      ['git', 'diff', '--stat=4096', 'abc123'],
      ['git', 'diff', '--name-status', 'abc123'],
      ['git', 'show', 'HEAD:README.md'],
      ['git', 'checkout', 'feature'],
      ['git', 'merge', 'origin/main', '--ff-only'],
    ]);
    for (const request of requests) {
      expect(request.options).toMatchObject({ cwd: workspace, windowsHide: true, maxBuffer: GIT_OUTPUT_MAX_BUFFER });
    }
    expect(GIT_OUTPUT_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });

  it('resolves with stdout when git exits non-zero with nothing on stderr, as simple-git did', async () => {
    setOffMainExecutor(async () => ({
      ok: false,
      error: { message: 'Command failed: git config --get checkout.workers', exitCode: 1, killed: false, signal: null, stdout: '', stderr: '' },
    }));

    await expect(gitAt(workspace).raw(['config', '--get', 'checkout.workers'])).resolves.toBe('');
  });

  it('rejects a non-zero exit with stderr, with stdout then stderr as the message', async () => {
    // "Worktree setup failed: <first line>" is built from this message.
    setOffMainExecutor(async () => ({
      ok: false,
      error: {
        message: 'Command failed: git worktree add',
        exitCode: 128,
        killed: false,
        signal: null,
        stdout: 'Preparing worktree (new branch \'feature\')\n',
        stderr: 'fatal: a branch named \'feature\' already exists\n',
      },
    }));

    await expect(gitAt(workspace).raw(['worktree', 'add', '-b', 'feature', 'wt']))
      .rejects.toThrow(/^Preparing worktree \(new branch 'feature'\)\nfatal: a branch named 'feature' already exists\n$/);
  });

  it('rejects with the error itself when git could not start', async () => {
    setOffMainExecutor(async () => ({
      ok: false,
      error: { message: 'spawn git ENOENT', code: 'ENOENT', exitCode: null, killed: false, signal: null, stdout: '', stderr: '' },
    }));

    await expect(gitAt(workspace).raw(['status'])).rejects.toThrow('spawn git ENOENT');
  });

  it('throws at once for a directory that does not exist, as simpleGit() did', () => {
    const executor = vi.fn<OffMainExecutor>();
    setOffMainExecutor(executor);

    expect(() => gitAt(path.join(workspace, 'missing'))).toThrow('Cannot use simple-git on a directory that does not exist');
    expect(executor).not.toHaveBeenCalled();
  });

  it('refuses a diff format flag, since it parses the --stat format only', async () => {
    setOffMainExecutor(async () => ({ ok: true, stdout: '', stderr: '' }));

    await expect(gitAt(workspace).diffSummary(['--numstat', 'HEAD'])).rejects.toThrow('default --stat format only');
  });
});

describe('gitAt parity with simple-git on a real repository', () => {
  let repository: string;

  beforeAll(() => {
    repository = path.join(workspace, 'parity');
    fs.mkdirSync(repository);
    run(repository, ['init', '-b', 'main']);
    run(repository, ['config', 'user.email', 'dev@example.com']);
    run(repository, ['config', 'user.name', 'Dev']);
    run(repository, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(repository, 'kept.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repository, 'renamed-from.txt'), 'rename me\nplease\nnow\n');
    fs.writeFileSync(path.join(repository, 'deleted.txt'), 'gone soon\n');
    fs.writeFileSync(path.join(repository, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(repository, ['add', '-A']);
    run(repository, ['commit', '-m', 'base']);

    // A branch with every kind of change the churn capture and the checkout
    // guard read: text edits, a binary edit, a rename, a delete, a staged add,
    // an unstaged edit, and untracked files (one in a new folder).
    fs.writeFileSync(path.join(repository, 'kept.txt'), 'one\n2\nthree\nfour\nfive\n');
    fs.writeFileSync(path.join(repository, 'image.bin'), Buffer.from([0, 9, 9, 9, 0, 255, 7]));
    run(repository, ['mv', 'renamed-from.txt', 'renamed-to.txt']);
    run(repository, ['rm', '-q', 'deleted.txt']);
    run(repository, ['add', '-A']);
    run(repository, ['commit', '-m', 'work']);
    fs.writeFileSync(path.join(repository, 'staged.txt'), 'new\n');
    run(repository, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(repository, 'kept.txt'), 'one\n2\nthree\nfour\nfive\nsix\n');
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'u\n');
    fs.mkdirSync(path.join(repository, 'folder with space'));
    fs.writeFileSync(path.join(repository, 'folder with space', 'inner.txt'), 'i\n');
    run(repository, ['mv', 'renamed-to.txt', 'renamed-again.txt']);
  });

  it('parses status as simple-git does: every entry, renames with their source, and the untracked paths', async () => {
    const ours = await gitAt(repository).status();
    const theirs = await simpleGit(repository).status();

    const plain = (files: ReadonlyArray<{ path: string; index: string; working_dir: string; from?: string }>) => files.map((file) => ({
      path: file.path,
      index: file.index,
      working_dir: file.working_dir,
      ...(file.from !== undefined ? { from: file.from } : {}),
    }));
    expect(plain(ours.files)).toEqual(plain(theirs.files));
    expect(ours.not_added).toEqual(theirs.not_added);
    // Not vacuous: the fixture produced a rename, a staged add and untracked files.
    expect(ours.files.some((file) => file.index === 'R' && file.from === 'renamed-to.txt')).toBe(true);
    expect(ours.not_added.length).toBeGreaterThanOrEqual(2);
  });

  it('parses diff --stat as simple-git does, binary files included', async () => {
    const base = run(repository, ['rev-parse', 'HEAD~1']).trim();
    for (const args of [[base], ['--cached'], [], [base, 'HEAD']]) {
      const ours = await gitAt(repository).diffSummary(args);
      const theirs = await simpleGit(repository).diffSummary(args);
      expect({ changed: ours.changed, insertions: ours.insertions, deletions: ours.deletions, files: ours.files })
        .toEqual({ changed: theirs.changed, insertions: theirs.insertions, deletions: theirs.deletions, files: theirs.files });
    }
    const branchDiff = await gitAt(repository).diffSummary([base]);
    expect(branchDiff.files.some((file) => file.binary)).toBe(true);
  });

  it('gives what simple-git gives for raw, revparse, diff and show, and the same failure message', async () => {
    const ours = gitAt(repository);
    const theirs = simpleGit(repository);

    expect(await ours.revparse(['--abbrev-ref', 'HEAD'])).toBe(await theirs.revparse(['--abbrev-ref', 'HEAD']));
    expect(await ours.raw(['rev-parse', 'HEAD'])).toBe(await theirs.raw(['rev-parse', 'HEAD']));
    expect(await ours.diff(['--name-status', 'HEAD~1'])).toBe(await theirs.diff(['--name-status', 'HEAD~1']));
    expect(await ours.show(['HEAD:kept.txt'])).toBe(await theirs.show(['HEAD:kept.txt']));
    // Exit 1 with an empty stderr: both resolve.
    expect(await ours.raw(['config', '--get', 'no.such.key'])).toBe(await theirs.raw(['config', '--get', 'no.such.key']));
    expect(await ours.raw(['rev-parse', '--verify', '--quiet', 'no-such-branch'])).toBe('');
    // Exit 128 with stderr: both reject, with the same message.
    const ourFailure = await ours.raw(['rev-parse', '--verify', 'no-such-branch']).catch((error: Error) => error.message);
    const theirFailure = await theirs.raw(['rev-parse', '--verify', 'no-such-branch']).catch((error: Error) => error.message);
    expect(ourFailure).toBe(theirFailure);
    expect(ourFailure).toMatch(/fatal/);
  });
});

describe('the parsers on fixed output', () => {
  it('reads a stat graph and the totals line the way simple-git does', () => {
    const summary = parseDiffStatSummary([
      ' src/a.ts        | 3 ++-',
      ' docs/{old => new}.md | 0',
      ' assets/logo.png | Bin 10 -> 12 bytes',
      ' 3 files changed, 2 insertions(+), 1 deletion(-)',
      '',
    ].join('\n'));

    expect(summary).toEqual({
      changed: 3,
      insertions: 2,
      deletions: 1,
      files: [
        { file: 'src/a.ts', changes: 3, insertions: 2, deletions: 1, binary: false },
        { file: 'docs/{old => new}.md', changes: 0, insertions: 0, deletions: 0, binary: false },
        { file: 'assets/logo.png', before: 10, after: 12, binary: true },
      ],
    });
  });

  it('reads a status record list, joining a rename to its source and skipping the branch line', () => {
    const summary = parseStatusSummary(['## main...origin/main', 'R  new.txt', 'old.txt', ' M edited.txt', '?? fresh.txt', ''].join('\0'));

    expect(summary.files).toEqual([
      { path: 'new.txt', index: 'R', working_dir: ' ', from: 'old.txt' },
      { path: 'edited.txt', index: ' ', working_dir: 'M' },
      { path: 'fresh.txt', index: '?', working_dir: '?' },
    ]);
    expect(summary.not_added).toEqual(['fresh.txt']);
  });
});
