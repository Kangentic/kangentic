/**
 * The Index card's per-source lines (`sources` in the status), in two halves.
 *
 * The retrieval worker reads every indexed project (`worker/index-status.ts`):
 * the corpus totals cost a full index count and move only as documents are
 * indexed, so they are kept per project for at least `SOURCE_TOTALS_TTL_MS`
 * (30 s), plus a fixed per-project share of it so projects do not all fall due
 * on one poll, instead of read on every 1.5 s poll. What is still waiting to be
 * embedded is read on every poll. The cache is keyed on time alone: nothing
 * invalidates it when the index changes, and the code says so.
 *
 * Main sums the projects and composes the lines (`retrievalService.getStatus`):
 * the counts, the share embedded, and the time left at the embed engine's rate.
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
  waitingByProject: new Map<string, Map<string, number>>(),
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
    /** Its vector tables exist, so what waits is read. */
    readonly hasVec = true;
    corpusTotals(): CorpusTotalsRow[] {
      storeState.corpusTotalsCalls.push(this.projectId);
      return (storeState.totalsByProject.get(this.projectId) ?? []).map((row) => ({ ...row }));
    }
    countChunksNeedingEmbedding(): Map<string, number> {
      storeState.waitingCalls += 1;
      return new Map(storeState.waitingByProject.get(this.projectId) ?? []);
    }
    summaryCounts(): { written: number; finishedTasks: number } {
      return { written: 0, finishedTasks: 0 };
    }
  },
}));

// Main's call to the worker runs the worker's reader in process.
const readerHolder = vi.hoisted(() => ({ reader: null as null | { readAll: (getDb: (projectId: string) => unknown, params: unknown) => Promise<unknown> } }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: {
    unavailableReason: null,
    call: vi.fn(async (method: string, params: unknown) => {
      if (method !== 'status.indexAll' || !readerHolder.reader) throw new Error(`unexpected ${method}`);
      const status = await readerHolder.reader.readAll((projectId) => ({ projectId }), params);
      return { ...(status as object), vecError: null };
    }),
  },
}));

import { createIndexStatusReader, SOURCE_TOTALS_TTL_MS, totalsKeptMs, type IndexAllParams } from '../../src/main/retrieval/worker/index-status';
import { hasVecSupport } from '../../src/main/retrieval/vec-support';

const START = new Date('2026-09-29T12:00:00.000Z');

function params(projectIds: string[], semantic = false): IndexAllParams {
  return { projectIds, modelTag: 'bge@1', semantic, summaries: false };
}

function dbFor(projectId: string): Database.Database {
  return { projectId } as unknown as Database.Database;
}

/** A reader whose turns between projects cost nothing, so fake timers do not hold it. */
function reader() {
  return createIndexStatusReader(Date.now, async () => undefined);
}

function setConversations(projectId: string, documents: number, chunks = documents): void {
  storeState.totalsByProject.set(projectId, [{ corpus: 'conversation', documents, chunks, embeddedChunks: chunks }]);
}

async function conversationsOf(statusReader: ReturnType<typeof reader>, projectId: string, semantic = false) {
  const status = await statusReader.readAll(dbFor, params([projectId], semantic));
  return status.projects[0]?.corpora.find((entry) => entry.corpus === 'conversation');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.clearAllMocks();
  storeState.totalsByProject.clear();
  storeState.waitingByProject.clear();
  storeState.corpusTotalsCalls.length = 0;
  storeState.waitingCalls = 0;
  embedEngineMock.chunksPerMinute = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the worker\'s source totals cache', () => {
  it('keeps each project\'s totals for at least the TTL and less than twice it, by a share fixed per project', () => {
    for (const projectId of ['proj-1', 'proj-2', 'a much longer project id', '354ea0ee-5d2a-494e-b071-53d63bddeec3']) {
      expect(totalsKeptMs(projectId)).toBeGreaterThanOrEqual(SOURCE_TOTALS_TTL_MS);
      expect(totalsKeptMs(projectId)).toBeLessThan(2 * SOURCE_TOTALS_TTL_MS);
      expect(totalsKeptMs(projectId)).toBe(totalsKeptMs(projectId));
    }
    // Spread: projects read together on one poll do not all fall due on one later poll.
    const kept = new Set(Array.from({ length: 20 }, (_unused, index) => totalsKeptMs(`project-${index}`)));
    expect(kept.size).toBeGreaterThan(10);
  });

  it('serves the totals of the first read for the rest of the window, then reads them again', async () => {
    const statusReader = reader();
    setConversations('proj-1', 3);
    expect((await conversationsOf(statusReader, 'proj-1'))?.documents).toBe(3);

    setConversations('proj-1', 5);
    vi.advanceTimersByTime(totalsKeptMs('proj-1') - 1_000);
    expect((await conversationsOf(statusReader, 'proj-1'))?.documents).toBe(3);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1']);

    vi.advanceTimersByTime(2_000);
    expect((await conversationsOf(statusReader, 'proj-1'))?.documents).toBe(5);
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('keeps each project on its own entry, and forgets one when told', async () => {
    const statusReader = reader();
    setConversations('proj-1', 3);
    setConversations('proj-2', 8);
    await statusReader.readAll(dbFor, params(['proj-1', 'proj-2', 'proj-1']));
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-2']);

    statusReader.forget('proj-1');
    await statusReader.readAll(dbFor, params(['proj-1']));
    expect(storeState.corpusTotalsCalls).toEqual(['proj-1', 'proj-2', 'proj-1']);
  });

  it('reads what is still waiting on every poll while semantic search is on, and never from the cache', async () => {
    const statusReader = reader();
    setConversations('proj-1', 2, 10);
    storeState.waitingByProject.set('proj-1', new Map([['conversation', 4]]));
    await statusReader.readAll(dbFor, params(['proj-1'], true));
    storeState.waitingByProject.set('proj-1', new Map([['conversation', 1]]));
    expect((await conversationsOf(statusReader, 'proj-1', true))?.embeddedChunks).toBe(9);
    expect(storeState.waitingCalls).toBe(2);
    // Off, nothing is counted, and the totals stand.
    expect((await conversationsOf(statusReader, 'proj-1', false))?.embeddedChunks).toBe(10);
    expect(storeState.waitingCalls).toBe(2);
  });

  // The same id asked twice must not list the project twice: main sums the
  // projects it is given, so a second entry would count its documents again.
  // The totals cache holds `corpusTotalsCalls` to two reads whether or not the
  // ids are deduped, so the listed projects are what pins it.
  //
  // Red-green: `[...new Set(params.projectIds)]` in `readAll`. Without it the
  // projects read `proj-1, proj-2, proj-1`.
  it('lists a project once however many times it is asked for', async () => {
    const statusReader = reader();
    setConversations('proj-1', 3);
    setConversations('proj-2', 8);
    const status = await statusReader.readAll(dbFor, params(['proj-1', 'proj-2', 'proj-1']));
    expect(status.projects.map((project) => project.projectId)).toEqual(['proj-1', 'proj-2']);
  });

  it('leaves out a project with no conversations indexed, the set All projects leaves out', async () => {
    const statusReader = reader();
    setConversations('indexed', 3);
    storeState.totalsByProject.set('tasks-only', [{ corpus: 'task', documents: 4, chunks: 4, embeddedChunks: 4 }]);
    const status = await statusReader.readAll(dbFor, params(['tasks-only', 'indexed', 'never-swept']));
    expect(status.projects.map((project) => project.projectId)).toEqual(['indexed']);
    expect(status.hasVec).toBe(true);
  });

  // Vector support is a flag on each project's own connection. Semantic search
  // can run when any of them has it, wherever in the read that project comes: one
  // connection without it, read last, does not turn the whole read to keywords.
  //
  // Red-green: `hasVec = hasVec || hasVecSupport(db)` in `readAll`, as
  // `hasVec = hasVecSupport(db)`. The last project read then decides, and the
  // first case reads false.
  it('reports vector support when any project\'s connection has it, whichever is read last', async () => {
    setConversations('with-vec', 3);
    setConversations('without-vec', 2);
    vi.mocked(hasVecSupport).mockImplementation((db) => (db as unknown as { projectId: string }).projectId === 'with-vec');
    try {
      expect((await reader().readAll(dbFor, params(['with-vec', 'without-vec']))).hasVec).toBe(true);
      expect((await reader().readAll(dbFor, params(['without-vec', 'with-vec']))).hasVec).toBe(true);
      expect((await reader().readAll(dbFor, params(['without-vec']))).hasVec).toBe(false);
    } finally {
      vi.mocked(hasVecSupport).mockImplementation(() => true);
    }
  });

  it('leaves out a project that cannot be read, and reads the rest', async () => {
    const statusReader = reader();
    setConversations('healthy', 3);
    const getDb = (projectId: string) => {
      if (projectId === 'broken') throw new Error('unable to open database file');
      return dbFor(projectId);
    };
    const status = await statusReader.readAll(getDb, params(['broken', 'healthy']));
    expect(status.projects.map((project) => project.projectId)).toEqual(['healthy']);
  });
});

describe('main\'s source lines in the status', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  function makeContext(projectIds: string[], knowledgeGraph: { indexingEnabled?: boolean; enabled?: boolean }): IpcContext {
    const projects = projectIds.map((id) => ({ id, name: id, path: `/mock/${id}` }));
    return {
      configManager: { load: () => ({ knowledgeGraph }) },
      currentProjectId: projectIds[0] ?? null,
      projectRepo: { list: () => projects, getById: (id: string) => projects.find((project) => project.id === id) },
    } as unknown as IpcContext;
  }

  beforeEach(async () => {
    readerHolder.reader = reader();
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
  });

  it('shows the share embedded, and never waits on a keyword-only source', async () => {
    const context = makeContext(['proj-1'], { indexingEnabled: true, enabled: true });
    setConversations('proj-1', 2, 10);
    // Commits are kept as text only: whatever the store reports, they never wait.
    storeState.waitingByProject.set('proj-1', new Map([['conversation', 4], ['commit', 7]]));
    storeState.totalsByProject.get('proj-1')?.push({ corpus: 'commit', documents: 7, chunks: 7, embeddedChunks: 0 });
    const sources = (await retrievalService.getStatus(context)).sources;
    expect(sources?.conversations).toEqual({ count: 2, percent: 60, minutesLeft: null });
    expect(sources?.commits).toEqual({ count: 7, percent: null, minutesLeft: null });
  });

  // The share reads only where passages can be embedded: with semantic search on
  // and a vector table in the worker. Each case below has passages that wait by
  // the totals alone (6 of 10 embedded), so a line that dropped its gate would
  // read 60 whatever the worker counted.
  //
  // Red-green: `semanticOn && index !== null && index.hasVec` in `getStatus`'s sources line.
  // Without `semanticOn &&` the totals' 4 unembedded passages read as waiting
  // with semantic search off (the worker reads no waiting count then, so they are
  // the only source of it); without `index.hasVec` the 4 that wait read as 60%
  // while the worker reports no vector support.
  describe('the share embedded', () => {
    const WAITING_TOTALS = [{ corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 6 }];

    it('reads 60 with semantic search on and vectors available, and nothing with it off', async () => {
      storeState.totalsByProject.set('proj-1', WAITING_TOTALS.map((row) => ({ ...row })));
      storeState.waitingByProject.set('proj-1', new Map([['conversation', 4]]));

      const on = await retrievalService.getStatus(makeContext(['proj-1'], { indexingEnabled: true, enabled: true }));
      expect(on.sources?.conversations).toEqual({ count: 2, percent: 60, minutesLeft: null });

      // Indexing stays on: only semantic search is switched off.
      const off = await retrievalService.getStatus(makeContext(['proj-1'], { indexingEnabled: true, enabled: false }));
      expect(off.sources?.conversations).toEqual({ count: 2, percent: null, minutesLeft: null });
    });

    it('reads nothing while the worker reports no vector support', async () => {
      storeState.totalsByProject.set('proj-1', WAITING_TOTALS.map((row) => ({ ...row })));
      storeState.waitingByProject.set('proj-1', new Map([['conversation', 4]]));
      const context = makeContext(['proj-1'], { indexingEnabled: true, enabled: true });

      expect((await retrievalService.getStatus(context)).sources?.conversations).toEqual({ count: 2, percent: 60, minutesLeft: null });

      vi.mocked(hasVecSupport).mockReturnValue(false);
      try {
        const status = await retrievalService.getStatus(context);
        expect(status.semantic).toBe('lexical');
        expect(status.sources?.conversations).toEqual({ count: 2, percent: null, minutesLeft: null });
      } finally {
        vi.mocked(hasVecSupport).mockReturnValue(true);
      }
    });
  });

  it('holds the share honest when the kept totals trail a fresh index', async () => {
    const context = makeContext(['proj-1'], { indexingEnabled: true, enabled: true });
    embedEngineMock.chunksPerMinute = 20;
    setConversations('proj-1', 1, 2);
    await retrievalService.getStatus(context);
    // Eight passages now wait, more than the two the kept totals know of: the
    // share reads from zero, never negative, and the time left is the waiting count's.
    storeState.waitingByProject.set('proj-1', new Map([['conversation', 8]]));
    const conversations = (await retrievalService.getStatus(context)).sources?.conversations;
    expect(conversations).toEqual({ count: 1, percent: 0, minutesLeft: 8 / 20 });
  });

  // The card read the open project only, inside a System tab, while the map's
  // All projects panel summed every project, so the two disagreed. Red-green:
  // the old status read `currentProjectId` alone and counted 2 here.
  it('sums every indexed project, not only the open one, and shares the drain across them', async () => {
    const context = makeContext(['open', 'other', 'empty'], { indexingEnabled: true, enabled: true });
    embedEngineMock.chunksPerMinute = 10;
    setConversations('open', 2, 10);
    setConversations('other', 3, 30);
    storeState.waitingByProject.set('other', new Map([['conversation', 20]]));
    const conversations = (await retrievalService.getStatus(context)).sources?.conversations;
    // 20 of 40 passages wait: 50%, two minutes at ten a minute.
    expect(conversations).toEqual({ count: 5, percent: 50, minutesLeft: 2 });
    // The project with passages waiting is drained even though it is not open.
    expect(embedEngineMock.markDirty).toHaveBeenCalledWith('other');
  });

  it('reports with no project open, since the card sits in a System tab', async () => {
    const context = { ...makeContext(['proj-1'], { indexingEnabled: true, enabled: true }), currentProjectId: null } as unknown as IpcContext;
    setConversations('proj-1', 4);
    const status = await retrievalService.getStatus(context);
    expect(status.sources?.conversations).toEqual({ count: 4, percent: null, minutesLeft: null });
    expect(status.semantic).toBe('hybrid');
  });

  // A fresh install, or the Knowledge Graph just switched on: no project holds a
  // conversation yet. The lines still need values to say so.
  it('reports zeros, not nothing, while no project is indexed yet', async () => {
    const status = await retrievalService.getStatus(makeContext(['proj-empty'], { indexingEnabled: true, enabled: true }));
    expect(status.sources?.conversations).toEqual({ count: 0, percent: null, minutesLeft: null });
    expect(status.summaries).toMatchObject({ written: 0, finishedTasks: 0, state: 'idle' });
  });

  it('reads no totals while indexing is off', async () => {
    setConversations('proj-1', 3);
    const status = await retrievalService.getStatus(makeContext(['proj-1'], { indexingEnabled: false, enabled: false }));
    expect(status.sources).toBeUndefined();
    expect(storeState.corpusTotalsCalls).toEqual([]);
  });
});
