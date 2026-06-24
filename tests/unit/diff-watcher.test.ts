/**
 * Unit tests for DiffWatcher - file system watcher with debounce for live diff updates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

/** Per-path close spies so tests can assert exactly which watchers were closed. */
const mockCloseFns = new Map<string, ReturnType<typeof vi.fn>>();
let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;

/**
 * Per-path watch callbacks: captured by the watchGitMetadata tests so each
 * fs.watch handle (working-tree, gitDir, logsDir) can be triggered independently.
 */
const watchCallbacksByPath = new Map<string, (eventType: string, filename: string | null) => void>();

/** Controls whether fs.existsSync reports the logs/ directory as present. */
let mockExistsSyncResult = true;

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((watchPath: string, _options: unknown, callback: (eventType: string, filename: string | null) => void) => {
      watchCallback = callback;
      watchCallbacksByPath.set(watchPath, callback);
      const closeFn = vi.fn();
      mockCloseFns.set(watchPath, closeFn);
      return { close: closeFn };
    }),
    existsSync: vi.fn(() => mockExistsSyncResult),
  },
}));

// Mock simple-git so the git-metadata tests can control rev-parse output.
// Tests that don't call subscribe() with a mocked git dir are unaffected because
// the real tests never awaited the async watchGitMetadata promise.
const mockGitRaw = vi.fn<(args: string[]) => Promise<string>>();
const mockGitInstance = { raw: mockGitRaw };

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGitInstance),
}));

// Extend the real path module: pin sep to '/' for cross-platform consistency
// (DiffWatcher splits filenames by path.sep; on CI Linux sep is already '/'),
// but keep the real `relative`, `isAbsolute`, and `join` so that
// `replacePathPrefix` (imported by releaseUnder) works correctly.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    default: {
      ...actual,
      sep: '/',
    },
  };
});

import path from 'node:path';
import { DiffWatcher } from '../../src/main/git/diff-watcher';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DiffWatcher', () => {
  let watcher: DiffWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCloseFns.clear();
    watchCallbacksByPath.clear();
    watchCallback = null;
    mockExistsSyncResult = true;
    // Default: git is not a real repo, so rev-parse rejects and watchGitMetadata no-ops.
    // Tests that need a real gitDir override this.
    mockGitRaw.mockRejectedValue(new Error('not a git repository'));
    watcher = new DiffWatcher();
  });

  afterEach(() => {
    watcher.closeAll();
    vi.useRealTimers();
  });

  it('subscribes and creates a file watcher', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    expect(watchCallback).not.toBeNull();
  });

  it('does not create duplicate watchers for the same path', () => {
    const callback = vi.fn();

    watcher.subscribe('/project', callback);

    const secondCallback = vi.fn();
    watcher.subscribe('/project', secondCallback);

    // Trigger a change - only the first callback should be wired
    watchCallback!('change', 'src/file.ts');
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it('fires callback after debounce period', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Simulate a file change
    watchCallback!('change', 'src/index.ts');

    // Not fired yet (within debounce)
    expect(callback).not.toHaveBeenCalled();

    // Advance past debounce (2000ms)
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid changes into a single callback', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Rapid file changes within the debounce window
    watchCallback!('change', 'src/a.ts');
    vi.advanceTimersByTime(200);
    watchCallback!('change', 'src/b.ts');
    vi.advanceTimersByTime(200);
    watchCallback!('change', 'src/c.ts');

    // Not fired yet
    expect(callback).not.toHaveBeenCalled();

    // Advance past debounce from last change
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores changes in .git directories', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', '.git/refs/heads/main');
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores changes in node_modules', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', 'node_modules/some-package/index.js');
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores changes in .kangentic directory', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', '.kangentic/worktrees/task/file.ts');
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores null filename events', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', null);
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribes and closes the watcher', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watcher.unsubscribe('/project');

    expect(mockCloseFns.get('/project')).toHaveBeenCalledTimes(1);
  });

  it('clears pending debounce timer on unsubscribe', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Trigger a change (starts debounce timer)
    watchCallback!('change', 'src/file.ts');

    // Unsubscribe before debounce fires
    watcher.unsubscribe('/project');

    // Advance past debounce
    vi.advanceTimersByTime(500);

    // Callback should NOT have fired
    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribe is a no-op for unknown paths', () => {
    // Should not throw
    watcher.unsubscribe('/nonexistent');
  });

  it('closeAll cleans up all watchers', () => {
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    watcher.subscribe('/project-a', callbackA);
    watcher.subscribe('/project-b', callbackB);

    watcher.closeAll();

    expect(mockCloseFns.get('/project-a')).toHaveBeenCalledTimes(1);
    expect(mockCloseFns.get('/project-b')).toHaveBeenCalledTimes(1);
  });

  // ── releaseUnder ──────────────────────────────────────────────────────────
  //
  // releaseUnder uses replacePathPrefix (path.relative-based) to match the
  // prefix exactly, so tests use platform-resolved paths to ensure correct
  // path.relative behaviour on both Windows and Linux CI.

  describe('releaseUnder', () => {
    it('closes a watcher whose path IS exactly the prefix', () => {
      // Use an absolute path so path.relative gives '' (exact match).
      const prefix = '/projects/app';
      watcher.subscribe(prefix, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(prefix)).toHaveBeenCalledTimes(1);
    });

    it('closes a watcher nested under the prefix', () => {
      const prefix = '/projects/app';
      const nestedPath = '/projects/app/.kangentic/worktrees/feat-x';
      watcher.subscribe(nestedPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(nestedPath)).toHaveBeenCalledTimes(1);
    });

    it('does NOT close a sibling that shares a string prefix but is a different directory', () => {
      // '/projects/app2' starts with the string '/projects/app' but is a sibling,
      // not a child. replacePathPrefix uses path.relative which returns '..'
      // for siblings, so the match must be null.
      const prefix = '/projects/app';
      const siblingPath = '/projects/app2';
      watcher.subscribe(siblingPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(siblingPath)).not.toHaveBeenCalled();
    });

    it('does NOT close an unrelated path', () => {
      const prefix = '/projects/app';
      const unrelatedPath = '/somewhere/else';
      watcher.subscribe(unrelatedPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(unrelatedPath)).not.toHaveBeenCalled();
    });

    it('closes inside-prefix watchers and leaves outside-prefix ones alive', () => {
      const prefix = '/projects/app';
      const insidePath = '/projects/app/.kangentic/worktrees/feat-a';
      const outsidePath = '/other/project';
      const siblingPath = '/projects/app-fork';

      watcher.subscribe(insidePath, vi.fn());
      watcher.subscribe(outsidePath, vi.fn());
      watcher.subscribe(siblingPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(insidePath)).toHaveBeenCalledTimes(1);
      expect(mockCloseFns.get(outsidePath)).not.toHaveBeenCalled();
      expect(mockCloseFns.get(siblingPath)).not.toHaveBeenCalled();
    });
  });

  // ── watchGitMetadata ─────────────────────────────────────────────────────
  //
  // These tests cover the new async git-metadata watch path added on this branch.
  // The production code calls simpleGit(worktreePath).raw(['rev-parse',
  // '--absolute-git-dir']) to find the git directory, then watches:
  //   - <gitDir>  (non-recursive) for GIT_META_FILES entries (index, HEAD, ...)
  //   - <gitDir>/logs  (non-recursive) for HEAD changes
  //
  // Both watchers are pushed to entry.watchers[]; unsubscribe() must close all
  // of them, not just the first.

  describe('watchGitMetadata', () => {
    const worktreePath = '/mock/project';
    const fakeGitDir = '/mock/project/.git';
    // Use path.join to match whatever separator the production code uses when
    // computing logsDir = path.join(gitDir, 'logs') -- on Windows this is a
    // backslash path, on POSIX a forward-slash path.
    const fakeLogsDir = path.join(fakeGitDir, 'logs');

    /**
     * Subscribe and flush the Promise microtask queue so the async
     * watchGitMetadata path (which awaits git.raw) runs to completion.
     */
    async function subscribeAndFlush(callback: () => void): Promise<void> {
      watcher.subscribe(worktreePath, callback);
      // Allow the git.raw promise and its .then() to complete.
      await Promise.resolve();
      await Promise.resolve();
    }

    it('fires the debounced callback when a GIT_META_FILES entry in gitDir changes', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      // Simulate the gitDir watcher firing for 'index' (a GIT_META_FILES member).
      const gitDirCallback = watchCallbacksByPath.get(fakeGitDir);
      expect(gitDirCallback).toBeDefined();
      gitDirCallback!('change', 'index');
      vi.advanceTimersByTime(500);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fires the debounced callback when logs/HEAD changes', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      // Simulate the logsDir watcher firing for 'HEAD'.
      const logsDirCallback = watchCallbacksByPath.get(fakeLogsDir);
      expect(logsDirCallback).toBeDefined();
      logsDirCallback!('change', 'HEAD');
      vi.advanceTimersByTime(500);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire callback when gitDir watcher sees a non-GIT_META_FILES filename', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      // 'objects' is not in GIT_META_FILES, so its change must be ignored.
      const gitDirCallback = watchCallbacksByPath.get(fakeGitDir);
      gitDirCallback!('change', 'objects');
      vi.advanceTimersByTime(500);

      expect(callback).not.toHaveBeenCalled();
    });

    it('does NOT fire callback for logs/HEAD watcher when filename is not HEAD', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      const logsDirCallback = watchCallbacksByPath.get(fakeLogsDir);
      logsDirCallback!('change', 'refs');  // not 'HEAD'
      vi.advanceTimersByTime(500);

      expect(callback).not.toHaveBeenCalled();
    });

    it('skips the logsDir watch when logs/ directory does not exist', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      mockExistsSyncResult = false;  // logs/ is absent
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      // Only the gitDir watch was registered, not logsDir.
      expect(watchCallbacksByPath.has(fakeLogsDir)).toBe(false);
    });

    it('still works if rev-parse rejects (best-effort: working-tree watch remains)', async () => {
      // Default beforeEach already sets mockGitRaw to reject.
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      // The working-tree watcher (registered synchronously before the async git call)
      // must still be present and functional.
      const workingTreeCallback = watchCallbacksByPath.get(worktreePath);
      expect(workingTreeCallback).toBeDefined();
      workingTreeCallback!('change', 'src/file.ts');
      vi.advanceTimersByTime(500);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    // ── unsubscribe closes ALL watchers (working-tree + gitDir + logsDir) ──

    it('unsubscribe closes ALL watchers in entry.watchers[] including metadata watchers', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      // Three watch handles should exist: working-tree, gitDir, logsDir.
      expect(mockCloseFns.has(worktreePath)).toBe(true);
      expect(mockCloseFns.has(fakeGitDir)).toBe(true);
      expect(mockCloseFns.has(fakeLogsDir)).toBe(true);

      watcher.unsubscribe(worktreePath);

      // ALL three close() fns must have been called once.
      expect(mockCloseFns.get(worktreePath)).toHaveBeenCalledTimes(1);
      expect(mockCloseFns.get(fakeGitDir)).toHaveBeenCalledTimes(1);
      expect(mockCloseFns.get(fakeLogsDir)).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe with only working-tree watch (no gitDir) closes just that watcher', async () => {
      // Default: mockGitRaw rejects, so only the working-tree watcher was registered.
      const callback = vi.fn();

      await subscribeAndFlush(callback);

      expect(mockCloseFns.has(worktreePath)).toBe(true);
      expect(mockCloseFns.has(fakeGitDir)).toBe(false);

      watcher.unsubscribe(worktreePath);

      expect(mockCloseFns.get(worktreePath)).toHaveBeenCalledTimes(1);
    });

    it('rev-parse is called with the correct worktreePath', async () => {
      mockGitRaw.mockResolvedValueOnce(`${fakeGitDir}\n`);
      const { default: simpleGit } = await import('simple-git');

      await subscribeAndFlush(vi.fn());

      expect(simpleGit).toHaveBeenCalledWith(worktreePath);
      expect(mockGitRaw).toHaveBeenCalledWith(['rev-parse', '--absolute-git-dir']);
    });
  });
});
