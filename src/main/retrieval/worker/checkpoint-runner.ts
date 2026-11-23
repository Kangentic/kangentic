/**
 * Where the retrieval worker's WAL checkpoints run: on the checkpoint thread
 * (`checkpoint-thread/checkpoint-thread-entry.ts`) when it is up, so a long
 * checkpoint never holds the worker's request loop (Sentry DESKTOP-4P), and on
 * the loop itself when it is not.
 *
 * - The thread starts on the first checkpoint, from the path main sent in
 *   `init` (`checkpointThreadPath`). A worker with no path (a test that never
 *   sends `init`) checkpoints on the loop, as every worker did before.
 * - One checkpoint per file at a time. A request for a file whose checkpoint is
 *   still running joins it rather than queueing a second copy: the running one
 *   copies what the second would have.
 * - A thread that fails to start, throws or exits is not restarted. The runner
 *   logs once, settles what the thread still owed by running it on the loop,
 *   and checkpoints on the loop from then on, under the labels in
 *   `checkpoint-labels.ts`, so a hold there is still named.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import type { CheckpointRow, FromCheckpointThreadMessage, ToCheckpointThreadMessage } from './checkpoint-thread/protocol';

export type { CheckpointRow };

/** A request for the thread; `send` gives it its id. */
type ThreadRequest = Omit<ToCheckpointThreadMessage, 'id'>;

/**
 * The PASSIVE checkpoint on the worker's loop, under `label`, for when the
 * thread cannot take it. Synchronous, so it runs inside the caller's span.
 */
export function passiveCheckpointInLoop(db: Database.Database, label: string): CheckpointRow | null {
  const [row] = timeSyncWork(label, () => db.pragma('wal_checkpoint(PASSIVE)') as CheckpointRow[]);
  return row ?? null;
}

/** Starts the thread. Tests pass a stand-in; production starts a real Worker. */
export type CheckpointThreadFactory = (threadPath: string) => Worker;

interface PendingRequest {
  /** What to run on the loop if the thread dies before it answers. */
  fallback: () => CheckpointRow | null;
  resolve: (row: CheckpointRow | null) => void;
  reject: (error: Error) => void;
}

export class CheckpointRunner {
  private threadPath: string | null = null;
  private thread: Worker | null = null;
  /** The thread failed once; every checkpoint runs on the loop from here. */
  private threadFailed = false;
  /** Settles once a failed thread has ended, which is when its connections are gone. */
  private threadEnded: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** The checkpoint running for each file, joined by a request that arrives meanwhile. */
  private readonly inFlight = new Map<string, Promise<CheckpointRow | null>>();

  constructor(private readonly startThread: CheckpointThreadFactory = (threadPath) => new Worker(threadPath)) {}

  /** Set where the thread loads from. Null keeps every checkpoint on the loop. */
  configure(threadPath: string | null): void {
    this.threadPath = threadPath;
  }

  /** Whether a checkpoint would go to the thread right now (it may still have to start). */
  get usesThread(): boolean {
    return this.threadPath !== null && !this.threadFailed;
  }

  /**
   * Checkpoint one database file. `inLoop` is the same checkpoint run on the
   * loop, with its span label, used when the thread is not available; it runs
   * synchronously, inside the caller's span. `dbPath` is read only when the
   * thread takes the checkpoint.
   */
  checkpoint(dbPath: () => string, inLoop: () => CheckpointRow | null): Promise<CheckpointRow | null> {
    if (!this.usesThread) return runInLoop(inLoop);
    const key = path.resolve(dbPath());
    const running = this.inFlight.get(key);
    if (running) return running;
    const request = this.send({ type: 'checkpoint', dbPath: key }, inLoop)
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  /** Close the thread's connection to a file, so Windows lets it be deleted.
   *  Resolves at once when the thread never started, and once a failed thread
   *  has ended, since its connections go only with it. */
  async close(dbPath: string): Promise<void> {
    if (this.threadFailed) {
      await this.threadEnded;
      return;
    }
    if (!this.thread) return;
    const key = path.resolve(dbPath);
    // A checkpoint still running on the file finishes first: the thread handles
    // messages in order, so the close lands after it anyway.
    await this.send({ type: 'close', dbPath: key }, () => null);
    // A thread that failed with the close pending answered it through the
    // fallback, before the thread was gone.
    if (this.threadFailed) await this.threadEnded;
  }

  private send(message: ThreadRequest, fallback: () => CheckpointRow | null): Promise<CheckpointRow | null> {
    const thread = this.ensureThread();
    if (!thread) return runInLoop(fallback);
    const id = this.nextId++;
    return new Promise<CheckpointRow | null>((resolve, reject) => {
      this.pending.set(id, { fallback, resolve, reject });
      try {
        const request: ToCheckpointThreadMessage = { ...message, id };
        thread.postMessage(request);
      } catch (error) { // report-ok: a worker cannot report; the thread is given up and the loop runs this checkpoint instead.
        this.pending.delete(id);
        this.failThread(error);
        runInLoop(fallback).then(resolve, reject);
      }
    });
  }

  private ensureThread(): Worker | null {
    if (this.thread) return this.thread;
    if (!this.threadPath || this.threadFailed) return null;
    let thread: Worker;
    try {
      thread = this.startThread(this.threadPath);
    } catch (error) { // report-ok: a worker cannot report; checkpoints fall back to the loop, as every worker ran them before the thread.
      this.failThread(error);
      return null;
    }
    this.thread = thread;
    // The worker exits by `process.exit`, never by waiting on this thread.
    thread.unref();
    thread.on('message', (message: FromCheckpointThreadMessage) => this.onMessage(message));
    thread.on('error', (error) => this.failThread(error));
    thread.on('exit', (code) => this.failThread(new Error(`the checkpoint thread exited with code ${code}`)));
    return thread;
  }

  private onMessage(message: FromCheckpointThreadMessage): void {
    if (typeof message !== 'object' || message === null || message.type !== 'result') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.ok) {
      request.resolve(message.row);
      return;
    }
    const error = new Error(message.message) as NodeJS.ErrnoException;
    if (message.errorName) error.name = message.errorName;
    if (message.errorCode) error.code = message.errorCode;
    request.reject(error);
  }

  /** Give up on the thread for this worker's life, and run what it owed on the loop. */
  private failThread(error: unknown): void {
    if (this.threadFailed) return;
    this.threadFailed = true;
    const thread = this.thread;
    this.thread = null;
    // report-ok: a worker cannot report; the loop takes the checkpoints over, so nothing is lost but the thread.
    console.warn('[retrieval-worker] checkpoint thread unavailable, checkpointing on the worker loop:', error instanceof Error ? error.message : String(error));
    const owed = [...this.pending.values()];
    this.pending.clear();
    for (const request of owed) runInLoop(request.fallback).then(request.resolve, request.reject);
    if (thread) {
      this.threadEnded = thread.terminate().then(() => undefined).catch(() => undefined); // report-ok: the thread already failed; ending it is cleanup.
    }
  }
}

function runInLoop(inLoop: () => CheckpointRow | null): Promise<CheckpointRow | null> {
  try {
    return Promise.resolve(inLoop());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The worker's one runner. `retrieval-worker.ts` configures it from `init`. */
export const checkpointRunner = new CheckpointRunner();
