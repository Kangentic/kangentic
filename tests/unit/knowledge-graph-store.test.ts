/**
 * Unit tests for src/renderer/stores/knowledge-graph-store.ts.
 *
 * tests/ui/knowledge-graph.spec.ts drives this store through the real surface,
 * but the mock bridge answers a snapshot read in the same tick, so a read is
 * never still in flight when the next one is asked for. That ordering is the
 * whole of what this file pins, by handing a read's promise to the test and
 * resolving it by hand:
 *  - a read asked for while another is in flight is not dropped: one more runs
 *    when the first lands, so a later read for another project (or a completion
 *    push) is never lost and the store cannot end on the older project,
 *  - the promise a mid-read caller gets settles only after that follow-up read
 *    lands, not when the older read does,
 *  - a reader's ask outranks a push that follows it (the pending read keeps the
 *    reader's project id and may start a rebuild a push may not), while a push
 *    that was waiting yields to a reader,
 *  - the read asked for meanwhile still runs when the first one fails,
 *  - the answer stream is gated on the active turn's request id,
 *  - a scope of just the open project is not a scope,
 *  - a project coming back into the scope is read again (its pushes were ignored
 *    while it was out), while one that stayed in, and the open project, are not, and
 *  - a scoped re-read that rejects keeps the island already drawn, while a first
 *    read that rejects records the project as empty,
 *  - the open project's island is seeded again from the live snapshot when it
 *    rejoins the scope, since its reads refreshed the snapshot while it was out,
 *  - closing the graph leaves a session that is still answering alone and ends
 *    it when that turn lands, while an idle close ends it at once,
 *  - reopening the graph does not prewarm over a turn from before the close,
 *  - a question asked before the first snapshot lands (no project yet) keeps its
 *    turn when that snapshot resolves, while a snapshot for a different project
 *    than the one a turn was asked in still ends the chat,
 *  - an open that names another project than the one last shown ends that chat
 *    first, so a question queued with the open is asked of the new project and
 *    its turn survives the new project's snapshot, while an open on the same
 *    project (or on none) keeps the chat, and
 *  - a read in flight when the graph closes asks for no rebuild when it lands.
 *
 * window.electronAPI is stubbed globally and the store is imported fresh for
 * every test (vi.resetModules): its in-flight read, pending read, stream
 * subscription and active request id are module-scope, so a shared instance
 * would carry one test's unresolved read into the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  KnowledgeGraphAnswerResult,
  KnowledgeGraphAnswerStreamPush,
  KnowledgeGraphCoverageBucket,
  KnowledgeGraphSnapshot,
} from '../../src/shared/types';

type KnowledgeGraphStore = typeof import('../../src/renderer/stores/knowledge-graph-store').useKnowledgeGraphStore;

interface PendingRead {
  projectId: string | null;
  resolve: (snapshot: KnowledgeGraphSnapshot | null) => void;
  reject: (error: Error) => void;
}

let pendingReads: PendingRead[] = [];
let streamListeners: Array<(event: KnowledgeGraphAnswerStreamPush) => void> = [];

const graphSnapshotMock = vi.fn<(projectId?: string | null, knownProjectionKey?: string | null) => Promise<KnowledgeGraphSnapshot | null>>();
const refreshGraphMock = vi.fn<(projectId?: string | null) => Promise<void>>();
const answerFromGraphMock = vi.fn<(...args: unknown[]) => Promise<KnowledgeGraphAnswerResult>>();
const prewarmMock = vi.fn<(options: { chatId: string; projectId: string | null }) => void>();
const endChatMock = vi.fn<(chatId: string) => void>();

function installWindowStub(): void {
  (globalThis as Record<string, unknown>).window = {
    electronAPI: {
      config: { onChanged: vi.fn(() => () => undefined) },
      knowledgeGraph: {
        graphSnapshot: graphSnapshotMock,
        refreshGraph: refreshGraphMock,
        graphProjects: vi.fn(async () => []),
        onGraphChanged: vi.fn(() => () => undefined),
        onAnswerStream: vi.fn((callback: (event: KnowledgeGraphAnswerStreamPush) => void) => {
          streamListeners.push(callback);
          return () => undefined;
        }),
        answerFromGraph: answerFromGraphMock,
        prewarm: prewarmMock,
        endChat: endChatMock,
      },
    },
  };
}

function makeBucket(): KnowledgeGraphCoverageBucket {
  return { documents: 0, chunks: 0, tone: 'ok' };
}

function makeSnapshot(projectId: string, overrides: Partial<KnowledgeGraphSnapshot> = {}): KnowledgeGraphSnapshot {
  return {
    projectId,
    projection: null,
    coverage: {
      indexed: makeBucket(),
      sourceMissingButSearchable: makeBucket(),
      empty: makeBucket(),
      failed: makeBucket(),
      notYetIndexed: makeBucket(),
      totalDocumentsWithChunks: 0,
      totalChunks: 0,
      totalEmbeddedChunks: 0,
      embeddedFraction: 0,
      knownDocumentIdsMatched: 0,
    },
    index: { corpora: [], summaries: { written: 0, finishedTasks: 0 }, storageBytes: 0 },
    building: false,
    stale: false,
    semanticAvailable: true,
    ...overrides,
  };
}

/** Hold the next answer open, so the turn stays in flight until the test
 *  settles it. */
function holdNextAnswer(): (result: KnowledgeGraphAnswerResult) => void {
  let release: (result: KnowledgeGraphAnswerResult) => void = () => undefined;
  answerFromGraphMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  return (result) => release(result);
}

const settledAnswer: KnowledgeGraphAnswerResult = {
  ok: true,
  agentName: 'Test Agent',
  answer: 'an answer',
  rows: [],
  related: [],
  handedCount: 0,
  promptTokens: 1,
};

/** Take the oldest unanswered read for `projectId` off the bridge. Throws when
 *  there is none, so a read the store never made fails here by name instead of
 *  hanging the test on a promise nothing will settle. */
function takePendingRead(projectId: string | null): PendingRead {
  const index = pendingReads.findIndex((read) => read.projectId === projectId);
  if (index < 0) {
    const pending = pendingReads.map((read) => String(read.projectId)).join(', ') || 'none';
    throw new Error(`no read pending for ${String(projectId)}; pending: ${pending}`);
  }
  return pendingReads.splice(index, 1)[0];
}

function resolveRead(projectId: string, snapshot: KnowledgeGraphSnapshot | null = makeSnapshot(projectId)): void {
  takePendingRead(projectId).resolve(snapshot);
}

/** Let every microtask (and the timer queue) run, for asserting that something
 *  has NOT settled. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fireStream(event: KnowledgeGraphAnswerStreamPush): void {
  for (const listener of streamListeners.slice()) listener(event);
}

let store: KnowledgeGraphStore;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  pendingReads = [];
  streamListeners = [];
  graphSnapshotMock.mockImplementation((projectId) => new Promise((resolve, reject) => {
    pendingReads.push({ projectId: projectId ?? null, resolve, reject });
  }));
  refreshGraphMock.mockResolvedValue(undefined);
  installWindowStub();
  ({ useKnowledgeGraphStore: store } = await import('../../src/renderer/stores/knowledge-graph-store'));
});

describe('knowledge-graph-store loadSnapshot while a read is in flight', () => {
  it('runs a read for another project when the first lands, and ends on that project', async () => {
    const first = store.getState().loadSnapshot('A');
    let secondSettled = false;
    const second = store.getState().loadSnapshot('B').then(() => { secondSettled = true; });
    // Only A has been asked of main so far: B waits for A rather than racing it.
    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);

    resolveRead('A');
    await first;
    await flush();

    // A landing starts the read asked for meanwhile, and the caller that asked
    // for it is still waiting: its promise is B's, not A's.
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('B', null);
    expect(secondSettled).toBe(false);

    const snapshotB = makeSnapshot('B');
    resolveRead('B', snapshotB);
    await second;

    expect(secondSettled).toBe(true);
    expect(store.getState().projectId).toBe('B');
    expect(store.getState().snapshot).toBe(snapshotB);
    expect(store.getState().loading).toBe(false);
  });

  it('does not lose a completion push that arrives mid-read', async () => {
    store.setState({ projectId: 'A' });
    const first = store.getState().loadSnapshot('A');
    void store.getState().loadSnapshot('A', { fromPush: true });
    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);

    resolveRead('A');
    await first;
    await flush();

    // The read in flight was started before the push, so it cannot show what
    // the push announced. One more read runs, for the same project.
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('A', null);
    resolveRead('A');
    await flush();
    expect(store.getState().loading).toBe(false);
  });

  it('runs exactly one follow-up for any number of reads asked for meanwhile', async () => {
    const first = store.getState().loadSnapshot('A');
    void store.getState().loadSnapshot('B');
    void store.getState().loadSnapshot('B');
    void store.getState().loadSnapshot('B');

    resolveRead('A');
    await first;
    await flush();
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);

    resolveRead('B');
    await flush();
    // Nothing further was asked for, so nothing further is read.
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(pendingReads).toHaveLength(0);
  });

  it('keeps a reader\'s project when a push arrives after it', async () => {
    const first = store.getState().loadSnapshot('A');
    void store.getState().loadSnapshot('B');
    // A following-mode push names no project (main resolves it), and must not
    // turn the reader's request for B into a read of "whatever is current".
    void store.getState().loadSnapshot(null, { fromPush: true });

    resolveRead('A');
    await first;
    await flush();

    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('B', null);
  });

  it('lets a reader replace a push that was waiting', async () => {
    const first = store.getState().loadSnapshot('A');
    void store.getState().loadSnapshot(null, { fromPush: true });
    void store.getState().loadSnapshot('B');

    resolveRead('A');
    await first;
    await flush();

    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('B', null);
  });

  it('keeps the reader\'s right to start a rebuild when a push follows it', async () => {
    store.setState({ projectId: 'A' });
    // `building` makes the first read ask for no rebuild of its own.
    const first = store.getState().loadSnapshot('A');
    void store.getState().loadSnapshot('A');
    void store.getState().loadSnapshot('A', { fromPush: true });

    resolveRead('A', makeSnapshot('A', { building: true }));
    await first;
    await flush();
    expect(refreshGraphMock).not.toHaveBeenCalled();

    // The follow-up is the reader's read, of a map with no projection yet. A
    // reader's read asks main to build it; a push's read would not have.
    resolveRead('A', makeSnapshot('A', { projection: null, stale: true }));
    await flush();
    expect(refreshGraphMock).toHaveBeenCalledTimes(1);
    expect(refreshGraphMock).toHaveBeenCalledWith('A');
  });

  it('still runs the read asked for meanwhile when the first read fails', async () => {
    const first = store.getState().loadSnapshot('A');
    const second = store.getState().loadSnapshot('B');

    takePendingRead('A').reject(new Error('main is busy'));
    await first;
    await flush();

    expect(graphSnapshotMock).toHaveBeenLastCalledWith('B', null);
    resolveRead('B');
    await second;
    expect(store.getState().projectId).toBe('B');
    expect(store.getState().loading).toBe(false);
  });

  it('reads once when nothing else was asked for', async () => {
    const only = store.getState().loadSnapshot('A');
    resolveRead('A');
    await only;
    await flush();
    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

describe('knowledge-graph-store answer stream', () => {
  it('applies a stream event only to the turn in flight', async () => {
    store.getState().attach();
    expect(streamListeners).toHaveLength(1);

    answerFromGraphMock.mockResolvedValueOnce({ ...settledAnswer, answer: 'first answer' });
    await store.getState().askQuestion('first question');
    const firstTurn = store.getState().thread[0];
    expect(firstTurn.status).toBe('done');

    const releaseSecond = holdNextAnswer();
    const secondAsk = store.getState().askQuestion('second question');
    const secondTurn = store.getState().thread[1];

    // A turn that is in the thread but is not the one in flight: its late
    // event names a real turn, so only the gate stops it being applied.
    fireStream({ requestId: firstTurn.id, kind: 'text', text: 'NOT THIS' });
    expect(store.getState().thread[0].text).toBe('first answer');
    expect(store.getState().thread[1].text).toBe('');

    // The same event for the turn in flight lands, so the check above cannot
    // pass merely because the listener was never wired.
    fireStream({ requestId: secondTurn.id, kind: 'text', text: 'streaming ' });
    expect(store.getState().thread[1].text).toBe('streaming ');
    expect(store.getState().thread[1].status).toBe('answering');

    releaseSecond({ ...settledAnswer, answer: 'second answer' });
    await secondAsk;
    expect(store.getState().thread[1].text).toBe('second answer');

    // Once no turn is in flight nothing is wanted, its own id included.
    fireStream({ requestId: secondTurn.id, kind: 'text', text: 'TOO LATE' });
    expect(store.getState().thread[1].text).toBe('second answer');
  });
});

describe('knowledge-graph-store setScope', () => {
  it('treats just the open project as no scope', () => {
    store.setState({ projectId: 'A', scopeProjectIds: ['A', 'B'] });

    store.getState().setScope(['A']);
    expect(store.getState().scopeProjectIds).toBeNull();

    store.setState({ scopeProjectIds: ['A', 'B'] });
    store.getState().setScope(['A', 'A']);
    expect(store.getState().scopeProjectIds).toBeNull();
  });

  it('keeps a scope that names another project, alone or with the open one', () => {
    store.setState({ projectId: 'A' });

    store.getState().setScope(['A', 'B']);
    expect(store.getState().scopeProjectIds).toEqual(['A', 'B']);

    store.getState().setScope(['B']);
    expect(store.getState().scopeProjectIds).toEqual(['B']);

    store.getState().setScope(null);
    expect(store.getState().scopeProjectIds).toBeNull();
  });

  it('reads a project again when it comes back into the scope, and keeps its old island until the read lands', async () => {
    const staleIsland = makeSnapshot('B', { stale: true });
    const freshIsland = makeSnapshot('B', { stale: false });
    store.setState({ projectId: 'A', snapshot: makeSnapshot('A') });

    store.getState().setScope(['A', 'B']);
    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('B', null);
    resolveRead('B', staleIsland);
    await flush();
    expect(store.getState().scopeSnapshots.B).toBe(staleIsland);

    // B leaves the scope (just the open project is no scope), where its pushes
    // are ignored, and comes back. The island it left behind may be stale.
    store.getState().setScope(['A']);
    expect(store.getState().scopeProjectIds).toBeNull();
    store.getState().setScope(['A', 'B']);

    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('B', null);
    // The old island stays on screen while the read is in flight.
    expect(store.getState().scopeSnapshots.B).toBe(staleIsland);

    resolveRead('B', freshIsland);
    await flush();
    expect(store.getState().scopeSnapshots.B).toBe(freshIsland);
  });

  it('does not read a project that stayed in the scope, only the one that joined it', async () => {
    store.setState({ projectId: 'A', snapshot: makeSnapshot('A') });
    store.getState().setScope(['A', 'B']);
    resolveRead('B');
    await flush();
    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);

    store.getState().setScope(['A', 'B', 'C']);

    // B was already in the previous scope: its island is kept without a read.
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('C', null);
  });

  it('does not read the open project when it rejoins the scope, its map is seeded', async () => {
    store.setState({ projectId: 'A', snapshot: makeSnapshot('A') });
    store.getState().setScope(['B']);
    resolveRead('B');
    await flush();
    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);

    store.getState().setScope(['A', 'B']);

    expect(graphSnapshotMock).toHaveBeenCalledTimes(1);
    expect(store.getState().scopeSnapshots.A).toBe(store.getState().snapshot);
  });

  it('seeds the open project from its live snapshot when it rejoins the scope, not from the island it left behind', async () => {
    const oldOwn = makeSnapshot('A', { stale: true });
    const newerOwn = makeSnapshot('A', { stale: false });
    store.setState({ projectId: 'A', snapshot: oldOwn });

    store.getState().setScope(['A', 'B']);
    expect(store.getState().scopeSnapshots.A).toBe(oldOwn);
    resolveRead('B');
    await flush();

    // A leaves the scope. Its island stays cached, but a read of A now reaches
    // only `snapshot`: the scope no longer holds A, so the island is not updated.
    store.getState().setScope(['B']);
    const reread = store.getState().loadSnapshot('A');
    resolveRead('A', newerOwn);
    await reread;
    expect(store.getState().snapshot).toBe(newerOwn);
    expect(store.getState().scopeSnapshots.A).toBe(oldOwn);

    store.getState().setScope(['A', 'B']);

    // The island is the newer snapshot itself (identity, not a lookalike), and
    // it came from the live snapshot: neither A nor B was read again.
    expect(store.getState().scopeSnapshots.A).toBe(newerOwn);
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
  });
});

describe('knowledge-graph-store close and open around a turn in flight', () => {
  /** The chat id the store handed the answering agent for the ask at `callIndex`. */
  function chatIdOfAsk(callIndex: number): string {
    const options = answerFromGraphMock.mock.calls[callIndex][4] as { chatId: string };
    return options.chatId;
  }

  it('ends the chat at once when no turn is in flight', () => {
    store.getState().open('A');
    expect(endChatMock).not.toHaveBeenCalled();
    const warmedChatId = prewarmMock.mock.calls[0][0].chatId;

    store.getState().close();

    expect(endChatMock).toHaveBeenCalledTimes(1);
    expect(endChatMock).toHaveBeenCalledWith(warmedChatId);
  });

  it('leaves a session that is still answering alone on close, and ends it once when that turn lands', async () => {
    store.getState().open('A');
    store.getState().close();
    expect(endChatMock).toHaveBeenCalledTimes(1);
    store.getState().open('A');

    const release = holdNextAnswer();
    const asking = store.getState().askQuestion('which tasks touched the relay?');
    const chatId = chatIdOfAsk(0);
    expect(store.getState().thread[0].status).toBe('finding');

    // The graph closes mid-answer: ending the session now would fail the turn
    // the kept chat is about to show.
    store.getState().close();
    expect(endChatMock).toHaveBeenCalledTimes(1);

    release(settledAnswer);
    await asking;

    // The answer landed into the kept chat, and only then does its session go.
    expect(store.getState().thread[0].status).toBe('done');
    expect(endChatMock).toHaveBeenCalledTimes(2);
    expect(endChatMock).toHaveBeenLastCalledWith(chatId);
  });

  it('keeps the session when a turn lands while the graph is still open', async () => {
    store.getState().open('A');
    const release = holdNextAnswer();
    const asking = store.getState().askQuestion('which tasks touched the relay?');

    release(settledAnswer);
    await asking;

    // Nothing was closed, so a follow-up can still be asked in the same session.
    expect(store.getState().thread[0].status).toBe('done');
    expect(endChatMock).not.toHaveBeenCalled();
  });

  it('prewarms on every open when no turn is in flight', () => {
    store.getState().open('A');
    expect(prewarmMock).toHaveBeenCalledTimes(1);
    const { chatId, projectId } = prewarmMock.mock.calls[0][0];
    expect(projectId).toBe('A');

    store.getState().close();
    store.getState().open('A');

    expect(prewarmMock).toHaveBeenCalledTimes(2);
    expect(prewarmMock.mock.calls[1][0]).toEqual({ chatId, projectId: 'A' });
  });

  it('does not prewarm over a turn from before the close, and prewarms again once it has settled', async () => {
    store.getState().open('A');
    store.getState().close();
    store.getState().open('A');
    expect(prewarmMock).toHaveBeenCalledTimes(2);

    const release = holdNextAnswer();
    const asking = store.getState().askQuestion('which tasks touched the relay?');
    store.getState().close();
    store.getState().open('A');

    // Its session is already warm and busy: a prewarm would replace it and fail
    // the turn.
    expect(prewarmMock).toHaveBeenCalledTimes(2);

    release(settledAnswer);
    await asking;
    store.getState().close();
    store.getState().open('A');

    expect(prewarmMock).toHaveBeenCalledTimes(3);
  });
});

describe('knowledge-graph-store loadSnapshot and the chat it lands on', () => {
  // Pins the `previousProjectId !== null` term in `projectChanged`. Without it
  // the first snapshot of a session counts as a project switch (null to the
  // resolved id), and a question asked before it lands is ended with the chat:
  // the thread is wiped, `endChat` fires, and the answer has no turn to land in.
  it('keeps a question asked before the first snapshot lands, and the answer to it', async () => {
    // Quick Find's route: `askInGraph` queues the question and opens the graph
    // with no project, and the Body asks it before the first read has landed.
    store.getState().askInGraph('which tasks touched the relay?', null);
    const queuedQuestion = store.getState().takeQueuedQuestion();
    expect(queuedQuestion).toBe('which tasks touched the relay?');
    expect(store.getState().projectId).toBeNull();
    const release = holdNextAnswer();
    const asking = store.getState().askQuestion(queuedQuestion ?? '');
    expect(store.getState().thread).toHaveLength(1);

    // Main resolves the project the store never had. Landing is asserted first,
    // so the silence from `endChat` below is about this read and not a read that
    // never arrived.
    takePendingRead(null).resolve(makeSnapshot('A'));
    await flush();
    expect(store.getState().projectId).toBe('A');
    expect(store.getState().loaded).toBe(true);

    expect(endChatMock).not.toHaveBeenCalled();
    expect(store.getState().thread).toHaveLength(1);

    // The user-visible symptom: the answer lands in the turn that was asked.
    release(settledAnswer);
    await asking;
    expect(store.getState().thread[0].status).toBe('done');
    expect(store.getState().thread[0].text).toBe('an answer');
    expect(endChatMock).not.toHaveBeenCalled();
  });

  // Control for the test above: the same ending of the chat is still wanted
  // when the open project is known and the snapshot is for another one, since
  // the tasks a thread names belong to the project it was asked in.
  it('still ends the chat when a snapshot lands for a different project than the thread was asked in', async () => {
    store.getState().open('A');
    resolveRead('A');
    await flush();
    expect(store.getState().projectId).toBe('A');

    const release = holdNextAnswer();
    const asking = store.getState().askQuestion('which tasks touched the relay?');
    expect(store.getState().thread).toHaveLength(1);
    const askedChatId = (answerFromGraphMock.mock.calls[0][4] as { chatId: string }).chatId;
    expect(endChatMock).not.toHaveBeenCalled();

    const switching = store.getState().loadSnapshot('B');
    resolveRead('B');
    await switching;

    expect(store.getState().projectId).toBe('B');
    expect(endChatMock).toHaveBeenCalledTimes(1);
    expect(endChatMock).toHaveBeenCalledWith(askedChatId);
    expect(store.getState().thread).toEqual([]);

    // The ended turn's late answer finds no turn and changes nothing.
    release(settledAnswer);
    await asking;
    expect(store.getState().thread).toEqual([]);
    expect(endChatMock).toHaveBeenCalledTimes(1);
  });

  // Pins the explicit-project branch of `open`. `close` keeps `projectId`, so a
  // graph reopened on another project (Quick Find's Ask row from another board)
  // still named the old one: `runTurn` sends `get().projectId`, so the queued
  // question was asked of the old project, and the new project's snapshot then
  // counted as a switch and ended the chat, dropping the question's turn.
  it('asks a question queued with an open on another project of that project, and keeps its turn', async () => {
    // A visit to project A that leaves a finished turn in the kept chat.
    store.getState().open('A');
    resolveRead('A');
    await flush();
    expect(store.getState().projectId).toBe('A');
    answerFromGraphMock.mockResolvedValueOnce(settledAnswer);
    await store.getState().askQuestion('first question');
    expect(store.getState().thread).toHaveLength(1);
    const firstChatId = (answerFromGraphMock.mock.calls[0][4] as { chatId: string }).chatId;
    store.getState().close();
    // The idle close ended A's session already. What follows is the open's own.
    const endChatCallsAfterClose = endChatMock.mock.calls.length;

    // Quick Find from project B's board: queue the question and open on B.
    store.getState().askInGraph('second question', 'B');

    // A's chat is over before anything is asked, and the store points at B with
    // no map of its own yet.
    expect(store.getState().projectId).toBe('B');
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().thread).toEqual([]);
    expect(endChatMock.mock.calls.slice(endChatCallsAfterClose)).toEqual([[firstChatId]]);

    // The graph body asks the queued question while B's snapshot read is still
    // held, the order that sent it to A.
    const queuedQuestion = store.getState().takeQueuedQuestion();
    expect(queuedQuestion).toBe('second question');
    const release = holdNextAnswer();
    const asking = store.getState().askQuestion(queuedQuestion ?? '');
    const secondAsk = answerFromGraphMock.mock.calls[1];
    expect(secondAsk[0]).toBe('second question');
    expect(secondAsk[1]).toBe('B');
    const secondAskOptions = secondAsk[4] as { chatId: string; history: unknown[] };
    // A new chat, which carries nothing of A's.
    expect(secondAskOptions.chatId).not.toBe(firstChatId);
    expect(secondAskOptions.history).toEqual([]);

    // B's snapshot lands. Landing is asserted first, so the silence from
    // `endChat` and the surviving turn below are about this read and not a
    // read that never arrived.
    takePendingRead('B').resolve(makeSnapshot('B'));
    await flush();
    expect(store.getState().projectId).toBe('B');
    expect(store.getState().loaded).toBe(true);
    // Not a switch: the chat already ended at the open, so no second end.
    expect(endChatMock.mock.calls.slice(endChatCallsAfterClose)).toEqual([[firstChatId]]);
    expect(store.getState().thread).toHaveLength(1);
    expect(store.getState().thread[0].question).toBe('second question');

    // The user-visible symptom: the answer lands in the turn that was asked.
    release(settledAnswer);
    await asking;
    expect(store.getState().thread[0].status).toBe('done');
    expect(store.getState().thread[0].text).toBe('an answer');
    expect(endChatMock.mock.calls.slice(endChatCallsAfterClose)).toEqual([[firstChatId]]);
  });

  // Control for the test above, and it passes with or without the fix: the chat
  // ends at an open only when the open NAMES a project other than the one last
  // shown. Reopening on the same project, or on none (follow whatever is
  // current, as a detached window does), keeps the thread. It stops an
  // over-eager open from wiping the chat on every visit.
  it('keeps the chat when the graph is reopened on the same project, or on none', async () => {
    store.getState().open('A');
    resolveRead('A');
    await flush();
    answerFromGraphMock.mockResolvedValueOnce(settledAnswer);
    await store.getState().askQuestion('first question');
    store.getState().close();
    let endChatCallsAfterClose = endChatMock.mock.calls.length;

    store.getState().open('A');
    expect(store.getState().projectId).toBe('A');
    expect(store.getState().thread).toHaveLength(1);
    expect(endChatMock).toHaveBeenCalledTimes(endChatCallsAfterClose);
    resolveRead('A');
    await flush();
    expect(store.getState().thread).toHaveLength(1);

    store.getState().close();
    endChatCallsAfterClose = endChatMock.mock.calls.length;
    store.getState().open(null);
    expect(store.getState().projectId).toBe('A');
    expect(store.getState().thread).toHaveLength(1);
    expect(endChatMock).toHaveBeenCalledTimes(endChatCallsAfterClose);
    // "Whatever is current" reads the project last shown, and main answers with it.
    takePendingRead('A').resolve(makeSnapshot('A'));
    await flush();
    expect(store.getState().thread).toHaveLength(1);
    expect(store.getState().thread[0].question).toBe('first question');
    expect(endChatMock).toHaveBeenCalledTimes(endChatCallsAfterClose);
  });
});

describe('knowledge-graph-store loadSnapshot when the graph closes mid-read', () => {
  // Pins the `closeCount === closesAtStart` term on the `rebuildIfStale` call.
  // `close` clears what was asked so the next open asks for its own rebuild; a
  // read that was already in flight and lands afterwards must not ask for one
  // on behalf of a graph nobody has open.
  it('asks for no rebuild when the graph closed while the read was in flight', async () => {
    store.getState().open('A');
    // The open's read is in flight. It is for a stale map, so a read that is
    // allowed to ask for a rebuild would.
    expect(pendingReads).toHaveLength(1);
    store.getState().close();

    resolveRead('A', makeSnapshot('A', { stale: true }));
    await flush();

    // It did land (the store holds its map), and asked for nothing.
    expect(store.getState().snapshot?.stale).toBe(true);
    expect(store.getState().loading).toBe(false);
    expect(refreshGraphMock).not.toHaveBeenCalled();

    // Control, same map and same store: a read that starts and lands with no
    // close in between still asks for the rebuild, so the silence above is the
    // close and not a snapshot that never needed one.
    const reread = store.getState().loadSnapshot('A');
    resolveRead('A', makeSnapshot('A', { stale: true }));
    await reread;
    expect(refreshGraphMock).toHaveBeenCalledTimes(1);
    expect(refreshGraphMock).toHaveBeenCalledWith('A');
  });
});

describe('knowledge-graph-store loadScopeSnapshot when a read fails', () => {
  it('keeps the island already drawn when a push-triggered re-read rejects', async () => {
    const goodIsland = makeSnapshot('B');
    store.setState({ projectId: 'A', snapshot: makeSnapshot('A') });
    store.getState().setScope(['A', 'B']);
    resolveRead('B', goodIsland);
    await flush();
    expect(store.getState().scopeSnapshots.B).toBe(goodIsland);

    const reread = store.getState().loadScopeSnapshot('B', { fromPush: true });
    takePendingRead('B').reject(new Error('main is busy'));
    await reread;

    // A failed re-read must not blank an island that was fine a moment ago.
    expect(store.getState().scopeSnapshots.B).toBe(goodIsland);
  });

  it('records a project as empty when its first read rejects', async () => {
    store.setState({ projectId: 'A', snapshot: makeSnapshot('A') });
    store.getState().setScope(['A', 'B']);
    expect('B' in store.getState().scopeSnapshots).toBe(false);

    takePendingRead('B').reject(new Error('main is busy'));
    await flush();

    // A project with nothing yet is marked empty (null), not left as "loading".
    expect('B' in store.getState().scopeSnapshots).toBe(true);
    expect(store.getState().scopeSnapshots.B).toBeNull();
  });
});

describe('knowledge-graph-store map key: an unchanged map is not sent again', () => {
  const projection = { signature: 'sig-1', nodes: [], edges: [], clusterings: [] } as unknown as NonNullable<KnowledgeGraphSnapshot['projection']>;

  it('parses a map sent as JSON, keeps its key, and sends that key with the next read', async () => {
    const { projection: _unused, ...shell } = makeSnapshot('A');
    const first = store.getState().loadSnapshot('A');
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('A', null);
    takePendingRead('A').resolve({ ...shell, projectionKey: 'key-1', projectionJson: JSON.stringify(projection) } as unknown as KnowledgeGraphSnapshot);
    await first;
    expect(store.getState().snapshot?.projection).toEqual(projection);
    expect(store.getState().snapshot?.projectionKey).toBe('key-1');

    // Main answers the next read "unchanged": the held map stays, the same object.
    const held = store.getState().snapshot?.projection;
    const second = store.getState().loadSnapshot('A');
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('A', 'key-1');
    takePendingRead('A').resolve({ ...shell, stale: true, projectionKey: 'key-1', projectionUnchanged: true } as unknown as KnowledgeGraphSnapshot);
    await second;
    expect(store.getState().snapshot?.projection).toBe(held);
    // Everything around the map is this read's.
    expect(store.getState().snapshot?.stale).toBe(true);
  });

  it('reads again without a key when main says unchanged but nothing is held for it', async () => {
    const { projection: _unused, ...shell } = makeSnapshot('A');
    const read = store.getState().loadSnapshot('A');
    takePendingRead('A').resolve({ ...shell, projectionKey: 'key-9', projectionUnchanged: true } as unknown as KnowledgeGraphSnapshot);
    await flush();
    // The follow-up read sends no key, so main sends the map.
    expect(graphSnapshotMock).toHaveBeenCalledTimes(2);
    expect(graphSnapshotMock).toHaveBeenLastCalledWith('A', null);
    takePendingRead('A').resolve({ ...shell, projectionKey: 'key-9', projectionJson: JSON.stringify(projection) } as unknown as KnowledgeGraphSnapshot);
    await read;
    expect(store.getState().snapshot?.projection).toEqual(projection);
  });

  it('keeps a map sent whole (the mocks) as the same object', async () => {
    const whole = makeSnapshot('A', { projection });
    const read = store.getState().loadSnapshot('A');
    resolveRead('A', whole);
    await read;
    expect(store.getState().snapshot).toBe(whole);
  });
});
