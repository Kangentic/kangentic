/**
 * The retrieval worker's own checkpoints while it writes.
 *
 * No connection auto-checkpoints while the worker is up (`checkpoint-driver.ts`),
 * and main's 5 s checkpoint request is a call like any other, so it waits
 * behind a long job step. A bulk write (the first index, the code fill, a
 * vector copy) then left the whole job's pages for one checkpoint: 698 ms in
 * one step after the dev seed. So each outermost worker transaction, once it
 * commits, checkpoints its connection when a second has passed since the last
 * one did. A step then copies about a second of writes, labelled
 * `db:checkpoint` and outside the transaction's own timing. PASSIVE never
 * blocks a writer.
 */

import type Database from 'better-sqlite3';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';

/** Shortest time between two checkpoints one connection runs after its writes. */
export const WRITE_CHECKPOINT_INTERVAL_MS = 1_000;

export interface CheckpointPacerDeps {
  now: () => number;
  checkpoint: (db: Database.Database) => void;
}

const defaultDeps: CheckpointPacerDeps = {
  now: () => performance.now(),
  checkpoint: (db) => { db.pragma('wal_checkpoint(PASSIVE)'); },
};

/** The after-commit hook (`setAfterCommitHook`) that paces the checkpoints. */
export function createCheckpointPacer(deps: CheckpointPacerDeps = defaultDeps): (db: Database.Database) => void {
  const lastCheckpointAt = new WeakMap<Database.Database, number>();
  return (db) => {
    const at = deps.now();
    const last = lastCheckpointAt.get(db);
    if (last !== undefined && at - last < WRITE_CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt.set(db, at);
    timeSyncWork('db:checkpoint', () => deps.checkpoint(db));
  };
}
