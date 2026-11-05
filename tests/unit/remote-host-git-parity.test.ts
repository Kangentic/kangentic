/**
 * The Changes panel's reads for a project on an SSH host give the answers a local project gives (#913).
 *
 * What a user loses if it breaks: a task on a host showing a different file list, line counts or file content
 * than its checkout holds, or a branch header that differs from `git`'s own.
 *
 * One real repository is read twice with the same real code: directly (a local project), and through the host
 * path (a stand-in folder here, `HostGit` over the real helper command runner with a POSIX shell and git). The
 * answers are compared. POSIX only: the host's scripts are `sh`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiffService } from '../../src/main/git/diff-service';
import { getBranchSummary } from '../../src/main/git/branch-summary';
import { createRemoteGitResolver } from '../../src/main/remote/host-git';
import { runHostCommand } from '../../src/main/remote/helper/host-command';
import { RemoteGitUnavailableError, setRemoteGitResolver } from '../../src/main/git/remote-git';
import { readWorktreeHeadUnqueued } from '../../src/main/git/worktree-head';
import { readGitObject } from '../../src/main/git/git-object-reader';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const hasShellAndGit = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  && spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasShellAndGit)('a project on a host reads as the same repository does locally', () => {
  let scratch: string;
  let home: string;
  let repo: string;
  let shell: string;
  let linkDown = false;

  function git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  }

  async function runOnHost(_hostId: string, request: HostCommandRequest): Promise<HostCommandResult> {
    if (linkDown) throw new Error('The link to the host is down.');
    return runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? repo, baseEnv: { ...process.env, HOME: home } });
  }

  beforeEach(() => {
    linkDown = false;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-parity-'));
    home = path.join(scratch, 'home');
    repo = path.join(home, 'api');
    // The shell folder here is empty, the stand-in for the repository on the host.
    shell = path.join(scratch, 'shell');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(shell, { recursive: true });
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const one = 1;\n');
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'logo.png'), randomBytes(5000));
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    git('checkout', '-q', '-b', 'feature');
    setRemoteGitResolver(createRemoteGitResolver({
      remoteProjects: () => [{ path: shell, remote: { hostId: 'host-a', path: repo } }],
      runCommand: runOnHost,
    }));
  });

  afterEach(() => {
    setRemoteGitResolver(null);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Edits, new files, a staged change and a big file: what a task's working tree holds. */
  function changeTheTree(): void {
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const one = 2;\nexport const two = 3;\n');
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'x\ny\nno newline at the end');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.concat([Buffer.from('head'), Buffer.alloc(10), randomBytes(200)]));
    fs.writeFileSync(path.join(repo, 'empty.txt'), '');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 's1\ns2\n');
    git('add', 'staged.txt');
    // Past one reply's first chunk and one frame, so pieces are pulled.
    fs.writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 40_000 }, (_unused, index) => `line ${index}`).join('\n'));
    fs.writeFileSync(path.join(repo, 'logo.png'), randomBytes(7000));
  }

  const filesInput = (directory: string, scope: 'working' | 'staged' | 'branch') => ({ baseBranch: 'main', scope, projectPath: directory, worktreePath: directory });

  it('lists the same changed files with the same counts, untracked ones included, in every scope', async () => {
    changeTheTree();
    for (const scope of ['working', 'staged', 'branch'] as const) {
      const local = await new DiffService(repo).getDiffFiles(filesInput(repo, scope));
      const remote = await new DiffService(shell).getDiffFiles(filesInput(shell, scope));
      expect(remote, `scope ${scope}`).toEqual(local);
    }
    const working = await new DiffService(shell).getDiffFiles(filesInput(shell, 'working'));
    expect(working.files.find((file) => file.path === 'new-file.txt')).toMatchObject({ status: 'U', insertions: 3, binary: false });
    expect(working.files.find((file) => file.path === 'blob.bin')).toMatchObject({ status: 'U', binary: true });
    expect(working.files.find((file) => file.path === 'empty.txt')).toMatchObject({ insertions: 0, binary: false });
  });

  it('shows the same file content on both sides, for a tracked change, an untracked file and one past a frame', async () => {
    changeTheTree();
    for (const [filePath, status] of [['src/app.ts', 'M'], ['new-file.txt', 'U'], ['big.txt', 'U'], ['notes.md', 'M']] as const) {
      const input = (directory: string) => ({ ...filesInput(directory, 'working'), filePath, status });
      const local = await new DiffService(repo).getFileContent(input(repo));
      const remote = await new DiffService(shell).getFileContent(input(shell));
      expect(remote, filePath).toEqual(local);
    }
    const big = await new DiffService(shell).getFileContent({ ...filesInput(shell, 'working'), filePath: 'big.txt', status: 'U' });
    expect(big.modified.length).toBeGreaterThan(256 * 1024);
  });

  it('shows an image as the same bytes, from the repository and from the working tree', async () => {
    changeTheTree();
    const input = (directory: string) => ({ ...filesInput(directory, 'working'), filePath: 'logo.png', status: 'M' as const });
    const local = await new DiffService(repo).getImageContent(input(repo));
    const remote = await new DiffService(shell).getImageContent(input(shell));
    expect(remote.original?.kind).toBe('bytes');
    expect(remote.modified?.kind).toBe('bytes');
    for (const side of ['original', 'modified'] as const) {
      const localSide = local[side];
      const remoteSide = remote[side];
      if (localSide?.kind !== 'bytes' || remoteSide?.kind !== 'bytes') throw new Error(`${side} is not bytes`);
      expect(Buffer.from(remoteSide.bytes).equals(Buffer.from(localSide.bytes))).toBe(true);
    }
    // A caller that holds the object id is told it is unchanged, and not sent the bytes again.
    const known = remote.original?.kind === 'bytes' ? remote.original.fingerprint : '';
    const again = await new DiffService(shell).getImageContent({ ...input(shell), knownFingerprints: { original: known } });
    expect(again.original?.kind).toBe('unchanged');
  });

  it('reads a name that is no file as missing, and a file over the cap as too large', async () => {
    const treeName = 'HEAD:src';
    expect(await readGitObject(shell, treeName, { maxBytes: 1000 })).toEqual({ kind: 'missing' });
    expect(await readGitObject(shell, 'HEAD:nothing-here', { maxBytes: 1000 })).toEqual({ kind: 'missing' });
    const tooLarge = await readGitObject(shell, 'HEAD:logo.png', { maxBytes: 100 });
    expect(tooLarge).toMatchObject({ kind: 'too-large', size: 5000 });
  });

  it('gives the branch header and the head git itself gives', async () => {
    fs.writeFileSync(path.join(repo, 'more.txt'), 'm\n');
    git('add', '.');
    git('commit', '-q', '-m', 'second');
    const local = await getBranchSummary({ projectPath: repo, baseBranch: 'main' });
    const remote = await getBranchSummary({ projectPath: shell, baseBranch: 'main' });
    expect(remote).toEqual(local);
    expect(remote).toMatchObject({ currentBranch: 'feature', ahead: 1, behind: 0 });
    expect(await readWorktreeHeadUnqueued(shell)).toEqual(await readWorktreeHeadUnqueued(repo));
  });

  it('rejects, rather than answering empty, when the host cannot be asked', async () => {
    changeTheTree();
    linkDown = true;
    await expect(getBranchSummary({ projectPath: shell, baseBranch: 'main' })).rejects.toBeInstanceOf(RemoteGitUnavailableError);
    await expect(new DiffService(shell).getDiffFiles(filesInput(shell, 'working'))).rejects.toBeInstanceOf(Error);
    await expect(new DiffService(shell).getFileContent({ ...filesInput(shell, 'working'), filePath: 'src/app.ts', status: 'M' })).rejects.toBeInstanceOf(RemoteGitUnavailableError);
    // The head contract is unchanged for its other callers: null and null, with the sha null saying git failed.
    expect(await readWorktreeHeadUnqueued(shell)).toEqual({ branch: null, sha: null });
  });

  it('has a fingerprint that moves for every kind of change and holds still otherwise', async () => {
    const runner = createRemoteGitResolver({
      remoteProjects: () => [{ path: shell, remote: { hostId: 'host-a', path: repo } }],
      runCommand: runOnHost,
    })(shell);
    if (!runner) throw new Error('the stand-in is not routed to the host');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    const clean = await runner.fingerprint();
    expect(await runner.fingerprint()).toBe(clean);

    // A new untracked file.
    fs.writeFileSync(path.join(repo, 'created.txt'), 'one\n');
    const withNew = await runner.fingerprint();
    expect(withNew).not.toBe(clean);

    // The same file edited again, to the same length: status is identical, only its time differs.
    await settle();
    fs.writeFileSync(path.join(repo, 'created.txt'), 'two\n');
    const edited = await runner.fingerprint();
    expect(edited).not.toBe(withNew);

    // A tracked file modified, then edited again with the same status.
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a\nB\nc\n');
    const modified = await runner.fingerprint();
    await settle();
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a\nb\nC\n');
    expect(await runner.fingerprint()).not.toBe(modified);

    // Staging, a commit, and a deletion each move it.
    const beforeStage = await runner.fingerprint();
    git('add', 'notes.md');
    const staged = await runner.fingerprint();
    expect(staged).not.toBe(beforeStage);
    git('commit', '-q', '-m', 'second');
    const committed = await runner.fingerprint();
    expect(committed).not.toBe(staged);
    fs.rmSync(path.join(repo, 'created.txt'));
    expect(await runner.fingerprint()).not.toBe(committed);
  });

  it('refuses a path that climbs out of the folder or follows a link, without reading it', async () => {
    fs.writeFileSync(path.join(home, 'secret.txt'), 'private\n');
    fs.symlinkSync(path.join(home, 'secret.txt'), path.join(repo, 'link.txt'));
    const climbing = await new DiffService(shell).getFileContent({ ...filesInput(shell, 'working'), filePath: '../secret.txt', status: 'M' });
    expect(climbing.modified).toBe('');
    const linked = await new DiffService(shell).getFileContent({ ...filesInput(shell, 'working'), filePath: 'link.txt', status: 'U' });
    expect(linked.modified).toBe('');
  });
});
