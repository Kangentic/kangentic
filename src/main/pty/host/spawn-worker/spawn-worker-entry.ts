/**
 * The pty host's spawn worker: a `worker_threads` Worker inside the
 * `kangentic-pty-host` utility process that starts every child process the
 * host runs (`spawn-worker-handler.ts`). The host's own thread carries every
 * terminal's input and output, and on Windows a process start holds the thread
 * that makes it for the whole CreateProcess: 190 to 454 ms a git start beside
 * an `npm ci`, which froze every terminal's echo for as long. Here it holds
 * only this thread.
 *
 * Bundled by esbuild as its own entry (`.vite/build/pty-host-spawn-worker.js`,
 * unpacked in a packaged build) and started by `WorkerSpawnService`. It loads
 * only `node:` built-ins and pure modules: a native module is unsafe in a
 * worker thread, and `tests/unit/pty-host-boundary.test.ts` keeps koffi,
 * node-pty, better-sqlite3 and electron out of its graph.
 */

import { format } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import { relaySlowSyncSpans } from '../../../diagnostics/event-loop-lag';
import { setMainExecutable } from '../host-exec';
import type { FromSpawnWorkerMessage, SpawnWorkerData, ToSpawnWorkerMessage } from './protocol';
import { SpawnWorkerHandler } from './spawn-worker-handler';

const port = parentPort;
if (!port) throw new Error('The pty host spawn worker runs only as a worker thread');

const data = workerData as SpawnWorkerData;
const post = (message: FromSpawnWorkerMessage): void => port.postMessage(message);

// A thread's console writes through the host's stdout, which nothing reads;
// the terminal thread hands these lines on to main's log instead.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    try {
      post({ type: 'log', level, text: format(...args) });
    } catch {
      // The port is closed: the host is exiting.
    }
  };
}

setMainExecutable(data.mainExecutable);
if (data.relaySlowSpans) {
  relaySlowSyncSpans((label, elapsedMs) => post({ type: 'slow-span', label, ms: Math.round(elapsedMs) }));
}

const handler = new SpawnWorkerHandler(post);
port.on('message', (message: ToSpawnWorkerMessage) => {
  if (typeof message !== 'object' || message === null) return;
  handler.handle(message);
});
