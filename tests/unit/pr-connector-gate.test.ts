import { describe, it, expect } from 'vitest';
import { registeredPRConnectors } from '../../src/main/pr/pr-registry';

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
    'git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE',
    'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE',
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
});
