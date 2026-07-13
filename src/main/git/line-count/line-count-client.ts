import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { LineCountEntry } from './line-count-worker';

/** Per-request timeout; generous since the worker itself bounds each file's
 *  read to LARGE_FILE_CAP_BYTES (count-lines.ts), so a batch's total work is
 *  capped regardless of how many files it contains. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Kill the worker after this long idle. Unlike the embedding worker, this
 *  process holds no expensive warm state (no loaded model) - a short idle
 *  window still avoids paying fork overhead repeatedly during a burst of
 *  closely-spaced diff refreshes, without holding a process open for no
 *  reason once the Changes panel is no longer in view. */
const IDLE_SHUTDOWN_MS = 60_000;
/** After this many crashes in one app run, stop trying to offload - callers
 *  fall back to inline counting (see diff-service.ts). */
const MAX_CRASHES = 3;

/** Rewrite an in-asar path to its asar.unpacked twin when packaged. */
function unpacked(absolutePath: string): string {
  return app.isPackaged ? absolutePath.replace('app.asar', 'app.asar.unpacked') : absolutePath;
}

interface PendingRequest {
  resolve: (entries: LineCountEntry[] | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the line-count utilityProcess worker. Spawns lazily on first
 * demand, shuts the worker down when idle, and restarts it (with a crash cap)
 * after an unexpected exit. Every failure path - not spawned, crashed, timed
 * out - resolves `null` so callers degrade to inline (main-thread, bounded)
 * counting rather than throwing. `dispose()` is synchronous for the shutdown
 * path (mirrors EmbedClient).
 */
export class LineCountClient {
  private child: UtilityProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private crashCount = 0;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** True while an intentional teardown (idle recycle or dispose) is in
   *  flight, so the resulting 'exit' is not miscounted as a crash. */
  private intentionalShutdown = false;

  get crashed(): boolean {
    return this.crashCount >= MAX_CRASHES;
  }

  /** Count newline-derived insertions (and detect binary content) for a batch
   *  of absolute file paths. Returns `null` on any failure (not spawned,
   *  crashed, timed out) so the caller falls back to inline counting. */
  async countFiles(absolutePaths: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LineCountEntry[] | null> {
    if (absolutePaths.length === 0) return [];
    if (this.disposed || this.crashed) return null;

    const child = this.ensureSpawned();
    if (!child) return null;

    this.clearIdleTimer();
    try {
      return await this.sendCount(child, absolutePaths, timeoutMs);
    } finally {
      this.armIdleShutdown();
    }
  }

  private ensureSpawned(): UtilityProcess | null {
    if (this.child) return this.child;
    if (this.disposed || this.crashed) return null;

    const workerPath = unpacked(path.join(__dirname, 'line-count-worker.js'));
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(workerPath, [], { serviceName: 'kangentic-line-count' });
    } catch (error) {
      console.warn('[git] line-count worker fork failed:', error);
      this.crashCount = MAX_CRASHES;
      return null;
    }
    this.child = child;
    child.on('message', (message: unknown) => this.onWorkerMessage(message));
    child.on('exit', () => this.onWorkerExit(child));
    return child;
  }

  private sendCount(child: UtilityProcess, paths: string[], timeoutMs: number): Promise<LineCountEntry[] | null> {
    const requestId = this.nextRequestId++;
    return new Promise<LineCountEntry[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, timer });
      child.postMessage({ type: 'count', id: requestId, paths });
    });
  }

  private onWorkerMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const record = message as { type?: string; id?: number; entries?: LineCountEntry[] };
    if ((record.type === 'result' || record.type === 'error') && typeof record.id === 'number') {
      const entry = this.pending.get(record.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(record.id);
      entry.resolve(record.type === 'result' ? record.entries ?? null : null);
    }
  }

  private onWorkerExit(child: UtilityProcess): void {
    const intentional = this.intentionalShutdown;
    this.intentionalShutdown = false;
    // A killed worker's 'exit' arrives asynchronously, after a replacement may
    // already have been spawned and tracked. Ignore the stale exit so it never
    // nulls the live child or resolves the replacement's in-flight requests.
    if (child !== this.child) return;
    this.child = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    // An idle recycle or dispose is not a crash; only an unexpected exit counts.
    if (!this.disposed && !intentional) this.crashCount += 1;
  }

  private armIdleShutdown(): void {
    if (this.disposed || this.idleTimer || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.killChild();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private killChild(): void {
    this.intentionalShutdown = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.postMessage({ type: 'shutdown' });
      } catch {
        // ignore; kill below is the real teardown
      }
      child.kill();
    }
  }

  /** Synchronous shutdown for the before-quit path. */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    this.killChild();
  }
}

export const lineCountClient = new LineCountClient();
