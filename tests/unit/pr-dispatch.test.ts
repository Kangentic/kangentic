import { describe, it, expect, vi } from 'vitest';
import {
  dispatchResolve,
  selectOwningConnectors,
  createDeferredDegrade,
  type ResolveKind,
} from '../../src/main/pr/shared/pr-dispatch';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../src/main/pr/shared/pr-errors';
import type { PRConnector, ResolvedPR } from '../../src/main/pr/shared/pr-connector';

const AZURE_URL = 'git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE';
const GITHUB_URL = 'https://github.com/owner/repo.git';

function resolved(number: number): ResolvedPR {
  return { url: `https://example.test/pull/${number}`, number, state: 'open' };
}

/**
 * A connector that owns whichever hosts are listed, and whose resolvers are all
 * the same stub. `kinds` controls which resolver members exist at all, so the
 * "owns the remote but cannot answer this kind" branch is reachable.
 */
function connector(options: {
  name: string;
  owns: string;
  behavior?: () => Promise<ResolvedPR | null>;
  kinds?: ResolveKind[];
}): PRConnector {
  const { name, owns, behavior, kinds = ['resolveForBranch', 'resolveByNumber', 'resolveByCommit'] } = options;
  const run = behavior ?? (async () => null);
  const base: PRConnector = {
    name,
    matchesRemote: (urls) => urls.some((url) => url.includes(owns)),
    matchesCommand: () => false,
    extract: () => null,
  };
  for (const kind of kinds) {
    (base as unknown as Record<string, unknown>)[kind] = run;
  }
  return base;
}

function dispatch(args: {
  connectors: PRConnector[];
  remoteUrls: readonly string[] | null;
  kind?: ResolveKind;
}) {
  const kind = args.kind ?? 'resolveForBranch';
  return dispatchResolve({
    connectors: args.connectors,
    remoteUrls: args.remoteUrls,
    repoCwd: '/repo',
    kind,
    invoke: (target) => {
      const method = target[kind];
      if (!method) throw new Error(`dispatch invoked ${target.name} without ${kind}`);
      return (method as () => Promise<ResolvedPR | null>)();
    },
  });
}

describe('dispatchResolve upholds the ownership invariant', () => {
  // The headline regression. Naive catch-and-continue swallows the owner's
  // throw, finds no other owner, and resolves null - which arms the link wipe.
  it('never turns an owning connector failure into a clean not-found', async () => {
    const owner = connector({
      name: 'Azure DevOps',
      owns: 'dev.azure.com',
      behavior: async () => {
        throw new PRResolverUnavailableError('az CLI not found');
      },
    });
    const bystander = connector({ name: 'GitHub', owns: 'github.com', behavior: async () => null });

    const call = dispatch({ connectors: [bystander, owner], remoteUrls: [AZURE_URL] });
    await expect(call).rejects.toBeInstanceOf(PRResolverUnavailableError);
  });

  it('throws when the remotes could not be read at all', async () => {
    const owner = connector({ name: 'GitHub', owns: 'github.com' });
    await expect(dispatch({ connectors: [owner], remoteUrls: null })).rejects.toThrow(/could not read the git remotes/i);
  });

  it('throws, naming the unmatched remote, when no connector owns it', async () => {
    const owner = connector({ name: 'GitHub', owns: 'github.com' });
    await expect(dispatch({ connectors: [owner], remoteUrls: [AZURE_URL] })).rejects.toThrow(
      /No PR connector matches the remote .*dev\.azure\.com/,
    );
  });

  it('distinguishes a repo with no remotes from an unmatched one', async () => {
    const owner = connector({ name: 'GitHub', owns: 'github.com' });
    await expect(dispatch({ connectors: [owner], remoteUrls: [] })).rejects.toThrow(/No git remote is configured/);
  });

  // Nothing ran, so "there is no PR" was never established.
  it('throws when the owner implements no resolver of this kind', async () => {
    const owner = connector({ name: 'Azure DevOps', owns: 'dev.azure.com', kinds: ['resolveForBranch'] });
    await expect(
      dispatch({ connectors: [owner], remoteUrls: [AZURE_URL], kind: 'resolveByCommit' }),
    ).rejects.toThrow(/Azure DevOps owns this remote but has no resolveByCommit resolver/);
  });

  it('returns a clean null when the sole owner ran and matched nothing', async () => {
    const owner = connector({ name: 'GitHub', owns: 'github.com', behavior: async () => null });
    await expect(dispatch({ connectors: [owner], remoteUrls: [GITHUB_URL] })).resolves.toBeNull();
  });

  it('returns the first match and does not invoke later connectors', async () => {
    const later = vi.fn(async () => resolved(2));
    const first = connector({ name: 'A', owns: 'github.com', behavior: async () => resolved(1) });
    const second = connector({ name: 'B', owns: 'github.com', behavior: later });

    await expect(dispatch({ connectors: [first, second], remoteUrls: [GITHUB_URL] })).resolves.toMatchObject({
      number: 1,
    });
    expect(later).not.toHaveBeenCalled();
  });

  // One owner could not check, so the other's clean miss cannot speak for both.
  it('throws when one owner degrades and another merely misses', async () => {
    const degraded = connector({
      name: 'A',
      owns: 'github.com',
      behavior: async () => {
        throw new PRResolverUnavailableError('gh missing');
      },
    });
    const missed = connector({ name: 'B', owns: 'github.com', behavior: async () => null });

    await expect(dispatch({ connectors: [degraded, missed], remoteUrls: [GITHUB_URL] })).rejects.toBeInstanceOf(
      PRResolverUnavailableError,
    );
  });

  it('rethrows the transient over the unavailable, whatever the order', async () => {
    const unavailable = connector({
      name: 'A',
      owns: 'github.com',
      behavior: async () => {
        throw new PRResolverUnavailableError('gh missing');
      },
    });
    const transient = connector({
      name: 'B',
      owns: 'github.com',
      behavior: async () => {
        throw new PRResolverTransientError('HTTP 503');
      },
    });

    await expect(
      dispatch({ connectors: [unavailable, transient], remoteUrls: [GITHUB_URL] }),
    ).rejects.toBeInstanceOf(PRResolverTransientError);
  });

  /**
   * A claimed `upstream` is not evidence that THIS repo's PRs live there. The
   * inferred tiers can take that guess because `disambiguate` guards them; the
   * number tier bypasses every guard, so resolving 42 against a
   * merely-plausible owner would return THAT owner's PR 42 - a mislink, which
   * is strictly worse than a miss.
   */
  it('does not fall back to a secondary remote for resolveByNumber', async () => {
    const github = connector({ name: 'GitHub', owns: 'github.com', behavior: async () => resolved(42) });
    const remoteUrls = ['https://gitea.corp.example/owner/repo.git', GITHUB_URL];

    await expect(dispatch({ connectors: [github], remoteUrls, kind: 'resolveByNumber' })).rejects.toBeInstanceOf(
      PRResolverUnavailableError,
    );
    // The inferred tiers still accept the same fallback.
    await expect(
      dispatch({ connectors: [github], remoteUrls, kind: 'resolveForBranch' }),
    ).resolves.toMatchObject({ number: 42 });
  });

  it('propagates an unknown error unchanged rather than deferring it', async () => {
    const broken = connector({
      name: 'A',
      owns: 'github.com',
      behavior: async () => {
        throw new TypeError('connector bug');
      },
    });
    await expect(dispatch({ connectors: [broken], remoteUrls: [GITHUB_URL] })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('selectOwningConnectors', () => {
  const azure = connector({ name: 'Azure DevOps', owns: 'dev.azure.com' });
  const github = connector({ name: 'GitHub', owns: 'github.com' });

  // origin=Azure + upstream=GitHub: without this, array order decides and
  // resolveByNumber(42) could return UPSTREAM's PR 42, which is a mislink.
  it('narrows to the connector owning the primary remote', () => {
    expect(selectOwningConnectors([azure, github], [AZURE_URL, GITHUB_URL])).toEqual([azure]);
    expect(selectOwningConnectors([azure, github], [GITHUB_URL, AZURE_URL])).toEqual([github]);
  });

  it('falls back to the full list when nothing claims the primary remote', () => {
    expect(selectOwningConnectors([azure, github], ['https://gitlab.com/g/p.git', GITHUB_URL])).toEqual([github]);
  });

  it('refuses the secondary fallback when asked to', () => {
    expect(
      selectOwningConnectors([azure, github], ['https://gitlab.com/g/p.git', GITHUB_URL], {
        allowSecondaryFallback: false,
      }),
    ).toEqual([]);
  });

  it('returns empty when nothing claims any remote', () => {
    expect(selectOwningConnectors([azure, github], ['https://gitlab.com/g/p.git'])).toEqual([]);
  });
});

describe('createDeferredDegrade', () => {
  it('resolves null on a degrade error so the caller can continue', async () => {
    const degrade = createDeferredDegrade();
    await expect(
      degrade.attempt(async () => {
        throw new PRResolverUnavailableError('nope');
      }),
    ).resolves.toBeNull();
    expect(degrade.pending()).toBeInstanceOf(PRResolverUnavailableError);
  });

  it('keeps the FIRST error of each class', async () => {
    const degrade = createDeferredDegrade();
    await degrade.attempt(async () => {
      throw new PRResolverUnavailableError('first');
    });
    await degrade.attempt(async () => {
      throw new PRResolverUnavailableError('second');
    });
    expect(degrade.pending()?.message).toBe('first');
  });

  // `instanceof` must survive: pr-linking.ts's catch tests it to set
  // degradeStatus, and a wrapped error would fall into the generic branch and
  // arm the very link wipe this machinery prevents.
  it('rethrows the original error instance, not a copy', async () => {
    const original = new PRResolverTransientError('HTTP 503');
    const degrade = createDeferredDegrade();
    await degrade.attempt(async () => {
      throw original;
    });
    expect(degrade.pending()).toBe(original);
  });

  it('has nothing pending when every attempt succeeded', async () => {
    const degrade = createDeferredDegrade();
    await degrade.attempt(async () => resolved(1));
    expect(degrade.pending()).toBeUndefined();
  });
});
