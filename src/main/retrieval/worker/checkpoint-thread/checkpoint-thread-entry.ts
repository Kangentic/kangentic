/**
 * The retrieval worker's checkpoint thread: a `worker_threads` Worker inside
 * the `kangentic-retrieval` utility process that runs every PASSIVE WAL
 * checkpoint on its own better-sqlite3 connection, so a long one no longer
 * holds the worker's request loop.
 *
 * A checkpoint copies every page written since the last one, and its length
 * follows the WAL and the disk. On the loop it held every interactive call:
 * one Fedora install's worker was killed five times in 80 minutes, each time
 * with `transcript.trailRead` unanswered behind `db:checkpoint` for the whole
 * 15 s budget (Sentry DESKTOP-4P), and the kill threw the copy away, so the
 * next worker met the same WAL. Measured on a 304 MB WAL: the checkpoint held
 * its calling thread for 527 to 683 ms on an SSD; on this thread the worker's
 * loop saw no gap over 65 ms. A slow disk scales the first number, never the
 * second.
 *
 * It loads one native module, better-sqlite3, which is context-aware and
 * documents worker-thread use; the afterPack probe
 * (`verifyRetrievalCheckpointThreadLoads`) starts this thread under the
 * packaged Electron and fails the build when it cannot checkpoint. It opens no
 * extension and reads no table, so each connection costs a file handle.
 *
 * Bundled by esbuild as its own entry (`.vite/build/retrieval-checkpoint-thread.js`,
 * unpacked in a packaged build) and started by `checkpoint-runner.ts`.
 */

import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { CheckpointRow, FromCheckpointThreadMessage, ToCheckpointThreadMessage } from './protocol';

const port = parentPort;
if (!port) throw new Error('The retrieval checkpoint thread runs only as a worker thread');

/** How long a connection waits for a lock it needs to open. PASSIVE itself never waits. */
const BUSY_TIMEOUT_MS = 1_000;

const connections = new Map<string, Database.Database>();

function connectionFor(dbPath: string): Database.Database {
  const existing = connections.get(dbPath);
  if (existing) return existing;
  // Migrations run on main first, so the file is always there; a missing one
  // is a project deleted under us, not one to create.
  const db = new Database(dbPath, { fileMustExist: true });
  // No checkpoint hides inside a commit on any connection (`checkpoint-driver.ts`).
  // This one never commits, but the setting keeps that true if it ever does.
  db.pragma('wal_autocheckpoint = 0');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  connections.set(dbPath, db);
  return db;
}

function post(message: FromCheckpointThreadMessage): void {
  port?.postMessage(message);
}

function failure(id: number, error: unknown): FromCheckpointThreadMessage {
  if (!(error instanceof Error)) return { type: 'result', id, ok: false, message: String(error) };
  const code = (error as { code?: unknown }).code;
  return {
    type: 'result',
    id,
    ok: false,
    message: error.message,
    errorName: error.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  };
}

port.on('message', (message: ToCheckpointThreadMessage) => {
  if (typeof message !== 'object' || message === null) return;
  if (message.type === 'checkpoint') {
    try {
      const [row] = connectionFor(message.dbPath).pragma('wal_checkpoint(PASSIVE)') as CheckpointRow[];
      post({ type: 'result', id: message.id, ok: true, row: row ?? null });
    } catch (error) { // report-ok: relayed to the runner, which hands it to the caller as the checkpoint's rejection.
      post(failure(message.id, error));
    }
    return;
  }
  if (message.type === 'close') {
    const db = connections.get(message.dbPath);
    connections.delete(message.dbPath);
    try {
      db?.close();
      post({ type: 'result', id: message.id, ok: true, row: null });
    } catch (error) { // report-ok: relayed to the runner, which hands it to the closing project as the close's rejection.
      post(failure(message.id, error));
    }
  }
});
