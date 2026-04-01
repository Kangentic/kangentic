/**
 * Unit tests for DiffWatcher - file system watcher with debounce for live diff updates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockWatcherClose = vi.fn();
let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((_path: string, _options: unknown, callback: (eventType: string, filename: string | null) => void) => {
      watchCallback = callback;
      return { close: mockWatcherClose };
    }),
  },
}));

// Use forward-slash separator for cross-platform tests.
// DiffWatcher uses path.sep to split filenames; on Linux path.sep is '/'.
vi.mock('node:path', () => ({
  default: {
    sep: '/',
  },
}));

import { DiffWatcher } from '../../src/main/git/diff-watcher';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DiffWatcher', () => {
  let watcher: DiffWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watchCallback = null;
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

    // Reset the mock call count, then subscribe again
    mockWatcherClose.mockClear();
    const secondCallback = vi.fn();
    watcher.subscribe('/project', secondCallback);

    // Trigger a change - only the first callback should be wired
    watchCallback!('change', 'src/file.ts');
    vi.advanceTimersByTime(2000);

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
    vi.advanceTimersByTime(2000);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid changes into a single callback', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Rapid file changes
    watchCallback!('change', 'src/a.ts');
    vi.advanceTimersByTime(500);
    watchCallback!('change', 'src/b.ts');
    vi.advanceTimersByTime(500);
    watchCallback!('change', 'src/c.ts');

    // Not fired yet
    expect(callback).not.toHaveBeenCalled();

    // Advance past debounce from last change
    vi.advanceTimersByTime(2000);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores changes in .git directories', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', '.git/refs/heads/main');
    vi.advanceTimersByTime(2000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores changes in node_modules', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', 'node_modules/some-package/index.js');
    vi.advanceTimersByTime(2000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores changes in .kangentic directory', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', '.kangentic/worktrees/task/file.ts');
    vi.advanceTimersByTime(2000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores null filename events', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', null);
    vi.advanceTimersByTime(2000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribes and closes the watcher', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watcher.unsubscribe('/project');

    expect(mockWatcherClose).toHaveBeenCalledTimes(1);
  });

  it('clears pending debounce timer on unsubscribe', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Trigger a change (starts debounce timer)
    watchCallback!('change', 'src/file.ts');

    // Unsubscribe before debounce fires
    watcher.unsubscribe('/project');

    // Advance past debounce
    vi.advanceTimersByTime(2000);

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

    expect(mockWatcherClose).toHaveBeenCalledTimes(2);
  });
});
