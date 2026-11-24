/**
 * How a commit that failed puts the index back. A restore that could not run must
 * never fall back to `rm --cached` in a repository with commits: that stages the
 * deletion of every file, and the next Commit takes what is staged.
 *
 * git is faked here because the failure is a moment (another process holding the
 * index while the restore runs and gone after). The real restore is in
 * git-actions.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  exitCodes: {} as Record<string, number | null>,
  calls: [] as string[][],
}));

vi.mock('../../src/main/git/remote-git', () => ({ remoteGitRunnerFor: () => null }));
vi.mock('../../src/main/git-actions/run-git-captured', () => ({
  outputTail: () => 'lint: 2 problems',
  runGitCaptured: async (_directory: string, args: readonly string[]) => {
    state.calls.push([...args]);
    const exitCode = state.exitCodes[args[0]] ?? 0;
    return { exitCode, stdout: '', stderr: '', unfinished: null };
  },
}));

import { commitChanges } from '../../src/main/git-actions/commit-and-push';
import type { GitWorkDetail } from '../../src/main/git/work-state';

const WORK = { stagedFileCount: 0 } as GitWorkDetail;
const verbs = (): string[] => state.calls.map((call) => call[0]);

beforeEach(() => {
  state.calls = [];
  state.exitCodes = {};
});

describe('undoing the staging of a commit that failed', () => {
  it('never removes files from the index of a repository with commits, even when the restore fails', async () => {
    state.exitCodes = { commit: 1, restore: 128 };
    await commitChanges('/repo', WORK, 'feat: x');
    expect(verbs()).toEqual(['rev-parse', 'add', 'commit', 'restore']);
  });

  it('does not take a git that could not answer for a repository with no commits', async () => {
    state.exitCodes = { 'rev-parse': 128, commit: 1 };
    await commitChanges('/repo', WORK, 'feat: x');
    expect(verbs()).not.toContain('rm');
  });

  it('removes them before the first commit, where there is nothing to restore from', async () => {
    state.exitCodes = { 'rev-parse': 1, commit: 1 };
    await commitChanges('/repo', WORK, 'feat: x');
    expect(verbs()).toEqual(['rev-parse', 'add', 'commit', 'rm']);
  });

  it('leaves what the user staged alone', async () => {
    state.exitCodes = { commit: 1 };
    await commitChanges('/repo', { ...WORK, stagedFileCount: 1 }, 'feat: x');
    expect(verbs()).toEqual(['commit']);
  });
});
