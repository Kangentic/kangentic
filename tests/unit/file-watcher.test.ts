/**
 * Unit tests for FileWatcher - fs.watch fast path with polling fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockWatcherClose = vi.fn();

// Handlers registered via watcher.on('error', ...), oldest first. Captured
// rather than discarded so the error path can be driven from a test.
let watchErrorHandlers: Array<() => void> = [];
const mockWatcherOn = vi.fn((eventName: string, handler: () => void) => {
  if (eventName === 'error') watchErrorHandlers.push(handler);
});

// Captured callbacks from fs.watch calls (in order)
let watchCallbacks: Array<(...args: unknown[]) => void> = [];
// The path each fs.watch call targeted, in order. Lets a test assert that a
// re-arm went to the file and not back to the directory.
let watchPaths: string[] = [];
let watchShouldThrow = false;
const mockStatSync = vi.fn(() => ({ mtimeMs: 0, size: 0 }));
const mockExistsSync = vi.fn(() => false);

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((watchPath: string, callback: (...args: unknown[]) => void) => {
      if (watchShouldThrow) {
        watchShouldThrow = false;
        throw new Error('ENOENT');
      }
      watchPaths.push(watchPath);
      watchCallbacks.push(callback);
      return { close: mockWatcherClose, on: mockWatcherOn };
    }),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
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

/** The storm threshold in file-watcher.ts. Exceed it to trip a disarm. */
const STORM_EVENT_THRESHOLD = 1000;

function fireWatcherTimes(count: number): void {
  for (let index = 0; index < count; index++) fireWatcher();
}

function fireDirWatcherTimes(count: number, eventType: string, filename: string | null): void {
  for (let index = 0; index < count; index++) fireDirWatcher(eventType, filename);
}

/** Invoke the most recently registered 'error' handler. */
function fireWatcherError(): void {
  const lastHandler = watchErrorHandlers[watchErrorHandlers.length - 1];
  if (lastHandler) lastHandler();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watchCallbacks = [];
    watchPaths = [];
    watchErrorHandlers = [];
    watchShouldThrow = false;
    mockStatSync.mockReturnValue({ mtimeMs: 0, size: 0 });
    // Default false so no existing test gains a re-arm; storm tests opt in.
    mockExistsSync.mockReturnValue(false);
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

    it('skips the redundant poll stat while fs.watch fired within the interval', () => {
      const isStale = vi.fn().mockReturnValue(false);
      createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // Native fs.watch event at t=500 -> marks the watcher healthy.
      vi.advanceTimersByTime(500);
      fireWatcher();
      vi.advanceTimersByTime(50); // let the debounce fire
      isStale.mockClear();

      // First poll at t=1000: the native watcher fired 500ms ago (< 1000ms),
      // so the poll skips its stat entirely (isStale is the stat proxy here).
      vi.advanceTimersByTime(450);
      expect(isStale).not.toHaveBeenCalled();
    });

    it('resumes the poll stat once fs.watch has been quiet past one interval', () => {
      const isStale = vi.fn().mockReturnValue(true);
      createWatcher({ pollIntervalMs: 1000, debounceMs: 50, isStale });

      // Native event at t=100, then fs.watch goes silent.
      vi.advanceTimersByTime(100);
      fireWatcher();
      vi.advanceTimersByTime(50);
      onChange.mockClear();

      // Poll at t=1000: gap 900 < 1000 -> skipped.
      vi.advanceTimersByTime(850);
      // Poll at t=2000: gap 1900 >= 1000 -> proceeds, stale -> onChange fires.
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(50); // debounce
      expect(onChange).toHaveBeenCalledTimes(1);
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

  describe('storm disarm', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // A disarm warns once, by design. Silence it so the suite output stays clean.
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('disarms a flooding directory watcher, and polling still delivers', () => {
      watchShouldThrow = true;
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({
        filePath: '/test/dir/status.json',
        debounceMs: 50,
        pollIntervalMs: 1000,
        isStale,
      });
      expect(watchPaths).toEqual(['/test/dir']);

      // The real Windows flood carries the watched directory's own absolute
      // path, which never equals the expected filename - so the filter drops
      // every event and nothing downstream of it ever sees the storm.
      fireDirWatcherTimes(STORM_EVENT_THRESHOLD + 1, 'rename', '\\\\?\\C:\\test\\dir');

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();

      // The poll fallback is untouched by the disarm.
      isStale.mockReturnValue(true);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      watcher.close();
    });

    it('disarms a flooding file watcher that never settles its debounce', () => {
      const watcher = createWatcher({ debounceMs: 50, pollIntervalMs: 100000 });

      // No timer advance: each event clears and re-arms the debounce, so
      // onChange never fires and the run never resets.
      fireWatcherTimes(STORM_EVENT_THRESHOLD + 1);

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
      watcher.close();
    });

    it('does not disarm on slow sibling churn spread across windows', () => {
      watchShouldThrow = true;
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({
        filePath: '/test/dir/status.json',
        debounceMs: 50,
        pollIntervalMs: 100000,
        isStale,
      });

      // Five times the threshold in total, but no single window holds enough.
      // This is the BoardConfigManager case: a project root where .git, build
      // output and lockfiles churn while kangentic.json never appears, so
      // nothing ever dispatches to reset the count.
      for (let burst = 0; burst < 5; burst++) {
        fireDirWatcherTimes(500, 'change', 'unrelated.log');
        vi.advanceTimersByTime(1001);
      }

      expect(mockWatcherClose).not.toHaveBeenCalled();
      watcher.close();
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
    });

    it('does not disarm while events keep dispatching', () => {
      const watcher = createWatcher({ debounceMs: 50, pollIntervalMs: 100000 });

      // Twice the threshold overall, but every batch settles and dispatches.
      for (let batch = 0; batch < 10; batch++) {
        fireWatcherTimes(200);
        vi.advanceTimersByTime(50);
      }

      expect(onChange).toHaveBeenCalledTimes(10);
      expect(mockWatcherClose).not.toHaveBeenCalled();
      watcher.close();
    });

    it('re-arms a FILE watch from the poll, never the directory', () => {
      watchShouldThrow = true;
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({
        filePath: '/test/dir/status.json',
        debounceMs: 50,
        pollIntervalMs: 1000,
        isStale,
      });
      expect(watchPaths).toEqual(['/test/dir']);

      fireDirWatcherTimes(STORM_EVENT_THRESHOLD + 1, 'rename', '\\\\?\\C:\\test\\dir');
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);

      // Target still missing: no re-arm, and no fs.watch throw once per second.
      vi.advanceTimersByTime(1000);
      expect(watchPaths).toEqual(['/test/dir']);

      // Target back: re-armed on the file, never back onto the directory.
      mockExistsSync.mockReturnValue(true);
      vi.advanceTimersByTime(1000);
      expect(watchPaths).toEqual(['/test/dir', '/test/dir/status.json']);

      watcher.close();
    });

    it('lets the very next poll run isStale after a disarm', () => {
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({ debounceMs: 50, pollIntervalMs: 1000, isStale });

      // A file-arm storm advances lastWatcherNativeFireTime on every event,
      // which would otherwise suppress the poll's stat for a full interval
      // after the handle is already gone.
      fireWatcherTimes(STORM_EVENT_THRESHOLD + 1);
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
      isStale.mockClear();

      vi.advanceTimersByTime(1000);
      expect(isStale).toHaveBeenCalled();

      watcher.close();
    });

    it('does not double-close when closed after a disarm', () => {
      const watcher = createWatcher({ debounceMs: 50, pollIntervalMs: 100000 });

      fireWatcherTimes(STORM_EVENT_THRESHOLD + 1);
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);

      watcher.close();
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('releases the handle on an error event and re-arms from the poll', () => {
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({ pollIntervalMs: 1000, isStale });
      expect(watchPaths).toEqual(['/test/status.json']);

      // Windows raises EPERM here when a watched FILE's directory is deleted.
      fireWatcherError();
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);

      mockExistsSync.mockReturnValue(true);
      vi.advanceTimersByTime(1000);
      expect(watchPaths).toEqual(['/test/status.json', '/test/status.json']);

      watcher.close();
    });

    it('does not re-arm after close', () => {
      const watcher = createWatcher({ pollIntervalMs: 1000 });
      mockExistsSync.mockReturnValue(true);

      watcher.close();
      const pathCountAtClose = watchPaths.length;

      vi.advanceTimersByTime(5000);
      expect(watchPaths).toHaveLength(pathCountAtClose);
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
