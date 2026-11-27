/**
 * What a failed git command tells a report (Sentry DESKTOP-4A: `git:diffFiles`
 * failed and the event said only `Error`). Each refusal here is produced by
 * real git through the git client, so the phrase `gitFailureCause` matches is
 * git's own and not a guess at it.
 *
 * `no_space` is the one cause no test can produce (it would mean filling a
 * disk), so it is pinned on the OS's ENOSPC text at the bottom. `permission`
 * needs a folder git cannot write, which `chmod` makes on POSIX only, so that
 * case runs off Windows. The worktree causes have the same two limits
 * (worktree-failure-cause-real-git.test.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGitCommand, runRemoteGitCommand } from '../../src/main/git/git-client';
import type { RemoteGitRunner } from '../../src/main/git/remote-git';
import { GitCommandError, gitFailureCause } from '../../src/main/git/git-command-error';

vi.setConfig({ testTimeout: 60_000 });

/** Two full hashes no repository here holds. */
const GONE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const ALSO_GONE = 'feedfacefeedfacefeedfacefeedfacefeedface';

let workspace: string;
let repository: string;
let unbornRepository: string;
// git prints its refusals in the locale's language, and the phrases are English.
let previousLocale: string | undefined;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

function initRepository(name: string): string {
  const directory = path.join(workspace, name);
  fs.mkdirSync(directory);
  // The files ref backend, so the ref lock below is a `.lock` file under refs/heads.
  run(directory, ['-c', 'init.defaultRefFormat=files', 'init', '-b', 'main']);
  run(directory, ['config', 'user.email', 'dev@example.com']);
  run(directory, ['config', 'user.name', 'Dev']);
  run(directory, ['config', 'commit.gpgsign', 'false']);
  return directory;
}

function commitReadme(directory: string): void {
  fs.writeFileSync(path.join(directory, 'README.md'), 'project\n');
  run(directory, ['add', '-A']);
  run(directory, ['commit', '-q', '-m', 'initial']);
}

/** The error the git client throws for `git <args>`, or a failure when git did not refuse. */
async function refusalOf(cwd: string, args: string[]): Promise<GitCommandError> {
  try {
    await runGitCommand(cwd, args);
  } catch (error) {
    expect(error).toBeInstanceOf(GitCommandError);
    return error as GitCommandError;
  }
  throw new Error(`git ${args.join(' ')} did not refuse`);
}

beforeAll(() => {
  // Set directly, not stubbed: the cases below unstub their own variables, and
  // the locale must hold for every one of them.
  previousLocale = process.env.LC_ALL;
  process.env.LC_ALL = 'C';
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-git-causes-')));
  repository = initRepository('acme-project');
  commitReadme(repository);
  unbornRepository = initRepository('acme-unborn');
});

afterAll(async () => {
  if (previousLocale === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = previousLocale;
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a refusal from real git', () => {
  it('is a named error that keeps git\'s text for the callers that read it', async () => {
    const error = await refusalOf(unbornRepository, ['diff', '--name-status', 'HEAD']);

    expect(error.name).toBe('GitCommandError');
    expect(error.exitCode).toBe(128);
    expect(error.message).toContain("fatal: ambiguous argument 'HEAD'");
    // The exec's own rejection stays as the cause, and the throw site is the top
    // frame (git's message runs over several lines, so the frames start after it).
    expect(error.cause).toBeInstanceOf(Error);
    const firstFrame = error.stack?.split('\n').find((line) => /^\s+at /.test(line));
    expect(firstFrame).toContain('runGitCommand');
  });

  it.each<[string, () => string, string[]]>([
    ['a HEAD with no commit behind it', () => unbornRepository, ['diff', '--name-status', 'HEAD']],
    ['a branch that is gone, to diff', () => repository, ['diff', '--name-status', 'acme-missing']],
    ['a branch that is gone, to show', () => repository, ['show', 'acme-missing:README.md']],
    ['a branch that is gone, to rev-parse', () => repository, ['rev-parse', '--verify', 'acme-missing']],
    ['a branch that is gone, to merge-base', () => repository, ['merge-base', 'acme-missing', 'HEAD']],
    ['a commit that is gone, to merge-base', () => repository, ['merge-base', GONE, 'HEAD']],
  ])('names %s as a revision that names nothing', async (_label, directory, args) => {
    expect((await refusalOf(directory(), args)).gitCause).toBe('unknown_revision');
  });

  it.each<[string, string[]]>([
    ['a diff of two', ['diff', '--name-status', GONE, ALSO_GONE]],
    ['a diff against one', ['diff', '--stat=4096', GONE]],
    ['a show of one', ['show', GONE]],
  ])('names %s commits the repository no longer holds', async (_label, args) => {
    expect((await refusalOf(repository, args)).gitCause).toBe('missing_object');
  });

  it('names a folder that is not a repository', async () => {
    const plainFolder = path.join(workspace, 'acme-plain');
    fs.mkdirSync(plainFolder);
    // Bounded at the workspace, so a repository above the temp folder cannot answer.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', workspace);

    expect((await refusalOf(plainFolder, ['status', '--porcelain'])).gitCause).toBe('not_a_repository');
  });

  // Read while probing for Sentry DESKTOP-5N, a churn read that died on a line the
  // classifier did not know. Not attributed to it: a removal deletes the file, and
  // only a write that stopped short leaves one like these.
  it.each<[string, string]>([
    ['empty', ''],
    ['cut short before its path', 'gitdir: '],
  ])('names a worktree whose .git file is %s', async (label, content) => {
    const worktree = path.join(workspace, `acme-gitfile-${label.split(' ')[0]}`);
    run(repository, ['worktree', 'add', '-q', '-b', `acme-gitfile-${label.split(' ')[0]}`, worktree]);
    const gitFile = path.join(worktree, '.git');
    // Windows marks the file hidden, which a plain overwrite refuses.
    fs.rmSync(gitFile, { force: true });
    fs.writeFileSync(gitFile, content);

    expect((await refusalOf(worktree, ['diff', '--stat=4096', 'HEAD'])).gitCause).toBe('broken_gitfile');
  });

  it('names a repository git reads as another user\'s', async () => {
    // git's own switch for this check, and no config that could list the folder as safe.
    const emptyConfig = path.join(workspace, 'empty-gitconfig');
    fs.writeFileSync(emptyConfig, '');
    vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

    expect((await refusalOf(repository, ['status', '--porcelain'])).gitCause).toBe('dubious_ownership');
  });

  it('names a ref another git process holds the lock on', async () => {
    const lockFile = path.join(repository, '.git', 'refs', 'heads', 'acme-locked.lock');
    fs.writeFileSync(lockFile, '');
    try {
      // The line also says `Unable to create '...lock': File exists`, the index lock's words.
      expect((await refusalOf(repository, ['branch', 'acme-locked'])).gitCause).toBe('ref_lock');
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  });

  it('names an index another git process holds the lock on', async () => {
    const lockFile = path.join(repository, '.git', 'index.lock');
    fs.writeFileSync(path.join(repository, 'acme-new.txt'), 'x\n');
    fs.writeFileSync(lockFile, '');
    try {
      expect((await refusalOf(repository, ['add', 'acme-new.txt'])).gitCause).toBe('index_lock');
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  });

  it.each<[string, string]>([
    ['cut short', 'not an index'],
    ['overwritten', 'x'.repeat(200)],
  ])('names an index that was %s', async (label, content) => {
    const damaged = initRepository(`acme-index-${label.replace(' ', '-')}`);
    commitReadme(damaged);
    fs.writeFileSync(path.join(damaged, '.git', 'index'), content);

    expect((await refusalOf(damaged, ['status', '--porcelain'])).gitCause).toBe('corrupt_index');
  });

  // chmod denies only on POSIX, and never to root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names a folder git cannot write', async () => {
    const lockedRoot = path.join(workspace, 'acme-read-only');
    fs.mkdirSync(lockedRoot);
    fs.chmodSync(lockedRoot, 0o555);
    try {
      const error = await refusalOf(repository, ['worktree', 'add', '-b', 'acme-denied', path.join(lockedRoot, '1'), 'main']);
      expect(error.gitCause).toBe('permission');
    } finally {
      fs.chmodSync(lockedRoot, 0o755);
    }
  });
});

describe('a refusal from a host\'s git', () => {
  function runnerAnswering(code: number, stdout: string, stderr: string): RemoteGitRunner {
    const unused = async (): Promise<never> => { throw new Error('not used by a git run'); };
    return {
      run: async () => ({ code, stdout: Buffer.from(stdout, 'utf8'), stderr }),
      readObject: unused,
      readWorkingFile: unused,
      countUntracked: unused,
      fingerprint: unused,
    };
  }

  it('is a GitCommandError with the cause, exit code and git\'s text', async () => {
    const stderr = `fatal: bad object ${GONE}\n`;
    const runner = runnerAnswering(128, 'partial output\n', stderr);

    const error = await runRemoteGitCommand(runner, ['show', GONE]).then(
      () => { throw new Error('the host\'s refusal did not reject'); },
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(GitCommandError);
    const refusal = error as GitCommandError;
    expect(refusal.gitCause).toBe('missing_object');
    expect(refusal.exitCode).toBe(128);
    expect(refusal.message).toBe(`partial output\n${stderr}`);
  });

  it('resolves with stdout when git exits non-zero and wrote nothing to stderr', async () => {
    const runner = runnerAnswering(1, 'acme-output\n', '');

    await expect(runRemoteGitCommand(runner, ['diff', '--quiet'])).resolves.toBe('acme-output\n');
  });
});

describe('git text no run here can produce', () => {
  it('pins the full disk on the OS text git passes on, since no test can fill a disk', () => {
    expect(gitFailureCause("error: unable to write file README.md: No space left on device\nfatal: Could not reset index file to revision 'HEAD'.\n")).toBe('no_space');
  });

  it('reads other for a refusal it has no phrase for, and for a git that prints another language', () => {
    expect(gitFailureCause('fatal: refusing to merge unrelated histories\n')).toBe('other');
    expect(gitFailureCause("fatal: argument 'HEAD' ambigu : revision inconnue ou chemin inexistant.\n")).toBe('other');
    expect(gitFailureCause('')).toBe('other');
  });

  it('reads permission from git\'s own line, the Windows file-lock shape included', () => {
    expect(gitFailureCause("error: unable to unlink old '.git/objects/pack/pack-1a2b3c.idx': Permission denied\n")).toBe('permission');
    const couldNotCreate = "fatal: could not create leading directories of '/tmp/acme/.git': Permission denied\n";
    expect(gitFailureCause(couldNotCreate)).toBe('permission');
    expect(gitFailureCause(`Preparing worktree (new branch 'acme')\n${couldNotCreate}`)).toBe('permission');
    expect(gitFailureCause(`Preparing worktree (new branch 'acme')\n${couldNotCreate}`.replace(/\n/g, '\r\n'))).toBe('permission');
  });

  it('does not read permission from ssh\'s refused login or a warning about a file git skipped', () => {
    expect(gitFailureCause('git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n')).toBe('other');
    expect(gitFailureCause('dev@example.com: Permission denied, please try again.\n')).toBe('other');
    expect(gitFailureCause("warning: unable to access '/home/dev/.config/git/attributes': Permission denied\nfatal: refusing to merge unrelated histories\n")).toBe('other');
  });

  it('reads what git wrote to stderr, never what it printed first', () => {
    // A failed `show` can print a file's text before it fails, and a file may say anything.
    const error = new GitCommandError({ stdout: 'log: Permission denied\n', stderr: 'fatal: refusing to merge unrelated histories\n', exitCode: 128 });

    expect(error.gitCause).toBe('other');
    expect(error.message).toBe('log: Permission denied\nfatal: refusing to merge unrelated histories\n');
  });
});
