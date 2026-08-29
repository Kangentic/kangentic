import fs from 'node:fs';

/**
 * Raw native events, arriving inside STORM_WINDOW_MS with no dispatch in
 * between, that mark an fs.watch handle as stuck rather than busy.
 *
 * On Windows, once the DIRECTORY backing an fs.watch handle is deleted the
 * handle emits `rename` in a tight loop and never stops. Measured on
 * node 24 / Windows 11: 145k to 155k events/sec, roughly 85% of it kernel
 * time, identically for a plain, a `recursive: true`, and a `recursive: false`
 * directory watch. No `error` event is emitted, recreating the path does not
 * stop it, and only close() does.
 *
 * The flood's `filename` is the watched directory's OWN absolute path in
 * extended-length (`\\?\C:\...`) form, so it never equals the file we are
 * looking for. That is why the count runs BEFORE the filename filter in
 * setupWatcher: nothing downstream of that filter ever observes a single storm
 * event, so accounting placed there would sit at zero while a core burns.
 *
 * A watch on a FILE whose parent directory is deleted does NOT flood. It emits
 * `error` (EPERM) and goes quiet, which attachErrorHandler covers instead.
 *
 * Both guards below are load-bearing:
 *  - Reset-on-dispatch covers a legitimate write burst, which always settles
 *    within debounceMs and therefore dispatches, zeroing the count.
 *  - The time window covers the directory arm, whose count also advances on
 *    unrelated SIBLING files that never dispatch. BoardConfigManager watches a
 *    project root for a usually-absent kangentic.json, where .git, build output
 *    and lockfiles churn constantly; a bare count with no window would cross the
 *    threshold during an ordinary hour of work and disarm a healthy watcher.
 */
const STORM_EVENT_THRESHOLD = 1000;
const STORM_WINDOW_MS = 1000;

interface FileWatcherOptions {
  filePath: string;
  onChange: () => void;
  debounceMs?: number;
  pollIntervalMs?: number;
  isStale?: () => boolean;
}

/**
 * Watches a file for changes using fs.watch as a fast path with polling
 * as a silent, reliable fallback.
 *
 * fs.watch is not consistent across platforms (Node.js docs). On Windows
 * it can silently stop firing; on Linux/macOS it can break when a file is
 * deleted and recreated (new inode). Rather than trying to detect and recover
 * from these failures, polling runs continuously and processes any changes
 * that fs.watch missed.
 */
export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWatcherFireTime: number;
  /** When fs.watch itself last delivered an OS event (0 = never). Tracked
   *  separately from lastWatcherFireTime, which also advances on poll-detected
   *  changes, so a broken watcher (only the poll fires) still falls back to
   *  full polling. Used to skip the redundant stat while fs.watch is healthy. */
  private lastWatcherNativeFireTime = 0;
  /** Raw native events since the last dispatch, and when that run started.
   *  See STORM_EVENT_THRESHOLD. */
  private nativeEventCount = 0;
  private nativeEventWindowStart = 0;
  private closed = false;

  private readonly filePath: string;
  private readonly onChange: () => void;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly isStale: () => boolean;

  constructor(options: FileWatcherOptions) {
    this.filePath = options.filePath;
    this.onChange = options.onChange;
    this.debounceMs = options.debounceMs ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.lastWatcherFireTime = Date.now();

    // Default staleness check: mtime-based (good for files overwritten on each write)
    this.isStale = options.isStale ?? (() => {
      try {
        const stat = fs.statSync(this.filePath);
        return stat.mtimeMs > this.lastWatcherFireTime;
      } catch {
        return false;
      }
    });

    this.setupWatcher();
    this.startPolling();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private onFileChange = (): void => {
    if (this.closed) return;
    this.lastWatcherFireTime = Date.now();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // A dispatch proves the handle is delivering usable events rather than
      // spinning, so the storm run starts over.
      this.nativeEventCount = 0;
      this.onChange();
    }, this.debounceMs);
  };

  /** fs.watch delivered an OS event: record native-watcher health, then handle
   *  the change. The poll uses lastWatcherNativeFireTime to skip its stat while
   *  the OS is already delivering events. */
  private onWatcherEvent = (): void => {
    this.lastWatcherNativeFireTime = Date.now();
    this.onFileChange();
  };

  /**
   * Every native fs.watch delivery, counted before any filename filter so a
   * flood that the filter drops entirely is still visible. See
   * STORM_EVENT_THRESHOLD for why both the count and the window are needed.
   */
  private onRawWatcherEvent = (): void => {
    // A queued completion can still arrive after close() or a disarm.
    if (this.closed || !this.watcher) return;

    this.nativeEventCount += 1;
    if (this.nativeEventCount === 1) {
      this.nativeEventWindowStart = Date.now();
      return;
    }
    if (this.nativeEventCount < STORM_EVENT_THRESHOLD) return;

    if (Date.now() - this.nativeEventWindowStart <= STORM_WINDOW_MS) {
      this.disarmWatcher();
      return;
    }
    // Slow accumulation across a long span is ordinary sibling churn, not a
    // storm. Start a fresh run rather than disarming a healthy watcher.
    this.nativeEventCount = 0;
  };

  private setupWatcher(): void {
    if (this.armFileWatcher()) return;

    // File may not exist yet; try watching the parent directory instead.
    const directory = this.filePath.replace(/[/\\][^/\\]+$/, '');
    const expectedFilename = this.filePath.replace(/^.*[/\\]/, '');
    try {
      const watcher = fs.watch(directory, (_eventType, filename) => {
        this.onRawWatcherEvent();
        if (filename === expectedFilename) {
          this.onWatcherEvent();
        }
      });
      this.attachErrorHandler(watcher);
      this.watcher = watcher;
      this.nativeEventCount = 0;
    } catch {
      // Can't watch directory either - polling fallback will still work
    }
  }

  /**
   * Arm a watch on the file itself. False when fs.watch throws (the file is
   * absent, or its directory is gone).
   *
   * Deliberately never falls back to the directory: the poll's re-arm calls
   * this directly and must not silently recreate the directory watch, which is
   * the arm that floods.
   */
  private armFileWatcher(): boolean {
    try {
      const watcher = fs.watch(this.filePath, () => {
        this.onRawWatcherEvent();
        this.onWatcherEvent();
      });
      this.attachErrorHandler(watcher);
      this.watcher = watcher;
      this.nativeEventCount = 0;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * fs.watch broke - polling covers it silently. Windows raises EPERM here when
   * the watched FILE's directory is deleted.
   *
   * Close and release the handle rather than leaving a dead FSWatcher in
   * `this.watcher`: that would block the poll's re-arm, and a leaked FSWatcher
   * is the handle class that once held the libuv loop open past a clean quit.
   * Identity-checked because a re-arm may already have replaced it, and nulling
   * the CURRENT handle from a stale handle's error would orphan a live watcher.
   */
  private attachErrorHandler(watcher: fs.FSWatcher): void {
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* already released */ }
      if (this.watcher !== watcher) return;
      this.watcher = null;
      this.nativeEventCount = 0;
      this.lastWatcherNativeFireTime = 0;
    });
  }

  /**
   * Release a stuck fs.watch handle and fall back to polling.
   *
   * Deliberately does NOT set `closed` and does NOT touch pollTimer or
   * debounceTimer: the instance stays alive on its polling fallback, and the
   * poll re-arms a file watch once the target exists again.
   *
   * Zeroing lastWatcherNativeFireTime keeps the very next poll tick from
   * skipping its isStale() check on the strength of the departed watcher's own
   * timestamps.
   */
  private disarmWatcher(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* already released */ }
      this.watcher = null;
      console.warn(
        `[file-watcher] released a flooding fs.watch handle for ${this.filePath} - falling back to polling`,
      );
    }
    this.nativeEventCount = 0;
    this.nativeEventWindowStart = 0;
    this.lastWatcherNativeFireTime = 0;
  }

  /**
   * Re-arm a watch that a storm or an error released.
   *
   * Runs above the poll's early returns because an actively-written file keeps
   * a debounce pending, which would starve a re-arm placed later in the body.
   *
   * Two limits. FILE watch only, since the directory arm is the one that
   * floods. And only when the file exists, which keeps a disarmed watcher from
   * throwing inside fs.watch once per second for the rest of its life.
   */
  private rearmFileWatcherIfDisarmed(): void {
    if (this.watcher) return;
    if (!fs.existsSync(this.filePath)) return;
    this.armFileWatcher();
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (this.closed) return;
      this.rearmFileWatcherIfDisarmed();
      if (this.debounceTimer) return;
      // fs.watch delivered an OS event within the last interval: it is healthy
      // and already pushing changes, so skip the redundant stat entirely. This
      // removes the per-interval statSync precisely during active streaming
      // (when the main loop is busiest). The poll still runs its full stat
      // when the native watcher is quiet (broke, or genuinely no changes), so
      // the fallback is preserved.
      if (Date.now() - this.lastWatcherNativeFireTime < this.pollIntervalMs) return;
      if (this.isStale()) {
        this.onFileChange();
      }
    }, this.pollIntervalMs);
    // A file-watcher poll must never, on its own, keep the process alive.
    // Without unref, a reader not detached before quit holds the libuv loop
    // open past a clean shutdown and trips the 6s hard failsafe.
    this.pollTimer.unref();
  }
}
