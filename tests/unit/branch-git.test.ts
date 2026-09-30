/**
 * Which branch the memory index reads: any repository with a commit has one.
 * Real repositories under the OS temp directory, driven by the real git, since
 * the order of the fallbacks and how each is named are the whole behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listTree, parseBatch, parseRefList, parseTree, readBlobs, readBranchHead } from '../../src/main/retrieval/branch-git';

let root = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A repository whose first branch is `branch`, with one commit unless `empty`. */
function repository(name: string, branch: string, empty = false): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q', '-b', branch);
  if (!empty) {
    fs.writeFileSync(path.join(directory, 'readme.md'), `# ${name}\n`);
    git(directory, 'add', '.');
    git(directory, 'commit', '-q', '-m', 'first');
  }
  return directory;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-branch-git-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readBranchHead', () => {
  it('reads the base branch when the project has it', async () => {
    const directory = repository('with-main', 'main');
    const head = await readBranchHead(directory, 'main');
    expect(head).toEqual({ ref: 'main', sha: git(directory, 'rev-parse', 'HEAD') });
  });

  it('prefers the base on origin, then the remote\'s own default when the base is missing', async () => {
    const upstream = repository('upstream-trunk', 'trunk');
    execFileSync('git', ['clone', '-q', upstream, path.join(root, 'clone-trunk')]);
    const clone = path.join(root, 'clone-trunk');

    // No main anywhere: origin/HEAD, named by the branch it points to.
    expect(await readBranchHead(clone, 'main')).toEqual({ ref: 'origin/trunk', sha: git(upstream, 'rev-parse', 'HEAD') });
    // The base itself on origin wins over the local branch of the same name.
    expect((await readBranchHead(clone, 'trunk'))?.ref).toBe('origin/trunk');
  });

  it('falls back to the checked-out branch in a repository with no main and no remote', async () => {
    const directory = repository('only-master', 'master');
    expect(await readBranchHead(directory, 'main')).toEqual({ ref: 'master', sha: git(directory, 'rev-parse', 'HEAD') });
  });

  it('reads nothing where nothing is committed, or there is no repository', async () => {
    expect(await readBranchHead(repository('fresh-init', 'main', true), 'main')).toBeNull();
    const plain = path.join(root, 'plain-folder');
    fs.mkdirSync(plain);
    expect(await readBranchHead(plain, 'main')).toBeNull();
  });
});

describe('parseRefList', () => {
  it('keys refs by their exact name, so a branch below the base is not the base', () => {
    const refs = parseRefList('refs/heads/main/wip\taaa\t\nrefs/remotes/origin/HEAD\tbbb\trefs/remotes/origin/master\n');
    expect(refs.get('refs/heads/main')).toBeUndefined();
    expect(refs.get('refs/heads/main/wip')).toEqual({ sha: 'aaa', symref: '' });
    expect(refs.get('refs/remotes/origin/HEAD')).toEqual({ sha: 'bbb', symref: 'refs/remotes/origin/master' });
  });
});

describe('parseTree', () => {
  const blob = 'a'.repeat(40);
  const otherBlob = 'b'.repeat(40);
  const submodule = 'c'.repeat(40);

  it('reads the blobs of `git ls-tree -r -l -z`, padded sizes included, and skips a submodule', () => {
    const stdout = [
      `100644 blob ${blob}     123\tsrc/main.ts`,
      `160000 commit ${submodule}       -\tvendor/library`,
      `100755 blob ${otherBlob}       0\tscripts/empty.sh`,
    ].map((record) => `${record}\0`).join('');

    expect(parseTree(stdout)).toEqual([
      { path: 'src/main.ts', blob, size: 123 },
      { path: 'scripts/empty.sh', blob: otherBlob, size: 0 },
    ]);
  });

  it('keeps a path exactly as git wrote it: -z never quotes, so a tab or newline is part of the name', () => {
    const stdout = `100644 blob ${blob}      42\tdocs/odd\tname\nfile.md\0`;
    expect(parseTree(stdout)).toEqual([{ path: 'docs/odd\tname\nfile.md', blob, size: 42 }]);
  });

  it('reads nothing from empty output or a stray terminator', () => {
    expect(parseTree('')).toEqual([]);
    expect(parseTree('\0')).toEqual([]);
  });
});

describe('parseBatch', () => {
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);
  const third = '3'.repeat(40);
  const fourth = '4'.repeat(40);
  const fifth = '5'.repeat(40);
  const sixth = '6'.repeat(40);

  /** One object as `git cat-file --batch` prints it: header, content, a newline. */
  function object(sha: string, content: Buffer): Buffer {
    return Buffer.concat([Buffer.from(`${sha} blob ${content.length}\n`), content, Buffer.from('\n')]);
  }

  it('reads each object by its declared size, and leaves out a missing one between real ones', () => {
    const output = Buffer.concat([
      object(first, Buffer.from('hello\nworld')),
      Buffer.from(`${second} missing\n`),
      object(third, Buffer.alloc(0)),
      object(fourth, Buffer.from([0xff, 0x00, 0x0a])),
    ]);

    const contents = parseBatch(output);

    expect([...contents.keys()]).toEqual([first, third, fourth]);
    expect(contents.get(first)?.toString('utf8')).toBe('hello\nworld');
    expect(contents.get(third)?.length).toBe(0);
    expect([...(contents.get(fourth) ?? [])]).toEqual([0xff, 0x00, 0x0a]);
  });

  it('never reads content that looks like a header as one', () => {
    const lookalike = Buffer.from(`${sixth} blob 2\nxx\n${second} missing`);
    const contents = parseBatch(Buffer.concat([object(fifth, lookalike), object(first, Buffer.from('after'))]));

    expect([...contents.keys()]).toEqual([fifth, first]);
    expect(contents.get(fifth)?.toString('utf8')).toBe(lookalike.toString('utf8'));
    expect(contents.get(first)?.toString('utf8')).toBe('after');
  });

  it('reads nothing from empty output', () => {
    expect(parseBatch(Buffer.alloc(0)).size).toBe(0);
  });
});

describe('listTree and readBlobs', () => {
  it('round-trips a real tree: a path git would quote, CRLF, an empty file, binary, and an object that is not there', async () => {
    const directory = repository('tree-round-trip', 'main');
    const files = new Map<string, Buffer>([
      ['docs/my notes.md', Buffer.from('# Notes\n\nline two\n')],
      ['src/naïve.ts', Buffer.from('export const naive = 1;\r\nexport const two = 2;\n')],
      ['empty.txt', Buffer.alloc(0)],
      ['assets/blob.bin', Buffer.from([0x00, 0xff, 0x0a, 0x0a, 0x00])],
      // A payload shaped like the next object's header must stay content.
      ['trick.txt', Buffer.from(`${'d'.repeat(40)} missing\n${'e'.repeat(40)} blob 3\nabc\n`)],
    ]);
    for (const [name, content] of files) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.writeFileSync(path.join(directory, name), content);
    }
    git(directory, 'add', '.');
    git(directory, 'commit', '-q', '-m', 'files');
    const head = git(directory, 'rev-parse', 'HEAD');

    const entries = await listTree(directory, head);

    // Every path once, spelled as on disk; the blob id is git's own answer for that path.
    expect(entries.map((entry) => entry.path).sort()).toEqual([...files.keys(), 'readme.md'].sort());
    for (const [name, content] of files) {
      const entry = entries.find((candidate) => candidate.path === name);
      expect(entry?.blob, name).toBe(git(directory, 'rev-parse', `${head}:${name}`));
      expect(entry?.size, name).toBe(content.length);
    }

    const notThere = '0'.repeat(40);
    const contents = await readBlobs(directory, [...entries.map((entry) => entry.blob), notThere, 'not-an-object']);

    expect(contents.size).toBe(entries.length);
    expect(contents.has(notThere)).toBe(false);
    expect(contents.has('not-an-object')).toBe(false);
    for (const [name, content] of files) {
      const blob = entries.find((candidate) => candidate.path === name)!.blob;
      expect(Buffer.compare(contents.get(blob) ?? Buffer.from('missing'), content), name).toBe(0);
    }
  });

  it('starts no process for nothing to read', async () => {
    const contents = await readBlobs(path.join(root, 'no-such-directory'), []);
    expect(contents.size).toBe(0);
  });
});
