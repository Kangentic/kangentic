import { describe, expect, it } from 'vitest';
import {
  packageNameFor,
  encodePackageName,
  unscopedPackageName,
  integrityFromDist,
  needsRepair,
  withRestoredMetadata,
  runWithConcurrency,
} from '../../scripts/repair-lockfile-integrity.js';

// scripts/repair-lockfile-integrity.js restores `resolved` and `integrity` on package-lock.json
// entries that lost them (see that file's header comment for the incident this fixes). It ships
// as a standalone CLI with no test of its own. Everything below exercises the pure helpers it is
// built from, so a change to one of them is caught before it ever reaches the script's write path.
//
// resolveEntry, fetchVersionManifest, and main are intentionally not exported or tested here.
// They hit the network and the filesystem, and the value in this file is the pure logic they sit
// on top of.

interface LockfileEntryFixture {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  license?: string;
}

describe('needsRepair', () => {
  const REGISTRY_RESOLVED = 'https://registry.npmjs.org/semver/-/semver-6.3.1.tgz';
  const REGISTRY_INTEGRITY =
    'sha512-BR7VvDCVHO+q2xBEWskxS6DJE1qRnb7DxzUrogb71CWoSficBxYsiAGd+Kl0mmq/MprG9yArRkyrQxTO6XjMzA==';

  it('exempts a git-sourced dependency, even with no integrity at all', () => {
    // This branch was written today and nothing else exercises it. Reverting the
    // non-registry exemption makes this `true`, which would send a git dependency's entry
    // through resolveEntry and point npm ci at the official tarball instead of the patched
    // fork the git dependency exists to pin.
    const entry: LockfileEntryFixture = {
      version: '4.2.3',
      resolved: 'git+https://github.com/org/some-lib.git#abcdef',
    };
    expect(needsRepair('node_modules/some-lib', entry)).toBe(false);
  });

  it('exempts a file: resolved dependency', () => {
    const entry: LockfileEntryFixture = { version: '1.0.0', resolved: 'file:../some-lib' };
    expect(needsRepair('node_modules/some-lib', entry)).toBe(false);
  });

  it('exempts a direct tarball URL resolved outside the registry', () => {
    const entry: LockfileEntryFixture = {
      version: '1.0.0',
      resolved: 'https://github.com/org/some-lib/archive/abcdef.tgz',
    };
    expect(needsRepair('node_modules/some-lib', entry)).toBe(false);
  });

  it('flags a registry-resolved entry missing integrity', () => {
    const entry: LockfileEntryFixture = { version: '6.3.1', resolved: REGISTRY_RESOLVED };
    expect(needsRepair('node_modules/semver', entry)).toBe(true);
  });

  it('flags an entry missing both resolved and integrity', () => {
    const entry: LockfileEntryFixture = { version: '6.3.1' };
    expect(needsRepair('node_modules/semver', entry)).toBe(true);
  });

  it('leaves a healthy registry entry alone', () => {
    const entry: LockfileEntryFixture = {
      version: '6.3.1',
      resolved: REGISTRY_RESOLVED,
      integrity: REGISTRY_INTEGRITY,
    };
    expect(needsRepair('node_modules/semver', entry)).toBe(false);
  });

  it('leaves a workspace symlink alone', () => {
    const entry: LockfileEntryFixture = { resolved: 'packages/protocol', link: true };
    expect(needsRepair('node_modules/@kangentic/protocol', entry)).toBe(false);
  });

  it('leaves a non-node_modules key alone regardless of its fields', () => {
    expect(needsRepair('', { version: '0.41.0' })).toBe(false);
    expect(needsRepair('packages/protocol', { version: '0.14.0' })).toBe(false);
  });
});

describe('integrityFromDist', () => {
  it('prefers dist.integrity when present', () => {
    const result = integrityFromDist({
      integrity: 'sha512-already-here==',
      shasum: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    });
    expect(result).toEqual({ integrity: 'sha512-already-here==', usedShasumFallback: false });
  });

  it('falls back to a hex shasum, converted to base64, not hex', () => {
    // da39a3ee5e6b4b0d3255bfef95601890afd80709 is the sha1 of the empty string. The expected
    // literal is computed once (Buffer.from(hex, 'hex').toString('base64')) and pasted here
    // rather than re-derived inline, so a regression to a hex-encoded (40-char, no padding)
    // integrity string fails against this exact base64 (28-char, trailing '=') value instead
    // of quietly matching a wrong encoding.
    const result = integrityFromDist({ shasum: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' });
    expect(result).toEqual({
      integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
      usedShasumFallback: true,
    });
  });

  it('returns null when neither field is usable', () => {
    expect(integrityFromDist({})).toBeNull();
  });

  it('rejects a shasum of the wrong length', () => {
    expect(integrityFromDist({ shasum: 'da39a3ee5e6b4b0d3255bfef95601890afd8070' })).toBeNull();
  });

  it('rejects a shasum containing non-hex characters', () => {
    expect(integrityFromDist({ shasum: 'zz39a3ee5e6b4b0d3255bfef95601890afd80709' })).toBeNull();
  });
});

describe('packageNameFor', () => {
  it('reads a plain key', () => {
    expect(packageNameFor('node_modules/semver', {})).toBe('semver');
  });

  it('takes everything after the LAST node_modules/ segment in a nested key', () => {
    expect(packageNameFor('node_modules/@babel/core/node_modules/semver', {})).toBe('semver');
  });

  it('keeps the scope for a scoped key', () => {
    expect(packageNameFor('node_modules/@babel/core', {})).toBe('@babel/core');
  });

  it('lets entry.name win outright for an npm alias', () => {
    expect(
      packageNameFor('node_modules/wrap-ansi-cjs', { name: 'wrap-ansi', version: '7.0.0' }),
    ).toBe('wrap-ansi');
  });
});

describe('encodePackageName', () => {
  it('percent-encodes the scope slash', () => {
    expect(encodePackageName('@babel/core')).toBe('@babel%2fcore');
  });

  it('leaves an unscoped name alone', () => {
    expect(encodePackageName('semver')).toBe('semver');
  });
});

describe('unscopedPackageName', () => {
  it('drops the scope', () => {
    expect(unscopedPackageName('@babel/core')).toBe('core');
  });

  it('leaves an unscoped name alone', () => {
    expect(unscopedPackageName('semver')).toBe('semver');
  });
});

describe('withRestoredMetadata', () => {
  it('does not mutate the input entry', () => {
    const originalEntry: LockfileEntryFixture = { version: '6.3.1', dev: true };
    const entrySnapshot = { ...originalEntry };

    withRestoredMetadata(
      originalEntry,
      'https://registry.npmjs.org/semver/-/semver-6.3.1.tgz',
      'sha512-abc==',
    );

    expect(originalEntry).toEqual(entrySnapshot);
  });

  it('orders name, version, resolved, integrity first when name is present', () => {
    const entry: LockfileEntryFixture = {
      name: 'wrap-ansi',
      version: '7.0.0',
      dev: true,
      license: 'MIT',
    };

    const result = withRestoredMetadata(
      entry,
      'https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz',
      'sha512-abc==',
    );

    expect(Object.keys(result)).toEqual([
      'name',
      'version',
      'resolved',
      'integrity',
      'dev',
      'license',
    ]);
    expect(result).toMatchObject({
      name: 'wrap-ansi',
      version: '7.0.0',
      resolved: 'https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz',
      integrity: 'sha512-abc==',
      dev: true,
      license: 'MIT',
    });
  });

  it('orders version, resolved, integrity first when name is absent, preserving other fields', () => {
    const entry: LockfileEntryFixture = { version: '6.3.1', dev: true, license: 'ISC' };

    const result = withRestoredMetadata(
      entry,
      'https://registry.npmjs.org/semver/-/semver-6.3.1.tgz',
      'sha512-abc==',
    );

    expect(Object.keys(result)).toEqual(['version', 'resolved', 'integrity', 'dev', 'license']);
    expect(result).toMatchObject({
      version: '6.3.1',
      resolved: 'https://registry.npmjs.org/semver/-/semver-6.3.1.tgz',
      integrity: 'sha512-abc==',
      dev: true,
      license: 'ISC',
    });
  });
});

describe('runWithConcurrency', () => {
  async function flushMicrotasks(times = 5): Promise<void> {
    for (let iteration = 0; iteration < times; iteration++) {
      await Promise.resolve();
    }
  }

  it('calls the worker exactly once per item, with no drops or duplicates', async () => {
    const items = [10, 20, 30, 40, 50];
    const callCountByItem = new Map<number, number>();

    await runWithConcurrency(items, 2, async (item: number) => {
      callCountByItem.set(item, (callCountByItem.get(item) ?? 0) + 1);
      return item;
    });

    expect(callCountByItem.size).toBe(items.length);
    for (const item of items) {
      expect(callCountByItem.get(item)).toBe(1);
    }
  });

  it('handles a limit greater than the item count without hanging', async () => {
    const results = await runWithConcurrency(['a', 'b'], 10, async (item: string) =>
      item.toUpperCase(),
    );
    expect(results).toEqual(['A', 'B']);
  });

  it('resolves immediately for an empty input array', async () => {
    const results = await runWithConcurrency([], 5, async () => {
      throw new Error('worker should never be called for an empty input');
    });
    expect(results).toEqual([]);
  });

  it('never exceeds the given limit and preserves result order under out-of-order completion', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const limit = 3;
    let inFlightCount = 0;
    let observedPeakConcurrency = 0;
    const pendingResolvers: Array<() => void> = [];

    const worker = (item: number): Promise<number> => {
      inFlightCount++;
      observedPeakConcurrency = Math.max(observedPeakConcurrency, inFlightCount);
      return new Promise<number>((resolve) => {
        pendingResolvers.push(() => {
          inFlightCount--;
          resolve(item * 10);
        });
      });
    };

    // runWithConcurrency starts exactly `limit` runners synchronously, each calling the
    // worker once before its first await, so all `limit` are already in flight the moment
    // this call returns control here. No await is needed before the loop below can see them.
    const resultsPromise = runWithConcurrency(items, limit, worker);

    // Resolve the MOST recently started worker first (LIFO), so completion order runs
    // opposite to dispatch order. Only the results-array-by-index guarantee inside
    // runWithConcurrency can make the final array come out in input order despite that.
    while (pendingResolvers.length > 0 || inFlightCount > 0) {
      const resolveMostRecentWorker = pendingResolvers.pop();
      if (resolveMostRecentWorker) resolveMostRecentWorker();
      await flushMicrotasks();
      expect(observedPeakConcurrency).toBeLessThanOrEqual(limit);
    }

    const results = await resultsPromise;
    expect(results).toEqual(items.map((item) => item * 10));
    expect(observedPeakConcurrency).toBe(limit);
  });
});
