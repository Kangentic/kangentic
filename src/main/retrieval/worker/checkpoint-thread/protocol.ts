/**
 * The messages between the retrieval worker's checkpoint runner
 * (`../checkpoint-runner.ts`) and its thread (`checkpoint-thread-entry.ts`).
 * Each message names a database by its file path, the key the thread opens
 * its own connection by.
 */

/** What `PRAGMA wal_checkpoint(PASSIVE)` answers: whether it was blocked, the
 *  WAL's length in pages, and how many pages it copied. */
export interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

export type ToCheckpointThreadMessage =
  | { type: 'checkpoint'; id: number; dbPath: string }
  /** Close the thread's connection to this file, so the file can be deleted. */
  | { type: 'close'; id: number; dbPath: string };

export type FromCheckpointThreadMessage =
  | { type: 'result'; id: number; ok: true; row: CheckpointRow | null }
  /** `message` stays in the worker's local log. It never reaches a report. */
  | { type: 'result'; id: number; ok: false; message: string; errorName?: string; errorCode?: string };
