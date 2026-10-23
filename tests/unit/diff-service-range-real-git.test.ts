/**
 * DiffService's fixed-range reads (`range: { base, head }`) and the remote
 * presence check behind History's commit links, against a real repository.
 *
 * A range is a completed task's whole change, read from commits alone: it must
 * ignore the working tree entirely (a completed task's view must never show
 * whatever the checkout happens to hold), read both file sides from git, and
 * refuse anything that is not a full hash before git sees it.
 *
 * Runs the real `git` binary against temp directories, as
 * diff-service-image-real-git.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DiffService, EMPTY_TREE_HASH } from '../../src/main/git/diff-service';
import { commitsMissingFromRemotes } from '../../src/main/git/remote-presence';
import type { GitImageSide } from '../../src/shared/types';

let repository: string;
let remote: string;

function run(args: string[], cwd = repository): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

function writeFile(relativePath: string, content: string | Buffer): void {
  const absolutePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

/** Starts like a PNG and holds a NUL byte, so git treats it as binary and never converts line endings. */
function imageBytes(marker: number, length: number): Buffer {
  const bytes = Buffer.alloc(length, marker);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).copy(bytes);
  return bytes;
}

function bytesOf(side: GitImageSide | null): Buffer {
  if (side === null || side.kind !== 'bytes') throw new Error(`expected a bytes side, got ${side === null ? 'null' : side.kind}`);
  return Buffer.from(side.bytes);
}

function commitAll(message: string): string {
  run(['add', '-A']);
  run(['commit', '-q', '-m', message]);
  return run(['rev-parse', 'HEAD']);
}

let rootCommit: string;
let firstTaskCommit: string;
let lastTaskCommit: string;

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-range-diff-'));
  remote = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-range-remote-'));
  run(['init', '-q', '--bare'], remote);
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'dev@example.com']);
  run(['config', 'user.name', 'Dev']);
  run(['config', 'core.autocrlf', 'false']);
  run(['config', 'commit.gpgsign', 'false']);
  writeFile('src/app.ts', 'one\ntwo\nthree\n');
  writeFile('docs/old-name.md', 'unchanged text\n');
  rootCommit = commitAll('root');
  writeFile('src/app.ts', 'one\nTWO\nthree\nfour\n');
  firstTaskCommit = commitAll('task: first');
  writeFile('src/new.ts', 'added\n');
  run(['mv', 'docs/old-name.md', 'docs/new-name.md']);
  lastTaskCommit = commitAll('task: second');
});

afterEach(() => {
  // Retries: on Windows a handle the just-exited git process held a beat
  // longer surfaces as EBUSY/EPERM, which `force` does not cover.
  fs.rmSync(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('DiffService range reads', () => {
  it('lists the files and totals between the two commits', async () => {
    const service = new DiffService(repository);
    const result = await service.getDiffFiles({ projectPath: repository, baseBranch: 'main', range: { base: rootCommit, head: lastTaskCommit } });
    const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
    expect(byPath['src/app.ts']).toMatchObject({ status: 'M', insertions: 2, deletions: 1 });
    expect(byPath['src/new.ts']).toMatchObject({ status: 'A', insertions: 1, deletions: 0 });
    expect(byPath['docs/new-name.md']).toMatchObject({ status: 'R', oldPath: 'docs/old-name.md' });
    expect(result.totalInsertions).toBe(3);
    expect(result.totalDeletions).toBe(1);
  });

  // The whole point of a range: a completed task's view must not show the
  // checkout's own uncommitted or untracked files.
  it('ignores the working tree, tracked edits and untracked files alike', async () => {
    writeFile('src/app.ts', 'something else entirely\n');
    writeFile('scratch/untracked.txt', 'not committed\n');
    const service = new DiffService(repository);
    const result = await service.getDiffFiles({ projectPath: repository, baseBranch: 'main', range: { base: rootCommit, head: lastTaskCommit } });
    expect(result.files.map((file) => file.path).sort()).toEqual(['docs/new-name.md', 'src/app.ts', 'src/new.ts']);
    const content = await service.getFileContent({
      projectPath: repository, baseBranch: 'main', filePath: 'src/app.ts', status: 'M', range: { base: rootCommit, head: lastTaskCommit },
    });
    expect(content.original).toBe('one\ntwo\nthree\n');
    expect(content.modified).toBe('one\nTWO\nthree\nfour\n');
  });

  it('reads a renamed file\'s left side from its old path', async () => {
    const service = new DiffService(repository);
    const content = await service.getFileContent({
      projectPath: repository, baseBranch: 'main', filePath: 'docs/new-name.md', oldPath: 'docs/old-name.md', status: 'R',
      range: { base: rootCommit, head: lastTaskCommit },
    });
    expect(content.original).toBe('unchanged text\n');
    expect(content.modified).toBe('unchanged text\n');
  });

  it('accepts the empty tree as the base, for a range that starts at a root commit', async () => {
    const service = new DiffService(repository);
    const result = await service.getDiffFiles({ projectPath: repository, baseBranch: 'main', range: { base: EMPTY_TREE_HASH, head: firstTaskCommit } });
    expect(result.files.map((file) => file.path).sort()).toEqual(['docs/old-name.md', 'src/app.ts']);
    expect(result.files.every((file) => file.status === 'A')).toBe(true);
  });

  it('refuses a range end that is not a full hash, before git sees it', async () => {
    const service = new DiffService(repository);
    await expect(service.getDiffFiles({ projectPath: repository, baseBranch: 'main', range: { base: 'main', head: lastTaskCommit } })).rejects.toThrow();
    await expect(service.getDiffFiles({ projectPath: repository, baseBranch: 'main', range: { base: rootCommit, head: '--output=x' } })).rejects.toThrow();
    const content = await service.getFileContent({
      projectPath: repository, baseBranch: 'main', filePath: 'src/app.ts', status: 'M', range: { base: rootCommit.slice(0, 7), head: lastTaskCommit },
    });
    expect(content).toMatchObject({ original: '', modified: '' });
  });

  // A commit id reached `git diff` unchecked before; an option-shaped one must be refused.
  it('refuses an option-shaped commit id', async () => {
    const service = new DiffService(repository);
    await expect(service.getDiffFiles({ projectPath: repository, baseBranch: 'main', commitOid: '--output=x' })).rejects.toThrow();
  });
});

// An image changed over a range. The same path holds a different image at every
// point a wrong read could land on, so each wrong source is told apart by bytes
// (and by length: different sizes keep git's racy same-size `add` skip out):
//   range base -> IMAGE_BASE      range head -> IMAGE_HEAD
//   HEAD / main (a later commit, also the merge base the branch scope falls back to) -> IMAGE_LATER
//   working tree (uncommitted) -> IMAGE_WORKING
describe('DiffService range image reads', () => {
  const IMAGE_PATH = 'img/a.png';
  const IMAGE_BASE = imageBytes(0x41, 32);
  const IMAGE_HEAD = imageBytes(0x42, 40);
  const IMAGE_LATER = imageBytes(0x43, 48);
  const IMAGE_WORKING = imageBytes(0x44, 56);
  let imageBaseCommit: string;
  let imageHeadCommit: string;

  beforeEach(() => {
    writeFile(IMAGE_PATH, IMAGE_BASE);
    imageBaseCommit = commitAll('image: base');
    writeFile(IMAGE_PATH, IMAGE_HEAD);
    imageHeadCommit = commitAll('image: head');
    writeFile(IMAGE_PATH, IMAGE_LATER);
    commitAll('image: later, past the range');
    writeFile(IMAGE_PATH, IMAGE_WORKING);
  });

  it('reads the base side and the head side from the two commits, not from the checkout', async () => {
    const service = new DiffService(repository);

    const result = await service.getImageContent({
      projectPath: repository, baseBranch: 'main', filePath: IMAGE_PATH, status: 'M', range: { base: imageBaseCommit, head: imageHeadCommit },
    });

    expect(bytesOf(result.original).equals(IMAGE_BASE)).toBe(true);
    expect(bytesOf(result.modified).equals(IMAGE_HEAD)).toBe(true);
    expect(result.original).toMatchObject({ fingerprint: `blob:${run(['rev-parse', `${imageBaseCommit}:${IMAGE_PATH}`])}` });
    expect(result.modified).toMatchObject({ fingerprint: `blob:${run(['rev-parse', `${imageHeadCommit}:${IMAGE_PATH}`])}` });
  });

  // Each row hands git a revision that DOES resolve (a branch, an abbreviation,
  // or the valid other end), so a read that slipped past the guard would answer
  // with bytes instead of unreadable.
  it.each([
    ['a base that is a branch name', () => ({ base: 'main', head: imageHeadCommit })],
    ['a head that is an option', () => ({ base: imageBaseCommit, head: '--output=x' })],
    ['a base that is an abbreviated hash', () => ({ base: imageBaseCommit.slice(0, 7), head: imageHeadCommit })],
  ])('refuses %s, and no side is read', async (_label, rangeOf) => {
    const service = new DiffService(repository);

    const result = await service.getImageContent({
      projectPath: repository, baseBranch: 'main', filePath: IMAGE_PATH, status: 'M', range: rangeOf(),
    });

    expect(result).toEqual({ original: { kind: 'unreadable' }, modified: { kind: 'unreadable' } });
  });
});

describe('commitsMissingFromRemotes', () => {
  it('names only the listed commits no remote ref reaches', async () => {
    run(['remote', 'add', 'origin', remote]);
    run(['push', '-q', 'origin', `${firstTaskCommit}:refs/heads/main`]);
    run(['fetch', '-q', 'origin']);
    const missing = await commitsMissingFromRemotes(repository, [rootCommit, firstTaskCommit, lastTaskCommit]);
    expect(missing && [...missing]).toEqual([lastTaskCommit]);
  });

  it('is empty for an empty list and null when git fails', async () => {
    await expect(commitsMissingFromRemotes(repository, [])).resolves.toEqual(new Set());
    await expect(commitsMissingFromRemotes(path.join(repository, 'no-such-dir'), [rootCommit])).resolves.toBeNull();
  });
});
