/**
 * The retrieval worker's `init` hands the checkpoint thread's path to the
 * runner (Sentry DESKTOP-4P). Main sends the path in `init`
 * (`checkpointThreadPath`, pinned in retrieval-client.test.ts); a worker that
 * dropped it would run every checkpoint on its request loop again, which is
 * what got it killed, and nothing else would fail.
 *
 * This drives the real worker entry the way main does, as
 * retrieval-worker-vec-load-report.test.ts does: it stands in for
 * `process.parentPort` and sends `init`. It starts no checkpoint, so no thread
 * is started.
 *
 * Tier: Unit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkpointRunner } from '../../src/main/retrieval/worker/checkpoint-runner';
import type { FromWorkerMessage } from '../../src/main/retrieval/worker/protocol';

type PortListener = (event: { data: unknown }) => void;

let messageListener: PortListener | null = null;
let readyReceived = false;
let directory: string;

// The worker entry replaces these four at import to relay them to main.
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-worker-init-thread-'));
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (eventName: string, listener: PortListener) => {
        if (eventName === 'message') messageListener = listener;
      },
      postMessage: (message: FromWorkerMessage) => {
        if (message.type === 'ready') readyReceived = true;
      },
    },
  });
  await import('../../src/main/retrieval/worker/retrieval-worker');
});

afterAll(() => {
  checkpointRunner.configure(null);
  Object.assign(console, originalConsole);
  Reflect.deleteProperty(process, 'parentPort');
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('retrieval worker init', () => {
  // Red-green: drop `checkpointRunner.configure(...)` from `initialize` and the runner
  // keeps every checkpoint on the loop.
  it('points the checkpoint runner at the thread path main sent', () => {
    expect(checkpointRunner.usesThread).toBe(false);
    const listener = messageListener;
    if (!listener) throw new Error('the worker entry did not register a message listener');

    listener({
      data: {
        type: 'init',
        projectsDir: directory,
        vecLoadablePath: null,
        checkpointThreadPath: path.join(directory, 'retrieval-checkpoint-thread.js'),
      },
    });

    expect(readyReceived).toBe(true);
    expect(checkpointRunner.usesThread).toBe(true);
  });
});
