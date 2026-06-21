/**
 * Unit tests for probePendingChanges -- the Done-move probe that reports
 * uncommitted files, at-risk local-only commits (gated on the repo having a
 * remote AND on the move force-deleting the branch), and the worktree's live
 * HEAD branch. The merge/remote-aware commit count itself lives in
 * countLocalOnlyCommits (covered by local-only-commits.test.ts) and is mocked
 * here so the probe's policy is tested in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The probe builds a simple-git instance and calls status() / getRemotes().
const mockGit = {
  status: vi.fn<() => Promise<{ files: unknown[] }>>(),
  getRemotes: vi.fn<() => Promise<unknown[]>>(),
  raw: vi.fn<(args: string[]) => Promise<string>>(),
};

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

// currentBranch comes from readWorktreeHead; mock it directly so the probe
// tests don't need a real repo for HEAD resolution.
const mockReadWorktreeHead = vi.fn<(path: string) => Promise<{ branch: string | null; sha: string | null }>>();
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: (path: string) => mockReadWorktreeHead(path),
}));

// The probe refreshes remote-tracking refs before counting. Mock it so the unit
// tests don't spawn a real fetch (the helper is covered in fetch-throttle.test.ts).
const mockFetchAllRemotesIfStale = vi.fn<(checkPath: string) => Promise<void>>();
vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchAllRemotesIfStale: (checkPath: string) => mockFetchAllRemotesIfStale(checkPath),
}));

// The merge/remote-aware count is mocked so the probe's autoCleanup policy is
// tested in isolation (the count's own logic is in local-only-commits.test.ts).
const mockCountLocalOnlyCommits = vi.fn<(checkPath: string, pr?: PrMergeContext) => Promise<number>>();
vi.mock('../../src/main/git/local-only-commits', () => ({
  countLocalOnlyCommits: (checkPath: string, pr?: PrMergeContext) => mockCountLocalOnlyCommits(checkPath, pr),
}));

// git-diff.ts imports these at module scope; stub them so the import resolves
// without Electron or real git wiring (the handler registration is unused here).
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/main/git/diff-service', () => ({ DiffService: class {} }));
vi.mock('../../src/main/git/diff-watcher', () => ({ DiffWatcher: class {} }));

import { probePendingChanges } from '../../src/main/ipc/handlers/git-diff';
import type { PrMergeContext } from '../../src/main/git/local-only-commits';

describe('probePendingChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.getRemotes.mockResolvedValue([]);
    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/work', sha: 'abc123' });
    mockFetchAllRemotesIfStale.mockResolvedValue(undefined);
    mockCountLocalOnlyCommits.mockResolvedValue(0);
  });

  it('counts uncommitted files from git status', async () => {
    mockGit.status.mockResolvedValue({ files: [{}, {}, {}] });

    const result = await probePendingChanges('/mock/worktree');

    expect(result.uncommittedFileCount).toBe(3);
    expect(result.hasPendingChanges).toBe(true);
  });

  it('reports the live HEAD branch', async () => {
    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/renamed', sha: 'deadbeef' });

    const result = await probePendingChanges('/mock/worktree');

    expect(result.currentBranch).toBe('feat/renamed');
  });

  it('returns null currentBranch on a detached HEAD', async () => {
    mockReadWorktreeHead.mockResolvedValue({ branch: null, sha: 'detached00' });

    const result = await probePendingChanges('/mock/worktree');

    expect(result.currentBranch).toBeNull();
  });

  it('skips the commit count entirely when the repo has no remotes', async () => {
    mockGit.getRemotes.mockResolvedValue([]);

    const result = await probePendingChanges('/mock/worktree');

    // The count must never run with no remotes (rev-list would count all history).
    expect(mockCountLocalOnlyCommits).not.toHaveBeenCalled();
    // With no remote there is nothing to refresh, so no fetch is attempted.
    expect(mockFetchAllRemotesIfStale).not.toHaveBeenCalled();
    expect(result.unpushedCommitCount).toBe(0);
  });

  it('counts at-risk commits when a remote exists and the branch will be deleted', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockCountLocalOnlyCommits.mockResolvedValue(4);

    const result = await probePendingChanges('/mock/worktree', { autoCleanup: true });

    expect(result.unpushedCommitCount).toBe(4);
    expect(result.hasPendingChanges).toBe(true);
  });

  it('defaults to the conservative (branch-deleted) policy when autoCleanup is omitted', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockCountLocalOnlyCommits.mockResolvedValue(2);

    const result = await probePendingChanges('/mock/worktree');

    expect(result.unpushedCommitCount).toBe(2);
    expect(result.hasPendingChanges).toBe(true);
  });

  it('does not warn about local-only commits when the branch will be kept (autoCleanup off)', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockCountLocalOnlyCommits.mockResolvedValue(5);

    const result = await probePendingChanges('/mock/worktree', { autoCleanup: false });

    // The branch survives, so the commits are recoverable and not at risk.
    expect(result.unpushedCommitCount).toBe(0);
    expect(result.hasPendingChanges).toBe(false);
  });

  it('still warns about uncommitted files even when the branch will be kept', async () => {
    mockGit.status.mockResolvedValue({ files: [{}] });
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockCountLocalOnlyCommits.mockResolvedValue(3);

    const result = await probePendingChanges('/mock/worktree', { autoCleanup: false });

    expect(result.uncommittedFileCount).toBe(1);
    expect(result.unpushedCommitCount).toBe(0);
    expect(result.hasPendingChanges).toBe(true);
  });

  it('forwards autoCleanup / prNumber / prState into the count', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);

    await probePendingChanges('/mock/worktree', { autoCleanup: true, prNumber: 7, prState: 'open' });

    expect(mockCountLocalOnlyCommits).toHaveBeenCalledWith('/mock/worktree', { prNumber: 7, prState: 'open' });
  });

  it('refreshes remote-tracking refs before counting', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);

    await probePendingChanges('/mock/worktree', { autoCleanup: true });

    expect(mockFetchAllRemotesIfStale).toHaveBeenCalledWith('/mock/worktree');
    // The fetch must complete before the count, otherwise it still reads stale
    // refs. invocationCallOrder is monotonic across all mocks.
    const fetchOrder = mockFetchAllRemotesIfStale.mock.invocationCallOrder[0];
    const countOrder = mockCountLocalOnlyCommits.mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(countOrder);
  });

  it('treats a count failure (unborn / detached) as zero', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockCountLocalOnlyCommits.mockRejectedValue(new Error('unknown revision HEAD'));

    const result = await probePendingChanges('/mock/worktree', { autoCleanup: true });

    expect(result.unpushedCommitCount).toBe(0);
  });

  it('reports no pending changes for a clean worktree with no remotes', async () => {
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.getRemotes.mockResolvedValue([]);

    const result = await probePendingChanges('/mock/worktree');

    expect(result.hasPendingChanges).toBe(false);
    expect(result.uncommittedFileCount).toBe(0);
    expect(result.unpushedCommitCount).toBe(0);
  });

  it('returns a safe default when git status throws', async () => {
    mockGit.status.mockRejectedValue(new Error('not a git repository'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });

  // -------------------------------------------------------------------------
  // Outer-catch branches: failures that happen AFTER status() succeeds.
  //
  // The outer try/catch in probePendingChanges is structured so that any
  // exception thrown after `git.status()` (e.g. from readWorktreeHead or
  // git.getRemotes) still lands in the same catch block and returns the safe
  // default. These tests confirm that the fallback fires for post-status
  // failures, not just for the status() call itself.
  // -------------------------------------------------------------------------

  it('returns a safe default when getRemotes() rejects after status() succeeds', async () => {
    mockGit.status.mockResolvedValue({ files: [{}] });
    mockGit.getRemotes.mockRejectedValue(new Error('could not read git config'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });

  it('returns the safe default if the freshness fetch rejects unexpectedly', async () => {
    // fetchAllRemotesIfStale is contracted to never reject, but the call site
    // sits outside the inner count try so that if it ever did, the outer catch
    // (safe default) fires rather than a false 0 count. This locks that
    // placement against future refactors.
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockFetchAllRemotesIfStale.mockRejectedValue(new Error('unexpected fetch failure'));

    const result = await probePendingChanges('/mock/worktree', { autoCleanup: true });

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });

  it('returns a safe default when readWorktreeHead rejects after status() succeeds', async () => {
    mockGit.status.mockResolvedValue({ files: [] });
    mockReadWorktreeHead.mockRejectedValue(new Error('unexpected read failure'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });
});
