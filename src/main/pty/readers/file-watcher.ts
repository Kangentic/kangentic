import fs from 'node:fs';

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

  private setupWatcher(): void {
    try {
      const watcher = fs.watch(this.filePath, this.onWatcherEvent);
      watcher.on('error', () => {
        // fs.watch broke - polling will cover it silently
      });
      this.watcher = watcher;
    } catch {
      // File may not exist yet; try watching the parent directory instead
      const directory = this.filePath.replace(/[/\\][^/\\]+$/, '');
      const expectedFilename = this.filePath.replace(/^.*[/\\]/, '');
      try {
        const watcher = fs.watch(directory, (_eventType, filename) => {
          if (filename === expectedFilename) {
            this.onWatcherEvent();
          }
        });
        watcher.on('error', () => {
          // fs.watch broke - polling will cover it silently
        });
        this.watcher = watcher;
      } catch {
        // Can't watch directory either - polling fallback will still work
      }
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (this.closed || this.debounceTimer) return;
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
