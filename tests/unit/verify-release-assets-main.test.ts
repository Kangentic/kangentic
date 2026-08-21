import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

// scripts/verify-release-assets.js is the CI gate that blocks `gh release edit --draft=false`
// unless a tag resolves to exactly one release carrying all 11 expected assets. This file covers
// the two things tests/unit/release-asset-manifest.test.ts does NOT: main() (the wrapper that
// turns an `ok: false` decision into the nonzero exit that actually blocks publishing) and
// releasesForTag's pagination loop. The pure decision function verifyReleaseAssets is fully
// covered there and is exercised here only incidentally, through main().
//
// main() and releasesForTag() are not currently mockable through vi.mock: verify-release-assets.js
// is a plain CommonJS script loaded via createRequire, which goes through Node's native module
// loader rather than vitest's module graph. Two approaches were tried and empirically rejected
// before landing on the one below:
//   1. `vi.spyOn(childProcessNamespace, 'execFileSync')` on an ESM `import * as childProcess from
//      'node:child_process'` throws: "Module namespace is not configurable in ESM".
//   2. `vi.mock('node:child_process', ...)` silently does nothing for this require path: a script
//      loaded via createRequire still resolved the REAL execFileSync and threw ENOENT for a
//      nonexistent binary in a throwaway probe.
// What does work: node:child_process's CJS module.exports object is an ordinary mutable object
// (unlike the frozen ESM namespace), and it is a process-wide singleton regardless of which
// `require`/createRequire call touches it. So we obtain it via CJS require, overwrite its
// `execFileSync` property with a vi.fn(), then evict verify-release-assets.js from the require
// cache and re-require it: its top-level `const { execFileSync } = require('node:child_process')`
// destructures a reference at require time, so the mocked function must already be in place
// BEFORE that fresh require runs. Restoring the builtin afterwards is unconditional (top-level
// afterEach, not vi.restoreAllMocks, which does not undo a plain property assignment) because a
// leaked mock here would silently poison any other test in the same worker that shells out.
//
// vi.restoreAllMocks() is also unconditional here: process.exit/console.error/console.log are
// re-spied per test via vi.spyOn, and vi.spyOn on an already-spied property reuses the existing
// spy rather than replacing it. Without restoring between tests, an earlier test's recorded
// calls leak into a later test's assertions on the "same" spy - which is exactly the false
// failure this file hit while under development (a later test's `.not.toHaveBeenCalled()` was
// tripped by an earlier test's real, expected call that nobody ever cleared).

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));
const scriptPath = path.join(REPO_ROOT, 'scripts/verify-release-assets.js');

interface RawRelease {
  id: number;
  draft: boolean;
  tag_name: string;
  assets: { name: string; state: string }[];
}

interface VerifyReleaseAssetsExports {
  verifyReleaseAssets: (
    releases: RawRelease[],
    tag: string
  ) => { ok: boolean; problems: string[]; release: RawRelease | null };
  releasesForTag: (repo: string, tag: string) => RawRelease[];
  parseArgs: (argv: string[]) => { tag: string | undefined; repo: string };
  main: () => void;
}

const childProcessModule = requireFromRepo('node:child_process') as {
  execFileSync: (...args: unknown[]) => string;
};
const realExecFileSync = childProcessModule.execFileSync;
const originalArgv = process.argv;
const originalGithubRepository = process.env.GITHUB_REPOSITORY;

afterEach(() => {
  childProcessModule.execFileSync = realExecFileSync;
  process.argv = originalArgv;
  if (originalGithubRepository === undefined) {
    delete process.env.GITHUB_REPOSITORY;
  } else {
    process.env.GITHUB_REPOSITORY = originalGithubRepository;
  }
  vi.restoreAllMocks();
});

/** Load a fresh copy of the script with execFileSync already patched at require time. */
function loadScriptWithMockedExecFileSync(
  execFileSyncImplementation: (file: string, args: readonly string[]) => string
): VerifyReleaseAssetsExports {
  childProcessModule.execFileSync = vi.fn(execFileSyncImplementation);
  delete requireFromRepo.cache[requireFromRepo.resolve(scriptPath)];
  return requireFromRepo(scriptPath) as VerifyReleaseAssetsExports;
}

/** The real error the mocked process.exit throws, so control flow stops exactly like the real one. */
class ProcessExitSentinel extends Error {
  constructor(public readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

function spyOnProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitSentinel(code);
  }) as never);
}

describe('parseArgs', () => {
  // parseArgs never touches execFileSync, so a plain unmocked require is safe here.
  const { parseArgs } = requireFromRepo(scriptPath) as VerifyReleaseAssetsExports;

  it('parses a tag and an explicit --repo', () => {
    expect(parseArgs(['v1.2.3', '--repo', 'owner/name'])).toEqual({
      tag: 'v1.2.3',
      repo: 'owner/name',
    });
  });

  it('returns an undefined tag when given no arguments, so main() hits the usage branch', () => {
    expect(parseArgs([]).tag).toBeUndefined();
  });

  it('defaults repo from GITHUB_REPOSITORY when set', () => {
    process.env.GITHUB_REPOSITORY = 'someOrg/someRepo';
    expect(parseArgs(['v1.2.3'])).toEqual({ tag: 'v1.2.3', repo: 'someOrg/someRepo' });
  });

  it('falls back to Kangentic/kangentic when GITHUB_REPOSITORY is unset', () => {
    delete process.env.GITHUB_REPOSITORY;
    expect(parseArgs(['v1.2.3'])).toEqual({ tag: 'v1.2.3', repo: 'Kangentic/kangentic' });
  });
});

describe('main', () => {
  const VERSION = '9.9.9';
  const TAG = `v${VERSION}`;

  it('exits nonzero on the verification-failure branch, not just the usage branch', () => {
    // No release at all for the tag -> verifyReleaseAssets returns ok:false.
    const { main } = loadScriptWithMockedExecFileSync(() => JSON.stringify([]));
    const exitSpy = spyOnProcessExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [...originalArgv.slice(0, 2), TAG, '--repo', 'Kangentic/kangentic'];

    expect(() => main()).toThrow(ProcessExitSentinel);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Pin the branch: this must be the verification-failure message, not the `!tag` usage
    // message, or a future test typo (e.g. an empty argv) would report the same exit code
    // for the wrong reason and this test would stay green even if the verification-failure
    // branch's process.exit(1) were deleted.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Release verification FAILED'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('does not exit nonzero when verification passes', () => {
    const { expectedReleaseAssets } = requireFromRepo('./scripts/release-assets.js') as {
      expectedReleaseAssets: (version: string) => string[];
    };
    const release: RawRelease = {
      id: 1,
      draft: true,
      tag_name: TAG,
      assets: expectedReleaseAssets(VERSION).map((name) => ({ name, state: 'uploaded' })),
    };
    // A single release satisfies the whole expected set, so page 1 (length 1, under 100) is the
    // only page requested; the loop breaks there regardless of what a page 2 would contain.
    const { main } = loadScriptWithMockedExecFileSync(() => JSON.stringify([release]));
    const exitSpy = spyOnProcessExit();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [...originalArgv.slice(0, 2), TAG, '--repo', 'Kangentic/kangentic'];

    expect(() => main()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Release verification passed'));
  });
});

describe('releasesForTag pagination', () => {
  it('walks past two full 100-item pages to a short page and collects matches from all three', () => {
    const tag = 'v9.9.9';
    const otherTag = 'v0.0.0';
    const makeRelease = (id: number, tagName: string): RawRelease => ({
      id,
      draft: true,
      tag_name: tagName,
      assets: [],
    });

    // One match seeded on each page proves the loop both walks past the two full pages
    // (rather than stopping at page 1) and keeps accumulating (rather than returning only
    // the last page's matches).
    const page1 = Array.from({ length: 100 }, (_unused, index) =>
      makeRelease(index + 1, index + 1 === 50 ? tag : otherTag)
    );
    const page2 = Array.from({ length: 100 }, (_unused, index) =>
      makeRelease(index + 101, index + 101 === 150 ? tag : otherTag)
    );
    const page3 = [makeRelease(201, tag)]; // length 1, under 100 -> loop stops here

    let callCount = 0;
    const { releasesForTag } = loadScriptWithMockedExecFileSync(() => {
      callCount += 1;
      if (callCount === 1) return JSON.stringify(page1);
      if (callCount === 2) return JSON.stringify(page2);
      return JSON.stringify(page3);
    });

    const matches = releasesForTag('Kangentic/kangentic', tag);

    expect(callCount).toBe(3);
    expect(matches.map((release) => release.id)).toEqual([50, 150, 201]);
  });
});
