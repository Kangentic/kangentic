/**
 * Unit tests closing two red-green coverage holes in FileWatcher's
 * storm-disarm logic (src/main/pty/readers/file-watcher.ts). Each hole was
 * empirically proven by a source mutation that left the full
 * tests/unit/file-watcher.test.ts suite green:
 *
 *  - HOLE A: the storm threshold boundary (file-watcher.ts:149,
 *    `if (this.nativeEventCount < STORM_EVENT_THRESHOLD) return;`) is
 *    unpinned. Every existing test fires STORM_EVENT_THRESHOLD + 1 events (or,
 *    in the slow-churn test, 500 per burst), so none of them sits exactly at
 *    the boundary. Changing `<` to `<=` leaves the whole suite green.
 *
 *  - HOLE B: disarmWatcher's `this.lastWatcherNativeFireTime = 0;`
 *    (file-watcher.ts:245) is unpinned. Deleting that line also leaves the
 *    whole suite green, because the existing 'lets the very next poll run
 *    isStale after a disarm' test uses the FILE arm, where armFileWatcher's
 *    callback runs onWatcherEvent unconditionally right after the zeroing,
 *    setting the timestamp straight back to Date.now() - so the existing
 *    test cannot tell a real zero from a stale timestamp that happens to
 *    land on the same arithmetic result one full pollIntervalMs later.
 *
 * This file mirrors tests/unit/file-watcher.test.ts's node:fs mock and helper
 * shapes rather than importing from it, since each spec file owns its own
 * `vi.mock('node:fs', ...)` factory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (mirrors tests/unit/file-watcher.test.ts) ─────────────────────────

const mockWatcherClose = vi.fn();
const mockWatcherOn = vi.fn();

// Captured callbacks from fs.watch calls (in order).
let watchCallbacks: Array<(...args: unknown[]) => void> = [];
// The path each fs.watch call targeted, in order.
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

// ── Helpers (mirrors tests/unit/file-watcher.test.ts) ───────────────────────

/** Simulate fs.watch firing for the most recent (file) watcher. */
function fireWatcher(): void {
  const lastCallback = watchCallbacks[watchCallbacks.length - 1];
  if (lastCallback) lastCallback();
}

function fireWatcherTimes(count: number): void {
  for (let eventIndex = 0; eventIndex < count; eventIndex++) fireWatcher();
}

/** Simulate fs.watch firing for the most recent directory watcher. */
function fireDirWatcher(eventType: string, filename: string | null): void {
  const lastCallback = watchCallbacks[watchCallbacks.length - 1];
  if (lastCallback) lastCallback(eventType, filename);
}

function fireDirWatcherTimes(count: number, eventType: string, filename: string | null): void {
  for (let eventIndex = 0; eventIndex < count; eventIndex++) fireDirWatcher(eventType, filename);
}

/** The storm threshold in file-watcher.ts. Declared locally rather than
 *  exported, mirroring tests/unit/file-watcher.test.ts's own local constant. */
const STORM_EVENT_THRESHOLD = 1000;

// ── Tests ────────────────────────────────────────────────────────────────

describe('FileWatcher storm-disarm coverage holes', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watchCallbacks = [];
    watchPaths = [];
    watchShouldThrow = false;
    mockStatSync.mockReturnValue({ mtimeMs: 0, size: 0 });
    mockExistsSync.mockReturnValue(false);
    onChange = vi.fn();
    // A disarm warns once, by design (mirrors the 'storm disarm' describe
    // block in file-watcher.test.ts): silence it so the suite output stays clean.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  function createWatcher(overrides: Record<string, unknown> = {}): FileWatcher {
    return new FileWatcher({
      filePath: '/test/dir/status.json',
      onChange,
      ...overrides,
    } as ConstructorParameters<typeof FileWatcher>[0]);
  }

  describe('HOLE A: storm threshold boundary (file-watcher.ts:149)', () => {
    it('does not disarm at exactly STORM_EVENT_THRESHOLD - 1 (999) raw events', () => {
      // Pins the lower side of the boundary. Catches a threshold check that
      // trips one event early, e.g. file-watcher.ts:149 changed to
      // `if (this.nativeEventCount < STORM_EVENT_THRESHOLD - 1) return;`: at
      // the 999th event, `999 < 999` is false, so it falls through, and the
      // elapsed time is 0ms (synchronous), which is <= STORM_WINDOW_MS, so it
      // would disarm here - this assertion goes red. (This is not the
      // specific `<=` mutation named for this task - that one is caught by
      // the next test below - but it establishes the other side of the same
      // boundary so a shift in either direction is caught.)
      const watcher = createWatcher({ debounceMs: 50, pollIntervalMs: 100000 });

      fireWatcherTimes(STORM_EVENT_THRESHOLD - 1);

      expect(mockWatcherClose).not.toHaveBeenCalled();
      watcher.close();
    });

    it('disarms at exactly STORM_EVENT_THRESHOLD (1000) raw events', () => {
      // Catches the proven mutation: changing file-watcher.ts:149's
      // `if (this.nativeEventCount < STORM_EVENT_THRESHOLD) return;` to `<=`.
      // At the 1000th event, `1000 <= 1000` is true under the mutation, so the
      // function returns before ever reaching the disarm check below it, and
      // close() is never called - this assertion goes red (0 calls, not 1)
      // until the 1001st event arrives. With the real `<`, `1000 < 1000` is
      // false, so it falls through to the disarm check; the elapsed time
      // since the window opened is 0ms (all 1000 events fire synchronously,
      // no timer advance between them), which is <= STORM_WINDOW_MS, so it
      // disarms on exactly the 1000th event.
      const watcher = createWatcher({ debounceMs: 50, pollIntervalMs: 100000 });

      fireWatcherTimes(STORM_EVENT_THRESHOLD);

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
      watcher.close();
    });
  });

  describe('HOLE B: disarmWatcher must zero lastWatcherNativeFireTime (file-watcher.ts:245)', () => {
    it('lets the very next poll run isStale after a directory-arm disarm with a short gap', () => {
      // Catches the proven mutation: deleting
      // `this.lastWatcherNativeFireTime = 0;` from disarmWatcher(). This test
      // deliberately uses the DIRECTORY arm (not the file arm the existing
      // 'lets the very next poll run isStale after a disarm' test uses),
      // because on the directory arm a storm's non-matching events never
      // call onWatcherEvent, so a genuine zeroing survives to the poll tick
      // instead of being immediately overwritten. The gap between the last
      // MATCHING event and the poll tick is shaped shorter than
      // pollIntervalMs, which is what makes a non-zeroed timestamp
      // discriminating.
      watchShouldThrow = true; // file arm throws -> falls back to directory watch
      const isStale = vi.fn().mockReturnValue(false);
      const watcher = createWatcher({
        debounceMs: 50,
        pollIntervalMs: 1000,
        isStale,
      });
      expect(watchPaths).toEqual(['/test/dir']);

      // t=500: one event whose filename MATCHES the watched file -> runs
      // onWatcherEvent, setting lastWatcherNativeFireTime = 500.
      vi.advanceTimersByTime(500);
      fireDirWatcher('change', 'status.json');

      // Let the debounce settle: onChange fires once, and the dispatch resets
      // nativeEventCount to 0 (a fresh storm-count run starts after this).
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      // t=600: a burst of NON-matching events. Each runs onRawWatcherEvent
      // (counting toward the storm) but never onWatcherEvent (filename
      // mismatch), so lastWatcherNativeFireTime is untouched by this burst -
      // whatever disarmWatcher does to it from here on is the only thing that
      // can change it.
      vi.advanceTimersByTime(50);
      fireDirWatcherTimes(STORM_EVENT_THRESHOLD, 'rename', 'unrelated.log');
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);

      // t=1000: the first poll tick. The gap between the poll tick (t=1000)
      // and the matching event's timestamp (t=500) is 500ms, well under the
      // 1000ms pollIntervalMs - discriminating only if disarmWatcher actually
      // zeroed the timestamp out from under it.
      isStale.mockClear();
      vi.advanceTimersByTime(400);

      // With the zeroing: lastWatcherNativeFireTime is 0, so Date.now() - 0 is
      // the full fake-timer epoch value (real wall-clock start plus the 1000ms
      // advanced), astronomically greater than pollIntervalMs (1000). The
      // poll's native-fire-time guard does not early-return, and isStale runs.
      // Without it (the mutation): lastWatcherNativeFireTime is still the t=500
      // timestamp, so Date.now() - lastWatcherNativeFireTime = 500, which IS
      // < 1000 - the poll early-returns and isStale is never called. This
      // assertion goes red.
      expect(isStale).toHaveBeenCalled();

      watcher.close();
    });
  });
});
