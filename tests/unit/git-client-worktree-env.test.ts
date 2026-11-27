/**
 * What a user loses if these break: with a worktree's `.git` file gone, git started at its
 * root walks up into the project's own checkout and a task is given the project's churn and
 * branch, which overwrites its real stats. And a `gitAt` of a path that is a file would
 * hand back a client that fails later, instead of failing where it is made.
 *
 * The executor seam records the env each git command is sent with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitAt, GitDirectoryMissingError } from '../../src/main/git/git-client';
import { setOffMainExecutor, type OffMainExecutor } from '../../src/main/utility-process/off-main-exec';

let workspace: string;
const savedEnvironment: Record<string, string | undefined> = {};

function sentEnvironment(executor: ReturnType<typeof vi.fn<OffMainExecutor>>): Record<string, string> | undefined {
  const request = executor.mock.calls[0][0];
  if (request.kind !== 'execFile') throw new Error('expected an execFile request');
  return request.options.env as Record<string, string> | undefined;
}

function installExecutor() {
  const executor = vi.fn<OffMainExecutor>(async () => ({ ok: true, stdout: 'abc\n', stderr: '' }));
  setOffMainExecutor(executor);
  return executor;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'git-client-env-'));
  for (const key of ['GIT_CEILING_DIRECTORIES', 'CHROME_CRASHPAD_PIPE_NAME']) savedEnvironment[key] = process.env[key];
  delete process.env.GIT_CEILING_DIRECTORIES;
});

afterEach(() => {
  setOffMainExecutor(null);
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the env of git run in a Kangentic worktree', () => {
  it('stops git walking above the worktrees folder when run at the worktree root, and strips the Crashpad pipe name', async () => {
    const worktreesFolder = path.join(workspace, '.kangentic', 'worktrees');
    const worktreeRoot = path.join(worktreesFolder, 'my-task');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    process.env.CHROME_CRASHPAD_PIPE_NAME = 'pipe-that-must-not-reach-git';
    const executor = installExecutor();

    await gitAt(worktreeRoot).revparse(['HEAD']);

    const environment = sentEnvironment(executor);
    expect(environment?.GIT_CEILING_DIRECTORIES).toBe(worktreesFolder);
    expect(environment).not.toHaveProperty('CHROME_CRASHPAD_PIPE_NAME');
  });

  it('sets no ceiling for a plain folder', async () => {
    const plainFolder = path.join(workspace, 'project');
    fs.mkdirSync(plainFolder);
    const executor = installExecutor();

    await gitAt(plainFolder).revparse(['HEAD']);

    expect(sentEnvironment(executor)).not.toHaveProperty('GIT_CEILING_DIRECTORIES');
  });

  it('sets no ceiling for a subfolder of a worktree', async () => {
    const subfolder = path.join(workspace, '.kangentic', 'worktrees', 'my-task', 'src');
    fs.mkdirSync(subfolder, { recursive: true });
    const executor = installExecutor();

    await gitAt(subfolder).revparse(['HEAD']);

    expect(sentEnvironment(executor)).not.toHaveProperty('GIT_CEILING_DIRECTORIES');
  });
});

describe('gitAt for a path that is a file', () => {
  it('throws the missing-directory error with no cause and runs nothing', () => {
    const filePath = path.join(workspace, 'not-a-folder.txt');
    fs.writeFileSync(filePath, 'x\n');
    const executor = installExecutor();

    let thrown: unknown;
    try {
      gitAt(filePath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitDirectoryMissingError);
    const missing = thrown as GitDirectoryMissingError;
    expect(missing.name).toBe('GitDirectoryMissingError');
    expect(missing.message).toBe('Cannot use simple-git on a directory that does not exist');
    expect(missing.cause).toBeUndefined();
    expect(executor).not.toHaveBeenCalled();
  });
});
