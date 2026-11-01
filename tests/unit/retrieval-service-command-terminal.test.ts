/**
 * retrievalService and the Earlier list's text search: the debounced
 * `index.commandTerminalConversation` worker call, the text search that says
 * when indexing is off, the timer cleanup on dispose, and the project-open
 * sweep asking for Command Terminal conversations.
 *
 * The retrieval client is a spy, so what is observed is which worker calls main
 * makes and when. Fake timers drive the 5 s debounce. Tier: Unit.
 *
 * Red-green (each by a brief edit to retrieval-service.ts, restored after):
 *  - key the timer map by project instead of conversation, or drop the
 *    `clearTimeout(existing)`: the coalescing / per-conversation tests go red.
 *  - drop the `isIndexingEnabled` guards: the indexing-off tests go red.
 *  - drop the `commandTerminalIndexTimers` loop from `dispose`: the dispose test
 *    goes red on its timer count.
 *  - drop `commandTerminals: true` from the open sweep: the project-open test
 *    goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

const clientMock = vi.hoisted(() => ({
  call: vi.fn(async (method: string): Promise<unknown> => {
    switch (method) {
      case 'index.sweep': return { purged: 0, tasks: null, changes: null, commits: null, code: null };
      case 'archive.sweep': return { archived: 0, purged: 0 };
      case 'transcripts.convertLegacy': return { converted: 0, moved: 0, bytes: 0 };
      case 'vec.migrateLayout': return { copied: 0, switched: false, freedBlocks: 0 };
      case 'index.buildWhenQuiet': return { built: [] };
      case 'index.commandTerminalConversation': return { outcome: 'indexed' };
      default: return undefined;
    }
  }),
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class extends Error {},
  retrievalClient: {
    on: vi.fn(),
    call: clientMock.call,
    notifyRunning: vi.fn(),
    closeProject: vi.fn(async () => undefined),
    unavailableReason: null,
  },
}));

const embedEngineMock = vi.hoisted(() => ({
  attach: vi.fn(),
  setOnRecordsEmbedded: vi.fn(),
  markDirty: vi.fn(),
  dispose: vi.fn(),
  getEmbedder: vi.fn(() => null),
  reconcile: vi.fn(),
  activeDevice: null as string | null,
  workerCrashed: false,
  workerCrashReason: null as string | null,
}));
vi.mock('../../src/main/retrieval/embedder/embed-engine', () => ({ embedEngine: embedEngineMock }));
vi.mock('../../src/main/retrieval/graph-facade', () => ({
  graphService: {
    notifyChanged: vi.fn(),
    setSummaryActivity: vi.fn(),
    setOnEmbeddingsWaiting: vi.fn(),
    setSummaryNamesOn: vi.fn(),
    setProjectIds: vi.fn(),
  },
}));

const DEBOUNCE_MS = 5000;

/** The calls main made to the worker for one method. */
function callsTo(method: string): unknown[][] {
  return clientMock.call.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

function makeContext(indexingEnabled: boolean, currentProjectId: string | null = null): IpcContext {
  return {
    sessionManager: Object.assign(new EventEmitter(), { getSession: () => undefined, getSessionProjectId: () => undefined }),
    boardEvents: new BoardEventBus(),
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled } }) },
    projectRepo: { list: () => [], getById: () => null },
    currentProjectId,
  } as unknown as IpcContext;
}

describe('retrievalService.scheduleCommandTerminalIndex', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // The module keeps its timers and `disposed` flag as singleton state.
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
  });

  it('makes one worker call for two reports of one conversation inside the debounce window', async () => {
    const context = makeContext(true);

    retrievalService.scheduleCommandTerminalIndex(context, 'project-1', 'conversation-a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1000);
    expect(callsTo('index.commandTerminalConversation')).toHaveLength(0);
    // The second report restarts the window, so the first would-be fire passes quietly.
    retrievalService.scheduleCommandTerminalIndex(context, 'project-1', 'conversation-a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1000);
    expect(callsTo('index.commandTerminalConversation')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);

    const calls = callsTo('index.commandTerminalConversation');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ projectId: 'project-1', agentSessionId: 'conversation-a', remoteTargets: expect.anything() });
    expect(calls[0][2]).toEqual({ timeoutMs: null });
  });

  it('makes one call per conversation when two conversations report', async () => {
    const context = makeContext(true);

    retrievalService.scheduleCommandTerminalIndex(context, 'project-1', 'conversation-a');
    retrievalService.scheduleCommandTerminalIndex(context, 'project-1', 'conversation-b');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);

    const reported = callsTo('index.commandTerminalConversation').map(([, params]) => (params as { agentSessionId: string }).agentSessionId);
    expect(reported.sort()).toEqual(['conversation-a', 'conversation-b']);
  });

  it('does nothing while the Knowledge Graph indexing switch is off', async () => {
    retrievalService.scheduleCommandTerminalIndex(makeContext(false), 'project-1', 'conversation-a');

    // No timer was armed, and nothing reaches the worker.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(callsTo('index.commandTerminalConversation')).toHaveLength(0);
  });

  it('drops a pending read when the switch goes off before the timer fires', async () => {
    let indexingEnabled = true;
    const context = {
      ...makeContext(true),
      configManager: { load: () => ({ knowledgeGraph: { indexingEnabled } }) },
    } as unknown as IpcContext;

    retrievalService.scheduleCommandTerminalIndex(context, 'project-1', 'conversation-a');
    indexingEnabled = false;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);

    expect(callsTo('index.commandTerminalConversation')).toHaveLength(0);
  });

  it('dispose cancels a pending timer, so no worker call follows', async () => {
    retrievalService.scheduleCommandTerminalIndex(makeContext(true), 'project-1', 'conversation-a');
    expect(vi.getTimerCount()).toBe(1);

    retrievalService.dispose();

    // The timer is cleared, not merely left to meet the `disposed` guard in its own callback.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(callsTo('index.commandTerminalConversation')).toHaveLength(0);
  });

  it('arms nothing once disposed', () => {
    retrievalService.dispose();

    retrievalService.scheduleCommandTerminalIndex(makeContext(true), 'project-1', 'conversation-a');

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('retrievalService.searchCommandTerminalText', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
  });

  it('says indexing is off, with no hits, and never asks the worker', async () => {
    const result = await retrievalService.searchCommandTerminalText(makeContext(false), 'project-1', 'rail');

    expect(result).toEqual({ indexingOff: true, hits: [] });
    expect(callsTo('search.commandTerminalConversations')).toHaveLength(0);
  });

  it('returns the worker\'s hits when indexing is on', async () => {
    const hits = [{ agentSessionId: 'conversation-a', snippet: 'the rail fix landed', matchStart: 4, matchEnd: 8 }];
    clientMock.call.mockResolvedValueOnce(hits);

    const result = await retrievalService.searchCommandTerminalText(makeContext(true), 'project-1', 'rail');

    expect(result).toEqual({ indexingOff: false, hits });
    expect(callsTo('search.commandTerminalConversations')).toEqual([
      ['search.commandTerminalConversations', { projectId: 'project-1', query: 'rail' }],
    ]);
  });
});

describe('retrievalService.startForProject', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
  });

  it('asks the open sweep to read Command Terminal conversations', async () => {
    const project = { id: 'project-1', name: 'Demo', path: '/mock/repo' };

    retrievalService.startForProject(makeContext(true, 'project-1'), project as never);
    await vi.advanceTimersByTimeAsync(100);

    const sweeps = callsTo('index.sweep');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0][1]).toMatchObject({ projectId: 'project-1', conversations: true, commandTerminals: true });
  });

  it('runs no index sweep while the indexing switch is off', async () => {
    const project = { id: 'project-1', name: 'Demo', path: '/mock/repo' };

    retrievalService.startForProject(makeContext(false, 'project-1'), project as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(callsTo('index.sweep')).toHaveLength(0);
  });
});
