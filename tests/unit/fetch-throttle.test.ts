/**
 * Unit tests for fetchIfStale.
 *
 * Covers the four code paths:
 *   1. Cached: skip spawn, return origin/branch
 *   2. Success: spawn resolves, populate cache, return origin/branch
 *   3. Timeout: spawn-with-timeout throws timeout error, log warning, fall back to local
 *   4. Abort: external AbortSignal aborts, fall back to local (no warning)
 *
 * Plus: cache integrity (timeout/abort must NOT poison the cache).
 *
 * runGitWithTimeout is mocked at the module boundary so we exercise
 * fetchIfStale's own logic without spawning real subprocesses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRunGitWithTimeout, mockIsGitTimeoutError } = vi.hoisted(() => ({
  mockRunGitWithTimeout: vi.fn(),
  mockIsGitTimeoutError: vi.fn((error: unknown): boolean => {
    return error instanceof Error && error.message.includes('aborted (timeout after');
  }),
}));

vi.mock('../../src/main/git/git-spawn', () => ({
  runGitWithTimeout: mockRunGitWithTimeout,
  isGitTimeoutError: mockIsGitTimeoutError,
}));

import { fetchIfStale, fetchAllRemotesIfStale, clearFetchCache, classifyFetchFailure } from '../../src/main/git/fetch-throttle';
import type { FetchFailureReason, FetchIfStaleOutcome } from '../../src/main/git/fetch-throttle';
import type { SimpleGit } from 'simple-git';

const PROJECT_PATH = '/mock/project';
const BRANCH = 'main';
const stubGit = {} as SimpleGit;

describe('fetchIfStale', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearFetchCache();
    mockRunGitWithTimeout.mockReset();
    // mockClear preserves implementation; mockReset would wipe the
    // hoisted-factory implementation that classifies timeout errors.
    mockIsGitTimeoutError.mockClear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns origin/<branch> and populates cache on success', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(`origin/${BRANCH}`);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockRunGitWithTimeout).toHaveBeenCalledWith(
      PROJECT_PATH,
      ['fetch', 'origin', BRANCH],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('skips spawn on a second call within the throttle window', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(1);

    mockRunGitWithTimeout.mockClear();
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(`origin/${BRANCH}`);
    expect(mockRunGitWithTimeout).not.toHaveBeenCalled();
  });

  it('falls back to local branch and logs warning on timeout', async () => {
    const timeoutError = new Error('git fetch origin main aborted (timeout after 15000ms) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(timeoutError);

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(BRANCH); // local fallback, NOT origin/branch
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FETCH] timed out'));
  });

  it('does NOT cache the timeout outcome - next call retries', async () => {
    const timeoutError = new Error('git fetch origin main aborted (timeout after 15000ms) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(timeoutError);
    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(1);

    // Next call should retry, not return from cache
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(`origin/${BRANCH}`);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('falls back to local branch on external AbortSignal cancellation (no warning)', async () => {
    const abortError = new Error('git fetch origin main aborted (external abort) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(abortError);

    const controller = new AbortController();
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { signal: controller.signal });

    expect(result).toBe(BRANCH);
    expect(warnSpy).not.toHaveBeenCalled(); // abort is not a timeout, no log noise
  });

  it('falls back to local branch on generic git error (no warning, no cache)', async () => {
    mockRunGitWithTimeout.mockRejectedValueOnce(new Error('fatal: no remote named origin'));

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(BRANCH);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('forwards the AbortSignal to runGitWithTimeout', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const controller = new AbortController();

    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { signal: controller.signal });

    expect(mockRunGitWithTimeout).toHaveBeenCalledWith(
      PROJECT_PATH,
      ['fetch', 'origin', BRANCH],
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('fetchIfStale onOutcome', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearFetchCache();
    mockRunGitWithTimeout.mockReset();
    mockIsGitTimeoutError.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reports fetched on success', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const outcomes: FetchIfStaleOutcome[] = [];

    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { onOutcome: (outcome) => outcomes.push(outcome) });

    expect(outcomes).toEqual([{ kind: 'fetched' }]);
  });

  it('reports throttled on a cache hit, without spawning', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);
    mockRunGitWithTimeout.mockClear();

    const outcomes: FetchIfStaleOutcome[] = [];
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { onOutcome: (outcome) => outcomes.push(outcome) });

    expect(result).toBe(`origin/${BRANCH}`);
    expect(outcomes).toEqual([{ kind: 'throttled' }]);
    expect(mockRunGitWithTimeout).not.toHaveBeenCalled();
  });

  it('reports a classified failure carrying the error message', async () => {
    const timeoutError = new Error('git fetch origin main aborted (timeout after 15000ms) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(timeoutError);
    const outcomes: FetchIfStaleOutcome[] = [];

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { onOutcome: (outcome) => outcomes.push(outcome) });

    expect(result).toBe(BRANCH);
    expect(outcomes).toEqual([{ kind: 'failed', reason: 'timeout', message: timeoutError.message }]);
  });

  it('a throwing onOutcome never changes the returned start point', async () => {
    const throwingObserver = () => { throw new Error('observer bug'); };

    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await expect(fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { onOutcome: throwingObserver }))
      .resolves.toBe(`origin/${BRANCH}`);

    clearFetchCache();
    mockRunGitWithTimeout.mockRejectedValueOnce(new Error('fatal: unable to access remote'));
    await expect(fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { onOutcome: throwingObserver }))
      .resolves.toBe(BRANCH);
  });
});

describe('classifyFetchFailure', () => {
  // Realistic messages in the shape spawnWithAbort actually rejects with:
  // `${label} exited with code ${code}: ${stderr}` for non-zero exits, and the
  // abort/timeout/kill shapes for the rest.
  const cases: Array<{ label: string; message: string; expected: FetchFailureReason }> = [
    {
      label: 'timeout abort',
      message: 'git fetch origin main aborted (timeout after 15000ms) (child process killed)',
      expected: 'timeout',
    },
    {
      label: 'signal kill asserting timeout',
      message: 'git fetch origin main killed by signal SIGKILL after 15000ms timeout',
      expected: 'timeout',
    },
    {
      label: 'external abort',
      message: 'git fetch origin main aborted (external abort) (child process killed)',
      expected: 'abort',
    },
    {
      label: 'abort before spawn',
      message: 'git fetch origin main aborted before spawn',
      expected: 'abort',
    },
    {
      label: 'branch missing on remote',
      message: "git fetch origin foo exited with code 128: fatal: couldn't find remote ref foo",
      expected: 'branch-missing',
    },
    {
      label: 'no remote configured',
      message: "git fetch origin main exited with code 128: fatal: 'origin' does not appear to be a git repository",
      expected: 'no-remote',
    },
    {
      label: 'https authentication failed',
      message: "git fetch origin main exited with code 128: fatal: Authentication failed for 'https://github.com/acme/app.git/'",
      expected: 'auth',
    },
    {
      label: 'ssh publickey denied (auth wins over its network-sounding tail)',
      message: 'git fetch origin main exited with code 128: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      expected: 'auth',
    },
    {
      label: 'credential prompt disabled',
      message: "git fetch origin main exited with code 128: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      expected: 'auth',
    },
    {
      label: 'https 403 wrapped in unable-to-access (auth wins over network)',
      message: "git fetch origin main exited with code 128: fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
      expected: 'auth',
    },
    {
      label: 'dns resolution failure',
      message: "git fetch origin main exited with code 128: fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
      expected: 'network',
    },
    {
      label: 'connection refused over ssh',
      message: 'git fetch origin main exited with code 128: ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.',
      expected: 'network',
    },
    {
      label: 'unrecognized git error',
      message: 'git fetch origin main exited with code 128: fatal: bad config line 3 in file .git/config',
      expected: 'other',
    },
    {
      // Red-green for the "Permission denied \(" narrowing: git-for-Windows
      // emits a BARE "Permission denied" for local file locks (antivirus, a
      // live agent holding a pack file). That is not an auth failure, and
      // toasting "authentication failed" for it would be confidently wrong.
      label: 'windows local file lock (bare Permission denied is NOT auth)',
      message: "git fetch origin main exited with code 128: error: unable to unlink old '.git/objects/pack/pack-1a2b3c.idx': Permission denied",
      expected: 'other',
    },
  ];

  for (const { label, message, expected } of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(classifyFetchFailure(new Error(message))).toBe(expected);
    });
  }

  it('classifies a non-Error value as other', () => {
    expect(classifyFetchFailure('exploded')).toBe('other');
  });
});

describe('fetchAllRemotesIfStale', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const WORKTREE_PATH = '/mock/repo/.kangentic/worktrees/a';
  const SIBLING_WORKTREE_PATH = '/mock/repo/.kangentic/worktrees/b';
  const COMMON_DIR_OUTPUT = '/mock/repo/.git\n';

  // The helper makes two spawn calls per invocation: `rev-parse
  // --git-common-dir` (repo identity for the throttle key), then the actual
  // `fetch --all`. Route the mock by the leading git subcommand so order and
  // count are explicit.
  function routeByGitSubcommand(
    fetchBehavior: () => Promise<{ stdout: string; stderr: string }>,
    commonDirOutput: string = COMMON_DIR_OUTPUT,
  ): void {
    mockRunGitWithTimeout.mockImplementation((_checkPath: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: commonDirOutput, stderr: '' });
      }
      return fetchBehavior();
    });
  }

  function fetchCallCount(): number {
    return mockRunGitWithTimeout.mock.calls.filter((call) => call[1][0] === 'fetch').length;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    clearFetchCache();
    mockRunGitWithTimeout.mockReset();
    mockIsGitTimeoutError.mockClear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fetches all remotes with prune and quiet using the probe timeout', async () => {
    routeByGitSubcommand(() => Promise.resolve({ stdout: '', stderr: '' }));

    await fetchAllRemotesIfStale(WORKTREE_PATH);

    expect(mockRunGitWithTimeout).toHaveBeenCalledWith(
      WORKTREE_PATH,
      ['fetch', '--all', '--prune', '--quiet'],
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it('throttles by common dir: two worktrees of the same repo share one fetch', async () => {
    routeByGitSubcommand(() => Promise.resolve({ stdout: '', stderr: '' }));

    await fetchAllRemotesIfStale(WORKTREE_PATH);
    await fetchAllRemotesIfStale(SIBLING_WORKTREE_PATH);

    // Both worktrees resolve to /mock/repo/.git, so the second call is throttled.
    expect(fetchCallCount()).toBe(1);
  });

  it('never rejects and does not cache on fetch failure (next call retries)', async () => {
    routeByGitSubcommand(() => Promise.reject(new Error('fatal: unable to access remote')));

    await expect(fetchAllRemotesIfStale(WORKTREE_PATH)).resolves.toBeUndefined();
    expect(fetchCallCount()).toBe(1);

    // Failure left the cache empty, so a second call attempts the fetch again.
    await fetchAllRemotesIfStale(WORKTREE_PATH);
    expect(fetchCallCount()).toBe(2);
  });

  it('logs a warning on timeout only', async () => {
    const timeoutError = new Error('git fetch --all --prune --quiet aborted (timeout after 5000ms) (child process killed)');
    routeByGitSubcommand(() => Promise.reject(timeoutError));

    await fetchAllRemotesIfStale(WORKTREE_PATH);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FETCH] all-remotes refresh timed out'));
  });

  it('does not log a warning on a generic (non-timeout) fetch error', async () => {
    routeByGitSubcommand(() => Promise.reject(new Error('fatal: no remote named origin')));

    await fetchAllRemotesIfStale(WORKTREE_PATH);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to checkPath as the cache key when rev-parse fails', async () => {
    // rev-parse rejects, so the identity falls back to checkPath. A successful
    // fetch from the SAME path then populates the cache and throttles the next call.
    mockRunGitWithTimeout.mockImplementation((_checkPath: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse') {
        return Promise.reject(new Error('fatal: not a git repository'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await fetchAllRemotesIfStale(WORKTREE_PATH);
    expect(fetchCallCount()).toBe(1);

    await fetchAllRemotesIfStale(WORKTREE_PATH);
    expect(fetchCallCount()).toBe(1);
  });

  it('dedupes concurrent calls into a single in-flight fetch', async () => {
    let resolveFetch: (value: { stdout: string; stderr: string }) => void = () => {};
    const pendingFetch = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveFetch = resolve;
    });
    routeByGitSubcommand(() => pendingFetch);

    const first = fetchAllRemotesIfStale(WORKTREE_PATH);
    const second = fetchAllRemotesIfStale(WORKTREE_PATH);

    resolveFetch({ stdout: '', stderr: '' });
    await Promise.all([first, second]);

    expect(fetchCallCount()).toBe(1);
  });
});
