/**
 * When `resolveWorktreeBase` (`src/main/git/base-branch.ts`) tries a base as a
 * tag on origin. Every branch candidate that misses locally is fetched, and each
 * fetch is capped at 15 s. A tag fetch after it is a second capped wait, so it
 * runs only where it can help: for a task's own base (a project default is a
 * branch), and never after a branch fetch that could not reach origin at all.
 * Mocked, because the claim is about which fetches run, not what git returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchFailureReason, FetchIfStaleOutcome } from '../../src/main/git/fetch-throttle';

const { mockFetchIfStale, mockFetchTagFromOrigin } = vi.hoisted(() => ({
  mockFetchIfStale: vi.fn(),
  mockFetchTagFromOrigin: vi.fn(async () => false),
}));

vi.mock('../../src/main/git/git-checks', () => ({ hasCommits: vi.fn(async () => true) }));
vi.mock('../../src/main/git/git-client', () => ({ gitAt: vi.fn(() => ({})) }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ fetchIfStale: mockFetchIfStale }));
vi.mock('../../src/main/git/base-ref', async (importOriginal) => ({
  // The pure start-point rule stays real; only the git-touching readers are stubbed.
  fixedBaseStartPoint: (await importOriginal<typeof import('../../src/main/git/base-ref')>()).fixedBaseStartPoint,
  classifyBaseRef: vi.fn(async () => ({ kind: 'unresolved' })),
  peelToCommit: vi.fn(async () => null),
  preferredBranchStartPoint: vi.fn(async () => null),
  fetchTagFromOrigin: mockFetchTagFromOrigin,
}));
vi.mock('../../src/main/utility-process/off-main-exec', () => ({
  execFileAsync: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

import { resolveWorktreeBase } from '../../src/main/git/base-branch';
import { classifyBaseRef } from '../../src/main/git/base-ref';

function branchFetchFails(reason: FetchFailureReason): void {
  mockFetchIfStale.mockImplementation(async (
    _git: unknown, _path: string, branch: string,
    options?: { onOutcome?: (outcome: FetchIfStaleOutcome) => void },
  ) => {
    options?.onOutcome?.({ kind: 'failed', reason, message: 'fatal' });
    return branch;
  });
}

describe('resolveWorktreeBase - the tag fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchTagFromOrigin.mockResolvedValue(false);
  });

  it('tries a task\'s own base as a tag on origin when the branch fetch found no such branch', async () => {
    branchFetchFails('branch-missing');
    mockFetchTagFromOrigin.mockResolvedValue(true);

    const resolution = await resolveWorktreeBase('/project', 'v2.4.0', 'main');

    expect(resolution).toEqual({ kind: 'resolved', baseBranch: 'v2.4.0', startPoint: 'refs/tags/v2.4.0' });
  });

  it('resolves a base the fetch brought in, and that now classifies as a commit, to that sha', async () => {
    const fullSha = '0123456789abcdef0123456789abcdef01234567';
    branchFetchFails('branch-missing');
    // The local pass finds nothing; after the fetch the same name reads as a commit.
    vi.mocked(classifyBaseRef)
      .mockResolvedValueOnce({ kind: 'unresolved' })
      .mockResolvedValueOnce({ kind: 'commit', sha: fullSha });

    const resolution = await resolveWorktreeBase('/project', fullSha, 'main');

    expect(resolution).toEqual({ kind: 'resolved', baseBranch: fullSha, startPoint: fullSha });
  });

  it.each(['no-remote', 'network', 'timeout', 'auth', 'abort'] as const)(
    'skips the tag fetch after a branch fetch that failed with %s',
    async (reason) => {
      branchFetchFails(reason);

      const resolution = await resolveWorktreeBase('/project', 'v2.4.0', 'main');

      expect(resolution.kind).toBe('unresolvable');
      expect(mockFetchTagFromOrigin).not.toHaveBeenCalled();
    },
  );

  it('never tries the project default chain as a tag', async () => {
    branchFetchFails('branch-missing');

    const resolution = await resolveWorktreeBase('/project', null, 'develop');

    expect(resolution.kind).toBe('unresolvable');
    expect(mockFetchIfStale).toHaveBeenCalledTimes(3);
    expect(mockFetchTagFromOrigin).not.toHaveBeenCalled();
  });
});
