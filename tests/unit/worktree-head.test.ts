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

import { readWorktreeHead, hasCommitsAheadOfBase } from '../../src/main/git/worktree-head';

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
