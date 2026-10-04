/**
 * The graph service computes a project's coverage once per index state.
 *
 * Coverage groups every chunk in the index (about 285 ms on a large project,
 * on main), and it was recomputed on every graph open and every refresh push.
 * The cache keys on `coverageFingerprint()`, so an unchanged index serves the
 * cached summary and a changed one recomputes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeState = {
  fingerprint: 'chunks:10',
  chunkTotalsCalls: 0,
  corpusFingerprint: 'all:10',
  corpusTotalsCalls: 0,
  /** Passages without the selected model's vector, by corpus. */
  waiting: new Map<string, number>([['task', 2]]),
  waitingModelTags: [] as string[],
};

vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));

vi.mock('../../src/main/retrieval/graph/projection-engine', () => ({
  runProjectionPass: vi.fn(),
  readCachedProjection: () => null,
  writeProjectionCache: vi.fn(),
  isProjectionFresh: () => false,
}));

vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    readonly hasVec = true;
    coverageFingerprint(): string {
      return storeState.fingerprint;
    }
    listIndexState(): unknown[] {
      return [];
    }
    documentChunkTotals(): unknown[] {
      storeState.chunkTotalsCalls += 1;
      return [{ corpus: 'conversation', docId: 'doc-1', chunkCount: 4, embeddedCount: 4 }];
    }
    knownConversationDocIds(): string[] {
      return ['doc-1'];
    }
    storedEmbeddingSignature(): null {
      return null;
    }
    maxChunkId(): number {
      return 4;
    }
    corpusFingerprint(): string {
      return storeState.corpusFingerprint;
    }
    corpusTotals(): unknown[] {
      storeState.corpusTotalsCalls += 1;
      return [
        { corpus: 'conversation', documents: 1, chunks: 4, embeddedChunks: 4 },
        { corpus: 'task', documents: 2, chunks: 3, embeddedChunks: 1 },
      ];
    }
    corpusTextBytes(): number {
      return 300;
    }
    countChunksNeedingEmbedding(modelTag: string): Map<string, number> {
      storeState.waitingModelTags.push(modelTag);
      return new Map(storeState.waiting);
    }
    summaryCounts(): { written: number; finishedTasks: number } {
      return { written: 5, finishedTasks: 6 };
    }
  },
}));

const summaryStore = {
  fingerprint: () => 'summaries',
  all: () => new Map<string, { summary: string }>(),
  awaitingRewrite: () => 1,
  writtenWith: () => [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', count: 4 }],
};

import { createGraphService } from '../../src/main/retrieval/graph/graph-service';

describe('graph service coverage cache', () => {
  beforeEach(() => {
    storeState.fingerprint = 'chunks:10';
    storeState.chunkTotalsCalls = 0;
    storeState.corpusFingerprint = 'all:10';
    storeState.corpusTotalsCalls = 0;
    storeState.waiting = new Map([['task', 2]]);
    storeState.waitingModelTags = [];
  });

  it('reads coverage once while the index is unchanged', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const first = service.getSnapshotWire('project-a', 'model');
    const second = service.getSnapshotWire('project-a', 'model');
    expect(storeState.chunkTotalsCalls).toBe(1);
    expect(second.coverage).toBe(first.coverage);
  });

  it('recomputes coverage when the fingerprint moves', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    service.getSnapshotWire('project-a', 'model');
    storeState.fingerprint = 'chunks:11';
    service.getSnapshotWire('project-a', 'model');
    expect(storeState.chunkTotalsCalls).toBe(2);
  });

  it('keeps each project on its own cache entry', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    service.getSnapshotWire('project-a', 'model');
    service.getSnapshotWire('project-b', 'model');
    service.getSnapshotWire('project-a', 'model');
    expect(storeState.chunkTotalsCalls).toBe(2);
  });

  it('reads the projection alone without touching coverage', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    expect(service.getProjection('project-a')).toBeNull();
    expect(storeState.chunkTotalsCalls).toBe(0);
  });

  it('reports every corpus, a missing one as zeros, and keeps the totals until the store moves', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const first = service.getSnapshotWire('project-a', 'model');
    expect(first.index.corpora).toEqual([
      { corpus: 'conversation', documents: 1, chunks: 4, embeddedChunks: 4, embeds: true },
      { corpus: 'task', documents: 2, chunks: 3, embeddedChunks: 1, embeds: true },
      // Kept as text only, so they have no embedded share to report.
      { corpus: 'change', documents: 0, chunks: 0, embeddedChunks: 0, embeds: false },
      { corpus: 'commit', documents: 0, chunks: 0, embeddedChunks: 0, embeds: false },
      // Embedded while its switch is on: its row carries an embedded share.
      { corpus: 'code', documents: 0, chunks: 0, embeddedChunks: 0, embeds: true },
    ]);
    // No projection yet and no stored width: the size is the other corpora's text.
    expect(first.index.storageBytes).toBe(300);

    service.getSnapshotWire('project-a', 'model');
    expect(storeState.corpusTotalsCalls).toBe(1);
    storeState.corpusFingerprint = 'all:11';
    service.getSnapshotWire('project-a', 'model');
    expect(storeState.corpusTotalsCalls).toBe(2);
    // The corpus totals and conversation coverage are cached apart: a task
    // record moving the store does not recompute coverage.
    expect(storeState.chunkTotalsCalls).toBe(1);
  });

  it('lets go of a project\'s cached coverage and totals when the project is forgotten', () => {
    // `forget` is what `project.close` calls before main deletes the project's
    // files. Red-green: without it both caches kept the closed project's
    // entries for the worker's lifetime, so the read after it served them.
    const service = createGraphService({ getDb: () => ({}) as never });
    service.getSnapshotWire('project-a', 'model');
    service.getSnapshotWire('project-b', 'model');
    expect(storeState.chunkTotalsCalls).toBe(2);
    expect(storeState.corpusTotalsCalls).toBe(2);

    service.forget('project-a');
    service.getSnapshotWire('project-a', 'model');
    service.getSnapshotWire('project-b', 'model');
    // Only the forgotten project read again.
    expect(storeState.chunkTotalsCalls).toBe(3);
    expect(storeState.corpusTotalsCalls).toBe(3);
  });

  it('counts the summaries as the Settings card does, and leaves what the scheduler is doing to main', () => {
    const service = createGraphService({ getDb: () => ({}) as never, summaries: () => summaryStore });
    expect(service.getSnapshotWire('project-a', 'model').index.summaries).toEqual({
      written: 5,
      finishedTasks: 6,
      awaitingRewrite: 1,
      writtenWith: [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', count: 4 }],
      // Main's scheduler runs the passes, and `graph-facade` adds these.
      skipped: 0,
      state: 'idle',
      retryInMs: null,
      choice: null,
    });
  });

  // The map's panel counted any model's vector as embedded while the Settings
  // card counted only the selected model's, so after a model change the two
  // disagreed. Both read `index-counts.ts` now.
  it('counts only the selected model\'s vectors as embedded, read on every snapshot', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    storeState.waiting = new Map([['task', 3], ['conversation', 1]]);
    const first = service.getSnapshotWire('project-a', 'bge@2').index.corpora;
    expect(first.find((entry) => entry.corpus === 'conversation')).toMatchObject({ chunks: 4, embeddedChunks: 3 });
    expect(first.find((entry) => entry.corpus === 'task')).toMatchObject({ chunks: 3, embeddedChunks: 0 });
    expect(storeState.waitingModelTags).toEqual(['bge@2']);
    // The totals stay cached; what waits moves as the drain works.
    storeState.waiting = new Map();
    const second = service.getSnapshotWire('project-a', 'bge@2').index.corpora;
    expect(second.find((entry) => entry.corpus === 'task')).toMatchObject({ chunks: 3, embeddedChunks: 3 });
    expect(storeState.corpusTotalsCalls).toBe(1);
  });
});
