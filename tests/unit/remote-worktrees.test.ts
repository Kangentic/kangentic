/**
 * A task's git worktree on an SSH host (#913): what `HostWorktrees` asks the host to run, how it reads the
 * answer, the stand-in folder it leaves on this computer, how `WorktreeManager` hands a remote project's
 * operations to it, and, where a POSIX shell and git exist, the real script against real repositories.
 *
 * What a user loses if it breaks: two agents editing one folder on the host again, a worktree made from the
 * wrong base, uncommitted work removed without a word, or a remote task's Post-Worktree Script run on the
 * wrong machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostWorktrees, createRemoteWorktreeResolver, hostWorktreePathFor } from '../../src/main/remote/remote-worktrees';
import { runHostCommand } from '../../src/main/remote/helper/host-command';
import { remoteWorktreeBackendForWorktree, setRemoteWorktreeResolver, type RemoteWorktreeBackend } from '../../src/main/git/remote-worktree';
import { WorktreeManager, setWorktreeRemovedListener, setWorktreeRemovingListener } from '../../src/main/git/worktree-manager';
import { tryHoldWorktreeCreation } from '../../src/main/git/worktree-creation-registry';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

let scratch: string;
let shellFolder: string;

const HOST_REPO = '/home/dev/api';
const task = { id: 'abcdef12-0000-4000-8000-000000000000', title: 'Fix login bug', display_id: 7, worktree_path: null as string | null };
const gitConfig = { worktreesEnabled: true, defaultBaseBranch: 'main' };

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-worktree-'));
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  setRemoteWorktreeResolver(null);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const answer = (stdout: string, extra: Partial<HostCommandResult> = {}): HostCommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra });

function backendWith(runCommand: (request: HostCommandRequest) => Promise<HostCommandResult>, present: Array<'present' | 'absent'> = ['absent']) {
  const pathPresence = vi.fn(async () => present);
  const calls: HostCommandRequest[] = [];
  const backend = new HostWorktrees({
    hostRepoPath: HOST_REPO,
    shellFolder,
    runCommand: async (request) => { calls.push(request); return runCommand(request); },
    pathPresence,
  });
  return { backend, calls, pathPresence };
}

describe('the path a worktree has on the host', () => {
  it('is the project\'s folder on the host plus .kangentic/worktrees/<n>', () => {
    expect(hostWorktreePathFor(path.join(shellFolder, '.kangentic', 'worktrees', '7'), shellFolder, HOST_REPO)).toBe('/home/dev/api/.kangentic/worktrees/7');
  });

  it.each([
    ['the worktrees folder itself', ['.kangentic', 'worktrees']],
    ['a folder two below it', ['.kangentic', 'worktrees', '7', 'src']],
    ['the project folder', []],
    ['another folder of the project', ['src', 'worktrees', '7']],
  ])('is refused for %s, because the removal deletes it', (_label, segments) => {
    expect(() => hostWorktreePathFor(path.join(shellFolder, ...segments), shellFolder, HOST_REPO)).toThrow('not a worktree folder of this project');
  });

  it('is refused for a path that climbs out of the shell folder', () => {
    expect(() => hostWorktreePathFor(path.join(shellFolder, '..', 'elsewhere'), shellFolder, HOST_REPO)).toThrow('not a worktree folder');
  });
});

describe('making a worktree on the host', () => {
  it('runs one script on the host with the repository, the worktree, the branch and the base candidates, and leaves a stand-in here', async () => {
    const { backend, calls } = backendWith(async () => answer('KG:created\nKG:branch:fix-login-bug-abcdef12\nKG:base:main\nKG:sha:0123abcd\n'));

    const result = await backend.ensureWorktree(task, gitConfig);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'sh', cwd: HOST_REPO });
    expect(calls[0].args.slice(0, 1)).toEqual(['-c']);
    expect(calls[0].args.slice(2)).toEqual(['kangentic-worktree', HOST_REPO, '/home/dev/api/.kangentic/worktrees/7', 'fix-login-bug-abcdef12', '0', 'main', 'master']);
    const localPath = path.join(shellFolder, '.kangentic', 'worktrees', '7');
    expect(result).toEqual({ worktreePath: localPath, branchName: 'fix-login-bug-abcdef12', worktreeFolder: '7', baseBranch: 'main', forkPointSha: '0123abcd' });
    expect(fs.statSync(localPath).isDirectory()).toBe(true);
  });

  it('cuts from the base the task names, and from nothing else', async () => {
    const { backend, calls } = backendWith(async () => answer('KG:created\nKG:branch:b\nKG:base:release\nKG:sha:aa\n'));

    await backend.ensureWorktree({ ...task, base_branch: 'release' }, gitConfig);

    expect(calls[0].args.slice(6)).toEqual(['1', 'release']);
  });

  it('keeps the branch name the task already has, and reports no base for a branch that existed', async () => {
    const { backend, calls } = backendWith(async () => answer('KG:created\nKG:branch:feature/mine\n'));

    const result = await backend.ensureWorktree({ ...task, branch_name: 'feature/mine' }, gitConfig);

    expect(calls[0].args[5]).toBe('feature/mine');
    expect(result).toMatchObject({ branchName: 'feature/mine', baseBranch: null, forkPointSha: null });
  });

  it('keeps the folder a task has always used', async () => {
    const { backend, calls } = backendWith(async () => answer('KG:created\nKG:branch:b\n'));

    const result = await backend.ensureWorktree({ ...task, worktree_folder: 'legacy-1a2b3c4d' }, gitConfig);

    expect(calls[0].args[4]).toBe('/home/dev/api/.kangentic/worktrees/legacy-1a2b3c4d');
    expect(result).toMatchObject({ worktreeFolder: 'legacy-1a2b3c4d' });
  });

  it('makes nothing, and asks the host nothing, when worktrees are off for the task', async () => {
    const { backend, calls } = backendWith(async () => answer(''));

    expect(await backend.ensureWorktree({ ...task, use_worktree: 0 }, gitConfig)).toEqual({ skipped: true, reason: 'disabled' });
    expect(await backend.ensureWorktree(task, { ...gitConfig, worktreesEnabled: false })).toEqual({ skipped: true, reason: 'disabled' });
    expect(calls).toEqual([]);
  });

  it.each(['not-a-repo', 'nested-worktree', 'no-commits'] as const)('says %s when the host does, and leaves no stand-in', async (reason) => {
    const { backend } = backendWith(async () => answer(`KG:skip:${reason}\n`));

    expect(await backend.ensureWorktree(task, gitConfig)).toEqual({ skipped: true, reason });
    expect(fs.existsSync(path.join(shellFolder, '.kangentic'))).toBe(false);
  });

  it('keeps a worktree the task already has, when the host says its .git is there', async () => {
    const { backend, calls, pathPresence } = backendWith(async () => answer(''), ['present']);

    const result = await backend.ensureWorktree({ ...task, worktree_path: path.join(shellFolder, '.kangentic', 'worktrees', '7') }, gitConfig);

    expect(result).toEqual({ skipped: true, reason: 'reused' });
    expect(pathPresence).toHaveBeenCalledWith(['/home/dev/api/.kangentic/worktrees/7/.git']);
    expect(calls).toEqual([]);
  });

  it('makes a new one when the task\'s worktree is gone from the host, in the same place', async () => {
    const { backend, calls } = backendWith(async () => answer('KG:created\nKG:branch:b\nKG:base:main\nKG:sha:aa\n'), ['absent']);

    const result = await backend.ensureWorktree({ ...task, worktree_path: path.join(shellFolder, '.kangentic', 'worktrees', '7') }, gitConfig);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ worktreePath: path.join(shellFolder, '.kangentic', 'worktrees', '7') });
  });

  it('is an error, and makes nothing, when the host cannot say whether the worktree is there', async () => {
    const run = vi.fn(async () => answer(''));
    const { backend, pathPresence } = backendWith(run);
    pathPresence.mockRejectedValueOnce(new Error('Kangentic has no connection set up for host h1'));

    await expect(backend.ensureWorktree({ ...task, worktree_path: path.join(shellFolder, '.kangentic', 'worktrees', '7') }, gitConfig)).rejects.toThrow('no connection set up');
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['the host\'s own words', answer('KG:error:fatal: a branch named x already exists\n', { code: 3 }), 'fatal: a branch named x already exists'],
    ['a refusal to run', { code: null, stdout: '', stderr: '', timedOut: false, error: 'The folder /home/dev/api does not exist on this host.' } as HostCommandResult, 'does not exist on this host'],
    ['a timeout', { code: null, stdout: '', stderr: '', timedOut: true } as HostCommandResult, 'took too long'],
    ['a shell that failed with no marker', answer('', { code: 127, stderr: 'sh: git: not found' }), 'git: not found'],
  ])('fails with %s and leaves no stand-in', async (_label, result, text) => {
    const { backend } = backendWith(async () => result);

    await expect(backend.ensureWorktree(task, gitConfig)).rejects.toThrow(text);
    expect(fs.existsSync(path.join(shellFolder, '.kangentic'))).toBe(false);
  });

  it.each([
    ['branch_name', { ...task, branch_name: '-fetch-hook' }, gitConfig],
    ['base_branch', { ...task, base_branch: '--upload-pack=evil' }, gitConfig],
    ['the default base branch', task, { ...gitConfig, defaultBaseBranch: '-evil' }],
  ])('refuses a %s that starts with a dash before the host is asked, since git would read it as an option', async (_label, refusedTask, refusedConfig) => {
    const run = vi.fn(async () => answer('KG:created\n'));
    const { backend } = backendWith(run);

    await expect(backend.ensureWorktree(refusedTask, refusedConfig)).rejects.toThrow('is not a usable branch name');
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(shellFolder, '.kangentic'))).toBe(false);
  });

  it('does not record a worktree the host never said it made', async () => {
    const { backend } = backendWith(async () => answer('some banner\n'));

    await expect(backend.ensureWorktree(task, gitConfig)).rejects.toThrow('did not say the worktree was made');
  });

  it('stops when told to abort, before the host is asked', async () => {
    const run = vi.fn(async () => answer('KG:created\n'));
    const { backend } = backendWith(run);
    const controller = new AbortController();
    controller.abort();

    await expect(backend.ensureWorktree(task, gitConfig, { signal: controller.signal })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('removing a worktree from the host', () => {
  const localPath = (): string => path.join(shellFolder, '.kangentic', 'worktrees', '7');

  it('removes it there and deletes the stand-in here', async () => {
    fs.mkdirSync(localPath(), { recursive: true });
    const { backend, calls } = backendWith(async () => answer('KG:removed\n'));

    expect(await backend.removeWorktree(localPath())).toBe(true);

    expect(calls[0].args.slice(2)).toEqual(['kangentic-worktree', HOST_REPO, '/home/dev/api/.kangentic/worktrees/7']);
    expect(fs.existsSync(localPath())).toBe(false);
  });

  it('is false, and keeps the stand-in, when git on the host refuses or the host cannot be reached', async () => {
    fs.mkdirSync(localPath(), { recursive: true });

    expect(await backendWith(async () => answer('KG:error:Could not remove it.\n', { code: 3 })).backend.removeWorktree(localPath())).toBe(false);
    expect(await backendWith(async () => { throw new Error('link is down'); }).backend.removeWorktree(localPath())).toBe(false);
    expect(await backendWith(async () => answer('')).backend.removeWorktree(localPath())).toBe(false);
    expect(fs.existsSync(localPath())).toBe(true);
  });

  it('refuses a path that is not a worktree of the project, and asks the host nothing', async () => {
    const run = vi.fn(async () => answer('KG:removed\n'));
    const { backend } = backendWith(run);

    expect(await backend.removeWorktree(path.join(shellFolder, 'src'))).toBe(false);
    expect(await backend.removeWorktree(shellFolder)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('what a removal would destroy', () => {
  const localPath = (): string => path.join(shellFolder, '.kangentic', 'worktrees', '7');

  it('is the host\'s count of uncommitted files and the branch it is on', async () => {
    const { backend, calls } = backendWith(async () => answer('KG:uncommitted:3\nKG:branch:fix-login\n'));

    expect(await backend.pendingChanges(localPath())).toEqual({ uncommittedFileCount: 3, currentBranch: 'fix-login' });
    expect(calls[0].args.slice(2)).toEqual(['kangentic-worktree', '/home/dev/api/.kangentic/worktrees/7']);
  });

  it('has no branch on a detached head, and rejects rather than reading a count it cannot read as zero', async () => {
    expect(await backendWith(async () => answer('KG:uncommitted:0\nKG:branch:\n')).backend.pendingChanges(localPath())).toEqual({ uncommittedFileCount: 0, currentBranch: null });
    await expect(backendWith(async () => answer('KG:uncommitted:\n')).backend.pendingChanges(localPath())).rejects.toThrow('did not say how many');
    await expect(backendWith(async () => answer('KG:error:The worktree is not on this host.\n', { code: 3 })).backend.pendingChanges(localPath())).rejects.toThrow('not on this host');
  });
});

describe('finding the host of a worktree\'s stand-in folder', () => {
  it('maps the folder back to its project, and only a folder exactly one below the marker', () => {
    setRemoteWorktreeResolver((projectPath) => (projectPath === shellFolder ? ({ marker: 'remote' } as unknown as RemoteWorktreeBackend) : null));

    expect(remoteWorktreeBackendForWorktree(path.join(shellFolder, '.kangentic', 'worktrees', '7'))).not.toBeNull();
    expect(remoteWorktreeBackendForWorktree(path.join(shellFolder, '.kangentic', 'worktrees', '7', 'src'))).toBeNull();
    expect(remoteWorktreeBackendForWorktree(path.join(shellFolder, '.kangentic', 'worktrees'))).toBeNull();
    expect(remoteWorktreeBackendForWorktree(path.join(scratch, 'local-project', '.kangentic', 'worktrees', '7'))).toBeNull();
  });
});

describe('WorktreeManager for a project on a host', () => {
  function fakeBackend() {
    const backend: RemoteWorktreeBackend = {
      ensureWorktree: vi.fn(async () => ({ skipped: true as const, reason: 'reused' as const })),
      removeWorktree: vi.fn(async () => true),
      pendingChanges: vi.fn(async () => ({ uncommittedFileCount: 0, currentBranch: null })),
    };
    setRemoteWorktreeResolver((projectPath) => (projectPath === shellFolder ? backend : null));
    return backend;
  }

  it('hands creation to the host, with no check of this computer\'s disk for a repository', async () => {
    const backend = fakeBackend();

    const result = await new WorktreeManager(shellFolder).ensureWorktree(task, gitConfig);

    expect(result).toEqual({ skipped: true, reason: 'reused' });
    expect(backend.ensureWorktree).toHaveBeenCalledTimes(1);
  });

  it('hands removal and a move aside to the host, and refuses a path outside the project\'s worktrees first', async () => {
    const backend = fakeBackend();
    const manager = new WorktreeManager(shellFolder);
    const worktree = path.join(shellFolder, '.kangentic', 'worktrees', '7');

    expect(await manager.removeWorktree(worktree)).toBe(true);
    expect(await manager.moveWorktreeAside(worktree)).toBe(true);
    expect(backend.removeWorktree).toHaveBeenCalledTimes(2);
    await expect(manager.removeWorktree(path.join(shellFolder, 'src'))).rejects.toThrow('not a direct child');
    expect(backend.removeWorktree).toHaveBeenCalledTimes(2);
  });

  describe('a removal on the host', () => {
    const removalPath = (): string => path.join(shellFolder, '.kangentic', 'worktrees', '7');

    afterEach(() => {
      setWorktreeRemovingListener(null);
      setWorktreeRemovedListener(null);
    });

    it.each(['removeWorktree', 'moveWorktreeAside'] as const)('%s leaves a path whose creation is in flight, and never asks the host', async (method) => {
      const backend = fakeBackend();
      const release = tryHoldWorktreeCreation(removalPath());
      expect(release).not.toBeNull();
      const removing = vi.fn(async () => undefined);
      const removed = vi.fn(async () => undefined);
      setWorktreeRemovingListener(removing);
      setWorktreeRemovedListener(removed);
      try {
        expect(await new WorktreeManager(shellFolder)[method](removalPath())).toBe(false);
      } finally {
        release!();
      }

      expect(backend.removeWorktree).not.toHaveBeenCalled();
      expect(removing).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
    });

    it('removes the creation\'s own path when the caller says it holds it', async () => {
      const backend = fakeBackend();
      const release = tryHoldWorktreeCreation(removalPath());
      try {
        expect(await new WorktreeManager(shellFolder).removeWorktree(removalPath(), { ownCreation: true })).toBe(true);
      } finally {
        release!();
      }
      expect(backend.removeWorktree).toHaveBeenCalledTimes(1);
    });

    it('tells the removing listener before the host is asked, and the removed listener after it succeeds', async () => {
      const backend = fakeBackend();
      const order: string[] = [];
      setWorktreeRemovingListener(async (target) => { order.push(`removing:${target}`); });
      vi.mocked(backend.removeWorktree).mockImplementation(async () => { order.push('host'); return true; });
      setWorktreeRemovedListener(async (target) => { order.push(`removed:${target}`); });

      expect(await new WorktreeManager(shellFolder).removeWorktree(removalPath())).toBe(true);

      expect(order).toEqual([`removing:${removalPath()}`, 'host', `removed:${removalPath()}`]);
    });

    it('does not tell the removed listener when the host did not remove it', async () => {
      const backend = fakeBackend();
      vi.mocked(backend.removeWorktree).mockResolvedValue(false);
      const removing = vi.fn(async () => undefined);
      const removed = vi.fn(async () => undefined);
      setWorktreeRemovingListener(removing);
      setWorktreeRemovedListener(removed);

      expect(await new WorktreeManager(shellFolder).moveWorktreeAside(removalPath())).toBe(false);

      expect(removing).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveBeenCalled();
    });
  });

  it('reports a failed host removal as not removed, so the task keeps its path', async () => {
    const backend = fakeBackend();
    vi.mocked(backend.removeWorktree).mockResolvedValue(false);

    expect(await new WorktreeManager(shellFolder).removeWorktree(path.join(shellFolder, '.kangentic', 'worktrees', '7'))).toBe(false);
  });

  it('runs no Post-Worktree Script and copies and links nothing here', async () => {
    fakeBackend();
    const marker = path.join(scratch, 'ran-here');
    const manager = new WorktreeManager(shellFolder);
    const setup = {
      copyFiles: ['.env'],
      linkNodeModules: true,
      initScript: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`,
      worktreesEnabled: true,
      defaultBaseBranch: 'main',
    };
    fs.writeFileSync(path.join(shellFolder, '.env'), 'SECRET=1');
    const worktree = path.join(shellFolder, '.kangentic', 'worktrees', '7');
    fs.mkdirSync(worktree, { recursive: true });

    await manager.setUpWorktree(worktree, setup);

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(worktree, '.env'))).toBe(false);
  });

  it('is unchanged for a project that is not on a host', async () => {
    const backend = fakeBackend();
    const localProject = path.join(scratch, 'local-project');
    fs.mkdirSync(localProject, { recursive: true });

    // Not a repository, so the local rules decide, and the host backend is never asked.
    expect(await new WorktreeManager(localProject).ensureWorktree(task, gitConfig)).toEqual({ skipped: true, reason: 'not-a-repo' });
    expect(backend.ensureWorktree).not.toHaveBeenCalled();
  });
});

describe('the resolver', () => {
  it('builds a backend only for a path that is a remote project\'s shell folder, aimed at its host and folder', async () => {
    const runCommand = vi.fn(async (_hostId: string, _request: HostCommandRequest) => answer('KG:created\nKG:branch:b\n'));
    const resolve = createRemoteWorktreeResolver({
      remoteOfProjectPath: (projectPath) => (projectPath === shellFolder ? { hostId: 'host-a', path: HOST_REPO } : null),
      runCommand,
      pathPresence: async () => ['absent'],
    });

    expect(resolve(path.join(scratch, 'other'))).toBeNull();
    const backend = resolve(shellFolder)!;
    await backend.ensureWorktree(task, gitConfig);

    expect(runCommand.mock.calls[0][0]).toBe('host-a');
    expect(runCommand.mock.calls[0][1].cwd).toBe(HOST_REPO);
  });
});

// The real script, against real repositories, as the host's shell runs it. The host's folder is a temporary
// one standing in for it, so the paths are this machine's.
const hasShellAndGit = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  && spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasShellAndGit)('on a real repository', () => {
  let repo: string;
  let shell: string;

  function git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  function hostBackend(): HostWorktrees {
    return new HostWorktrees({
      hostRepoPath: repo,
      shellFolder: shell,
      runCommand: (request) => runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? repo, baseEnv: process.env }),
      pathPresence: async (paths) => paths.map((candidate) => (fs.existsSync(candidate) ? 'present' as const : 'absent' as const)),
    });
  }

  beforeEach(() => {
    repo = path.join(scratch, 'host-repo');
    shell = path.join(scratch, 'real-shell');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(shell, { recursive: true });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
  });

  it('makes a checkout on its own branch at the path the task row records, and removes it, keeping the branch', async () => {
    const backend = hostBackend();

    const created = await backend.ensureWorktree(task, gitConfig);
    if ('skipped' in created) throw new Error(`skipped: ${created.reason}`);

    const hostWorktree = path.join(repo, '.kangentic', 'worktrees', '7');
    expect(fs.readFileSync(path.join(hostWorktree, 'a.txt'), 'utf8')).toBe('one\n');
    expect(created.branchName).toBe('fix-login-bug-abcdef12');
    expect(created.baseBranch).toBe('main');
    expect(created.forkPointSha).toBe(git('rev-parse', 'main'));
    expect(git('-C', hostWorktree, 'symbolic-ref', '--short', 'HEAD')).toBe('fix-login-bug-abcdef12');
    expect(created.worktreePath).toBe(path.join(shell, '.kangentic', 'worktrees', '7'));
    expect(fs.existsSync(created.worktreePath)).toBe(true);

    expect(await backend.removeWorktree(created.worktreePath)).toBe(true);
    expect(fs.existsSync(hostWorktree)).toBe(false);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(git('branch', '--list', 'fix-login-bug-abcdef12')).toContain('fix-login-bug-abcdef12');
  });

  it('gives two tasks two checkouts that do not share files', async () => {
    const backend = hostBackend();
    await backend.ensureWorktree(task, gitConfig);
    await backend.ensureWorktree({ ...task, id: '11111111-0000-4000-8000-000000000000', title: 'Other', display_id: 8 }, gitConfig);

    fs.writeFileSync(path.join(repo, '.kangentic', 'worktrees', '7', 'a.txt'), 'changed in 7\n');

    expect(fs.readFileSync(path.join(repo, '.kangentic', 'worktrees', '8', 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('reuses the branch a task already has and a base the host has only as a branch', async () => {
    git('branch', 'release');
    const backend = hostBackend();

    const onRelease = await backend.ensureWorktree({ ...task, base_branch: 'release' }, gitConfig);
    if ('skipped' in onRelease) throw new Error('skipped');
    expect(onRelease.baseBranch).toBe('release');
    await backend.removeWorktree(onRelease.worktreePath);

    // The branch outlives the worktree, so the next creation attaches to it and reports no base.
    const again = await backend.ensureWorktree({ ...task, branch_name: onRelease.branchName }, gitConfig);
    if ('skipped' in again) throw new Error('skipped');
    expect(again.branchName).toBe(onRelease.branchName);
    expect(again.baseBranch).toBeNull();
    expect(again.forkPointSha).toBeNull();
  });

  it('falls back from a default base that is not there to master, then to the current branch', async () => {
    git('branch', '-m', 'main', 'master');
    const created = await hostBackend().ensureWorktree(task, gitConfig);
    if ('skipped' in created) throw new Error('skipped');
    expect(created.baseBranch).toBe('master');

    git('branch', '-m', 'master', 'trunk');
    fs.rmSync(path.join(repo, '.kangentic'), { recursive: true, force: true });
    git('worktree', 'prune');
    git('branch', '-D', created.branchName);
    const onTrunk = await hostBackend().ensureWorktree(task, gitConfig);
    if ('skipped' in onTrunk) throw new Error('skipped');
    expect(onTrunk.baseBranch).toBe('trunk');
  });

  it('refuses a base the task names that the host does not have, in words', async () => {
    await expect(hostBackend().ensureWorktree({ ...task, base_branch: 'nope' }, gitConfig)).rejects.toThrow('base branch nope does not exist in the repository on this host');
  });

  it('says not-a-repo for a folder that is not the top of a repository, and no-commits for an empty one', async () => {
    fs.mkdirSync(path.join(repo, 'sub'));
    const subBackend = new HostWorktrees({
      hostRepoPath: path.join(repo, 'sub'),
      shellFolder: shell,
      runCommand: (request) => runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? repo, baseEnv: process.env }),
      pathPresence: async () => ['absent'],
    });
    expect(await subBackend.ensureWorktree(task, gitConfig)).toEqual({ skipped: true, reason: 'not-a-repo' });

    const empty = path.join(scratch, 'empty-repo');
    fs.mkdirSync(empty);
    spawnSync('git', ['init', '-q'], { cwd: empty });
    const emptyBackend = new HostWorktrees({
      hostRepoPath: empty,
      shellFolder: shell,
      runCommand: (request) => runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? empty, baseEnv: process.env }),
      pathPresence: async () => ['absent'],
    });
    expect(await emptyBackend.ensureWorktree(task, gitConfig)).toEqual({ skipped: true, reason: 'no-commits' });
  });

  it('says nested-worktree when the project folder is itself a worktree', async () => {
    const linked = path.join(scratch, 'linked');
    git('worktree', 'add', '-q', '-b', 'other', linked);
    const backend = new HostWorktrees({
      hostRepoPath: linked,
      shellFolder: shell,
      runCommand: (request) => runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? linked, baseEnv: process.env }),
      pathPresence: async () => ['absent'],
    });
    expect(await backend.ensureWorktree(task, gitConfig)).toEqual({ skipped: true, reason: 'nested-worktree' });
  });

  it('counts uncommitted files, and removing leaves nothing behind but the branch', async () => {
    const backend = hostBackend();
    const created = await backend.ensureWorktree(task, gitConfig);
    if ('skipped' in created) throw new Error('skipped');
    const hostWorktree = path.join(repo, '.kangentic', 'worktrees', '7');

    expect(await backend.pendingChanges(created.worktreePath)).toEqual({ uncommittedFileCount: 0, currentBranch: created.branchName });
    fs.writeFileSync(path.join(hostWorktree, 'new.txt'), 'x');
    fs.writeFileSync(path.join(hostWorktree, 'a.txt'), 'edited');
    expect((await backend.pendingChanges(created.worktreePath)).uncommittedFileCount).toBe(2);

    // The user confirmed the Done move that reached here, as for a local worktree: the removal is forced.
    expect(await backend.removeWorktree(created.worktreePath)).toBe(true);
    expect(fs.existsSync(hostWorktree)).toBe(false);
    expect(git('worktree', 'list', '--porcelain')).not.toContain('.kangentic/worktrees/7');
  });

  it('clears a husk left at the path and makes the worktree again', async () => {
    const backend = hostBackend();
    const hostWorktree = path.join(repo, '.kangentic', 'worktrees', '7');
    fs.mkdirSync(hostWorktree, { recursive: true });
    fs.writeFileSync(path.join(hostWorktree, 'stale.txt'), 'left over');

    const created = await backend.ensureWorktree(task, gitConfig);
    if ('skipped' in created) throw new Error('skipped');

    expect(fs.existsSync(path.join(hostWorktree, 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(hostWorktree, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('puts no quote, space or dollar sign of a task title into the shell as code', async () => {
    const marker = path.join(scratch, 'pwned');
    const created = await hostBackend().ensureWorktree({ ...task, title: `x'; touch ${marker}; echo '` }, gitConfig);
    if ('skipped' in created) throw new Error('skipped');

    expect(fs.existsSync(marker)).toBe(false);
  });
});
