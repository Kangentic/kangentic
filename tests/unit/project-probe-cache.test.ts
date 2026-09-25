/**
 * Unit tests for the `project:probePath` in-flight de-dupe + short TTL cache
 * (`src/renderer/utils/project-probe.ts`).
 *
 * Mirrors `git-branches.test.ts`'s strategy (concurrent de-dupe, fresh-cache
 * serve, TTL expiry, no-cache-on-rejection) with the one structural
 * difference the module itself calls out: this cache is keyed by PATH, not by
 * the current project id. `fetchProjectProbe` also reads `window.electronAPI`
 * directly rather than a Zustand store, so there is no `useProjectStore` mock
 * to drive - the path argument alone selects the cache entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProjectPathProbe } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  probePath: vi.fn(),
}));

import { fetchProjectProbe, invalidateProjectProbeCache } from '../../src/renderer/utils/project-probe';

function makeProbe(overrides: Partial<ProjectPathProbe> = {}): ProjectPathProbe {
  return {
    exists: true,
    isDirectory: true,
    isGitRepo: true,
    isInsideWorktree: false,
    hasCommits: true,
    currentBranch: 'main',
    suggestedName: 'project',
    alreadyRegisteredProjectId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  invalidateProjectProbeCache();
  (globalThis as unknown as { window: { electronAPI: { projects: { probePath: typeof mocks.probePath } } } }).window = {
    electronAPI: { projects: { probePath: mocks.probePath } },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchProjectProbe', () => {
  it('collapses two concurrent calls for the same path into a single IPC invocation', async () => {
    const probe = makeProbe();
    mocks.probePath.mockResolvedValue(probe);

    const first = fetchProjectProbe('/mock/projects/repo-a');
    const second = fetchProjectProbe('/mock/projects/repo-a'); // concurrent, before the first resolves

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(probe);
    expect(b).toBe(probe);
    expect(mocks.probePath).toHaveBeenCalledTimes(1);
  });

  // The load-bearing difference from git-branches.ts: this cache keys on the
  // PATH argument, never the current project id, so two different paths never
  // share an entry - a task hosted from the Agent Monitor must probe its OWN
  // project rather than serving whatever the open board last probed.
  it('keys the cache by path: two different paths each get their own probe and their own IPC call', async () => {
    const probeA = makeProbe({ suggestedName: 'repo-a' });
    const probeB = makeProbe({ suggestedName: 'repo-b' });
    mocks.probePath.mockImplementation(async (path: string) => (path === '/mock/projects/repo-a' ? probeA : probeB));

    const resultA = await fetchProjectProbe('/mock/projects/repo-a');
    const resultB = await fetchProjectProbe('/mock/projects/repo-b');

    expect(resultA.suggestedName).toBe('repo-a');
    expect(resultB.suggestedName).toBe('repo-b');
    expect(mocks.probePath).toHaveBeenCalledTimes(2);
    expect(mocks.probePath).toHaveBeenNthCalledWith(1, '/mock/projects/repo-a');
    expect(mocks.probePath).toHaveBeenNthCalledWith(2, '/mock/projects/repo-b');

    // Re-probing path A within the TTL must still serve A's cached entry, not
    // whatever the most-recently-probed path (B) returned.
    const resultAAgain = await fetchProjectProbe('/mock/projects/repo-a');
    expect(resultAAgain.suggestedName).toBe('repo-a');
    expect(mocks.probePath).toHaveBeenCalledTimes(2);
  });

  it('serves a fresh cache without a second IPC call', async () => {
    mocks.probePath.mockResolvedValue(makeProbe());
    await fetchProjectProbe('/mock/projects/repo-a');
    // Well within the 15s TTL.
    await vi.advanceTimersByTimeAsync(1_000);
    await fetchProjectProbe('/mock/projects/repo-a');
    expect(mocks.probePath).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache TTL has elapsed', async () => {
    mocks.probePath.mockResolvedValue(makeProbe());
    await fetchProjectProbe('/mock/projects/repo-a');
    // Past the 15s TTL.
    await vi.advanceTimersByTimeAsync(15_001);
    await fetchProjectProbe('/mock/projects/repo-a');
    expect(mocks.probePath).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejection: the next call for the same path retries', async () => {
    mocks.probePath.mockRejectedValueOnce(new Error('probe failed'));
    await expect(fetchProjectProbe('/mock/projects/repo-a')).rejects.toThrow('probe failed');

    mocks.probePath.mockResolvedValueOnce(makeProbe());
    await expect(fetchProjectProbe('/mock/projects/repo-a')).resolves.toMatchObject({ isGitRepo: true });
    expect(mocks.probePath).toHaveBeenCalledTimes(2);
  });
});
