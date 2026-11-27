/**
 * What a user loses if these break: an SSH project's tasks never get their lines changed
 * written to Stats (its worktree folder here is an empty stand-in with no `.git`, and a
 * guard that forgot that skips every one of them), and the local log line for a failed
 * churn read either says nothing useful or leaks file text from git's stdout.
 *
 * Runs the real `captureGitChurn` with the diff read and the read queue replaced, the
 * remote resolver registered through its real seam, and real folders under os.tmpdir().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureGitChurn } from '../../src/main/ipc/handlers/git-stats-capture';
import { GitCommandError } from '../../src/main/git/git-command-error';
import { setRemoteGitResolver, type RemoteGitRunner } from '../../src/main/git/remote-git';

const churnRead = vi.hoisted(() => ({
  directories: [] as string[],
  outcome: { kind: 'churn' } as { kind: 'churn' } | { kind: 'failure'; failure: unknown },
}));

vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError: vi.fn(),
}));

vi.mock('../../src/main/git/diff-service', () => ({
  DiffService: class {
    constructor(directory: string) {
      churnRead.directories.push(directory);
    }
    async getChurnSummary(): Promise<{ linesAdded: number; linesRemoved: number; filesChanged: number }> {
      if (churnRead.outcome.kind === 'failure') throw churnRead.outcome.failure;
      return { linesAdded: 12, linesRemoved: 3, filesChanged: 2 };
    }
  },
}));

vi.mock('../../src/main/git/git-read-queue', () => ({
  GitReadPriority: { BACKGROUND: 0 },
  viaGitRead: <Result>(read: () => Promise<Result>) => read(),
}));

const TASK_ID = 'task-abcdef12';
const LOG_PREFIX = '[GIT_STATS] Churn read failed for task task-abc: ';

function captureArguments(worktreePath: string) {
  const sessionRepo = {
    listForTaskNewestFirst: () => [{ id: 'record-1' }],
    setTaskGitStats: vi.fn(),
  };
  const usageHistoryRepo = { setTaskGitStats: vi.fn() };
  const task = { id: TASK_ID, title: 'Task', worktree_path: worktreePath, pr_state: null, archived_at: null, base_branch: null };
  return { sessionRepo, usageHistoryRepo, task };
}

function capture(worktreePath: string) {
  const { sessionRepo, usageHistoryRepo, task } = captureArguments(worktreePath);
  captureGitChurn(task as never, sessionRepo as never, usageHistoryRepo as never, 'record-1', '/mock/project', 'main');
  return { sessionRepo, usageHistoryRepo };
}

/** Give a read that was never started the turns it would have needed. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const temporaryFolders: string[] = [];

function emptyFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'churn-standin-'));
  temporaryFolders.push(folder);
  return folder;
}

beforeEach(() => {
  churnRead.directories.length = 0;
  churnRead.outcome = { kind: 'churn' };
});

afterEach(() => {
  setRemoteGitResolver(null);
  vi.restoreAllMocks();
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('captureGitChurn for a remote project worktree', () => {
  it('reads and writes the stats for the empty stand-in folder a remote project holds here', async () => {
    const standIn = emptyFolder();
    setRemoteGitResolver((directory) => (directory === standIn ? ({} as unknown as RemoteGitRunner) : null));

    const { sessionRepo, usageHistoryRepo } = capture(standIn);

    const expectedStats = { linesAdded: 12, linesRemoved: 3, filesChanged: 2 };
    await vi.waitFor(() => expect(sessionRepo.setTaskGitStats).toHaveBeenCalledWith(['record-1'], 'record-1', expectedStats));
    expect(usageHistoryRepo.setTaskGitStats).toHaveBeenCalledWith(['record-1'], 'record-1', expectedStats);
    expect(churnRead.directories).toEqual([standIn]);
  });

  it('starts no read for the same folder when no remote project owns it', async () => {
    const folderWithNoGitFile = emptyFolder();

    const { sessionRepo, usageHistoryRepo } = capture(folderWithNoGitFile);
    await settle();

    expect(churnRead.directories).toEqual([]);
    expect(sessionRepo.setTaskGitStats).not.toHaveBeenCalled();
    expect(usageHistoryRepo.setTaskGitStats).not.toHaveBeenCalled();
  });
});

describe('the local log line for a failed churn read', () => {
  async function loggedLineFor(failure: unknown): Promise<string> {
    churnRead.outcome = { kind: 'failure', failure };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    capture('/mock/worktree-that-does-not-exist');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining(LOG_PREFIX)));
    const logged = warn.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith(LOG_PREFIX));
    return logged ?? '';
  }

  it('is the error line of a git failure that wrote one', async () => {
    const failure = new GitCommandError({ stdout: '', stderr: 'hint: something\nerror: pathspec did not match\n', exitCode: 1 });

    expect(await loggedLineFor(failure)).toBe(`${LOG_PREFIX}error: pathspec did not match`);
  });

  it('is the error name for a git failure with no fatal or error line, and never its stdout', async () => {
    const failure = new GitCommandError({ stdout: 'DISTINCTIVE-FILE-TEXT', stderr: 'warning: nothing to say\n', exitCode: 1 });

    const logged = await loggedLineFor(failure);

    expect(logged).toBe(`${LOG_PREFIX}GitCommandError`);
    expect(logged).not.toContain('DISTINCTIVE-FILE-TEXT');
  });

  it('is the name and code of a plain error that has a code', async () => {
    const failure = Object.assign(new Error('permission text'), { code: 'EACCES' });

    expect(await loggedLineFor(failure)).toBe(`${LOG_PREFIX}Error EACCES`);
  });

  it('is the name of a plain error with no code', async () => {
    expect(await loggedLineFor(new Error('some text'))).toBe(`${LOG_PREFIX}Error`);
  });

  it('is the type of a thrown value that is not an error', async () => {
    expect(await loggedLineFor('a thrown string')).toBe(`${LOG_PREFIX}string`);
  });
});
