/**
 * Unit tests for the git:listBranches in-flight de-dupe + short TTL cache
 * (`src/renderer/utils/git-branches.ts`).
 *
 * The handler shells out to git (~900ms); opening a task dialog fires two
 * concurrent list calls (the dialog's existence check + the embedded
 * BranchPicker). These tests lock that concurrent calls collapse to one IPC,
 * a fresh cache serves without IPC, the cache expires, a project switch forces
 * a refetch, and rejections are not cached.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useProjectStore: { getState: vi.fn() },
  listBranches: vi.fn(),
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: mocks.useProjectStore }));

import { fetchGitBranches, invalidateGitBranchesCache } from '../../src/renderer/utils/git-branches';

function setProject(id: string | null): void {
  mocks.useProjectStore.getState.mockReturnValue({ currentProject: id ? { id } : null });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  invalidateGitBranchesCache();
  setProject('project-1');
  (globalThis as unknown as { window: { electronAPI: { git: { listBranches: typeof mocks.listBranches } } } }).window = {
    electronAPI: { git: { listBranches: mocks.listBranches } },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchGitBranches', () => {
  it('collapses two concurrent calls into a single IPC invocation', async () => {
    mocks.listBranches.mockResolvedValue(['main', 'dev']);

    const first = fetchGitBranches();
    const second = fetchGitBranches(); // concurrent, before the first resolves

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(['main', 'dev']);
    expect(b).toEqual(['main', 'dev']);
    expect(mocks.listBranches).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh cache without a second IPC call', async () => {
    mocks.listBranches.mockResolvedValue(['main']);
    await fetchGitBranches();
    // Well within the TTL.
    await vi.advanceTimersByTimeAsync(1_000);
    await fetchGitBranches();
    expect(mocks.listBranches).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache TTL has elapsed', async () => {
    mocks.listBranches.mockResolvedValue(['main']);
    await fetchGitBranches();
    // Past the 15s TTL.
    await vi.advanceTimersByTimeAsync(15_001);
    await fetchGitBranches();
    expect(mocks.listBranches).toHaveBeenCalledTimes(2);
  });

  it('refetches when the current project changes, even within the TTL', async () => {
    mocks.listBranches.mockResolvedValue(['main']);
    await fetchGitBranches();
    expect(mocks.listBranches).toHaveBeenCalledTimes(1);

    // Switch projects: the cached branches belong to the old repo and must not
    // be served for the new one.
    setProject('project-2');
    await fetchGitBranches();
    expect(mocks.listBranches).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejection: the next call retries', async () => {
    mocks.listBranches.mockRejectedValueOnce(new Error('git failed'));
    await expect(fetchGitBranches()).rejects.toThrow('git failed');

    mocks.listBranches.mockResolvedValueOnce(['main']);
    await expect(fetchGitBranches()).resolves.toEqual(['main']);
    expect(mocks.listBranches).toHaveBeenCalledTimes(2);
  });
});
