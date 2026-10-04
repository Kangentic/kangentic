/**
 * A snapshot's Index panel counts the project's task summaries, and the
 * summary store is opened per project (`summariesFor`). When it cannot be
 * opened, the snapshot still has to come back: the rest of the Index panel
 * (corpora, storage, the store's own summary counts) is valid, and one
 * unreadable table must not blank the whole map.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      return 'chunks:10';
    }
    listIndexState(): unknown[] {
      return [];
    }
    documentChunkTotals(): unknown[] {
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
      return 'all:10';
    }
    corpusTotals(): unknown[] {
      return [
        { corpus: 'conversation', documents: 1, chunks: 4, embeddedChunks: 4 },
        { corpus: 'task', documents: 2, chunks: 3, embeddedChunks: 1 },
      ];
    }
    corpusTextBytes(): number {
      return 300;
    }
    countChunksNeedingEmbedding(): Map<string, number> {
      return new Map();
    }
    summaryCounts(): { written: number; finishedTasks: number } {
      return { written: 5, finishedTasks: 6 };
    }
  },
}));

import { createGraphService } from '../../src/main/retrieval/graph/graph-service';

const WRITTEN_WITH = [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', count: 4 }];

const workingSummaries = {
  fingerprint: () => 'summaries',
  all: () => new Map<string, { summary: string }>(),
  awaitingRewrite: () => 1,
  writtenWith: () => WRITTEN_WITH,
};

describe('graph service when a project\'s summary store cannot be obtained', () => {
  const openSummaries = vi.fn<(projectId: string) => typeof workingSummaries>();

  beforeEach(() => {
    openSummaries.mockReset();
  });

  // Red-green: graph-service.ts:429-435, `summarySourceFor`, wraps
  // `summariesFor(projectId)` in a try/catch that returns an empty source. Drop the
  // catch and the throw runs up through `indexSummaryFor` and `snapshotWithKey`,
  // neither of which catches, so `getSnapshotWire` throws and this test fails.
  // Return anything but 0 and [] from the fallback and the assertions fail.
  // `summarySourceFor` is the only caller of `summariesFor` on this path: region
  // names are off by default (`summaryNamesOn`), so `summaryKeyFor` never opens
  // the store, and the map is null, so no naming runs.
  it('still returns a snapshot, with no summaries awaiting a rewrite and none written with a choice', () => {
    openSummaries.mockImplementation(() => {
      throw new Error('no such table: memory_task_summaries');
    });
    const service = createGraphService({ getDb: () => ({}) as never, summaries: openSummaries });

    const wire = service.getSnapshotWire('project-a', 'model');

    expect(openSummaries).toHaveBeenCalledWith('project-a');
    // The store's own counts survive: only the summary store's figures fall back.
    expect(wire.index.summaries).toEqual({
      written: 5,
      finishedTasks: 6,
      awaitingRewrite: 0,
      writtenWith: [],
      skipped: 0,
      state: 'idle',
      retryInMs: null,
      choice: null,
    });
    // The rest of the Index panel is intact.
    expect(wire.index.corpora.map((entry) => entry.corpus)).toEqual(['conversation', 'task', 'change', 'commit', 'code']);
    expect(wire.index.corpora.find((entry) => entry.corpus === 'task')).toMatchObject({ chunks: 3 });
    expect(wire.index.storageBytes).toBe(300);
  });

  it('counts the summaries again on the next snapshot once the summary store opens', () => {
    openSummaries.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    openSummaries.mockImplementation(() => workingSummaries);
    const service = createGraphService({ getDb: () => ({}) as never, summaries: openSummaries });

    const first = service.getSnapshotWire('project-a', 'model');
    expect(first.index.summaries).toMatchObject({ awaitingRewrite: 0, writtenWith: [] });

    // The failure is not remembered: nothing about it is cached.
    const second = service.getSnapshotWire('project-a', 'model');
    expect(second.index.summaries).toMatchObject({ awaitingRewrite: 1, writtenWith: WRITTEN_WITH });
  });
});
