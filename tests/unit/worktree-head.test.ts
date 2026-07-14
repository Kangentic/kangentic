/**
 * Unit tests for readWorktreeHead -- the helper that reads the live HEAD
 * branch and tip SHA from a worktree without a real git repository.
 *
 * The function wraps two `simpleGit(path).revparse()` calls:
 *   1. `--abbrev-ref HEAD` -> the symbolic branch name, or the literal string
 *      "HEAD" when the repo is in a detached-HEAD state.
 *   2. `HEAD` -> the full commit SHA.
 *
 * `branch` is null when:
 *   - the abbrev-ref output is the literal string "HEAD" (detached HEAD)
 *   - the output is empty or only whitespace
 *   - any git error is thrown
 * `sha` is null only when a git error is thrown; it survives a detached HEAD.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One shared mock object that both revparse and raw calls route through. The
// mocks are configured per-test to return the desired values.
const mockGit = {
  revparse: vi.fn<(args: string[]) => Promise<string>>(),
  raw: vi.fn<(args: string[]) => Promise<string>>(),
};

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGit),
}));

import { readWorktreeHead, readWorktreeHeadUnqueued, hasCommitsAheadOfBase } from '../../src/main/git/worktree-head';
import { viaGitRead } from '../../src/main/git/git-read-queue';

describe('readWorktreeHead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the branch name and SHA for a normal (attached) HEAD', async () => {
    // First call: abbrev-ref returns the branch name.
    // Second call: HEAD returns the commit SHA.
    mockGit.revparse
      .mockResolvedValueOnce('feat/my-feature\n')
      .mockResolvedValueOnce('a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4\n');

    const result = await readWorktreeHead('/mock/worktree');

    expect(result.branch).toBe('feat/my-feature');
    expect(result.sha).toBe('a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4');
  });

  it('returns branch: null when abbrev-ref outputs the literal string "HEAD" (detached HEAD)', async () => {
    // In a detached-HEAD state git prints "HEAD" as the abbrev-ref output.
    // The SHA is still valid and should be returned.
    mockGit.revparse
      .mockResolvedValueOnce('HEAD\n')
      .mockResolvedValueOnce('deadbeef00000000000000000000000000000000\n');

    const result = await readWorktreeHead('/mock/worktree');

    expect(result.branch).toBeNull();
    expect(result.sha).toBe('deadbeef00000000000000000000000000000000');
  });

  it('returns branch: null when abbrev-ref outputs empty or whitespace-only', async () => {
    // Some git configurations emit an empty string instead of a branch name
    // when the repo has no commits yet (unborn branch).
    mockGit.revparse
      .mockResolvedValueOnce('   \n')
      .mockResolvedValueOnce('0000000000000000000000000000000000000000\n');

    const result = await readWorktreeHead('/mock/worktree');

    expect(result.branch).toBeNull();
    // SHA can still be valid in some unborn states (it may also be empty; test
    // only the branch null-guard here since that is the invariant under test).
  });

  it('returns { branch: null, sha: null } when git throws', async () => {
    // If the worktree directory is gone or not a git repo, simpleGit throws.
    // The catch block returns the all-null safe default.
    mockGit.revparse.mockRejectedValue(new Error('not a git repository'));

    const result = await readWorktreeHead('/mock/missing-worktree');

    expect(result.branch).toBeNull();
    expect(result.sha).toBeNull();
  });

  it('invokes simpleGit with the caller-supplied path', async () => {
    const { simpleGit } = await import('simple-git');
    mockGit.revparse
      .mockResolvedValueOnce('main\n')
      .mockResolvedValueOnce('cafebabe00000000000000000000000000000000\n');

    await readWorktreeHead('/mock/specific-path');

    expect(simpleGit).toHaveBeenCalledWith('/mock/specific-path');
  });

  it('calls revparse with --abbrev-ref HEAD and HEAD in order', async () => {
    mockGit.revparse
      .mockResolvedValueOnce('main\n')
      .mockResolvedValueOnce('abc000\n');

    await readWorktreeHead('/mock/worktree');

    expect(mockGit.revparse).toHaveBeenNthCalledWith(1, ['--abbrev-ref', 'HEAD']);
    expect(mockGit.revparse).toHaveBeenNthCalledWith(2, ['HEAD']);
  });

  it('trims surrounding whitespace from the branch name and SHA', async () => {
    // Verify the trim() calls so callers can rely on clean output.
    mockGit.revparse
      .mockResolvedValueOnce('  release/v2.0  \n')
      .mockResolvedValueOnce('  beef1234  \n');

    const result = await readWorktreeHead('/mock/worktree');

    expect(result.branch).toBe('release/v2.0');
    expect(result.sha).toBe('beef1234');
  });
});

/**
 * hasCommitsAheadOfBase is the Tier-3 guard that keeps the PR confidence ladder
 * from attributing a base-branch tip (which a freshly-branched worktree sits on)
 * to the task. `rev-list --count <base>..<sha>` is the number of commits
 * reachable from <sha> but not from <base>: 0 means the commit is already
 * contained in base (a branchless worktree, or any rebase/squash/merge tip), so
 * the commit anchor must be skipped; >0 means the commit is the task's own work.
 */
describe('hasCommitsAheadOfBase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the commit has commits of its own ahead of base (count > 0)', async () => {
    mockGit.raw.mockResolvedValue('3');
    expect(await hasCommitsAheadOfBase('/mock/repo', 'main', 'abc123')).toBe(true);
  });

  it('returns false when the commit is already contained in base (count 0)', async () => {
    // A fresh worktree sits on base's tip: 0 commits ahead -> skip the anchor so
    // the last-merged PR is never attributed to the task.
    mockGit.raw.mockResolvedValue('0');
    expect(await hasCommitsAheadOfBase('/mock/repo', 'main', 'base-tip')).toBe(false);
  });

  it('tolerates surrounding whitespace and a trailing newline', async () => {
    mockGit.raw.mockResolvedValue('  2\n');
    expect(await hasCommitsAheadOfBase('/mock/repo', 'main', 'abc123')).toBe(true);
  });

  it('returns false when git throws (fails safe -> skip the anchor, never fails open)', async () => {
    mockGit.raw.mockRejectedValue(new Error('fatal: bad revision main..missing'));
    expect(await hasCommitsAheadOfBase('/mock/repo', 'main', 'missing')).toBe(false);
  });

  it('queries rev-list --count for <base>..<sha>', async () => {
    mockGit.raw.mockResolvedValue('1');
    await hasCommitsAheadOfBase('/mock/repo', 'develop', 'abc123');
    expect(mockGit.raw).toHaveBeenCalledWith(['rev-list', '--count', 'develop..abc123']);
  });
});

/**
 * Both helpers run through the global git read queue (viaGitRead), so a burst
 * of callers (batch Done-moves, PR-link fan-in) never spawns unbounded git
 * children. Red-green: these fail if a refactor silently unwraps the queue.
 */
describe('git read queue wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caps concurrent readWorktreeHead jobs at the queue concurrency (2)', async () => {
    const gates: Array<() => void> = [];
    // The FIRST revparse of each job blocks on a gate; a job's second revparse
    // resolves immediately. Jobs admitted = gates created.
    mockGit.revparse.mockImplementation((args: string[]) => {
      if (args[0] === '--abbrev-ref') {
        return new Promise<string>((resolve) => {
          gates.push(() => resolve('main\n'));
        });
      }
      return Promise.resolve('abc123\n');
    });

    const jobs = Array.from({ length: 4 }, () => readWorktreeHead('/mock/worktree'));

    await expect.poll(() => gates.length).toBe(2);
    // Let any stray microtasks run; still only 2 admitted.
    await new Promise((resolve) => setImmediate(resolve));
    expect(gates.length).toBe(2);

    // Draining the gates admits the remaining jobs.
    while (gates.length > 0) {
      gates.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(jobs);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result).toEqual({ branch: 'main', sha: 'abc123' });
    }
  });

  it('caps concurrent hasCommitsAheadOfBase jobs at the queue concurrency (2)', async () => {
    // Every hasCommitsAheadOfBase call blocks on a gate; jobs admitted = gates
    // created. Red-green: fails (4 gates instead of 2) if viaGitRead is ever
    // unwrapped from hasCommitsAheadOfBase.
    const gates: Array<() => void> = [];
    mockGit.raw.mockImplementation(() => {
      return new Promise<string>((resolve) => {
        gates.push(() => resolve('3'));
      });
    });

    const jobs = Array.from({ length: 4 }, (_, index) =>
      hasCommitsAheadOfBase('/mock/repo', 'main', `sha-${index}`),
    );

    await expect.poll(() => gates.length).toBe(2);
    // Let any stray microtasks run; still only 2 admitted.
    await new Promise((resolve) => setImmediate(resolve));
    expect(gates.length).toBe(2);

    // Draining the gates admits the remaining jobs.
    while (gates.length > 0) {
      gates.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(jobs);
    expect(results).toEqual([true, true, true, true]);
  });

  it('readWorktreeHeadUnqueued bypasses the global read queue entirely', async () => {
    // Interactive single-flight panel paths (branch-summary.ts,
    // commit-graph.ts) must not wait behind a BACKGROUND churn capture
    // holding both queue slots. Saturate both slots with jobs that never
    // resolve on their own, then confirm readWorktreeHeadUnqueued still
    // resolves. Red-green: fails (times out) if the unqueued variant is
    // ever re-wrapped in viaGitRead.
    const blockerGates: Array<() => void> = [];
    const blockerJobs = Array.from({ length: 2 }, () =>
      viaGitRead(() => new Promise<void>((resolve) => { blockerGates.push(resolve); })),
    );
    await expect.poll(() => blockerGates.length).toBe(2);

    mockGit.revparse
      .mockResolvedValueOnce('feat/unqueued\n')
      .mockResolvedValueOnce('deadbeef00000000000000000000000000000000\n');

    const result = await readWorktreeHeadUnqueued('/mock/worktree-unqueued');

    expect(result).toEqual({
      branch: 'feat/unqueued',
      sha: 'deadbeef00000000000000000000000000000000',
    });

    // Clean up so the shared queue starts the next test empty.
    for (const release of blockerGates) release();
    await Promise.all(blockerJobs);
  });
});
