/**
 * The retrieval worker's checkpoint thread (Sentry DESKTOP-4P). A PASSIVE
 * checkpoint ran on the worker's only request loop, so a large WAL on a slow
 * disk held `transcript.trailRead` past its 15 s budget and main killed the
 * worker, five times in 80 minutes on one install. Checkpoints now run on their
 * own thread and connection (`checkpoint-thread-entry.ts`, started by
 * `checkpoint-runner.ts`).
 *
 * - The real thread, bundled by esbuild as the build does, checkpoints a real
 *   WAL and lets go of the file, so a deleted project's folder can be removed.
 * - The real worker entry answers a request while a checkpoint still holds the
 *   thread. A stub thread stands in for the slow disk, and the database module
 *   is mocked so the in-loop path holds the loop just as long.
 * - The runner joins a second request for a file and falls back to the loop
 *   when the thread cannot run.
 *
 * Tier: Unit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import Database from 'better-sqlite3';
import { CheckpointRunner, checkpointRunner } from '../../src/main/retrieval/worker/checkpoint-runner';
import { createCheckpointPacer } from '../../src/main/retrieval/worker/checkpoint-pacing';
import type { FromWorkerMessage, ReplyMessage } from '../../src/main/retrieval/worker/protocol';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** How long the stub thread, and the mocked in-loop checkpoint, hold. */
const HOLD_MS = 1_500;
const HELD_ROW = { busy: 0, log: 7, checkpointed: 7 };

function holdThread(): void {
  const until = Date.now() + HOLD_MS;
  while (Date.now() < until) {
    // Busy wait: nothing else on this thread runs.
  }
}

const { getProjectDbMock, projectDbPathMock } = vi.hoisted(() => ({
  getProjectDbMock: vi.fn(),
  projectDbPathMock: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  configureProjectDbAccess: vi.fn(),
  closeProjectDb: vi.fn(),
  getProjectDb: getProjectDbMock,
  projectDbPath: projectDbPathMock,
  setProjectDbInitializer: vi.fn(),
  setWalAutoCheckpoint: vi.fn(),
}));

let directory: string;
let threadPath: string;
let stubThreadPath: string;
let threadMessageLogPath: string;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-checkpoint-thread-'));
  threadPath = path.join(directory, 'retrieval-checkpoint-thread.js');
  const betterSqlite3 = path.join(REPO_ROOT, 'node_modules', 'better-sqlite3');
  await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    conditions: ['require'],
    entryPoints: [path.join(REPO_ROOT, 'src/main/retrieval/worker/checkpoint-thread/checkpoint-thread-entry.ts')],
    outfile: threadPath,
    logLevel: 'silent',
    // External as in the build, but by absolute path: the bundle sits in a temp
    // folder with no node_modules above it.
    plugins: [{
      name: 'better-sqlite3-from-repo',
      setup(build) {
        build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: betterSqlite3, external: true }));
      },
    }],
  });
  // A thread that holds for HOLD_MS on the checkpoint of `project-held.db`, as a slow disk does,
  // and records every message it receives (type and file) to a log the test reads.
  stubThreadPath = path.join(directory, 'stub-checkpoint-thread.js');
  threadMessageLogPath = path.join(directory, 'stub-checkpoint-thread-messages.log');
  fs.writeFileSync(stubThreadPath, [
    "const { parentPort } = require('node:worker_threads');",
    "const fs = require('node:fs');",
    'parentPort.on(\'message\', (message) => {',
    `  fs.appendFileSync(${JSON.stringify(threadMessageLogPath)}, JSON.stringify({ type: message.type, dbPath: message.dbPath }) + '\\n');`,
    "  if (message.type === 'checkpoint') {",
    "    if (message.dbPath.endsWith('project-held.db')) {",
    `      const until = Date.now() + ${HOLD_MS};`,
    '      while (Date.now() < until) { /* the slow disk */ }',
    '    }',
    `    parentPort.postMessage({ type: 'result', id: message.id, ok: true, row: ${JSON.stringify(HELD_ROW)} });`,
    '    return;',
    '  }',
    "  parentPort.postMessage({ type: 'result', id: message.id, ok: true, row: null });",
    '});',
  ].join('\n'));
}, 60_000);

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the checkpoint thread on a real database', () => {
  it('copies a real WAL off the calling thread and lets go of the file', async () => {
    const dbDirectory = fs.mkdtempSync(path.join(directory, 'db-'));
    const dbPath = path.join(dbDirectory, 'project.db');
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE chunk (body BLOB)');
    const insert = writer.prepare('INSERT INTO chunk (body) VALUES (?)');
    const body = Buffer.alloc(64 * 1024, 1);
    writer.transaction(() => { for (let row = 0; row < 64; row += 1) insert.run(body); })();
    // The writer stays open, as main's and the pty host's connections do: a last
    // connection's close checkpoints and deletes the WAL itself.

    const runner = new CheckpointRunner();
    runner.configure(threadPath);
    const inLoop = vi.fn(() => null);

    let row: Awaited<ReturnType<CheckpointRunner['checkpoint']>>;
    try {
      row = await runner.checkpoint(() => dbPath, inLoop);
    } finally {
      await runner.close(dbPath);
      writer.close();
    }

    expect(inLoop).not.toHaveBeenCalled();
    expect(row?.log).toBeGreaterThan(0);
    expect(row?.checkpointed).toBe(row?.log);
    // SQLite deletes the WAL only when the LAST connection closes, so a thread that kept
    // its connection would leave it behind. This holds on every OS, where the delete
    // below proves the release only on Windows (POSIX deletes an open file).
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    // Windows refuses to delete a file any connection still holds.
    fs.rmSync(dbDirectory, { recursive: true });
    expect(fs.existsSync(dbDirectory)).toBe(false);
  }, 30_000);
});

describe('retrieval worker: a request while a checkpoint holds the thread', () => {
  type PortListener = (event: { data: unknown }) => void;
  let messageListener: PortListener | null = null;
  let nextRequestId = 1;
  const pendingReplies = new Map<number, (reply: ReplyMessage) => void>();
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

  beforeAll(async () => {
    projectDbPathMock.mockImplementation((projectId: string) => path.join(directory, `${projectId}.db`));
    // The same checkpoint on the loop holds it as long as the stub thread holds its own.
    getProjectDbMock.mockImplementation(() => ({
      pragma: () => {
        holdThread();
        return [HELD_ROW];
      },
    }));
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: {
        on: (eventName: string, listener: PortListener) => {
          if (eventName === 'message') messageListener = listener;
        },
        postMessage: (message: FromWorkerMessage) => {
          if (message.type === 'reply') pendingReplies.get(message.id)?.(message);
        },
      },
    });
    await import('../../src/main/retrieval/worker/retrieval-worker');
    // What `init` does with main's path. Not `init` itself, which would start a
    // second watchdog on the real stderr.
    checkpointRunner.configure(stubThreadPath);
  });

  afterAll(() => {
    checkpointRunner.configure(null);
    Object.assign(console, originalConsole);
    Reflect.deleteProperty(process, 'parentPort');
  });

  /** Each request arrives as its own task, as a real port delivers it, so a held
   *  loop holds back the requests behind it. */
  function callWorker(method: string, params: unknown): Promise<ReplyMessage> {
    const listener = messageListener;
    if (!listener) throw new Error('the worker entry did not register a message listener');
    const id = nextRequestId++;
    const reply = new Promise<ReplyMessage>((resolve) => pendingReplies.set(id, resolve));
    setImmediate(() => listener({ data: { type: 'request', id, method, params } }));
    return reply;
  }

  // Red-green: run `db.checkpoint` on the loop (`checkpointRunner.configure(null)`, which is what
  // every worker did before the thread) and the checkpoint's reply comes first: the loop is held
  // for HOLD_MS before the second request is even read.
  it('answers the second request first, while the checkpoint is still running', async () => {
    const order: string[] = [];
    const checkpoint = callWorker('db.checkpoint', { projectIds: ['project-held'] }).then((reply) => {
      order.push('checkpoint');
      return reply;
    });
    const read = callWorker('sessions.replayToolBreakdowns', { sessionsDir: directory, sessionIds: [] }).then((reply) => {
      order.push('read');
      return reply;
    });

    const readReply = await read;
    expect(readReply.ok).toBe(true);
    expect(order).toEqual(['read']);

    const checkpointReply = await checkpoint;
    expect(order).toEqual(['read', 'checkpoint']);
    expect(checkpointReply.ok && checkpointReply.result).toEqual([
      { projectId: 'project-held', walFrames: HELD_ROW.log, checkpointed: HELD_ROW.checkpointed, busy: false },
    ]);
    // The thread took it: the worker's own connection was never opened for it.
    expect(getProjectDbMock).not.toHaveBeenCalled();
  }, 30_000);

  /** What the stub thread has received so far, in order. */
  function receivedByThread(): Array<{ type: string; dbPath: string }> {
    if (!fs.existsSync(threadMessageLogPath)) return [];
    return fs.readFileSync(threadMessageLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; dbPath: string });
  }

  function receivedFor(dbPath: string, type: string): number {
    return receivedByThread().filter((message) => message.type === type && message.dbPath === path.resolve(dbPath)).length;
  }

  // Red-green: delete the `checkpointRunner.close(...)` line in `closeDb` and the thread never
  // receives the close, so Windows would refuse the unlink while its connection stays open.
  it('project.close sends the thread a close for that project database before it replies', async () => {
    const projectId = 'project-close-a';
    const dbPath = path.join(directory, `${projectId}.db`);
    // The runner starts the thread on its first checkpoint, and closes nothing before that.
    const checkpointReply = await callWorker('db.checkpoint', { projectIds: [projectId] });
    expect(checkpointReply.ok).toBe(true);
    expect(receivedFor(dbPath, 'checkpoint')).toBe(1);
    expect(receivedFor(dbPath, 'close')).toBe(0);

    const closeReply = await callWorker('project.close', { projectId });

    expect(closeReply.ok).toBe(true);
    expect(receivedFor(dbPath, 'close')).toBe(1);
  });

  // Red-green: delete `assertNotClosed(projectId)` in `checkpointDb` and the thread gets a
  // checkpoint for a database main is about to delete, and the reply is a row, not null.
  it('a checkpoint for a closed project is skipped and never reaches the thread', async () => {
    const projectId = 'project-close-a';
    const dbPath = path.join(directory, `${projectId}.db`);
    const checkpointsBefore = receivedFor(dbPath, 'checkpoint');

    const reply = await callWorker('db.checkpoint', { projectIds: [projectId] });

    expect(reply.ok && reply.result).toEqual([null]);
    expect(receivedFor(dbPath, 'checkpoint')).toBe(checkpointsBefore);
  });

  // Red-green: point `requestCheckpoint` at `inLoop` (or `db.pragma`) and the pragma is called.
  it('the after-write pacer posts its checkpoint to the thread and never runs one on the loop', async () => {
    const dbPath = path.join(directory, 'pacer-target.db');
    const pragma = vi.fn();
    const hook = createCheckpointPacer();

    const returned = hook({ name: dbPath, pragma } as unknown as Database.Database);

    // The hook does not wait for the thread: it hands back at once, with nothing to await.
    expect(returned).toBeUndefined();
    expect(pragma).not.toHaveBeenCalled();
    await expect.poll(() => receivedFor(dbPath, 'checkpoint'), { timeout: 5_000 }).toBe(1);
    expect(pragma).not.toHaveBeenCalled();
  });
});

describe('the checkpoint thread on a path that is not there', () => {
  it('rejects a checkpoint of a missing file with SQLITE_CANTOPEN and never runs it on the loop', async () => {
    const runner = new CheckpointRunner();
    runner.configure(threadPath);
    const inLoop = vi.fn(() => null);
    const missing = path.join(directory, 'never-created.db');

    await expect(runner.checkpoint(() => missing, inLoop)).rejects.toMatchObject({ code: 'SQLITE_CANTOPEN' });

    expect(inLoop).not.toHaveBeenCalled();
    expect(fs.existsSync(missing)).toBe(false);
    // The thread is up and answered, so a close of a file it never opened still resolves.
    await expect(runner.close(path.join(directory, 'never-opened.db'))).resolves.toBeUndefined();
  }, 30_000);
});

// The fakes below emit the thread's events by hand. These start a real `worker_threads` Worker that
// fails the ways a packaged build can (a bundle that is not on disk, a thread that dies holding a
// request), so the runner is held to what Node really emits, not to what a stand-in assumes.
// What a user loses if this goes: the checkpoints silently stop landing (a request that never
// settles holds main's 5 s checkpoint call forever), or the worker returns to the DESKTOP-4P kill
// loop without any test noticing.
//
// Red-green: delete the `thread.on('error', ...)` and `thread.on('exit', ...)` lines in
// `ensureThread` and both cases below hang until their timeout.
describe('CheckpointRunner on a real thread that fails', () => {
  it('runs the checkpoint on the loop, and stays there, when the thread bundle is not on disk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const runner = new CheckpointRunner();
      runner.configure(path.join(directory, 'retrieval-checkpoint-thread-missing.js'));
      const inLoop = vi.fn(() => HELD_ROW);

      await expect(runner.checkpoint(() => path.join(directory, 'a.db'), inLoop)).resolves.toEqual(HELD_ROW);
      await expect(runner.checkpoint(() => path.join(directory, 'a.db'), inLoop)).resolves.toEqual(HELD_ROW);

      expect(inLoop).toHaveBeenCalledTimes(2);
      expect(runner.usesThread).toBe(false);
      // The thread is gone for good, so a close has nothing to wait on and still resolves.
      await expect(runner.close(path.join(directory, 'a.db'))).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it('runs what a thread that died holding the request owed on the loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dyingThreadPath = path.join(directory, 'dying-checkpoint-thread.js');
      fs.writeFileSync(dyingThreadPath, [
        "const { parentPort } = require('node:worker_threads');",
        "parentPort.on('message', () => { process.exit(3); });",
      ].join('\n'));
      const runner = new CheckpointRunner();
      runner.configure(dyingThreadPath);
      const inLoop = vi.fn(() => HELD_ROW);

      await expect(runner.checkpoint(() => path.join(directory, 'a.db'), inLoop)).resolves.toEqual(HELD_ROW);

      expect(inLoop).toHaveBeenCalledTimes(1);
      expect(runner.usesThread).toBe(false);
      await expect(runner.close(path.join(directory, 'a.db'))).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});

/** A thread stand-in whose replies the test sends by hand. */
interface FakeThread extends EventEmitter {
  posted: Array<{ type: string; id: number; dbPath: string }>;
  postMessage(message: { type: string; id: number; dbPath: string }): void;
  unref(): void;
  terminate(): Promise<number>;
}

function fakeThread(): FakeThread {
  const thread = new EventEmitter() as FakeThread;
  thread.posted = [];
  thread.postMessage = (message) => { thread.posted.push(message); };
  thread.unref = () => undefined;
  thread.terminate = async () => 0;
  return thread;
}

describe('CheckpointRunner', () => {
  it('joins a second request for a file whose checkpoint is still running', async () => {
    const thread = fakeThread();
    const runner = new CheckpointRunner(() => thread as unknown as Worker);
    runner.configure('thread.js');
    const dbPath = path.join(directory, 'joined.db');

    const first = runner.checkpoint(() => dbPath, () => null);
    const second = runner.checkpoint(() => dbPath, () => null);
    expect(thread.posted).toHaveLength(1);

    thread.emit('message', { type: 'result', id: thread.posted[0].id, ok: true, row: HELD_ROW });
    await expect(first).resolves.toEqual(HELD_ROW);
    await expect(second).resolves.toEqual(HELD_ROW);

    // Once it finished, the next request is a new checkpoint.
    void runner.checkpoint(() => dbPath, () => null);
    expect(thread.posted).toHaveLength(2);
  });

  it('runs on the loop when there is no thread to start', async () => {
    const runner = new CheckpointRunner();
    const inLoop = vi.fn(() => HELD_ROW);
    await expect(runner.checkpoint(() => 'unused.db', inLoop)).resolves.toEqual(HELD_ROW);
    expect(inLoop).toHaveBeenCalledTimes(1);
  });

  it('falls back to the loop for good when the thread cannot start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const startThread = vi.fn(() => { throw new Error('no threads'); });
      const runner = new CheckpointRunner(startThread);
      runner.configure('thread.js');
      const inLoop = vi.fn(() => HELD_ROW);

      await expect(runner.checkpoint(() => 'a.db', inLoop)).resolves.toEqual(HELD_ROW);
      await expect(runner.checkpoint(() => 'b.db', inLoop)).resolves.toEqual(HELD_ROW);

      expect(inLoop).toHaveBeenCalledTimes(2);
      expect(startThread).toHaveBeenCalledTimes(1);
      expect(runner.usesThread).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('runs what a thread that died still owed on the loop, and stays there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const thread = fakeThread();
      const runner = new CheckpointRunner(() => thread as unknown as Worker);
      runner.configure('thread.js');
      const inLoop = vi.fn(() => HELD_ROW);

      const owed = runner.checkpoint(() => 'a.db', inLoop);
      thread.emit('exit', 1);

      await expect(owed).resolves.toEqual(HELD_ROW);
      expect(inLoop).toHaveBeenCalledTimes(1);
      await expect(runner.checkpoint(() => 'a.db', inLoop)).resolves.toEqual(HELD_ROW);
      expect(thread.posted).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  // Red-green: let `runInLoop` call `inLoop()` without its try/catch and the throw is synchronous.
  it('turns a synchronous throw from the loop checkpoint into a rejection', async () => {
    const runner = new CheckpointRunner();

    let rejectedFromError: Promise<unknown> | undefined;
    expect(() => {
      rejectedFromError = runner.checkpoint(() => 'a.db', () => { throw new Error('disk gone'); });
    }).not.toThrow();
    await expect(rejectedFromError).rejects.toThrow('disk gone');

    let rejectedFromString: Promise<unknown> | undefined;
    expect(() => {
      rejectedFromString = runner.checkpoint(() => 'a.db', () => { throw 'plain text'; });
    }).not.toThrow();
    const reason = await (rejectedFromString as Promise<unknown>).catch((caught: unknown) => caught);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('plain text');
  });

  it('runs the checkpoint on the loop once, and stays there, when the thread refuses a message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const thread = fakeThread();
      const postMessage = vi.fn(() => { throw new Error('port closed'); });
      thread.postMessage = postMessage;
      const runner = new CheckpointRunner(() => thread as unknown as Worker);
      runner.configure('thread.js');
      const inLoop = vi.fn(() => HELD_ROW);

      await expect(runner.checkpoint(() => 'a.db', inLoop)).resolves.toEqual(HELD_ROW);
      expect(inLoop).toHaveBeenCalledTimes(1);
      expect(runner.usesThread).toBe(false);

      await expect(runner.checkpoint(() => 'a.db', inLoop)).resolves.toEqual(HELD_ROW);
      expect(inLoop).toHaveBeenCalledTimes(2);
      expect(postMessage).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  // Red-green: drop the `null` guard in `onMessage` and the null message throws out of `emit`;
  // drop the `type` check and a stray message settles a request it was never an answer to.
  it('ignores a reply for an unknown id, a null message and a message of another type', async () => {
    const thread = fakeThread();
    const runner = new CheckpointRunner(() => thread as unknown as Worker);
    runner.configure('thread.js');
    let settled = false;
    const pending = runner.checkpoint(() => 'a.db', () => null).then((row) => {
      settled = true;
      return row;
    });
    const realId = thread.posted[0].id;

    thread.emit('message', { type: 'result', id: realId + 100, ok: true, row: null });
    thread.emit('message', null);
    thread.emit('message', { type: 'progress', id: realId, ok: true, row: HELD_ROW });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    thread.emit('message', { type: 'result', id: realId, ok: true, row: HELD_ROW });
    await expect(pending).resolves.toEqual(HELD_ROW);
  });

  describe('close() on a thread that failed', () => {
    /** A thread whose `terminate` settles only when the test says so. */
    function threadWithManualTerminate(): { thread: FakeThread; terminate: ReturnType<typeof vi.fn>; release: () => void } {
      const thread = fakeThread();
      let release: () => void = () => undefined;
      const gate = new Promise<number>((resolve) => { release = () => resolve(0); });
      const terminate = vi.fn(() => gate);
      thread.terminate = terminate;
      return { thread, terminate, release };
    }

    const flushTasks = () => new Promise<void>((resolve) => setImmediate(resolve));

    // Red-green: delete `await this.threadEnded` in the failed branch of `close` and it resolves at once.
    it('waits for the failed thread to be terminated', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { thread, terminate, release } = threadWithManualTerminate();
        const runner = new CheckpointRunner(() => thread as unknown as Worker);
        runner.configure('thread.js');
        const owed = runner.checkpoint(() => 'a.db', () => HELD_ROW);
        thread.emit('exit', 1);
        await expect(owed).resolves.toEqual(HELD_ROW);
        expect(terminate).toHaveBeenCalledTimes(1);

        let closed = false;
        const closing = runner.close('a.db').then(() => { closed = true; });
        await flushTasks();
        expect(closed).toBe(false);

        release();
        await closing;
        expect(closed).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    // Red-green: delete the `if (this.threadFailed) await this.threadEnded` after the send in `close`.
    it('waits for the thread to be terminated when it fails with the close pending', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { thread, terminate, release } = threadWithManualTerminate();
        const runner = new CheckpointRunner(() => thread as unknown as Worker);
        runner.configure('thread.js');
        void runner.checkpoint(() => 'a.db', () => HELD_ROW);
        let closed = false;
        const closing = runner.close('a.db').then(() => { closed = true; });
        expect(thread.posted.map((message) => message.type)).toEqual(['checkpoint', 'close']);

        thread.emit('error', new Error('thread crashed'));
        await flushTasks();
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(closed).toBe(false);

        release();
        await closing;
        expect(closed).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('passes a failed checkpoint back to its caller', async () => {
    const thread = fakeThread();
    const runner = new CheckpointRunner(() => thread as unknown as Worker);
    runner.configure('thread.js');

    const failed = runner.checkpoint(() => 'gone.db', () => null);
    thread.emit('message', { type: 'result', id: thread.posted[0].id, ok: false, message: 'unable to open database file', errorName: 'SqliteError', errorCode: 'SQLITE_CANTOPEN' });

    await expect(failed).rejects.toMatchObject({ name: 'SqliteError', code: 'SQLITE_CANTOPEN' });
  });
});
