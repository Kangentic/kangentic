/**
 * Unit tests for FileWatcher - fs.watch fast path with polling fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockWatcherClose = vi.fn();
const mockWatcherOn = vi.fn();

// Captured callbacks from fs.watch calls (in order)
let watchCallbacks: Array<(...args: unknown[]) => void> = [];
let watchShouldThrow = false;
const mockStatSync = vi.fn(() => ({ mtimeMs: 0, size: 0 }));

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((_path: string, callback: (...args: unknown[]) => void) => {
      if (watchShouldThrow) {
        watchShouldThrow = false;
        throw new Error('ENOENT');
      }
      watchCallbacks.push(callback);
      return { close: mockWatcherClose, on: mockWatcherOn };
    }),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  },
}));

import { FileWatcher } from '../../src/main/pty/readers/file-watcher';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Simulate fs.watch firing for the most recent file watcher */
function fireWatcher(): void {
  const lastCallback = watchCallbacks[watchCallbacks.length - 1];
  if (lastCallback) lastCallback();
}

/** Simulate fs.watch firing for a directory watcher with a filename */
function fireDirWatcher(eventType: string, filename: string | null): void {
  const lastCallback = watchCallbacks[watchCallbacks.length - 1];
  if (lastCallback) lastCallback(eventType, filename);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watchCallbacks = [];
    watchShouldThrow = false;
    mockStatSync.mockReturnValue({ mtimeMs: 0, size: 0 });
    onChange = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWatcher(overrides: Record<string, unknown> = {}): FileWatcher {
    return new FileWatcher({
      filePath: '/test/status.json',
      onChange,
      ...overrides,
    } as ConstructorParameters<typeof FileWatcher>[0]);
  }

  describe('fs.watch fast path', () => {
    it('fires onChange after debounce when fs.watch triggers', () => {
      const watcher = createWatcher({ debounceMs: 50 });

      fireWatcher();
      expect(onChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });

    it('debounces rapid fs.watch events into a single onChange call', () => {
      const watcher = createWatcher({ debounceMs: 50 });

      fireWatcher();
      vi.advanceTimersByTime(20);
      fireWatcher();
      vi.advanceTimersByTime(20);
      fireWatcher();

      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });
  });

  describe('polling fallback', () => {
    it('detects changes via polling when fs.watch is silent', () => {
      const isStale = vi.fn().mockReturnValue(true);
      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // Advance to first poll
      vi.advanceTimersByTime(1000);

      // Wait for debounce
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });

    it('does not double-fire when fs.watch already handled the change', () => {
      const isStale = vi.fn().mockReturnValue(true);
      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // fs.watch fires first - starts debounce
      fireWatcher();

      // Poll runs while debounce is pending - debounceTimer guard skips it
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });

    it('skips polling when isStale returns false', () => {
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      vi.advanceTimersByTime(5000);
      expect(onChange).not.toHaveBeenCalled();

      watcher.close();
    });

    it('uses default mtime-based staleness check', () => {
      // Set mtime in the future (file was modified after watcher construction)
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() + 5000 });

      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50 });

      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });

    it('respects custom isStale function', () => {
      let stale = false;
      const isStale = vi.fn(() => stale);
      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // Not stale - no trigger
      vi.advanceTimersByTime(1050);
      expect(onChange).not.toHaveBeenCalled();

      // Now stale
      stale = true;
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });

    it('polls repeatedly when data keeps arriving', () => {
      let staleCount = 0;
      const isStale = vi.fn(() => {
        staleCount++;
        // Stale on odd checks (simulates new data arriving between polls)
        return staleCount % 2 === 1;
      });
      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // First poll: stale -> trigger
      vi.advanceTimersByTime(1050);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Second poll: not stale -> skip
      // Third poll: stale -> trigger
      vi.advanceTimersByTime(2050);
      expect(onChange).toHaveBeenCalledTimes(2);

      watcher.close();
    });
  });

  describe('directory fallback', () => {
    it('falls back to directory watching when file does not exist', () => {
      watchShouldThrow = true;

      const watcher = createWatcher({
        filePath: '/test/dir/status.json',
        debounceMs: 50,
      });

      // Should have fallen back to directory watch
      expect(watchCallbacks).toHaveLength(1);

      // Simulate directory change for the expected file
      fireDirWatcher('change', 'status.json');
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Different file in same directory - should not trigger
      fireDirWatcher('change', 'other.json');
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });
  });

  describe('close', () => {
    it('cleans up watcher, poll timer, and debounce timer', () => {
      const watcher = createWatcher({ debounceMs: 50 });

      // Start a debounce
      fireWatcher();

      watcher.close();

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);

      // Advance time - nothing should fire after close
      vi.advanceTimersByTime(5000);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const watcher = createWatcher();
      watcher.close();
      watcher.close();
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
    });

    it('ignores fs.watch events after close', () => {
      const watcher = createWatcher({ debounceMs: 50 });
      watcher.close();

      fireWatcher();
      vi.advanceTimersByTime(50);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('no stale logging', () => {
    it('does not produce console.warn or console.debug output', () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const debugSpy = vi.spyOn(console, 'debug');

      const isStale = vi.fn().mockReturnValue(true);
      const watcher = createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // Run many poll cycles
      for (let iteration = 0; iteration < 20; iteration++) {
        vi.advanceTimersByTime(1050);
      }

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      debugSpy.mockRestore();
      watcher.close();
    });
  });
});
