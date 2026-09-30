/**
 * The Index card's per-source lines (`sources` in the status), in two halves.
 *
 * The retrieval worker reads them (`worker/index-status.ts`): the corpus
 * totals cost a full index count and move only as documents are indexed, so
 * they are kept for `SOURCE_TOTALS_TTL_MS` (30 s) per project instead of read on
 * every 1.5 s poll, while what is still waiting to be embedded is read on every
 * poll. The cache is keyed on time alone: nothing invalidates it when the index
 * changes, and the code says so.
 *
 * Main composes the lines (`retrievalService.getStatus`): the counts, the share
 * embedded, and the time left at the embed engine's rate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn((projectId: string) => ({ projectId })) }));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));
vi.mock('../../src/main/retrieval/conversation/conversation-indexer', () => ({
  ConversationIndexer: class {
    indexSession = vi.fn(async () => ({}));
  },
}));
vi.mock('../../src/main/retrieval/embedder/embedding-model', () => ({
  isEmbeddingModelPresent: vi.fn(() => true),
  downloadEmbeddingModel: vi.fn(async () => {}),
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
  chunksPerMinute: null as number | null,
}));
vi.mock('../../src/main/retrieval/embedder/embed-engine', () => ({
  embedEngine: embedEngineMock,
}));

interface CorpusTotalsRow {
  corpus: string;
  documents: number;
  chunks: number;
  embeddedChunks: number;
}

const storeState = vi.hoisted(() => ({
  totalsByProject: new Map<string, Array<{ corpus: string; documents: number; chunks: number; embeddedChunks: number }>>(),
  waitingByCorpus: new Map<string, number>(),
  corpusTotalsCalls: [] as string[],
  waitingCalls: 0,
}));
vi.mock('../../src/main/retrieval/retrieval-store', async (importOriginal) => ({
  // Its constants stay real (the code indexer reads one at import).
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-store')>()),
  RetrievalStore: class {
    private readonly projectId: string;
    constructor(db: { projectId: string }) {
      this.projectId = db.projectId;
    }
    corpusTotals(): CorpusTotalsRow[] {
      storeState.corpusTotalsCalls.push(this.projectId);
      return (storeState.totalsByProject.get(this.projectId) ?? []).map((row) => ({ ...row }));
    }
    countChunksNeedingEmbedding(): Map<string, number> {
      storeState.waitingCalls += 1;
      return new Map(storeState.waitingByCorpus);
    }
  },
}));

// Main's call to the worker runs the worker's reader in process.
const readerHolder = vi.hoisted(() => ({ reader: null as null | { read: (db: unknown, params: unknown) => unknown } }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: {
    unavailableReason: null,
    call: vi.fn(async (method: string, params: { projectId: string }) => {
      if (method !== 'status.index' || !readerHolder.reader) throw new Error(`unexpected ${method}`);
      return { ...(readerHolder.reader.read({ projectId: params.projectId }, params) as object), vecError: null };
    }),
  },
}));

import { createIndexStatusReader, SOURCE_TOTALS_TTL_MS, type IndexStatusParams } from '../../src/main/retrieval/worker/index-status';

const START = new Date('2026-09-29T12:00:00.000Z');

function params(projectId: string, semantic = false): IndexStatusParams {
  return { projectId, modelTag: 'bge@1', semantic, summaries: false, code: null, sources: true };
}

function dbFor(projectId: string): Database.Database {
  return { projectId } as unknown as Database.Database;
}

function setConversations(projectId: string, documents: number, chunks = documents): void {
  storeState.totalsByProject.set(projectId, [{ corpus: 'conversation', documents, chunks, embeddedChunks: chunks }]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.clearAllMocks();
  storeState.totalsByProject.clear();
  storeState.waitingByCorpus.clear();
  storeState.corpusTotalsCalls.length = 0;
  storeState.waitingCalls = 0;
  embedEngineMock.chunksPerMinute = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the worker\'s source totals cache', () => {
  it('serves the totals of the first read for the rest of the window, then reads them again', () => {
    const reader = createIndexStatusReader();
    setConversations('proj-1', 3);
    expect(reader.read(dbFor('proj-1'), params('proj-1')).sources?.totals[0].documents).toBe(3);

    setConversations('proj-1', 5);
    vi.advanceTimersByTime(SOURCE_TOTALS_TTL_MS - 1_000);
    expect(reader.read(dbFor('proj-1'), params('proj-1')).sources?.totals[0].documents).toBe(3);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1']);

    vi.advanceTimersByTime(2_000);
    expect(reader.read(dbFor('proj-1'), params('proj-1')).sources?.totals[0].documents).toBe(5);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('measures the window from the read, so polling inside it does not stretch it', () => {
    const reader = createIndexStatusReader();
    setConversations('proj-1', 3);
    reader.read(dbFor('proj-1'), params('proj-1'));
    vi.advanceTimersByTime(20_000);
    setConversations('proj-1', 5);
    expect(reader.read(dbFor('proj-1'), params('proj-1')).sources?.totals[0].documents).toBe(3);
    vi.advanceTimersByTime(11_000);
    expect(reader.read(dbFor('proj-1'), params('proj-1')).sources?.totals[0].documents).toBe(5);
  });

  it('keeps each project on its own entry, and forgets one when told', () => {
    const reader = createIndexStatusReader();
    setConversations('proj-1', 3);
    setConversations('proj-2', 8);
    reader.read(dbFor('proj-1'), params('proj-1'));
    reader.read(dbFor('proj-2'), params('proj-2'));
    reader.read(dbFor('proj-1'), params('proj-1'));
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-2']);

    reader.forget('proj-1');
    reader.read(dbFor('proj-1'), params('proj-1'));
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-2', 'proj-1']);
  });

  it('reads what is still waiting on every poll while semantic search is on, and never from the cache', () => {
    const reader = createIndexStatusReader();
    setConversations('proj-1', 2, 10);
    storeState.waitingByCorpus.set('conversation', 4);
    reader.read(dbFor('proj-1'), params('proj-1', true));
    storeState.waitingByCorpus.set('conversation', 1);
    expect(reader.read(dbFor('proj-1'), params('proj-1', true)).sources?.waitingByCorpus.get('conversation')).toBe(1);
    expect(storeState.waitingCalls).toBe(2);
    // Off, nothing waits and nothing is counted.
    expect(reader.read(dbFor('proj-1'), params('proj-1', false)).sources?.waitingByCorpus.size).toBe(0);
    expect(storeState.waitingCalls).toBe(2);
  });
});

describe('main\'s source lines in the status', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  function makeContext(projectId: string, knowledgeGraph: { indexingEnabled?: boolean; enabled?: boolean }): IpcContext {
    return {
      configManager: { load: () => ({ knowledgeGraph }) },
      currentProjectId: projectId,
    } as unknown as IpcContext;
  }

  beforeEach(async () => {
    readerHolder.reader = createIndexStatusReader();
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
  });

  it('shows the share embedded, and never waits on a keyword-only source', async () => {
    const context = makeContext('proj-1', { indexingEnabled: true, enabled: true });
    setConversations('proj-1', 2, 10);
    storeState.waitingByCorpus.set('conversation', 4);
    // Commits are kept as text only: whatever the store reports, they never wait.
    storeState.waitingByCorpus.set('commit', 7);
    const sources = (await retrievalService.getStatus(context)).sources;
    expect(sources?.conversations).toEqual({ count: 2, percent: 60, minutesLeft: null });
    expect(sources?.commits).toEqual({ count: 0, percent: null, minutesLeft: null });
  });

  it('holds the share honest when the kept totals trail a fresh index', async () => {
    const context = makeContext('proj-1', { indexingEnabled: true, enabled: true });
    embedEngineMock.chunksPerMinute = 20;
    setConversations('proj-1', 1, 2);
    await retrievalService.getStatus(context);
    // Eight passages now wait, more than the two the kept totals know of: the
    // share reads from zero, never negative, and the time left is the waiting count's.
    storeState.waitingByCorpus.set('conversation', 8);
    const conversations = (await retrievalService.getStatus(context)).sources?.conversations;
    expect(conversations).toEqual({ count: 1, percent: 0, minutesLeft: 8 / 20 });
  });

  it('reads no totals while indexing is off', async () => {
    setConversations('proj-1', 3);
    const status = await retrievalService.getStatus(makeContext('proj-1', { indexingEnabled: false, enabled: false }));
    expect(status.sources).toBeUndefined();
    expect(storeState.corpusTotalsCalls).toEqual([]);
  });
});
