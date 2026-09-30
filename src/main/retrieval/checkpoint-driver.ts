/**
 * Who checkpoints the project databases' WAL, main or the retrieval worker.
 *
 * SQLite runs an auto-checkpoint on the connection that commits, so with its
 * default every main commit that crosses 1000 WAL pages copies the WAL into
 * the database and syncs it on the main thread (measured: a sums write that
 * normally takes a few ms reached 19 ms). While a retrieval worker is up, main
 * turns its own auto-checkpoint off and asks the worker for a PASSIVE
 * checkpoint of every database it has open, every 30 s. PASSIVE never waits
 * for or blocks a writer, and the worker's own connections keep their
 * auto-checkpoint, so its bulk writes checkpoint as they go.
 *
 * When the worker goes down, main takes checkpoints back at once, so a worker
 * that is restarting or latched off never leaves a WAL growing unchecked.
 */

import { openProjectDbIds, setWalAutoCheckpoint } from '../db/database';
import { retrievalClient, type RetrievalClient } from './retrieval-client';

export const CHECKPOINT_INTERVAL_MS = 30_000;

export function attachCheckpointDriver(client: Pick<RetrievalClient, 'on' | 'call'> = retrievalClient): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const checkpoint = (): void => {
    const projectIds = openProjectDbIds();
    if (projectIds.length === 0) return;
    // A checkpoint's length follows the WAL, so it has no call budget.
    void client.call('db.checkpoint', { projectIds }, { timeoutMs: null }).catch(() => undefined);
  };
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  client.on('ready', () => {
    setWalAutoCheckpoint(0);
    stop();
    timer = setInterval(checkpoint, CHECKPOINT_INTERVAL_MS);
    timer.unref();
  });
  client.on('down', () => {
    stop();
    setWalAutoCheckpoint(null);
  });
  return stop;
}
