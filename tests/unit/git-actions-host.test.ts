/**
 * Commit and push for a project on an SSH host (src/main/git-actions/) run the host's git, hooks
 * included, and never this computer's in the empty stand-in folder.
 *
 * What a user loses if it breaks: a commit that runs in the wrong repository, a message the shell
 * reads as code, or a hook's refusal that reads as a lost connection. The real helper command runner
 * with a POSIX shell and git. POSIX only: the host's scripts are `sh`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/pr/pr-registry', () => ({ canCreatePullRequest: async () => true }));

import { commitChanges, pushCommits } from '../../src/main/git-actions/commit-and-push';
import { readGitWorkDetail } from '../../src/main/git/work-state';
import { invalidateRemoteUrlsCache } from '../../src/main/git/git-remotes';
import { createRemoteGitResolver } from '../../src/main/remote/host-git';
import { RemoteGitUnavailableError, setRemoteGitResolver } from '../../src/main/git/remote-git';
import { gitIn, runHostCommandAt } from './helpers/host-git-rig';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const hasShellAndGit = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  && spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasShellAndGit)('git actions on a host', () => {
  let scratch: string;
  let home: string;
  let repo: string;
  let shell: string;
  let linkDown = false;

  async function runOnHost(_hostId: string, request: HostCommandRequest): Promise<HostCommandResult> {
    if (linkDown) throw new Error('The link to the host is down.');
    return runHostCommandAt(request, home, repo);
  }
  const work = () => readGitWorkDetail({ worktreePath: shell, projectPath: shell, baseBranch: 'main' });

  beforeEach(() => {
    linkDown = false;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-actions-'));
    home = path.join(scratch, 'home');
    repo = path.join(home, 'api');
    shell = path.join(scratch, 'shell');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(shell, { recursive: true });
    gitIn(scratch, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.name', 't');
    gitIn(repo, 'config', 'user.email', 't@example.com');
    gitIn(repo, 'config', 'core.hooksPath', '.git/hooks');
    gitIn(repo, 'remote', 'add', 'origin', path.join(scratch, 'origin.git'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'first');
    gitIn(repo, 'push', '-q', 'origin', 'main');
    gitIn(repo, 'checkout', '-q', '-b', 'feature', 'origin/main');
    setRemoteGitResolver(createRemoteGitResolver({
      remoteProjects: () => [{ path: shell, remote: { hostId: 'host-a', path: repo } }],
      runCommand: runOnHost,
    }));
    invalidateRemoteUrlsCache(shell);
  });

  afterEach(() => {
    setRemoteGitResolver(null);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('commits there with the message exactly as written, then publishes the branch', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const message = 'feat: quotes " and $HOME and `date`\n\n- body; rm -rf x';
    expect(await commitChanges(shell, await work(), message)).toBeNull();
    expect(gitIn(repo, 'log', '-1', '--format=%B').trim()).toBe(message);

    const committed = await work();
    expect(committed).toMatchObject({ unpushedCommitCount: 1, pushTarget: null, canCreatePullRequest: false });
    expect(await pushCommits(shell, committed)).toBeNull();
    expect(gitIn(path.join(scratch, 'origin.git'), 'rev-parse', 'feature')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    expect(await work()).toMatchObject({ unpushedCommitCount: 0, pushTarget: 'feature' });
  });

  it('gives the agent a host hook\'s own output, and unstages what it staged', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: 2 problems"\nexit 1\n', { mode: 0o755 });
    const failure = await commitChanges(shell, await work(), 'feat: x');
    expect(failure).toMatchObject({ for: 'agent', step: 'commit' });
    expect(failure?.for === 'agent' && failure.output).toContain('lint: 2 problems');
    expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('tells the user when the host does not answer, and reads no state from here', async () => {
    const before = await work();
    linkDown = true;
    expect(await pushCommits(shell, before)).toMatchObject({ for: 'user', step: 'push' });
    await expect(work()).rejects.toBeInstanceOf(RemoteGitUnavailableError);
  });
});
