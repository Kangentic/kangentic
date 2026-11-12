/**
 * What a failed worktree step tells Sentry (DESKTOP-2S said only `worktree`).
 * Each refusal here is produced by real git through the git client the
 * lifecycle uses, so the phrase `worktreeFailureCause` matches is git's own and
 * not a guess at it. The report then carries the fixed cause and nothing git
 * said: git writes branch names, and a branch is named after a task.
 *
 * `worktree_no_space` is the one cause no test can produce (it would mean
 * filling a disk), so it is pinned on the OS's ENOSPC text at the bottom.
 * `worktree_permission` needs a folder git cannot write, which `chmod` makes
 * on POSIX only, so that case runs off Windows.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const reportHandledError = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ app: { getPath: () => '/mock', isPackaged: false } }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

import { runGitCommand } from '../../src/main/git/git-client';
import {
  StaleWorktreeDirectoryError,
  WorktreeSetupScriptError,
  worktreeFailureCause,
} from '../../src/main/git/worktree-errors';
import { notifySpawnBlocked } from '../../src/main/ipc/helpers/task-git';
import { resetLaunchReports } from '../../src/main/pty/agent-launch-report';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';

vi.setConfig({ testTimeout: 60_000 });

const BRANCH = 'fix-acme-billing-export';

let workspace: string;
let projectPath: string;
let worktreesRoot: string;
// git prints its refusals in the locale's language, and the phrases are English.
let previousLocale: string | undefined;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

/** The error the git client throws for `git <args>`, or a failure when git did not refuse. */
async function refusalOf(cwd: string, args: string[]): Promise<Error> {
  try {
    await runGitCommand(cwd, args);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`git ${args.join(' ')} did not refuse`);
}

function worktreeAt(name: string): string {
  return path.join(worktreesRoot, name);
}

beforeAll(() => {
  // Set directly, not stubbed: a test below unstubs its own variable, and the
  // locale must hold for every case after it.
  previousLocale = process.env.LC_ALL;
  process.env.LC_ALL = 'C';
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-refusals-')));
  projectPath = path.join(workspace, 'acme-project');
  worktreesRoot = path.join(projectPath, '.kangentic', 'worktrees');
  fs.mkdirSync(projectPath);
  // The files ref backend, so the ref lock below is a `.lock` file under refs/heads.
  run(projectPath, ['-c', 'init.defaultRefFormat=files', 'init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  run(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  fs.mkdirSync(worktreesRoot, { recursive: true });
  // The task's branch, checked out in its own worktree.
  run(projectPath, ['worktree', 'add', '-b', BRANCH, worktreeAt('1'), 'main']);
});

afterAll(async () => {
  if (previousLocale === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = previousLocale;
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const task = { id: 'task-1', title: 'Fix Acme billing export', agent: 'claude', agent_override: null } as unknown as Task;

function makeContext(): IpcContext {
  return {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    currentProjectId: 'project-1',
  } as unknown as IpcContext;
}

/** Report `error` as a failed worktree step, and return everything that left. */
function reported(error: Error): { cause: unknown; sent: string } {
  notifySpawnBlocked(makeContext(), task, 'worktree', error, 'project-1');
  expect(reportHandledError).toHaveBeenCalledTimes(1);
  const [sentError, tags, extra, fingerprint] = reportHandledError.mock.calls[0];
  return {
    cause: (tags as Record<string, string>).cause,
    sent: JSON.stringify([(sentError as Error).message, tags, extra, fingerprint]),
  };
}

function expectNothingGitSaid(sent: string): void {
  expect(sent).not.toMatch(/acme/i);
  expect(sent).not.toContain('refs/heads');
  expect(sent).not.toContain(workspace.replace(/\\/g, '/'));
  expect(sent).not.toContain(JSON.stringify(workspace).slice(1, -1));
}

describe('a worktree refusal from real git', () => {
  beforeEach(() => {
    reportHandledError.mockClear();
    resetLaunchReports();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('names a branch checked out in another worktree', async () => {
    const error = await refusalOf(projectPath, ['worktree', 'add', worktreeAt('2'), BRANCH]);
    const { cause, sent } = reported(error);
    expect(cause).toBe('worktree_branch_checked_out');
    expectNothingGitSaid(sent);
  });

  it('names a branch that already exists', async () => {
    const error = await refusalOf(projectPath, ['worktree', 'add', '-b', BRANCH, worktreeAt('3'), 'main']);
    const { cause, sent } = reported(error);
    expect(cause).toBe('worktree_branch_exists');
    expectNothingGitSaid(sent);
  });

  it('names a folder that already exists', async () => {
    fs.mkdirSync(worktreeAt('4'));
    fs.writeFileSync(path.join(worktreeAt('4'), 'left-behind.txt'), 'x\n');
    const error = await refusalOf(projectPath, ['worktree', 'add', '-b', 'acme-path-taken', worktreeAt('4'), 'main']);
    const { cause, sent } = reported(error);
    expect(cause).toBe('worktree_path_exists');
    expectNothingGitSaid(sent);
  });

  it('names a folder git still has registered after it went', async () => {
    run(projectPath, ['worktree', 'add', '-b', 'acme-gone', worktreeAt('5'), 'main']);
    fs.rmSync(worktreeAt('5'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    const error = await refusalOf(projectPath, ['worktree', 'add', worktreeAt('5'), 'acme-gone']);
    const { cause, sent } = reported(error);
    expect(cause).toBe('worktree_path_registered');
    expectNothingGitSaid(sent);
  });

  it('names a start point that does not resolve', async () => {
    const error = await refusalOf(projectPath, ['worktree', 'add', '-b', 'acme-new', worktreeAt('6'), 'origin/acme-missing']);
    const { cause, sent } = reported(error);
    expect(cause).toBe('worktree_invalid_reference');
    expectNothingGitSaid(sent);
  });

  it('names a branch name git will not take', async () => {
    const error = await refusalOf(projectPath, ['worktree', 'add', '-b', 'acme..billing', worktreeAt('7'), 'main']);
    const { cause, sent } = reported(error);
    expect(cause).toBe('worktree_invalid_branch_name');
    expectNothingGitSaid(sent);
  });

  it('names a ref another git process holds the lock on', async () => {
    const lockFile = path.join(projectPath, '.git', 'refs', 'heads', 'acme-locked.lock');
    fs.writeFileSync(lockFile, '');
    try {
      const error = await refusalOf(projectPath, ['worktree', 'add', '-b', 'acme-locked', worktreeAt('8'), 'main']);
      const { cause, sent } = reported(error);
      expect(cause).toBe('worktree_ref_lock');
      expectNothingGitSaid(sent);
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  });

  it('names a folder that is not a repository', async () => {
    const plainFolder = path.join(workspace, 'acme-plain');
    fs.mkdirSync(plainFolder);
    // Bounded at the workspace, so a repository above the temp folder cannot answer.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', workspace);
    try {
      const error = await refusalOf(plainFolder, ['worktree', 'add', worktreeAt('9'), 'main']);
      const { cause, sent } = reported(error);
      expect(cause).toBe('worktree_not_a_repository');
      expectNothingGitSaid(sent);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // chmod denies only on POSIX, and never to root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names a worktrees folder git cannot write', async () => {
    const lockedRoot = path.join(workspace, 'acme-read-only');
    fs.mkdirSync(lockedRoot);
    fs.chmodSync(lockedRoot, 0o555);
    try {
      const error = await refusalOf(projectPath, ['worktree', 'add', '-b', 'acme-denied', path.join(lockedRoot, '10'), 'main']);
      const { cause, sent } = reported(error);
      expect(cause).toBe('worktree_permission');
      expectNothingGitSaid(sent);
    } finally {
      fs.chmodSync(lockedRoot, 0o755);
    }
  });
});

describe('a worktree failure that is not a git refusal', () => {
  it('keeps a folder that would not clear as stale_directory, its existing issue', () => {
    expect(worktreeFailureCause(new StaleWorktreeDirectoryError("fatal: 'x' already exists"))).toBe('stale_directory');
  });

  it('names the setup script by its type, whatever its output says', () => {
    expect(worktreeFailureCause(new WorktreeSetupScriptError('npm ERR! Permission denied'))).toBe('worktree_setup_script');
  });

  it('reads git\'s phrase through a wrapping error\'s cause', () => {
    const gitError = new Error("Preparing worktree (new branch 'x')\nfatal: invalid reference: origin/x\n");
    expect(worktreeFailureCause(new Error('Worktree setup failed', { cause: gitError }))).toBe('worktree_invalid_reference');
  });

  it('pins the full disk on the OS text git passes on, since no test can fill a disk', () => {
    expect(worktreeFailureCause(new Error("error: unable to write file README.md: No space left on device\nfatal: Could not reset index file to revision 'HEAD'."))).toBe('worktree_no_space');
  });

  it('sends worktree_other for anything else', () => {
    expect(worktreeFailureCause(new Error('Cannot use simple-git on a directory that does not exist'))).toBe('worktree_other');
    expect(worktreeFailureCause('not an error')).toBe('worktree_other');
  });
});
