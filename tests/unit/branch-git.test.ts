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
import { parseRefList, readBranchHead } from '../../src/main/retrieval/branch-git';

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
