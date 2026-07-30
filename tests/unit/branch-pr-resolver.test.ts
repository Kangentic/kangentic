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

/**
 * `resolveByCommit` probes local git to reject a candidate PR whose own base
 * already contains the commit. Stub that probe so the connector never shells out
 * to a real git in these tests: a resolver unit test that depends on the machine's
 * git state is green locally and arbitrary on CI (.claude/rules/cross-platform-parity.md).
 *
 * Keys are `<baseRefName>..<sha>`; an unset key yields `null` (undetermined),
 * which is the production fall-back-to-the-hint-rule path, so every pre-existing
 * case keeps its original behavior with no per-test setup.
 *
 * The stub itself is a `vi.fn()`, not a plain async function, so tests can assert
 * call count and arguments - this is what makes the per-base-ref memoization
 * (`containmentByBaseRef` in dropCandidatesSharingBaseHistory) and the
 * empty-base-ref shortcut observable; a plain function makes both silently
 * unfalsifiable, since the containment Map alone yields the same answer whether
 * the caller probes once or once per candidate.
 */
const gitRefs = vi.hoisted(() => {
  const containment = new Map<string, boolean | null>();
  const isShaContainedInRef = vi.fn(async (_repoCwd: string, ref: string, sha: string) =>
    containment.get(`${ref}..${sha}`) ?? null);
  return { containment, isShaContainedInRef };
});

// Spread the real module so the three exports this test does not stub
// (readWorktreeHead, readWorktreeHeadUnqueued, hasCommitsAheadOfBase) stay live.
// A flat factory would leave them `undefined`, which costs nothing today but
// breaks confusingly the first time ladder-level coverage grows into this file:
// pr-linking.ts imports two of them from this same path.
vi.mock('../../src/main/git/worktree-head', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/worktree-head')>()),
  isShaContainedInRef: gitRefs.isShaContainedInRef,
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
      { number: 1, html_url: 'u-merged', state: 'closed', draft: false, merged_at: '2026-02-01T00:00:00Z', merge_commit_sha: 'merge-sha-1', head: { ref: 'feat', repo: sameRepo }, base: { ref: 'main', repo: sameRepo }, updated_at: '2026-02-01T00:00:00Z' },
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
    expect(result[0].mergeCommitOid).toBe('merge-sha-1');     // merge_commit_sha -> mergeCommitOid
    expect(result[1].mergeCommitOid).toBeUndefined();         // absent in raw -> undefined
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
    gitRefs.containment.clear();
    gitRefs.isShaContainedInRef.mockClear();
  });

  it('resolveByNumber maps the gh item to a ResolvedPR', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByNumber').mockResolvedValue(pr({ number: 42, state: 'MERGED' }));
    const result = await gitHubPRConnector.resolveByNumber!('/r', 42);
    expect(result).toMatchObject({ number: 42, state: 'merged' });
  });

  it('resolveByNumber keeps a fork (cross-repository) PR - an explicit number is unambiguous', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByNumber').mockResolvedValue(
      pr({ number: 31, state: 'OPEN', isCrossRepository: true }),
    );
    const result = await gitHubPRConnector.resolveByNumber!('/r', 31);
    expect(result).toMatchObject({ number: 31, state: 'open' });
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

  it('resolveByCommit returns the single PR when containment is undetermined and the hint does not match', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 5, headRefName: 'renamed-real-branch' }),
    ]);
    // Done-task case: stored slug != real branch, but a single PR for the commit is unambiguous.
    // With no containment entry the git probe is undetermined (the candidate's base ref was never
    // fetched locally), so the base-history filter abstains and this lenient hint path decides.
    // It is intentional and must stay: rejecting a single non-matching PR here would break the
    // renamed-branch case tier 3 exists for. The magnet bug is prevented by the base-history
    // filter below and the linker's commits-ahead-of-base guard, not by tightening the hint.
    expect((await gitHubPRConnector.resolveByCommit!('/r', 'sha', 'stale-slug'))?.number).toBe(5);
    // The probe DID run and abstained (no map entry yields null). Asserting that,
    // rather than that the map is empty, is what pins the path: it is the
    // abstention, not a skipped probe, that hands the decision to the hint rule.
    expect(gitRefs.isShaContainedInRef).toHaveBeenCalledWith('/r', 'main', 'sha');
  });

  it('resolveByCommit drops a candidate whose merge commit IS the resolved-from commit (base-tip magnet)', async () => {
    // The #77 magnet: a fresh worktree branched from develop sits on develop's tip,
    // which is the merge commit of the last-merged PR (716). resolveByCommit must not
    // link that sibling PR even though it is the only candidate, because the commit is
    // shared base history, not this task's own work.
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 716, headRefName: 'chore/715-claude-rules-and-hooks', mergeCommitOid: '5d503751' }),
    ]);
    expect(await gitHubPRConnector.resolveByCommit!('/r', '5d503751', 'ci-release-tickets-s-a66f2e5c')).toBeNull();
  });

  it('resolveByCommit keeps a candidate whose merge commit differs from the resolved-from commit (own work)', async () => {
    // A task's authored HEAD is never its own PR's merge product, so a real
    // commit-based discovery still resolves.
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 500, headRefName: 'feat', mergeCommitOid: 'other-sha' }),
    ]);
    expect((await gitHubPRConnector.resolveByCommit!('/r', 'head-sha', 'feat'))?.number).toBe(500);
  });

  it('resolveByCommit - multi-candidate: drops base-tip magnet that would win by recency, keeps the real PR', async () => {
    // Multi-candidate, no branchHint - the "base branch wrong or unknown" path.
    // Candidate #716 is the base-tip magnet: its mergeCommitOid equals the commit
    // being resolved from AND it is the more-recently-updated MERGED PR, so without
    // the filter disambiguate would return it by recency. The filter drops it and
    // #500 (the task's own PR, older updatedAt) survives.
    const resolvedFromSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const ownPrMergeCommitSha = '0000111122223333444455556666777788889999';
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 716, state: 'MERGED', updatedAt: '2026-05-01T00:00:00Z', headRefName: 'chore/last-merged', mergeCommitOid: resolvedFromSha }),
      pr({ number: 500, state: 'MERGED', updatedAt: '2026-01-01T00:00:00Z', headRefName: 'feat', mergeCommitOid: ownPrMergeCommitSha }),
    ]);
    const result = await gitHubPRConnector.resolveByCommit!('/r', resolvedFromSha);
    expect(result?.number).toBe(500);
  });

  it('resolveByCommit drops an open sibling PR whose own base already contains the commit', async () => {
    // The reported mislink: a task worktree with zero commits of its own sits on
    // the tip of feature/estimation, and an unrelated open PR branched from that
    // same tip, so its head branch contains the commit as inherited base history.
    // The mergeCommitOid filter does not catch it (that PR is open and unmerged)
    // and the lone surviving candidate slips past the lenient hint path, so the
    // per-candidate base-history check is the only thing that can reject it.
    const baseTipSha = '13c8f483';
    gitRefs.containment.set(`feature/estimation..${baseTipSha}`, true);
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 380, state: 'OPEN', headRefName: 'chore/update-mcp-sdk', baseRefName: 'feature/estimation' }),
    ]);
    expect(
      await gitHubPRConnector.resolveByCommit!('/r', baseTipSha, 'mcp-identityserver-c-e81ecf03'),
    ).toBeNull();
  });

  it('resolveByCommit drops a CLOSED sibling PR whose own base already contains the commit', async () => {
    // Same mislink as the OPEN case above, but for a CLOSED candidate. Only OPEN
    // (dropped) and MERGED (exempt) are exercised elsewhere: a plausible future
    // regression - widening the exemption from `item.state === 'MERGED'` to
    // `item.state === 'MERGED' || item.state === 'CLOSED'` - would pass every
    // other test in this file while reopening this exact mislink for a closed
    // sibling. Red-green: fails (resolves the sibling instead of null) under
    // that widened guard.
    const baseTipSha = '13c8f483';
    gitRefs.containment.set(`feature/estimation..${baseTipSha}`, true);
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 380, state: 'CLOSED', headRefName: 'chore/update-mcp-sdk', baseRefName: 'feature/estimation' }),
    ]);
    expect(
      await gitHubPRConnector.resolveByCommit!('/r', baseTipSha, 'mcp-identityserver-c-e81ecf03'),
    ).toBeNull();
  });

  it('resolveByCommit keeps a PR whose head is ahead of its base, even on a renamed branch', async () => {
    // The other half of the contract: the renamed-branch case tier 3 exists for.
    // A real PR head always has at least one commit its base does not, so a
    // non-matching branch hint must not cost the task its badge.
    gitRefs.containment.set('feature/estimation..own-work', false);
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 5, state: 'OPEN', headRefName: 'renamed-real-branch', baseRefName: 'feature/estimation' }),
    ]);
    expect(
      (await gitHubPRConnector.resolveByCommit!('/r', 'own-work', 'stale-slug'))?.number,
    ).toBe(5);
  });

  it('resolveByCommit keeps a MERGED candidate whose base contains the commit (own merged PR)', async () => {
    // A merged PR's own commits ARE in its base afterwards, so containment cannot
    // tell "this task's work, now merged" from "inherited base history". Rejecting
    // would clear a correct link for a task on a non-default base whose PR landed
    // via a real merge commit. The merged shape is covered by mergeCommitOid.
    gitRefs.containment.set('feature/estimation..merged-head', true);
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 77, state: 'MERGED', headRefName: 'feat', baseRefName: 'feature/estimation', mergeCommitOid: 'other-sha' }),
    ]);
    const result = await gitHubPRConnector.resolveByCommit!('/r', 'merged-head', 'feat');
    expect(result?.number).toBe(77);
    expect(result?.state).toBe('merged');
  });

  it('resolveByCommit keeps a candidate with an empty base ref (undetermined, never a malformed range)', async () => {
    // gh-client's normalizeCommitPull defaults a missing base.ref to ''.
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 12, state: 'OPEN', headRefName: 'feat', baseRefName: '' }),
    ]);
    expect((await gitHubPRConnector.resolveByCommit!('/r', 'sha', 'feat'))?.number).toBe(12);
    // The `!item.baseRefName` shortcut must skip the git probe entirely for an
    // empty base ref. Without this assertion the test above still passes even if
    // the shortcut is deleted, because the unset map key `..sha` also yields null
    // (undetermined), which the disambiguate/hint path also keeps. Red-green:
    // fails if the shortcut is removed, since the probe would then actually run.
    expect(gitRefs.isShaContainedInRef).not.toHaveBeenCalled();
  });

  it('resolveByCommit - multi-candidate: drops the base-contained sibling and keeps the real PR', async () => {
    // The sibling would win outright: it is OPEN, more recently updated, and no
    // branch hint is passed to break the tie by name. Only the base-history
    // filter separates them.
    gitRefs.containment.set('feature/estimation..own-work', false);
    gitRefs.containment.set('develop..own-work', true);
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 380, state: 'OPEN', updatedAt: '2026-05-01T00:00:00Z', headRefName: 'chore/sibling', baseRefName: 'develop' }),
      pr({ number: 500, state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z', headRefName: 'renamed-real-branch', baseRefName: 'feature/estimation' }),
    ]);
    expect((await gitHubPRConnector.resolveByCommit!('/r', 'own-work'))?.number).toBe(500);
  });

  it('resolveByCommit memoizes containment per base ref: one probe for two candidates sharing a baseRefName', async () => {
    // Two OPEN candidates share baseRefName 'develop' and both sit on develop's
    // tip, so both are dropped as inherited base history, leaving no survivor
    // (`toBeNull()` documents that drop outcome, but is true regardless of
    // memoization - the containment Map answers the same either way). The
    // memoization itself is pinned ONLY by the call-count assertion below:
    // red-green: fails (2 calls instead of 1) if the per-base-ref memoization
    // (`containmentByBaseRef` in dropCandidatesSharingBaseHistory) is ever
    // deleted in favor of probing once per candidate.
    gitRefs.containment.set('develop..shared-sha', true);
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([
      pr({ number: 1, state: 'OPEN', headRefName: 'feat-a', baseRefName: 'develop' }),
      pr({ number: 2, state: 'OPEN', headRefName: 'feat-b', baseRefName: 'develop' }),
    ]);

    const result = await gitHubPRConnector.resolveByCommit!('/r', 'shared-sha');

    expect(result).toBeNull();
    expect(gitRefs.isShaContainedInRef).toHaveBeenCalledTimes(1);
    expect(gitRefs.isShaContainedInRef).toHaveBeenCalledWith('/r', 'develop', 'shared-sha');
  });

  it('registry resolvePRByNumber / resolvePRByCommit delegate to the connector', async () => {
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByNumber').mockResolvedValue(pr({ number: 7, state: 'OPEN' }));
    vi.spyOn(GitHubImporter.prototype, 'resolvePRByCommit').mockResolvedValue([pr({ number: 8, state: 'OPEN' })]);
    expect((await resolvePRByNumber('/r', 7))?.number).toBe(7);
    expect((await resolvePRByCommit('/r', 'sha'))?.number).toBe(8);
  });
});
