/**
 * readGitObject (src/main/git/git-object-reader.ts) against a real repository:
 * one `git cat-file --batch` process answers the object id, the size and the
 * bytes, and stops at the header for a known id or an object over the cap.
 * The image reader in diff-service.ts mocks this module, so these tests are
 * what pins that git really answers each kind of name the way the mock does.
 *
 * Runs the real `git` binary against a temp directory, mirroring
 * diff-service-image-real-git.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseObjectHeader, readGitObject } from '../../src/main/git/git-object-reader';

/** The empty tree object every repository has: the "parent" a root commit is diffed against. */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NO_CAP = 1024 * 1024;

/** Starts like a PNG and holds NUL bytes, so git treats it as binary and the bytes must come back untouched. */
const IMAGE_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), Buffer.alloc(40, 0x2a)]);

let repository: string;

function run(args: string[]): string {
  return execFileSync('git', args, { cwd: repository, windowsHide: true }).toString().trim();
}

function writeFile(relativePath: string, bytes: Buffer): void {
  const absolutePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-object-reader-'));
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'dev@example.com']);
  run(['config', 'user.name', 'Dev']);
  run(['config', 'core.autocrlf', 'false']);
  run(['config', 'commit.gpgsign', 'false']);
  writeFile('img/a.png', IMAGE_BYTES);
  writeFile('img/with space.png', IMAGE_BYTES);
  writeFile('img/empty.png', Buffer.alloc(0));
  run(['add', '-A']);
  run(['commit', '-m', 'add the images']);
});

afterEach(async () => {
  await fs.promises.rm(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('readGitObject against a real repository', () => {
  it('reads a commit spec and an index spec to the exact bytes and the blob id rev-parse reports', async () => {
    const commit = run(['rev-parse', 'HEAD']);

    const fromCommit = await readGitObject(repository, `${commit}:img/a.png`, { maxBytes: NO_CAP });
    const fromIndex = await readGitObject(repository, ':img/a.png', { maxBytes: NO_CAP });

    const blobId = run(['rev-parse', ':img/a.png']);
    expect(fromCommit).toEqual({ kind: 'blob', objectId: blobId, bytes: IMAGE_BYTES });
    expect(fromIndex).toEqual({ kind: 'blob', objectId: blobId, bytes: IMAGE_BYTES });
  });

  it('reads a path holding a space: the whole input line is the name', async () => {
    const read = await readGitObject(repository, 'HEAD:img/with space.png', { maxBytes: NO_CAP });

    expect(read.kind).toBe('blob');
  });

  it('answers unchanged for the id the caller holds', async () => {
    const blobId = run(['rev-parse', 'HEAD:img/a.png']);

    const read = await readGitObject(repository, 'HEAD:img/a.png', { knownObjectId: blobId, maxBytes: NO_CAP });

    expect(read).toEqual({ kind: 'unchanged', objectId: blobId });
  });

  it('answers too-large with the exact size over the cap, and still reads an object of exactly the cap', async () => {
    const overCap = await readGitObject(repository, 'HEAD:img/a.png', { maxBytes: IMAGE_BYTES.length - 1 });
    const atCap = await readGitObject(repository, 'HEAD:img/a.png', { maxBytes: IMAGE_BYTES.length });

    expect(overCap).toEqual({ kind: 'too-large', objectId: run(['rev-parse', 'HEAD:img/a.png']), size: IMAGE_BYTES.length });
    expect(atCap.kind).toBe('blob');
  });

  it('reads an empty file as an empty blob', async () => {
    const read = await readGitObject(repository, 'HEAD:img/empty.png', { maxBytes: NO_CAP });

    expect(read).toEqual({ kind: 'blob', objectId: run(['rev-parse', 'HEAD:img/empty.png']), bytes: Buffer.alloc(0) });
  });

  it('answers missing for a path git does not have, a root commit\'s empty-tree parent, a directory, and a name with a line break', async () => {
    for (const objectName of ['HEAD:img/none.png', `${EMPTY_TREE_HASH}:img/a.png`, 'HEAD:img', 'HEAD:img/a.png\nHEAD:img/a.png']) {
      expect(await readGitObject(repository, objectName, { maxBytes: NO_CAP })).toEqual({ kind: 'missing' });
    }
  });

  it('hands back bytes in a buffer of their own, never a slice of a shared pool', async () => {
    // Electron's IPC clones the whole buffer behind a view, so a pooled slice
    // would carry unrelated bytes to the renderer.
    const read = await readGitObject(repository, 'HEAD:img/a.png', { maxBytes: NO_CAP });

    if (read.kind !== 'blob') throw new Error(`expected a blob, got ${read.kind}`);
    expect(read.bytes.byteOffset).toBe(0);
    expect(read.bytes.buffer.byteLength).toBe(IMAGE_BYTES.length);
  });

  it('rejects when git itself fails: a directory that is not a repository', async () => {
    const notARepository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-not-a-repository-'));
    try {
      await expect(readGitObject(notARepository, 'HEAD:img/a.png', { maxBytes: NO_CAP })).rejects.toThrow(/exited/);
    } finally {
      await fs.promises.rm(notARepository, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe('parseObjectHeader', () => {
  it('reads an object header, for SHA-1 and SHA-256 ids', () => {
    expect(parseObjectHeader(`${'a'.repeat(40)} blob 1234`)).toEqual({ kind: 'object', objectId: 'a'.repeat(40), type: 'blob', size: 1234 });
    expect(parseObjectHeader(`${'b'.repeat(64)} tree 0`)).toEqual({ kind: 'object', objectId: 'b'.repeat(64), type: 'tree', size: 0 });
  });

  it('reads a missing or ambiguous answer, including for a name that holds spaces', () => {
    expect(parseObjectHeader('HEAD:img/none.png missing')).toEqual({ kind: 'missing' });
    expect(parseObjectHeader('HEAD:img/with space.png missing')).toEqual({ kind: 'missing' });
    expect(parseObjectHeader('abc ambiguous')).toEqual({ kind: 'missing' });
  });

  it('refuses a header it does not recognise rather than guessing a size', () => {
    // The case the old `cat-file -s` reader guarded with Number.isFinite.
    expect(parseObjectHeader(`${'a'.repeat(40)} blob not-a-number`)).toBeNull();
    expect(parseObjectHeader('short blob 12')).toBeNull();
    expect(parseObjectHeader('')).toBeNull();
  });
});
