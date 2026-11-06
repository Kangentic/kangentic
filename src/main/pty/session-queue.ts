import type { SpawnSessionInput } from '../../shared/types';
import { isShuttingDown } from '../shutdown-state';

interface QueueEntry {
  input: SpawnSessionInput & { id: string };
}

type SpawnFn = (input: SpawnSessionInput) => Promise<void>;
type ActiveCountFn = () => number;

export type QueuedInput = SpawnSessionInput & { id: string };

/** What a gate reads about a start. */
export type GatedInput = Pick<SpawnSessionInput, 'taskId' | 'projectId' | 'transient' | 'workflowId'>;

/** A task holding, or reserving, an agent slot in whichever column it is in. */
export interface ColumnHolder {
  projectId: string;
  taskId: string;
  /** Null for a slot a restart is keeping. */
  sessionId: string | null;
}

/** A Command Terminal and a workflow's own agent belong to no column. */
export function isColumnExempt(input: Pick<SpawnSessionInput, 'transient' | 'workflowId'>): boolean {
  return Boolean(input.transient || input.workflowId);
}

/**
 * What the queue asks about a limit it cannot see for itself, a column's agent
 * limit today. The queue stays free of database code: the gate is injected, and
 * with no gate the queue is the plain FIFO it always was.
 */
export interface QueueGate {
  /** Whether this input has to wait even with a global slot free. */
  mustWait(input: GatedInput, queued: readonly QueuedInput[]): boolean;
  /** The index of the next entry to start, or -1 when none can. */
  pick(queued: readonly QueuedInput[]): number;
  /** How many entries are waiting on the gate rather than on a global slot. */
  countBlocked(queued: readonly QueuedInput[]): number;
}

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
  private gate: QueueGate | null = null;

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

  /** Install the gate. This does not drain: a gate that frees entries needs a `notifySlotFreed()` after it. */
  setGate(gate: QueueGate): void {
    this.gate = gate;
  }

  /**
   * Check if a new session should be queued: the global limit is reached, or the
   * gate says this input waits. A gate that throws admits, because a limit that
   * cannot be read must not strand a task.
   */
  shouldQueue(input?: GatedInput): boolean {
    if (this.getActiveCount() >= this.maxConcurrent) return true;
    return input ? this.gateBlocks(input) : false;
  }

  /** Whether the gate alone holds this input, whatever the global count reads. */
  gateBlocks(input: GatedInput): boolean {
    if (!this.gate) return false;
    try {
      return this.gate.mustWait(input, this.queuedInputs());
    } catch (error) {
      console.error('[SessionQueue] mustWait threw, admitting:', error);
      return false;
    }
  }

  /** Add an entry to the queue. The input must have `id` set by the caller. */
  enqueue(input: SpawnSessionInput & { id: string }): void {
    this.queue.push({ input });
  }

  /** Remove a specific session from the queue (e.g. on kill/suspend). Returns true if found. */
  remove(sessionId: string): boolean {
    const idx = this.queue.findIndex((q) => q.input.id === sessionId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** Swap a waiting entry's command, keeping its place. False when it is not waiting. */
  replaceCommand(sessionId: string, command: string): boolean {
    const entry = this.queue.find((candidate) => candidate.input.id === sessionId);
    if (!entry) return false;
    entry.input = { ...entry.input, command };
    return true;
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
          const index = this.pickNext();
          if (index < 0) break;
          const [next] = this.queue.splice(index, 1);
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

  private queuedInputs(): QueuedInput[] {
    return this.queue.map((entry) => entry.input);
  }

  /** The gate's choice, or the head with no gate or a gate that threw. */
  private pickNext(): number {
    if (!this.gate) return 0;
    try {
      return this.gate.pick(this.queuedInputs());
    } catch (error) {
      console.error('[SessionQueue] pick threw, taking the head:', error);
      return 0;
    }
  }

  /** Clear all entries from the queue. */
  clear(): void {
    this.queue.length = 0;
  }

  get length(): number {
    return this.queue.length;
  }

  /** Entries waiting on the gate, which hold no claim on a global slot. */
  get blockedCount(): number {
    if (!this.gate || this.queue.length === 0) return 0;
    try {
      return this.gate.countBlocked(this.queuedInputs());
    } catch (error) {
      console.error('[SessionQueue] countBlocked threw, counting none:', error);
      return 0;
    }
  }

  /** Queued inputs in queue order, for anything that reports the line. */
  get entries(): readonly QueuedInput[] {
    return this.queuedInputs();
  }

  get maxConcurrentSessions(): number {
    return this.maxConcurrent;
  }
}
