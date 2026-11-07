import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { probeGitOnHost } from '../../src/main/git/remote-git-probe';
import type { RemoteGitRunner } from '../../src/main/git/remote-git';

/**
 * The Branch row's Worktree option reads `project:probePath`, and for a remote project that answer comes from
 * the host's git. These run real git in folders under the temp directory, behind the same `run` the host's
 * runner has, so the four answers are checked against what git itself says.
 */

const execFileAsync = promisify(execFile);
const GIT_ENVIRONMENT = {
  ...process.env,
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

function git(directory: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: directory, env: GIT_ENVIRONMENT, stdio: 'ignore' });
}

function runnerIn(directory: string): Pick<RemoteGitRunner, 'run'> {
  return {
    async run(args) {
      try {
        const { stdout } = await execFileAsync('git', [...args], { cwd: directory, env: GIT_ENVIRONMENT });
        return { code: 0, stdout: Buffer.from(stdout), stderr: '' };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: Buffer.from(failure.stdout ?? ''), stderr: failure.stderr ?? '' };
      }
    },
  };
}

describe('probeGitOnHost', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-git-probe-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function folder(name: string): string {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  it('reads a folder that is no repository as not one, with nothing else true', async () => {
    const probe = await probeGitOnHost(runnerIn(folder('plain')));
    expect(probe).toEqual({ isGitRepo: false, isInsideWorktree: false, hasCommits: false, currentBranch: null });
  });

  it('reads a repository with no commit yet as a repository without commits, so the row says No commits yet', async () => {
    const directory = folder('unborn');
    git(directory, 'init');
    const probe = await probeGitOnHost(runnerIn(directory));
    expect(probe.isGitRepo).toBe(true);
    expect(probe.hasCommits).toBe(false);
    expect(probe.isInsideWorktree).toBe(false);
  });

  it('reads a repository with a commit as one that can have a worktree, and names its branch', async () => {
    const directory = folder('committed');
    git(directory, 'init', '-b', 'trunk');
    git(directory, 'commit', '--allow-empty', '-m', 'first');
    const probe = await probeGitOnHost(runnerIn(directory));
    expect(probe).toEqual({ isGitRepo: true, isInsideWorktree: false, hasCommits: true, currentBranch: 'trunk' });
  });

  it('does not read a subfolder of a repository as a project root', async () => {
    const directory = folder('parent');
    git(directory, 'init');
    const inner = path.join(directory, 'packages', 'app');
    fs.mkdirSync(inner, { recursive: true });
    const probe = await probeGitOnHost(runnerIn(inner));
    expect(probe.isGitRepo).toBe(false);
  });

  it('reads a linked worktree as inside a worktree', async () => {
    const directory = folder('main-checkout');
    git(directory, 'init', '-b', 'trunk');
    git(directory, 'commit', '--allow-empty', '-m', 'first');
    const linked = path.join(root, 'linked');
    git(directory, 'worktree', 'add', '-b', 'side', linked);
    const probe = await probeGitOnHost(runnerIn(linked));
    expect(probe.isGitRepo).toBe(true);
    expect(probe.isInsideWorktree).toBe(true);
  });

  it('rejects when the host cannot be asked, so a down link never reads as not a repository', async () => {
    const unreachable: Pick<RemoteGitRunner, 'run'> = {
      run: () => Promise.reject(new Error('The link to the host is down.')),
    };
    await expect(probeGitOnHost(unreachable)).rejects.toThrow('The link to the host is down.');
  });
});
