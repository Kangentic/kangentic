/**
 * What the retrieval worker tells main when sqlite-vec will not load (Sentry
 * DESKTOP-4Q). The report used to carry only the class and errno; the reason
 * the loader gave stayed in the local log. It now carries the reason as a fixed
 * word and whether the file was there, and still never the message, which
 * holds the install path.
 *
 * This drives the real worker entry the way main does: it stands in for
 * `process.parentPort`, sends `init` with a sqlite-vec path that is not a
 * library, and opens a real project database, whose initializer runs the load.
 *
 * Tier: Unit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FromWorkerMessage, HandledErrorMessage, ReplyMessage } from '../../src/main/retrieval/worker/protocol';

type PortListener = (event: { data: unknown }) => void;

const PROJECT_ID = 'project-vec-load';
const suffix = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

let messageListener: PortListener | null = null;
let nextRequestId = 1;
const pendingReplies = new Map<number, (reply: ReplyMessage) => void>();
const handledErrors: HandledErrorMessage[] = [];
let directory: string;
let vecPath: string;

// The worker entry replaces these four at import to relay them to main.
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-vec-load-report-'));
  // A project database main would have created and migrated first.
  const setup = new Database(path.join(directory, `${PROJECT_ID}.db`));
  setup.pragma('journal_mode = WAL');
  setup.close();
  // An extension file that is there but is not a library.
  vecPath = path.join(directory, `vec0${suffix}`);
  fs.writeFileSync(vecPath, Buffer.alloc(4096, 0x5a));

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (eventName: string, listener: PortListener) => {
        if (eventName === 'message') messageListener = listener;
      },
      postMessage: (message: FromWorkerMessage) => {
        if (message.type === 'reply') pendingReplies.get(message.id)?.(message);
        if (message.type === 'handledError') handledErrors.push(message);
      },
    },
  });
  await import('../../src/main/retrieval/worker/retrieval-worker');
  messageListener?.({ data: { type: 'init', projectsDir: directory, vecLoadablePath: vecPath } });
});

afterAll(async () => {
  // Let go of the database before the folder goes: Windows refuses to unlink an open file.
  await callWorker('project.close', { projectId: PROJECT_ID });
  Object.assign(console, originalConsole);
  Reflect.deleteProperty(process, 'parentPort');
  fs.rmSync(directory, { recursive: true, force: true });
});

function callWorker(method: string, params: unknown): Promise<ReplyMessage> {
  if (!messageListener) throw new Error('the worker entry did not register a message listener');
  const id = nextRequestId++;
  const reply = new Promise<ReplyMessage>((resolve) => pendingReplies.set(id, resolve));
  messageListener({ data: { type: 'request', id, method, params } });
  return reply;
}

describe('retrieval worker: a sqlite-vec load failure', () => {
  // Red-green: post `{ type: 'handledError', code, ...errorShapeOf(error) }` alone (the code
  // before the fix) and `loadCause` and `fileExists` are missing.
  it('relays the cause and whether the file exists, once, and none of the message', async () => {
    // Opening the database runs the initializer, which loads sqlite-vec.
    await callWorker('db.checkpoint', { projectIds: [PROJECT_ID] });
    await callWorker('db.checkpoint', { projectIds: [PROJECT_ID] });

    expect(handledErrors).toHaveLength(1);
    const [report] = handledErrors;
    expect(report).toMatchObject({ type: 'handledError', code: 'sqlite_vec_load', loadCause: 'bad_image', fileExists: true });
    // Only fixed shapes cross: no path, no loader words.
    const wire = JSON.stringify(report);
    expect(wire).not.toContain(directory.replace(/\\/g, '\\\\'));
    expect(wire).not.toContain('vec0');
    const allowedKeys = new Set(['type', 'code', 'errorName', 'errorCode', 'loadCause', 'fileExists']);
    expect(Object.keys(report).filter((key) => !allowedKeys.has(key))).toEqual([]);
  });
});
