/**
 * retrievalService.getStatus - the Index card's per-source lines (`sources`).
 *
 * The lines are built from the project's corpus totals, which cost a full index
 * count and move only as documents are indexed, so `sourcesStatusFor` keeps them
 * for `SOURCE_TOTALS_TTL_MS` (30 s) per project instead of reading them on every
 * 1.5 s poll. What moves by the second, the passages still waiting to be
 * embedded, is read on every poll. The cache is keyed on time alone: nothing
 * invalidates it when the index changes, and the code comments say so.
 *
 * The scaffolding mirrors tests/unit/retrieval-service-status.test.ts (the real
 * module, the electron and native-module imports stubbed); the store is a stub
 * whose totals the test moves, so the cache is observed through what the status
 * says and through how often the totals were read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn((projectId: string) => ({ projectId })) }));
vi.mock('../../src/main/retrieval/vec-extension', () => ({
  lastVecLoadError: vi.fn(() => null),
  loadVecExtension: vi.fn(() => false),
}));
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
vi.mock('../../src/main/retrieval/retrieval-store', () => ({
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

const START = new Date('2026-09-29T12:00:00.000Z');

function makeContext(projectId: string, knowledgeGraph: { indexingEnabled?: boolean; enabled?: boolean } = { indexingEnabled: true, enabled: false }): IpcContext {
  return {
    configManager: { load: () => ({ knowledgeGraph }) },
    currentProjectId: projectId,
  } as unknown as IpcContext;
}

function setConversations(projectId: string, documents: number, chunks = documents): void {
  storeState.totalsByProject.set(projectId, [{ corpus: 'conversation', documents, chunks, embeddedChunks: chunks }]);
}

describe('retrievalService.getStatus source totals cache', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.clearAllMocks();
    storeState.totalsByProject.clear();
    storeState.waitingByCorpus.clear();
    storeState.corpusTotalsCalls.length = 0;
    storeState.waitingCalls = 0;
    embedEngineMock.chunksPerMinute = null;
    // The module keeps the cache at module scope with no reset hook, so each test
    // gets a fresh module instance.
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
  });

  it('serves the totals of the first read for the rest of the window, then reads them again', () => {
    const context = makeContext('proj-1');
    setConversations('proj-1', 3);
    expect(retrievalService.getStatus(context).sources?.conversations.count).toBe(3);

    // Documents arrive; a poll 29 s later still shows the count it took.
    setConversations('proj-1', 5);
    vi.advanceTimersByTime(29_000);
    expect(retrievalService.getStatus(context).sources?.conversations.count).toBe(3);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1']);

    // Past the window (31 s after the first read) the new count is read.
    vi.advanceTimersByTime(2_000);
    expect(retrievalService.getStatus(context).sources?.conversations.count).toBe(5);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('measures the window from the read, so polling inside it does not stretch it', () => {
    const context = makeContext('proj-1');
    setConversations('proj-1', 3);
    retrievalService.getStatus(context);

    vi.advanceTimersByTime(20_000);
    setConversations('proj-1', 5);
    // A poll at 20 s hits the cache. If it renewed the entry, the poll at 31 s
    // (11 s later) would hit it again and still show 3.
    expect(retrievalService.getStatus(context).sources?.conversations.count).toBe(3);
    vi.advanceTimersByTime(11_000);
    expect(retrievalService.getStatus(context).sources?.conversations.count).toBe(5);
  });

  it('keeps each project on its own entry', () => {
    setConversations('proj-1', 3);
    setConversations('proj-2', 8);

    expect(retrievalService.getStatus(makeContext('proj-1')).sources?.conversations.count).toBe(3);
    expect(retrievalService.getStatus(makeContext('proj-2')).sources?.conversations.count).toBe(8);
    expect(retrievalService.getStatus(makeContext('proj-1')).sources?.conversations.count).toBe(3);

    // One read each: the second project neither reused the first's totals nor evicted them.
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-2']);
  });

  it('reads what is still waiting on every poll, and never from the cache', () => {
    const context = makeContext('proj-1', { indexingEnabled: true, enabled: true });
    setConversations('proj-1', 2, 10);
    storeState.waitingByCorpus.set('conversation', 4);
    // Commits are kept as text only: whatever the store reports, they never wait.
    storeState.waitingByCorpus.set('commit', 7);
    const first = retrievalService.getStatus(context).sources;
    expect(first?.conversations).toEqual({ count: 2, percent: 60, minutesLeft: null });
    expect(first?.commits).toEqual({ count: 0, percent: null, minutesLeft: null });

    // No time passes: the totals are the cached ones, the waiting share is fresh.
    storeState.waitingByCorpus.set('conversation', 1);
    expect(retrievalService.getStatus(context).sources?.conversations).toEqual({ count: 2, percent: 90, minutesLeft: null });
    expect(storeState.waitingCalls).toBe(2);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1']);
  });

  it('holds the share honest when the kept totals trail a fresh index', () => {
    const context = makeContext('proj-1', { indexingEnabled: true, enabled: true });
    embedEngineMock.chunksPerMinute = 20;
    setConversations('proj-1', 1, 2);
    retrievalService.getStatus(context);

    // Eight passages now wait, more than the two the kept totals know of: the
    // share reads from zero, never negative, and the time left is the waiting count's.
    storeState.waitingByCorpus.set('conversation', 8);
    const conversations = retrievalService.getStatus(context).sources?.conversations;

    expect(conversations).toEqual({ count: 1, percent: 0, minutesLeft: 8 / 20 });
  });

  it('reads no totals while indexing is off', () => {
    setConversations('proj-1', 3);

    const status = retrievalService.getStatus(makeContext('proj-1', { indexingEnabled: false, enabled: false }));

    expect(status.sources).toBeUndefined();
    expect(storeState.corpusTotalsCalls).toEqual([]);
  });
});
