/**
 * Line-count worker - runs in an Electron utilityProcess child so counting
 * newlines across a large set of untracked files never blocks the main event
 * loop (which owns better-sqlite3, the PTYs, and IPC).
 *
 * A deliberately dumb translation layer: for each requested path, run the
 * same bounded count-lines helper the main process uses inline for small
 * batches, and post the results back.
 *
 * Bundled by esbuild as its own entry (`.vite/build/line-count-worker.js`).
 */

import { countFileLines } from './count-lines';

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

const parentPort = process.parentPort;

function post(message: unknown): void {
  parentPort.postMessage(message);
}

async function countPaths(paths: string[]): Promise<LineCountEntry[]> {
  return Promise.all(
    paths.map(async (absolutePath): Promise<LineCountEntry> => {
      try {
        const result = await countFileLines(absolutePath);
        return { path: absolutePath, insertions: result.insertions, binary: result.binary };
      } catch {
        // File may have been deleted/moved between the caller's stat and this read.
        return { path: absolutePath, insertions: 0, binary: false };
      }
    }),
  );
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
      .catch((error: unknown) => post({ type: 'error', id: requestId, message: String(error) }));
  }
});
