/**
 * The retrieval worker's own checkpoints while it writes.
 *
 * No connection auto-checkpoints while the worker is up (`checkpoint-driver.ts`),
 * and main's 5 s checkpoint request is a call like any other, so it waits
 * behind a long job step. A bulk write (the first index, the code fill, a
 * vector copy) then left the whole job's pages for one checkpoint: 698 ms in
 * one step after the dev seed. So each outermost worker transaction, once it
 * commits, asks for a checkpoint of its file when a second has passed since
 * the last one did. The checkpoint runs on the checkpoint thread
 * (`checkpoint-runner.ts`) and the commit does not wait for it; only the
 * in-loop fallback runs here, labelled `db:checkpoint-after-write`. PASSIVE
 * never blocks a writer.
 */

import type Database from 'better-sqlite3';
import { CHECKPOINT_AFTER_WRITE_LABEL } from './checkpoint-labels';
import { checkpointRunner, passiveCheckpointInLoop } from './checkpoint-runner';

/** Shortest time between two checkpoints one connection runs after its writes. */
export const WRITE_CHECKPOINT_INTERVAL_MS = 1_000;

export interface CheckpointPacerDeps {
  now: () => number;
  checkpoint: (db: Database.Database) => void;
}

/** Ask the runner for a checkpoint of the connection's file, without waiting for it. */
function requestCheckpoint(db: Database.Database): void {
  const inLoop = () => passiveCheckpointInLoop(db, CHECKPOINT_AFTER_WRITE_LABEL);
  // report-ok: a missed checkpoint costs nothing; the next commit or main's 5 s request copies the same pages.
  checkpointRunner.checkpoint(() => db.name, inLoop).catch(() => undefined);
}

const defaultDeps: CheckpointPacerDeps = {
  now: () => performance.now(),
  checkpoint: requestCheckpoint,
};

/** The after-commit hook (`setAfterCommitHook`) that paces the checkpoints. */
export function createCheckpointPacer(deps: CheckpointPacerDeps = defaultDeps): (db: Database.Database) => void {
  const lastCheckpointAt = new WeakMap<Database.Database, number>();
  return (db) => {
    const at = deps.now();
    const last = lastCheckpointAt.get(db);
    if (last !== undefined && at - last < WRITE_CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt.set(db, at);
    deps.checkpoint(db);
  };
}
