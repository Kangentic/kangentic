/**
 * Who checkpoints the project databases' WAL, main or the retrieval worker.
 *
 * SQLite runs an auto-checkpoint on the connection that commits, so with its
 * default every main commit that crosses 1000 WAL pages copies the WAL into
 * the database and syncs it on the main thread (measured: a sums write that
 * normally takes a few ms reached 19 ms). While a retrieval worker is up, main
 * turns its own auto-checkpoint off and asks the worker for a PASSIVE
 * checkpoint of every database it has open, every 5 s. PASSIVE never waits
 * for or blocks a writer. The worker's and the pty host's connections run
 * with auto-checkpoint off too, so this is the only checkpoint while the
 * worker is up.
 *
 * Why 5 s: a checkpoint copies whatever was written since the last one, and
 * the pty host's transcript writes are never checkpointed by the host. After a
 * 15 s terminal flood the 30 s interval this had copied 65,897 pages in one
 * 476 ms step, which every Ask and search waited behind. At 5 s a step copies
 * at most 5 s of writes, and an idle one finds nothing to copy.
 *
 * When the worker goes down, main takes checkpoints back at once, so a worker
 * that is restarting or latched off never leaves a WAL growing unchecked.
 */

import { openProjectDbIds, setWalAutoCheckpoint } from '../db/database';
import { retrievalClient, type RetrievalClient } from './retrieval-client';

export const CHECKPOINT_INTERVAL_MS = 5_000;

export function attachCheckpointDriver(client: Pick<RetrievalClient, 'on' | 'call'> = retrievalClient): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  // One checkpoint at a time: a tick while the worker is still busy with the
  // last one (or a long step ahead of it) is skipped, not queued.
  let inFlight = false;

  const checkpoint = (): void => {
    if (inFlight) return;
    const projectIds = openProjectDbIds();
    if (projectIds.length === 0) return;
    inFlight = true;
    // A checkpoint's length follows the WAL, so it has no call budget.
    void client.call('db.checkpoint', { projectIds }, { timeoutMs: null })
      .catch(() => undefined)
      .finally(() => { inFlight = false; });
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
