import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GhPrListItem } from '../../src/main/boards/adapters/github-common/gh-client';

/**
 * Unit tests for the authoritative branch->PR resolver.
 *
 * Group A exercises GitHubImporter.resolvePRByBranch against a mocked `gh`
 * binary (which detection + execFile), covering invocation shape, JSON parse,
 * and the unavailable/auth degradation contract.
 *
 * Group B exercises the connector's disambiguation + state mapping by stubbing
 * resolvePRByBranch directly, so it is independent of the gh exec details.
 */

const state = vi.hoisted(() => ({
  whichResult: '/usr/bin/gh' as string | Error,
  ghStdout: '[]',
  ghError: null as Error | null,
  lastArgs: [] as readonly string[],
  lastCwd: undefined as string | undefined,
}));

vi.mock('which', () => ({
  default: async () => {
    if (state.whichResult instanceof Error) throw state.whichResult;
    return state.whichResult;
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  // Mirror Node's native execFile, which exposes a `util.promisify.custom`
  // returning `{ stdout, stderr }`, so `const { stdout } = await execFileAsync(...)`
  // works against the mock without touching the real CLI.
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const mockExecFile = Object.assign(
    (...mockArgs: unknown[]) => {
      const callback = mockArgs.find((candidate): candidate is (err: Error | null, result?: unknown) => void => typeof candidate === 'function');
      if (callback) callback(state.ghError, { stdout: state.ghStdout, stderr: '' });
    },
    {
      [promisifyCustom]: (_file: string, args?: readonly string[] | unknown, opts?: { cwd?: string }) => {
        state.lastArgs = Array.isArray(args) ? (args as readonly string[]) : [];
        state.lastCwd = opts?.cwd;
        if (state.ghError) return Promise.reject(state.ghError);
        return Promise.resolve({ stdout: state.ghStdout, stderr: '' });
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

import { GitHubImporter, GhUnavailableError, GhTransientError } from '../../src/main/boards/adapters/github-common/gh-client';
import { gitHubPRConnector } from '../../src/main/pr/adapters/github/github-connector';
import { resolvePRForBranch, resolvePRByNumber, resolvePRByCommit, PRResolverUnavailableError, PRResolverTransientError } from '../../src/main/pr/pr-registry';

function pr(overrides: Partial<GhPrListItem>): GhPrListItem {
  return {
    number: 1,
    url: 'https://github.com/owner/repo/pull/1',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat',
    baseRefName: 'main',
    updatedAt: '2026-01-01T00:00:00Z',
    isCrossRepository: false,
    ...overrides,
  };
}

describe('GitHubImporter.resolvePRByBranch', () => {
  beforeEach(() => {
    state.whichResult = '/usr/bin/gh';
    state.ghStdout = '[]';
    state.ghError = null;
  });

  it('throws GhUnavailableError when gh is not installed', async () => {
    state.whichResult = new Error('not found');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByBranch('/repo', 'feat')).rejects.toBeInstanceOf(GhUnavailableError);
  });

  it('queries gh pr list scoped to the branch + cwd and returns parsed items', async () => {
    state.ghStdout = JSON.stringify([pr({ number: 5 })]);
    const importer = new GitHubImporter();
    const result = await importer.resolvePRByBranch('/repo/worktree', 'feat');

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(5);
    expect(state.lastArgs).toEqual(expect.arrayContaining(['pr', 'list', '--head', 'feat', '--state', 'all']));
    expect(state.lastCwd).toBe('/repo/worktree');
  });

  it('returns [] when gh fails for a non-auth reason (no PR / not a gh repo)', async () => {
    state.ghError = new Error('no pull requests match');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByBranch('/repo', 'feat')).resolves.toEqual([]);
  });

  it('throws GhUnavailableError on an auth failure (degrade to scraper)', async () => {
    state.ghError = new Error('gh auth login required (HTTP 401)');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByBranch('/repo', 'feat')).rejects.toBeInstanceOf(GhUnavailableError);
  });
});

describe('gitHubPRConnector.resolveForBranch (disambiguation + state mapping)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stub(items: GhPrListItem[]) {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByBranch').mockResolvedValue(items);
  }

  it('maps MERGED -> merged', async () => {
    stub([pr({ state: 'MERGED' })]);
    expect((await gitHubPRConnector.resolveForBranch!('/r', 'feat'))?.state).toBe('merged');
  });

  it('maps CLOSED -> closed', async () => {
    stub([pr({ state: 'CLOSED' })]);
    expect((await gitHubPRConnector.resolveForBranch!('/r', 'feat'))?.state).toBe('closed');
  });

  it('maps OPEN + isDraft -> draft', async () => {
    stub([pr({ state: 'OPEN', isDraft: true })]);
    expect((await gitHubPRConnector.resolveForBranch!('/r', 'feat'))?.state).toBe('draft');
  });

  it('maps OPEN -> open', async () => {
    stub([pr({ state: 'OPEN' })]);
    expect((await gitHubPRConnector.resolveForBranch!('/r', 'feat'))?.state).toBe('open');
  });

  it('prefers an OPEN PR over a merged/closed one', async () => {
    stub([
      pr({ number: 1, state: 'MERGED', updatedAt: '2026-05-01T00:00:00Z' }),
      pr({ number: 2, state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z' }),
    ]);
    const result = await gitHubPRConnector.resolveForBranch!('/r', 'feat');
    expect(result?.number).toBe(2);
    expect(result?.state).toBe('open');
  });

  it('prefers the PR whose base ref matches the requested base branch', async () => {
    stub([
      pr({ number: 1, state: 'OPEN', baseRefName: 'develop', updatedAt: '2026-05-01T00:00:00Z' }),
      pr({ number: 2, state: 'OPEN', baseRefName: 'main', updatedAt: '2026-01-01T00:00:00Z' }),
    ]);
    const result = await gitHubPRConnector.resolveForBranch!('/r', 'feat', 'main');
    expect(result?.number).toBe(2);
  });

  it('falls back to the most recently updated PR', async () => {
    stub([
      pr({ number: 1, state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z' }),
      pr({ number: 2, state: 'OPEN', updatedAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect((await gitHubPRConnector.resolveForBranch!('/r', 'feat'))?.number).toBe(2);
  });

  it('returns null when no PR matches the head ref', async () => {
    stub([]);
    expect(await gitHubPRConnector.resolveForBranch!('/r', 'feat')).toBeNull();
  });
});

describe('resolvePRForBranch registry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to the GitHub connector and returns its ResolvedPR', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByBranch').mockResolvedValue([
      pr({ number: 9, url: 'https://github.com/owner/repo/pull/9', state: 'OPEN' }),
    ]);
    const result = await resolvePRForBranch('/r', 'feat');
    expect(result).toEqual({
      url: 'https://github.com/owner/repo/pull/9',
      number: 9,
      state: 'open',
      baseRefName: 'main',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });
});

describe('GitHubImporter.resolvePRByNumber', () => {
  beforeEach(() => {
    state.whichResult = '/usr/bin/gh';
    state.ghError = null;
  });

  it('returns the single PR from gh pr view', async () => {
    state.ghStdout = JSON.stringify(pr({ number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'MERGED' }));
    const importer = new GitHubImporter();
    const result = await importer.resolvePRByNumber('/repo', 42);
    expect(result?.number).toBe(42);
    expect(state.lastArgs).toEqual(expect.arrayContaining(['pr', 'view', '42']));
  });

  it('throws GhUnavailableError when gh is not installed', async () => {
    state.whichResult = new Error('not found');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByNumber('/repo', 42)).rejects.toBeInstanceOf(GhUnavailableError);
  });

  it('returns null when the number no longer resolves', async () => {
    state.ghError = new Error('no pull requests found for number 42');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByNumber('/repo', 42)).resolves.toBeNull();
  });
});

describe('GitHubImporter.resolvePRByCommit (REST normalization)', () => {
  beforeEach(() => {
    state.whichResult = '/usr/bin/gh';
    state.ghError = null;
  });

  it('queries the commits/{sha}/pulls endpoint and normalizes REST -> GhPrListItem', async () => {
    const sameRepo = { full_name: 'owner/repo' };
    state.ghStdout = JSON.stringify([
      { number: 1, html_url: 'u-merged', state: 'closed', draft: false, merged_at: '2026-02-01T00:00:00Z', head: { ref: 'feat', repo: sameRepo }, base: { ref: 'main', repo: sameRepo }, updated_at: '2026-02-01T00:00:00Z' },
      { number: 2, html_url: 'u-open', state: 'open', draft: false, merged_at: null, head: { ref: 'feat', repo: sameRepo }, base: { ref: 'main', repo: sameRepo }, updated_at: '2026-01-01T00:00:00Z' },
      { number: 3, html_url: 'u-closed', state: 'closed', draft: false, merged_at: null, head: { ref: 'feat', repo: sameRepo }, base: { ref: 'main', repo: sameRepo }, updated_at: '2026-01-01T00:00:00Z' },
      { number: 4, html_url: 'u-draft', state: 'open', draft: true, merged_at: null, head: { ref: 'feat', repo: sameRepo }, base: { ref: 'main', repo: sameRepo }, updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const importer = new GitHubImporter();
    const result = await importer.resolvePRByCommit('/repo', 'abc123');

    expect(state.lastArgs).toEqual(['api', 'repos/{owner}/{repo}/commits/abc123/pulls']);
    expect(result.map((item) => [item.number, item.state, item.isDraft])).toEqual([
      [1, 'MERGED', false],   // merged_at non-null -> MERGED even though REST state is 'closed'
      [2, 'OPEN', false],
      [3, 'CLOSED', false],
      [4, 'OPEN', true],      // draft preserved
    ]);
    expect(result[0].url).toBe('u-merged');
    expect(result[0].headRefName).toBe('feat');
    expect(result.every((item) => item.isCrossRepository === false)).toBe(true);
  });

  it('flags a fork PR as cross-repository when head and base repos differ', async () => {
    state.ghStdout = JSON.stringify([
      { number: 9, html_url: 'u-fork', state: 'open', draft: false, merged_at: null, head: { ref: 'feat', repo: { full_name: 'fork/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const importer = new GitHubImporter();
    const result = await importer.resolvePRByCommit('/repo', 'abc123');
    expect(result[0].isCrossRepository).toBe(true);
  });

  it('classifies a transient gh failure (HTTP 5xx) as GhTransientError', async () => {
    state.ghError = new Error('HTTP 503: Service unavailable');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByCommit('/repo', 'abc123')).rejects.toBeInstanceOf(GhTransientError);
  });

  it('throws GhUnavailableError when gh is not installed', async () => {
    state.whichResult = new Error('not found');
    const importer = new GitHubImporter();
    await expect(importer.resolvePRByCommit('/repo', 'abc123')).rejects.toBeInstanceOf(GhUnavailableError);
  });
});

describe('connector resolveByNumber / resolveByCommit + error translation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveByNumber maps the gh item to a ResolvedPR', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByNumber').mockResolvedValue(pr({ number: 42, state: 'MERGED' }));
    const result = await gitHubPRConnector.resolveByNumber!('/r', 42);
    expect(result).toMatchObject({ number: 42, state: 'merged' });
  });

  it('resolveByCommit disambiguates the associated PRs', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 1, state: 'MERGED', updatedAt: '2026-05-01T00:00:00Z' }),
      pr({ number: 2, state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z' }),
    ]);
    const result = await gitHubPRConnector.resolveByCommit!('/r', 'sha');
    expect(result?.number).toBe(2); // prefers OPEN over merged
  });

  it('translates GhUnavailableError into the generic PRResolverUnavailableError', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByBranch').mockRejectedValue(new GhUnavailableError('gh CLI not found'));
    await expect(gitHubPRConnector.resolveForBranch!('/r', 'feat')).rejects.toBeInstanceOf(PRResolverUnavailableError);
  });

  it('translates GhTransientError into the generic PRResolverTransientError', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockRejectedValue(new GhTransientError('HTTP 503'));
    await expect(gitHubPRConnector.resolveByCommit!('/r', 'sha')).rejects.toBeInstanceOf(PRResolverTransientError);
  });

  it('resolveForBranch filters out fork (cross-repository) PRs even when they are open', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByBranch').mockResolvedValue([
      pr({ number: 1, state: 'OPEN', isCrossRepository: true }),   // fork PR, would win on state
      pr({ number: 2, state: 'MERGED', isCrossRepository: false }),
    ]);
    const result = await gitHubPRConnector.resolveForBranch!('/r', 'feat');
    expect(result?.number).toBe(2); // the same-repo PR, not the fork
  });

  it('resolveByCommit returns null when the commit maps to multiple PRs and none is on the hinted branch', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 1, headRefName: 'other-a' }),
      pr({ number: 2, headRefName: 'other-b' }),
    ]);
    expect(await gitHubPRConnector.resolveByCommit!('/r', 'sha', 'feat')).toBeNull();
  });

  it('resolveByCommit picks the PR whose head ref matches the hint', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 1, headRefName: 'other' }),
      pr({ number: 2, headRefName: 'feat' }),
    ]);
    expect((await gitHubPRConnector.resolveByCommit!('/r', 'sha', 'feat'))?.number).toBe(2);
  });

  it('resolveByCommit returns the single PR even if the hint does not match (unambiguous)', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 5, headRefName: 'renamed-real-branch' }),
    ]);
    // Done-task case: stored slug != real branch, but a single PR for the commit is unambiguous.
    expect((await gitHubPRConnector.resolveByCommit!('/r', 'sha', 'stale-slug'))?.number).toBe(5);
  });

  it('registry resolvePRByNumber / resolvePRByCommit delegate to the connector', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByNumber').mockResolvedValue(pr({ number: 7, state: 'OPEN' }));
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([pr({ number: 8, state: 'OPEN' })]);
    expect((await resolvePRByNumber('/r', 7))?.number).toBe(7);
    expect((await resolvePRByCommit('/r', 'sha'))?.number).toBe(8);
  });
});
