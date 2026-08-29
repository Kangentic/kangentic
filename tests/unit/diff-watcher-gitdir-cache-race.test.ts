/**
 * Unit test closing a red-green coverage hole for an in-flight
 * releaseUnder() race in DiffWatcher.watchGitMetadata
 * (src/main/git/diff-watcher.ts): a releaseUnder() that lands while
 * `git rev-parse --absolute-git-dir` is still resolving must leave
 * gitDirCache genuinely empty, not silently repopulated by the late
 * resolution.
 *
 * The fix is the entry-liveness guard immediately before the cache write in
 * watchGitMetadata's `.then()`:
 *   if (this.watchers.get(worktreePath) !== entry) return;
 *   this.gitDirCache.set(worktreePath, gitDir);
 *
 * The two existing 'git dir cache' tests in tests/unit/diff-watcher.test.ts
 * both fully `await` the rev-parse promise before calling releaseUnder, so
 * neither one exercises the in-flight case this guard protects. This test
 * drives the promise on a manually-controlled schedule so releaseUnder can
 * land WHILE it is still pending.
 *
 * Mirrors tests/unit/diff-watcher.test.ts's node:fs / simple-git / node:path
 * mocking style rather than importing from it, since each spec file owns its
 * own `vi.mock(...)` factories.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (mirrors tests/unit/diff-watcher.test.ts) ─────────────────────────

/** Per-path close spies, keyed by the watched path. */
const mockCloseFns = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((watchPath: string, _options: unknown, _callback: (eventType: string, filename: string | null) => void) => {
      const closeFn = vi.fn();
      mockCloseFns.set(watchPath, closeFn);
      return { close: closeFn };
    }),
    existsSync: vi.fn(() => true),
  },
}));

// Mock simple-git so the test can control rev-parse resolution timing.
const mockGitRaw = vi.fn<(args: string[]) => Promise<string>>();
const mockGitInstance = { raw: mockGitRaw };

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGitInstance),
}));

// Extend the real path module: pin sep to '/' for cross-platform consistency
// (DiffWatcher splits filenames by path.sep; on CI Linux sep is already '/'),
// but keep the real `relative`, `isAbsolute`, and `join` so releaseUnder's
// replacePathPrefix works correctly.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    default: {
      ...actual,
      sep: '/',
    },
  };
});

import { DiffWatcher } from '../../src/main/git/diff-watcher';

// ── Helpers ──────────────────────────────────────────────────────────────

/** A promise this test resolves on its own schedule, standing in for the
 *  in-flight `git rev-parse` subprocess. */
function createDeferredGitRawResult(): {
  promise: Promise<string>;
  resolve: (resolvedGitDir: string) => void;
} {
  let resolvePromise!: (resolvedGitDir: string) => void;
  const promise = new Promise<string>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('DiffWatcher git dir cache in-flight release race', () => {
  let watcher: DiffWatcher;

  beforeEach(() => {
    mockCloseFns.clear();
    mockGitRaw.mockReset();
    // Default: git is not a real repo, so rev-parse rejects and
    // watchGitMetadata no-ops (mirrors tests/unit/diff-watcher.test.ts). The
    // one test in this file overrides this with its own controlled
    // resolution.
    mockGitRaw.mockRejectedValue(new Error('not a git repository'));
    watcher = new DiffWatcher();
  });

  afterEach(() => {
    watcher.closeAll();
  });

  it('re-resolves the git dir when releaseUnder lands while rev-parse is still in flight', async () => {
    // Catches the fix's guard being removed. Without
    // `if (this.watchers.get(worktreePath) !== entry) return;` in
    // watchGitMetadata's .then(), the late resolution below would silently
    // repopulate gitDirCache with a git dir that releaseUnder already
    // declared gone, the second subscribe would take the cache-hit branch,
    // and mockGitRaw would be called only once total instead of twice - this
    // assertion goes red.
    const worktreePath = '/mock/race';
    const fakeGitDir = '/mock/race/.git';

    const firstRevParseResolution = createDeferredGitRawResult();
    mockGitRaw.mockReturnValueOnce(firstRevParseResolution.promise);

    // Subscribe #1: cache miss, kicks off the in-flight rev-parse.
    watcher.subscribe(worktreePath, vi.fn());
    expect(mockGitRaw).toHaveBeenCalledTimes(1);

    // The worktree is deleted (or a task's isolation is released) while
    // rev-parse is still pending.
    watcher.releaseUnder(worktreePath);

    // NOW the subprocess finally resolves, racing the release.
    firstRevParseResolution.resolve(`${fakeGitDir}\n`);
    await Promise.resolve();
    await Promise.resolve();

    // Subscribe #2: if the cache was genuinely left empty by the release,
    // this is a fresh miss and rev-parse is called again.
    mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
    watcher.subscribe(worktreePath, vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGitRaw).toHaveBeenCalledTimes(2);
  });
});
