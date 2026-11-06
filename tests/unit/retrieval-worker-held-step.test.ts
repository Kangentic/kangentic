/**
 * Which step the watchdog names when a retrieval handler's synchronous slice
 * holds the loop (Sentry DESKTOP-1Q). Most handlers are one-line reads with no
 * span of their own, so a hold in one read as `outside any labelled step`, with
 * the method's name nowhere near the line that said so.
 *
 * `dispatch` is module-private in `retrieval-worker.ts`, so this drives the
 * entry the way `retrieval-worker-closed-project.test.ts` does: it stands in for
 * `process.parentPort`, imports the module, and sends real request messages.
 * It never sends `init`: that starts a second watchdog on the real stderr at the
 * production thresholds and replaces this test's span sink. The watchdog here is
 * the real thread, writing to a file, because a hold is only named if the line
 * leaves while the loop is held.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FromWorkerMessage, ReplyMessage } from '../../src/main/retrieval/worker/protocol';
import { startEventLoopWatchdog, type EventLoopWatchdog } from '../../src/main/retrieval/worker/event-loop-watchdog';

const { getProjectDbMock } = vi.hoisted(() => ({ getProjectDbMock: vi.fn() }));

vi.mock('../../src/main/db/database', () => ({
  configureProjectDbAccess: vi.fn(),
  closeProjectDb: vi.fn(),
  getProjectDb: getProjectDbMock,
  setProjectDbInitializer: vi.fn(),
  setWalAutoCheckpoint: vi.fn(),
}));

type PortListener = (event: { data: unknown }) => void;

const CHECK_INTERVAL_MS = 50;
const HELD_CHECKS = 4;
/** Far past HELD_CHECKS * CHECK_INTERVAL_MS (200 ms), so a loaded CI runner still sees the line. */
const HOLD_MS = 1_000;

function holdEventLoop(): void {
  const until = Date.now() + HOLD_MS;
  while (Date.now() < until) {
    // Busy wait: nothing else on this thread runs, the heartbeat included.
  }
}

let messageListener: PortListener | null = null;
let nextRequestId = 1;
const pendingReplies = new Map<number, (reply: ReplyMessage) => void>();

// The worker entry replaces these four at import to relay them to main.
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

beforeAll(async () => {
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
});

afterAll(() => {
  Object.assign(console, originalConsole);
  Reflect.deleteProperty(process, 'parentPort');
});

function callWorker(method: string, params: unknown): Promise<ReplyMessage> {
  if (!messageListener) throw new Error('the worker entry did not register a message listener');
  const id = nextRequestId++;
  const reply = new Promise<ReplyMessage>((resolve) => pendingReplies.set(id, resolve));
  messageListener({ data: { type: 'request', id, method, params } });
  return reply;
}

describe('retrieval worker: naming the step that held the loop', () => {
  let directory: string;
  let outputPath: string;
  let descriptor: number;
  let watchdog: EventLoopWatchdog;

  beforeEach(async () => {
    getProjectDbMock.mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-held-step-'));
    outputPath = path.join(directory, 'stderr.txt');
    descriptor = fs.openSync(outputPath, 'w');
    watchdog = startEventLoopWatchdog({
      fd: descriptor,
      heartbeatIntervalMs: 10,
      checkIntervalMs: CHECK_INTERVAL_MS,
      heldChecks: HELD_CHECKS,
    });
    await watchdog.online;
    // Let the thread see a few heartbeats, so a hold starts from a re-armed watchdog.
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS * 2));
  });

  afterEach(async () => {
    await watchdog.stop();
    fs.closeSync(descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** What the watchdog wrote from `offset` on: only bytes after the hold began count. */
  function writtenSince(offset: number): string {
    return fs.readFileSync(outputPath).subarray(offset).toString('utf8');
  }

  // Red-green: call `handler(message.params, context)` in dispatch with no span and
  // the first two cases read `outside any labelled step`.
  it('names the method of a handler with no span of its own', async () => {
    getProjectDbMock.mockImplementation(() => {
      holdEventLoop();
      throw new Error('stop after the hold');
    });
    const sizeBeforeHold = fs.statSync(outputPath).size;

    const reply = await callWorker('sessions.summaries', { projectId: 'project-held' });

    expect(writtenSince(sizeBeforeHold)).toContain('in method:sessions.summaries\n');
    // A synchronous throw inside the span is still a reply, not a lost request.
    expect(reply.ok).toBe(false);
  });

  it('names the checkpoint method for a slow open, which the checkpoint span does not reach', async () => {
    getProjectDbMock.mockImplementation(() => {
      holdEventLoop();
      return { pragma: () => [{ busy: 0, log: 0, checkpointed: 0 }] };
    });
    const sizeBeforeHold = fs.statSync(outputPath).size;

    await callWorker('db.checkpoint', { projectIds: ['project-slow-open'] });

    expect(writtenSince(sizeBeforeHold)).toContain('in method:db.checkpoint\n');
  });

  // The method span must not take over a handler's own detail: a report that read
  // `in method:db.checkpoint` here would blame the open it just ruled out.
  it('keeps a span the handler has of its own, since the innermost label wins', async () => {
    getProjectDbMock.mockImplementation(() => ({
      pragma: () => {
        holdEventLoop();
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      },
    }));
    const sizeBeforeHold = fs.statSync(outputPath).size;

    await callWorker('db.checkpoint', { projectIds: ['project-slow-pragma'] });

    expect(writtenSince(sizeBeforeHold)).toContain('in db:checkpoint\n');
  });
});
