/**
 * The retrieval worker entry's database context after `project.close`.
 *
 * Main closes a project in the worker to delete or prune it, then unlinks the
 * database files. A request still queued for that project (a checkpoint tick,
 * an embed drain step) used to reopen its database in the gap, and Windows then
 * refused the unlink and left the file behind. The worker now remembers each
 * project it was told to close, and `getDb` throws for it instead of reopening.
 *
 * The context is module-private in `retrieval-worker.ts`, so this drives the
 * entry the way main does: it stands in for `process.parentPort`, imports the
 * module so it registers its message listener, and sends real request messages.
 * `db/database` is mocked (better-sqlite3 cannot load under vitest's Node), so
 * what is observed is which project ids the worker asks it to open.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FromWorkerMessage, ReplyMessage } from '../../src/main/retrieval/worker/protocol';
import type { IndexSweepResult, IndexSweepSteps } from '../../src/main/retrieval/worker/index-methods';

const { getProjectDbMock, closeProjectDbMock } = vi.hoisted(() => ({
  getProjectDbMock: vi.fn(),
  closeProjectDbMock: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  configureProjectDbAccess: vi.fn(),
  closeProjectDb: closeProjectDbMock,
  getProjectDb: getProjectDbMock,
  setProjectDbInitializer: vi.fn(),
  setWalAutoCheckpoint: vi.fn(),
}));

type PortListener = (event: { data: unknown }) => void;

/** What a PASSIVE checkpoint of a healthy database reports. */
const CHECKPOINT_ROW = { busy: 0, log: 3, checkpointed: 3 };
const fakeDatabase = { pragma: vi.fn(() => [CHECKPOINT_ROW]) };

let messageListener: PortListener | null = null;
let nextRequestId = 1;
const pendingReplies = new Map<number, (reply: ReplyMessage) => void>();
/** What the worker's console relayed to main (its `warn` and `log` lines), in order. */
const workerLogs: string[] = [];

// The worker entry replaces these four at import to relay them to main.
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

beforeAll(async () => {
  getProjectDbMock.mockImplementation(() => fakeDatabase);
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (eventName: string, listener: PortListener) => {
        if (eventName === 'message') messageListener = listener;
      },
      postMessage: (message: FromWorkerMessage) => {
        if (message.type === 'reply') pendingReplies.get(message.id)?.(message);
        if (message.type === 'log') workerLogs.push(message.text);
      },
    },
  });
  await import('../../src/main/retrieval/worker/retrieval-worker');
});

afterAll(() => {
  Object.assign(console, originalConsole);
  Reflect.deleteProperty(process, 'parentPort');
});

/** Send one request the way main's client does, and resolve with the reply. */
function callWorker(method: string, params: unknown): Promise<ReplyMessage> {
  if (!messageListener) throw new Error('the worker entry did not register a message listener');
  const id = nextRequestId++;
  const reply = new Promise<ReplyMessage>((resolve) => pendingReplies.set(id, resolve));
  messageListener({ data: { type: 'request', id, method, params } });
  return reply;
}

describe('retrieval worker: a project closed for deletion', () => {
  // Red-green: make `context.getDb` call `getProjectDb` unconditionally (the
  // code before the fix) and the checkpoint after the close finds a database
  // for the closed project, so its entry is a result object and not null, and
  // `getProjectDb` is asked for it again. Both assertions in the first test go
  // red. In the second test the request still fails (the fake database has no
  // `prepare`), but with a TypeError instead of the closed-for-deletion message,
  // and `getProjectDb` is called, so the message match and the not-called check
  // go red. The `ok` check alone would not.

  it('reports no checkpoint for a project after it was closed, and never asks to reopen it', async () => {
    const before = await callWorker('db.checkpoint', { projectIds: ['project-open'] });
    // Control: a project not yet closed checkpoints through the same path.
    expect(before).toEqual({
      type: 'reply',
      id: expect.any(Number),
      ok: true,
      result: [{ projectId: 'project-open', walFrames: 3, checkpointed: 3, busy: false }],
    });

    const closed = await callWorker('project.close', { projectId: 'project-open' });
    expect(closed.ok).toBe(true);
    expect(closeProjectDbMock).toHaveBeenCalledWith('project-open');

    getProjectDbMock.mockClear();
    const after = await callWorker('db.checkpoint', { projectIds: ['project-open', 'project-other'] });

    expect(after.ok).toBe(true);
    // The closed project is skipped (null), the other one is still served.
    expect(after.ok && after.result).toEqual([
      null,
      { projectId: 'project-other', walFrames: 3, checkpointed: 3, busy: false },
    ]);
    expect(getProjectDbMock.mock.calls).toEqual([['project-other']]);
  });

  it('fails any other request for a closed project with a closed-for-deletion error', async () => {
    await callWorker('project.close', { projectId: 'project-deleted' });
    getProjectDbMock.mockClear();

    const reply = await callWorker('usage.read', { projectId: 'project-deleted', read: 'getEarliestTurnMs', args: [] });

    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error).toMatch(/project-deleted was closed for deletion/);
    expect(getProjectDbMock).not.toHaveBeenCalled();
  });

  it('leaves a project that was never closed openable', async () => {
    const reply = await callWorker('db.checkpoint', { projectIds: ['project-never-closed'] });

    expect(reply.ok && reply.result).toEqual([
      { projectId: 'project-never-closed', walFrames: 3, checkpointed: 3, busy: false },
    ]);
    expect(getProjectDbMock).toHaveBeenCalledWith('project-never-closed');
  });
});

describe('retrieval worker: a record sweep queued behind a project close', () => {
  // Red-green: `index.sweep` and `index.session` hand each record sweep
  // `{ getDb: context.getDb }`. Drop that argument from one sweep (the code
  // before the fix) and that sweep falls back to its module default, which is
  // `getProjectDb` itself: it reopens the closed project's database, so
  // `getProjectDb` is called with the closed id and the worker's log carries no
  // closed-for-deletion line. Both assertions below go red for that sweep alone,
  // which is why each sweep has its own case. Every project id is fresh because
  // the worker remembers each id it was told to close.
  const noneIndexed = { indexed: 0, removed: 0 };
  const sweeps: Array<{ step: string; steps: IndexSweepSteps; slot: keyof IndexSweepResult; result: unknown }> = [
    { step: 'tasks', steps: { tasks: true }, slot: 'tasks', result: noneIndexed },
    { step: 'changes', steps: { changes: { projectPath: null } }, slot: 'changes', result: { indexed: 0 } },
    {
      step: 'commits',
      steps: { commits: { projectPath: '/mock/repo', baseBranch: 'main', allowFullRead: true } },
      slot: 'commits',
      result: { ...noneIndexed, relinked: 0, deferred: false },
    },
    {
      step: 'code',
      steps: { code: { plan: 'index', projectPath: '/mock/repo', baseBranch: 'main', allowFullRead: true } },
      slot: 'code',
      result: { ...noneIndexed, deferred: false },
    },
  ];

  it.each(sweeps)('index.sweep $step: reports nothing indexed and never reopens the closed database', async ({ step, steps, slot, result }) => {
    const projectId = `project-closed-before-${step}-sweep`;
    await callWorker('project.close', { projectId });
    getProjectDbMock.mockClear();
    workerLogs.length = 0;

    const reply = await callWorker('index.sweep', { projectId, remoteTargets: [], ...steps });

    expect(reply.ok).toBe(true);
    // The step ran (its slot is a result, not null) and found nothing to index.
    expect(reply.ok && (reply.result as IndexSweepResult)[slot]).toEqual(result);
    expect(getProjectDbMock).not.toHaveBeenCalled();
    // And it stopped at the worker's guard, not at some other failure.
    expect(workerLogs.some((line) => line.includes(`Project ${projectId} was closed for deletion`))).toBe(true);
  });

  it('index.session: the change sweep after the close does not reopen the closed database either', async () => {
    const projectId = 'project-closed-before-session-index';
    await callWorker('project.close', { projectId });
    getProjectDbMock.mockClear();
    workerLogs.length = 0;

    const reply = await callWorker('index.session', {
      projectId,
      sessionId: 'session-1',
      subagents: false,
      changes: { projectPath: null },
      remoteTargets: [],
    });

    expect(reply.ok).toBe(true);
    // The conversation read already refused (outcome 'error'); the change sweep after it must too.
    expect(reply.ok && reply.result).toEqual({ outcome: 'error', changesIndexed: 0 });
    expect(getProjectDbMock).not.toHaveBeenCalled();
    expect(workerLogs.some((line) => line.includes(`Project ${projectId} was closed for deletion`))).toBe(true);
  });

  it('still opens the database of a project that was never closed, through the same sweeps', async () => {
    // Control for the not-called assertions above: they would hold vacuously if
    // a sweep never asked for a database at all.
    getProjectDbMock.mockClear();

    const reply = await callWorker('index.sweep', {
      projectId: 'project-swept-open',
      remoteTargets: [],
      tasks: true,
      changes: { projectPath: null },
    });

    expect(reply.ok).toBe(true);
    expect(getProjectDbMock).toHaveBeenCalledWith('project-swept-open');
    expect(getProjectDbMock.mock.calls.every(([requestedId]) => requestedId === 'project-swept-open')).toBe(true);
  });
});
