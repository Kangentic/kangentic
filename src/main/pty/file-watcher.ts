import fs from 'node:fs';

interface FileWatcherOptions {
  filePath: string;
  onChange: () => void;
  label: string;
  debounceMs?: number;
  pollIntervalMs?: number;
  staleThresholdMs?: number;
  isStale?: () => boolean;
}

/**
 * Watches a file for changes using fs.watch with automatic directory fallback
 * (when the file doesn't exist yet) and a polling safety net that detects
 * when fs.watch silently stops firing and restarts it.
 */
export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWatcherFireTime: number;
  private closed = false;
  private hasLoggedStaleRecovery = false;

  private readonly filePath: string;
  private readonly onChange: () => void;
  private readonly label: string;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly isStale: () => boolean;

  constructor(options: FileWatcherOptions) {
    this.filePath = options.filePath;
    this.onChange = options.onChange;
    this.label = options.label;
    this.debounceMs = options.debounceMs ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.staleThresholdMs = options.staleThresholdMs ?? 5000;
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
    // Do NOT reset hasLoggedStaleRecovery here — if the watcher was restarted
    // by polling, the new fs.watch may fire once immediately (Node behavior),
    // which would reset the flag and cause repeated log spam on the next poll.
    // The flag is only reset when a poll cycle confirms the watcher is healthy.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.onChange(), this.debounceMs);
  };

  private setupWatcher(): void {
    try {
      const watcher = fs.watch(this.filePath, this.onFileChange);
      watcher.on('error', (error: Error) => {
        console.warn(`[WATCHER] ${this.label} watcher error:`, error.message);
      });
      this.watcher = watcher;
    } catch {
      // File may not exist yet; try watching the parent directory instead
      const directory = this.filePath.replace(/[/\\][^/\\]+$/, '');
      const expectedFilename = this.filePath.replace(/^.*[/\\]/, '');
      try {
        const watcher = fs.watch(directory, (_eventType, filename) => {
          if (filename === expectedFilename) {
            this.onFileChange();
          }
        });
        watcher.on('error', (error: Error) => {
          console.warn(`[WATCHER] ${this.label} dir watcher error:`, error.message);
        });
        this.watcher = watcher;
      } catch {
        // Can't watch directory either — polling fallback will still work
      }
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (this.closed) return;
      const timeSinceLastFire = Date.now() - this.lastWatcherFireTime;
      if (this.isStale() && timeSinceLastFire > this.staleThresholdMs) {
        if (!this.hasLoggedStaleRecovery) {
          console.warn(`[WATCHER] ${this.label} stale (${Math.round(timeSinceLastFire / 1000)}s since last fire). Recovering.`);
          this.hasLoggedStaleRecovery = true;
        }
        this.onChange();
        this.restartWatcher();
      } else if (this.hasLoggedStaleRecovery && !this.isStale()) {
        // Watcher recovered — allow future stale logs
        this.hasLoggedStaleRecovery = false;
      }
    }, this.pollIntervalMs);
  }

  private restartWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.lastWatcherFireTime = Date.now();
    this.setupWatcher();
  }
}
