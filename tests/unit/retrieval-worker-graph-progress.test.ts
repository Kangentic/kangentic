/**
 * The retrieval worker's hops for a first build's progress: the `graph.refresh`
 * reply and the `graph-progress` event.
 *
 * Both are wiring between layers, each a few lines that no single-function test
 * sees. `graph.refresh` must hand back what the graph service's `markDirty`
 * answered, because the renderer paints the building card from that reply. And
 * the service's `onBuildProgress` must reach main as a `graph-progress` event
 * that carries the figure itself, because the facade drops one that does not.
 * Lose either hop and the bar sits at "No map yet" or stops moving, with every
 * other test still green.
 *
 * The graph service is replaced by a stub that hands back the deps the worker
 * built it with, so the test drives the worker's own callbacks. The worker entry
 * is driven the way `retrieval-worker-closed-project.test.ts` drives it: a
 * stand-in for `process.parentPort`, the module imported so it registers its
 * message listener, and real request messages. `db/database` is mocked because
 * better-sqlite3 cannot load under vitest's Node.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FromWorkerMessage, ReplyMessage } from '../../src/main/retrieval/worker/protocol';
import type { GraphServiceDeps } from '../../src/main/retrieval/graph/graph-service';
import type { KnowledgeGraphBuildProgress } from '../../src/shared/types';

const { graphStub } = vi.hoisted(() => ({
  graphStub: {
    deps: null as unknown,
    markDirty: vi.fn(),
    setSummaryNamesOn: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  configureProjectDbAccess: vi.fn(),
  closeProjectDb: vi.fn(),
  getProjectDb: vi.fn(),
  setProjectDbInitializer: vi.fn(),
  setWalAutoCheckpoint: vi.fn(),
}));

// Everything else the module exports stays real: other worker code imports it.
vi.mock('../../src/main/retrieval/graph/graph-service', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/retrieval/graph/graph-service')>();
  return {
    ...actual,
    createGraphService: (deps: GraphServiceDeps) => {
      graphStub.deps = deps;
      return { markDirty: graphStub.markDirty, setSummaryNamesOn: graphStub.setSummaryNamesOn };
    },
  };
});

type PortListener = (event: { data: unknown }) => void;

let messageListener: PortListener | null = null;
let nextRequestId = 1;
const pendingReplies = new Map<number, (reply: ReplyMessage) => void>();
/** Every message the worker posted to main, in order. */
const posted: FromWorkerMessage[] = [];

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
        posted.push(message);
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

beforeEach(() => {
  posted.length = 0;
  graphStub.markDirty.mockReset();
});

/** Send one request the way main's client does, and resolve with the reply. */
function callWorker(method: string, params: unknown): Promise<ReplyMessage> {
  if (!messageListener) throw new Error('the worker entry did not register a message listener');
  const id = nextRequestId++;
  const reply = new Promise<ReplyMessage>((resolve) => pendingReplies.set(id, resolve));
  messageListener({ data: { type: 'request', id, method, params } });
  return reply;
}

const REFRESH_PARAMS = { projectId: 'project-1', modelTag: 'model', dimensions: 4, summaryNamesOn: false };
const FIRST_BUILD_PROGRESS: KnowledgeGraphBuildProgress = { pass: 7, stage: 'reading', percent: 41 };

/** The deps the worker built its graph service with, once a graph call made it. */
function workerDeps(): GraphServiceDeps {
  if (!graphStub.deps) throw new Error('no graph call has built the graph service yet');
  return graphStub.deps as GraphServiceDeps;
}

describe('retrieval worker: graph.refresh', () => {
  // Red-green: make the `graph.refresh` handler a block body that calls
  // `markDirty` and returns nothing (the code before the progress answer) and
  // the reply carries no result, so both cases below go red.
  it('replies with the progress the graph service answered a first build with', async () => {
    graphStub.markDirty.mockReturnValueOnce(FIRST_BUILD_PROGRESS);

    const reply = await callWorker('graph.refresh', REFRESH_PARAMS);

    expect(reply).toEqual({ type: 'reply', id: expect.any(Number), ok: true, result: FIRST_BUILD_PROGRESS });
    expect(graphStub.markDirty).toHaveBeenCalledWith('project-1', 'model', 4);
  });

  it('replies null, not nothing, when no first build runs', async () => {
    graphStub.markDirty.mockReturnValueOnce(null);

    const reply = await callWorker('graph.refresh', REFRESH_PARAMS);

    expect(reply).toEqual({ type: 'reply', id: expect.any(Number), ok: true, result: null });
  });
});

describe('retrieval worker: the events its graph service raises', () => {
  // Red-green: drop `onBuildProgress` from `graphFor` in `methods.ts` and the
  // service's push reaches nobody, so the event never posts. Drop the
  // `progress` argument from the worker's `emit` and the event posts without the
  // figure, which the facade ignores.
  it('posts a graph-progress event that carries the figure', async () => {
    graphStub.markDirty.mockReturnValueOnce(null);
    await callWorker('graph.refresh', REFRESH_PARAMS);
    posted.length = 0;

    workerDeps().onBuildProgress?.('project-1', FIRST_BUILD_PROGRESS);

    expect(posted).toEqual([
      { type: 'event', event: 'graph-progress', projectId: 'project-1', progress: FIRST_BUILD_PROGRESS },
    ]);
  });

  it('posts a graph-changed event with no figure', async () => {
    graphStub.markDirty.mockReturnValueOnce(null);
    await callWorker('graph.refresh', REFRESH_PARAMS);
    posted.length = 0;

    workerDeps().onChanged?.('project-1');

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: 'event', event: 'graph-changed', projectId: 'project-1' });
    expect(posted[0]).not.toHaveProperty('progress');
  });
});
