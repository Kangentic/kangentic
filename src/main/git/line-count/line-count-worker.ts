/**
 * Line-count worker - runs in an Electron utilityProcess child so counting
 * newlines across a large set of untracked files never blocks the main event
 * loop (which owns better-sqlite3, the PTYs, and IPC).
 *
 * A deliberately dumb translation layer: run the same bounded count-lines
 * helper the main process uses inline for small batches over the requested
 * paths, and post the results back.
 *
 * Bundled by esbuild as its own entry (`.vite/build/line-count-worker.js`).
 */

import { countLinesInFiles, firstOfEachFailure } from './count-lines';
import { errorCodeOf, errorNameOf, syscallOf } from '../../../shared/handled-error-copy';

interface CountMessage {
  type: 'count';
  id: number;
  paths: string[];
}
interface ShutdownMessage {
  type: 'shutdown';
}
type IncomingMessage = CountMessage | ShutdownMessage;

export interface LineCountEntry {
  path: string;
  insertions: number;
  binary: boolean;
}

/**
 * A file the worker could not count for a reason other than being gone, by a
 * fixed code. A worker cannot report, so main does (`line-count-client.ts`).
 * Only the failure's class, errno and syscall cross: its message names the
 * file, and stays here.
 */
export interface LineCountHandledError {
  type: 'handledError';
  code: 'count_file';
  errorName: string;
  errorCode?: string;
  syscall?: string;
}

const parentPort = process.parentPort;

function post(message: unknown): void {
  parentPort.postMessage(message);
}

/** Sent once per class and errno for the worker's run. Main reports each once a run too. */
const relayUncountedFile = firstOfEachFailure((error) => {
  const relay: LineCountHandledError = { type: 'handledError', code: 'count_file', errorName: errorNameOf(error) };
  const errorCode = errorCodeOf(error);
  if (errorCode) relay.errorCode = errorCode;
  const syscall = syscallOf(error);
  if (syscall) relay.syscall = syscall;
  post(relay);
});

async function countPaths(paths: string[]): Promise<LineCountEntry[]> {
  const counts = await countLinesInFiles(paths, relayUncountedFile);
  return counts.map((count, index) => ({ path: paths[index], insertions: count.insertions, binary: count.binary }));
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as IncomingMessage;
  // Defensive parse boundary (mirrors LineCountClient.onWorkerMessage): a
  // malformed payload must be ignored, not throw inside the handler.
  if (typeof message !== 'object' || message === null) return;

  if (message.type === 'shutdown') {
    process.exit(0);
    return;
  }

  if (message.type === 'count') {
    const requestId = message.id;
    countPaths(message.paths)
      .then((entries) => post({ type: 'result', id: requestId, entries }))
      // report-ok: a worker process cannot report. Main gets the error reply, resolves the
      // request as null and counts the files inline.
      .catch((error: unknown) => post({ type: 'error', id: requestId, message: String(error) }));
  }
});
