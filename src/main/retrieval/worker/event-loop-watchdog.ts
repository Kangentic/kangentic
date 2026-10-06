/**
 * Names the step that held the retrieval worker's event loop, for a worker
 * that hangs rather than exits.
 *
 * Main kills a worker that does not answer an interactive call in 15 s
 * (`INTERACTIVE_TIMEOUT_MS`), and the latch report then says which call timed
 * out and which others were pending (Sentry DESKTOP-1Q). It cannot say which
 * of those interleaved jobs was running the synchronous step that held the
 * loop, and a hung worker cannot answer the question itself. A thread can:
 *
 * - The worker's own thread bumps a heartbeat in a `SharedArrayBuffer` every
 *   500 ms, and writes the label of the `timeSyncWork` span it is running into
 *   the same buffer (`setSyncSpanLabelSink`). Neither posts a message, so main
 *   pays nothing while the worker is healthy.
 * - A watchdog thread checks the heartbeat every second. After five checks
 *   with no beat, about 5 s, well inside the 15 s kill, it writes one line to
 *   stderr: `[retrieval-worker] event loop held 5 s in index:chunk-window`.
 *   That stderr is the tail the restart policy already puts in its crash log
 *   line and latch report, so main needs no change to carry it.
 *
 * The watchdog writes with `fs.writeSync` on the stderr descriptor. A worker
 * thread's `console` and `process.stderr` are forwarded through the thread
 * that is hung, so a line written that way would never leave.
 *
 * It counts checks rather than measuring wall time, so a machine that slept
 * does not read as a held loop: both threads stop while it sleeps, and the
 * heartbeat resumes within a check of waking.
 *
 * The thread runs inline source (`eval: true`) that requires only `node:`
 * built-ins. It loads no native module, which is unsafe in a worker thread,
 * and has no file to package or bundle.
 */

import { Worker } from 'node:worker_threads';
import { setSyncSpanLabelSink } from '../../diagnostics/event-loop-lag';

/** Longest label kept, in UTF-8 bytes. Labels are short fixed identifiers. */
const LABEL_BYTES = 96;
/** Int32 slots ahead of the label: the heartbeat, then the label's length. */
const HEADER_BYTES = 8;
const HEARTBEAT_SLOT = 0;
const LABEL_LENGTH_SLOT = 1;

export const HEARTBEAT_INTERVAL_MS = 500;
export const WATCHDOG_CHECK_INTERVAL_MS = 1_000;
/** Checks in a row with no heartbeat before the watchdog writes. */
export const WATCHDOG_HELD_CHECKS = 5;

/**
 * The watchdog thread. Plain CommonJS, because an `eval` worker runs its
 * source as a script. Exported for the test that pins its requires.
 */
export const WATCHDOG_THREAD_SOURCE = `
// eslint-disable-next-line @typescript-eslint/no-require-imports -- thread source, never bundled; ESLint skips strings, so this marker is for esbuild-cjs-imports.test.ts
const { workerData } = require('node:worker_threads');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- thread source, never bundled; ESLint skips strings, so this marker is for esbuild-cjs-imports.test.ts
const fs = require('node:fs');
const { buffer, fd, checkIntervalMs, heldChecks, prefix } = workerData;
const header = new Int32Array(buffer, 0, ${HEADER_BYTES / 4});
const labelBytes = new Uint8Array(buffer, ${HEADER_BYTES}, ${LABEL_BYTES});
const decoder = new TextDecoder();
let lastBeat = Atomics.load(header, ${HEARTBEAT_SLOT});
let checksWithoutBeat = 0;
let reported = false;
setInterval(() => {
  const beat = Atomics.load(header, ${HEARTBEAT_SLOT});
  if (beat !== lastBeat) {
    lastBeat = beat;
    checksWithoutBeat = 0;
    reported = false;
    return;
  }
  checksWithoutBeat += 1;
  if (reported || checksWithoutBeat < heldChecks) return;
  reported = true;
  const length = Atomics.load(header, ${LABEL_LENGTH_SLOT});
  const label = length > 0 ? decoder.decode(labelBytes.slice(0, length)) : null;
  const seconds = Math.round((checksWithoutBeat * checkIntervalMs) / 1000);
  const where = label ? 'in ' + label : 'outside any labelled step';
  try {
    fs.writeSync(fd, prefix + ' event loop held ' + seconds + ' s ' + where + '\\n');
  } catch {
    // The descriptor is gone: the process is exiting.
  }
}, checkIntervalMs);
`;

export interface EventLoopWatchdogOptions {
  /** Where the line goes. The worker's stderr (2) unless a test passes a file. */
  fd?: number;
  prefix?: string;
  heartbeatIntervalMs?: number;
  checkIntervalMs?: number;
  heldChecks?: number;
}

export interface EventLoopWatchdog {
  /** Resolves once the watchdog thread runs, so a test can hold the loop after it. */
  online: Promise<void>;
  stop: () => Promise<void>;
}

/** Start the heartbeat, the span-label sink, and the watchdog thread. */
export function startEventLoopWatchdog(options: EventLoopWatchdogOptions = {}): EventLoopWatchdog {
  const buffer = new SharedArrayBuffer(HEADER_BYTES + LABEL_BYTES);
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  const labelBytes = new Uint8Array(buffer, HEADER_BYTES, LABEL_BYTES);
  const encoder = new TextEncoder();

  // The thread first, and nothing else until it exists: the caller runs ahead
  // of the worker's `ready`, so a constructor that throws must cost only the
  // diagnostics, never the worker's startup.
  let watchdog: Worker;
  try {
    watchdog = new Worker(WATCHDOG_THREAD_SOURCE, {
      eval: true,
      workerData: {
        buffer,
        fd: options.fd ?? 2,
        checkIntervalMs: options.checkIntervalMs ?? WATCHDOG_CHECK_INTERVAL_MS,
        heldChecks: options.heldChecks ?? WATCHDOG_HELD_CHECKS,
        prefix: options.prefix ?? '[retrieval-worker]',
      },
    });
  } catch (error) {
    console.warn('[retrieval-worker] event-loop watchdog did not start:', error);
    return { online: Promise.resolve(), stop: async () => undefined };
  }
  // Diagnostics only: the thread never keeps the worker alive, and a thread
  // that fails takes nothing else with it.
  watchdog.unref();
  watchdog.on('error', (error) => {
    console.warn('[retrieval-worker] event-loop watchdog stopped:', error);
  });
  const online = new Promise<void>((resolve) => watchdog.once('online', () => resolve()));

  setSyncSpanLabelSink((label) => {
    if (label === null) {
      Atomics.store(header, LABEL_LENGTH_SLOT, 0);
      return;
    }
    const { written } = encoder.encodeInto(label, labelBytes);
    Atomics.store(header, LABEL_LENGTH_SLOT, written);
  });

  const heartbeat = setInterval(() => {
    Atomics.add(header, HEARTBEAT_SLOT, 1);
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    online,
    stop: async () => {
      clearInterval(heartbeat);
      setSyncSpanLabelSink(null);
      await watchdog.terminate();
    },
  };
}
