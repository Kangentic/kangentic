import type { SpawnSessionInput } from '../../shared/types';
import { isShuttingDown } from '../shutdown-state';

interface QueueEntry {
  input: SpawnSessionInput;
  sessionId: string;
}

type SpawnFn = (input: SpawnSessionInput) => Promise<void>;
type ActiveCountFn = () => number;

/**
 * Manages session concurrency with a reentrancy-safe queue.
 *
 * SessionManager delegates all "should we queue or spawn?" decisions here.
 * The reentrancy guard (`_processing` + `_dirty` loop) ensures that even
 * when multiple callers invoke `notifySlotFreed()` concurrently, only one
 * `processQueue` loop runs at a time -- preventing over-spawning.
 */
export class SessionQueue {
  private queue: QueueEntry[] = [];
  private maxConcurrent: number;
  private _processing = false;
  private _dirty = false;
  private spawner: SpawnFn;
  private getActiveCount: ActiveCountFn;

  constructor(opts: {
    spawner: SpawnFn;
    getActiveCount: ActiveCountFn;
    maxConcurrent: number;
  }) {
    this.spawner = opts.spawner;
    this.getActiveCount = opts.getActiveCount;
    this.maxConcurrent = opts.maxConcurrent;
  }

  /** Update the concurrency limit and immediately try to promote. */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
    this.notifySlotFreed();
  }

  /** Check if a new session should be queued (active count >= limit). */
  shouldQueue(): boolean {
    return this.getActiveCount() >= this.maxConcurrent;
  }

  /** Add an entry to the queue. */
  enqueue(input: SpawnSessionInput, sessionId: string): void {
    this.queue.push({ input, sessionId });
  }

  /** Remove a specific session from the queue (e.g. on kill/suspend). Returns true if found. */
  remove(sessionId: string): boolean {
    const idx = this.queue.findIndex((q) => q.sessionId === sessionId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** Signal that a slot may have opened (session exited/suspended/killed). */
  notifySlotFreed(): void {
    // Don't await -- callers (kill, suspend, onExit) shouldn't block.
    // The reentrancy guard ensures only one loop runs at a time.
    this.processQueue().catch((err) => {
      console.error('[SessionQueue] processQueue error:', err);
    });
  }

  /**
   * Process the queue with a reentrancy guard.
   *
   * If another call is already inside this method, we set `_dirty` and
   * return -- the running call will re-check the queue before exiting.
   * This prevents concurrent async iterations from each popping an entry
   * and over-spawning beyond the limit.
   *
   * Each spawn is awaited so that `getActiveCount()` reflects the new
   * session before the next iteration decides whether to promote another.
   */
  private async processQueue(): Promise<void> {
    if (this._processing) {
      this._dirty = true;
      return;
    }

    this._processing = true;

    try {
      do {
        this._dirty = false;
        while (this.queue.length > 0 && !isShuttingDown() && this.getActiveCount() < this.maxConcurrent) {
          const next = this.queue.shift()!;
          try {
            await this.spawner(next.input);
          } catch (err) {
            console.error(
              `[SessionQueue] Failed to spawn queued session for task ${next.input.taskId}:`,
              err,
            );
          }
        }
      } while (this._dirty);
    } finally {
      this._processing = false;
    }
  }

  /** Clear all entries from the queue. */
  clear(): void {
    this.queue.length = 0;
  }

  get length(): number {
    return this.queue.length;
  }

  get maxConcurrentSessions(): number {
    return this.maxConcurrent;
  }
}
