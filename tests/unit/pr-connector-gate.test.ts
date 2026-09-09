import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registeredPRConnectors, commitAnchorSelfVerifies } from '../../src/main/pr/pr-registry';

// The registry's only git touch. Stubbed so `commitAnchorSelfVerifies` can be
// driven over the REAL connectors with a chosen remote set and no repo on disk.
// Both this and the `vi.mock` below are hoisted above the imports by vitest.
const remotes = vi.hoisted(() => ({ urls: null as readonly string[] | null }));
vi.mock('../../src/main/git/git-remotes', () => ({
  // The empty-path guard is the real function's, mirrored here rather than
  // stubbed away: `readRemoteUrls('') === null` is pinned in
  // `git-remotes.test.ts`, and dropping it here would let this file assert an
  // answer the composed chain does not actually give.
  readRemoteUrls: async (repoCwd: string) => (repoCwd ? remotes.urls : null),
  invalidateRemoteUrlsCache: () => {},
}));

/**
 * CI backstop for `PRConnector.matchesRemote`.
 *
 * The contract can require the member but not that it DISCRIMINATES. A
 * connector written as `matchesRemote: () => true` type-checks, is eligible on
 * every remote, and therefore can report a clean `not-found` for a repo it does
 * not host - which `pr-linking.ts` acts on by CLEARING the task's PR link.
 *
 * These tests run against the REAL `connectors` array, not a copy, so appending
 * a third provider with a lazy gate fails here rather than in production. This
 * is the mechanical guard `.claude/rules/agent-adapters-boundary.md`-style
 * conventions are supposed to carry; without it the gate's correctness rested
 * on two literal assertions a reviewer could delete with nothing going red.
 */

/** One representative remote per hosting provider we know how to spell. */
const PROVIDER_REMOTES: Record<string, string[]> = {
  github: ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git'],
  azure: [
    'git@ssh.dev.azure.com:v3/my-org/My%20Project/my-repo',
    'https://dev.azure.com/my-org/My%20Project/_git/my-repo',
  ],
};

/** Remotes no registered connector should ever claim. */
const FOREIGN_REMOTES = [
  'https://gitlab.com/group/project.git',
  'git@bitbucket.org:owner/repo.git',
  'https://git.sr.ht/~owner/repo',
  'C:\\Users\\dev\\some\\local\\repo',
  '/home/dev/some/local/repo',
];

describe('every registered connector has a discriminating remote gate', () => {
  it('registers at least two connectors, so these assertions are not vacuous', () => {
    expect(registeredPRConnectors.length).toBeGreaterThanOrEqual(2);
  });

  // A `() => true` gate fails here: it claims every provider's remote.
  it.each(Object.entries(PROVIDER_REMOTES).flatMap(([provider, urls]) => urls.map((url) => [provider, url])))(
    'at most one connector claims the %s remote %s',
    (_provider, url) => {
      const claimants = registeredPRConnectors.filter((connector) => connector.matchesRemote([url]));
      expect(claimants.map((connector) => connector.name)).toHaveLength(1);
    },
  );

  // A `() => true` gate also fails here.
  it.each(FOREIGN_REMOTES)('no connector claims %s', (url) => {
    const claimants = registeredPRConnectors.filter((connector) => connector.matchesRemote([url]));
    expect(claimants.map((connector) => connector.name)).toEqual([]);
  });

  it('no connector claims an empty remote list', () => {
    for (const connector of registeredPRConnectors) {
      expect(connector.matchesRemote([])).toBe(false);
    }
  });

  it('every connector claims at least one remote, so none is dead weight', () => {
    const allKnown = Object.values(PROVIDER_REMOTES).flat();
    for (const connector of registeredPRConnectors) {
      expect(allKnown.some((url) => connector.matchesRemote([url]))).toBe(true);
    }
  });

  // `matchesRemote` must be pure - the registry calls it inside a filter, with
  // remotes it already read, and a subprocess there would spawn per connector
  // per dispatch.
  it('matchesRemote is synchronous', () => {
    for (const connector of registeredPRConnectors) {
      expect(connector.matchesRemote(['https://github.com/owner/repo.git'])).toBeTypeOf('boolean');
    }
  });

  // The commit anchor is the one tier the linker cannot police on its own: its
  // commits-ahead-of-base gate measures against a base the task may never have
  // recorded, and it cannot tell a PR's own work from history that PR merely
  // inherited. Only the connector knows, so it has to say so out loud.
  //
  // Omission is a valid ANSWER (the linker then skips the tier), but it must not
  // be a valid way to avoid the QUESTION - a new adapter that pastes an existing
  // one and drops this line would otherwise silently lose the commit tier, or,
  // if the default were ever flipped, silently gain an unverified one.
  it('every connector implementing resolveByCommit declares whether it verifies commit ownership', () => {
    const commitCapable = registeredPRConnectors.filter((connector) => connector.resolveByCommit);
    expect(commitCapable.length).toBeGreaterThan(0);
    for (const connector of commitCapable) {
      expect(
        typeof connector.verifiesCommitOwnership,
        `${connector.name} implements resolveByCommit but does not declare verifiesCommitOwnership. `
        + 'Declare true only if a hit proves the commit is that PR\'s own work (see PRConnector).',
      ).toBe('boolean');
    }
  });
});

/**
 * The gate itself, over the REAL registry.
 *
 * The test above pins what each connector DECLARES; this one pins what
 * `commitAnchorSelfVerifies` does with those declarations, which is the part
 * `pr-linking.ts` actually calls. The ladder suite mocks it wholesale, so
 * without these its `capable.length > 0 && every(...)` logic has no direct
 * coverage anywhere.
 *
 * The never-rejects property is the load-bearing one. A rejection here reaches
 * `pr-linking.ts` as a non-`PRResolver*` error, which aborts the whole ladder
 * (losing Tiers 4, 5 and 6, the last chance for a task with no worktree) and
 * sets `resolveFailed`. It holds only because `readRemoteUrls` never rejects
 * and `matchesRemote` is synchronous and pure, both pinned elsewhere in this
 * file and in `git-remotes.test.ts`.
 *
 * One branch is deliberately uncovered: `every()` answering false needs an
 * owning, commit-capable connector that declares nothing, which the
 * declaration test above makes impossible to register.
 */
describe('commitAnchorSelfVerifies', () => {
  beforeEach(() => {
    remotes.urls = null;
  });

  it('is false, not a rejection, when the remotes cannot be read at all', async () => {
    remotes.urls = null;
    await expect(commitAnchorSelfVerifies('C:/repo')).resolves.toBe(false);
  });

  it('is false for a real repository with no remotes configured', async () => {
    remotes.urls = [];
    await expect(commitAnchorSelfVerifies('C:/repo')).resolves.toBe(false);
  });

  // No owner means no commit-capable owner, which is what the `capable.length
  // > 0` clause is for: without it an empty `every()` answers TRUE and hands
  // the commit tier to a repo nothing claims.
  it.each(FOREIGN_REMOTES)('is false for %s, which no connector owns', async (url) => {
    remotes.urls = [url];
    await expect(commitAnchorSelfVerifies('C:/repo')).resolves.toBe(false);
  });

  it.each(Object.entries(PROVIDER_REMOTES).flatMap(([provider, urls]) => urls.map((url) => [provider, url])))(
    'is true for the %s remote %s, whose owner declares verifiesCommitOwnership',
    async (_provider, url) => {
      remotes.urls = [url];
      await expect(commitAnchorSelfVerifies('C:/repo')).resolves.toBe(true);
    },
  );

  // The gate must select the same owners as the dispatch it gates.
  // `dispatchResolve` passes `allowSecondaryFallback: kind !== 'resolveByNumber'`,
  // so for `resolveByCommit` a claimed SECONDARY remote owns the repo. A gate
  // that refused the fallback would answer false for a repo the commit tier
  // would still dispatch to: safe, but silently drifted.
  it('follows the secondary remote when the primary is unrecognized, as the commit dispatch does', async () => {
    remotes.urls = ['https://gitlab.com/group/project.git', 'https://github.com/owner/repo.git'];
    await expect(commitAnchorSelfVerifies('C:/repo')).resolves.toBe(true);
  });

  it('is false for an empty repoCwd', async () => {
    remotes.urls = ['https://github.com/owner/repo.git'];
    await expect(commitAnchorSelfVerifies('')).resolves.toBe(false);
  });
});
