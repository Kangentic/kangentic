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
    digestCounts(): { written: number; finishedTasks: number } {
      return { written: 5, finishedTasks: 6 };
    }
    lastIndexedAt(): string {
      return '2026-09-28T10:00:00.000Z';
    }
  },
}));

import { createGraphService } from '../../src/main/retrieval/graph/graph-service';

describe('graph service coverage cache', () => {
  beforeEach(() => {
    storeState.fingerprint = 'chunks:10';
    storeState.chunkTotalsCalls = 0;
    storeState.corpusFingerprint = 'all:10';
    storeState.corpusTotalsCalls = 0;
  });

  it('reads coverage once while the index is unchanged', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const first = service.getSnapshot('project-a', 'model');
    const second = service.getSnapshot('project-a', 'model');
    expect(storeState.chunkTotalsCalls).toBe(1);
    expect(second.coverage).toBe(first.coverage);
  });

  it('recomputes coverage when the fingerprint moves', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    service.getSnapshot('project-a', 'model');
    storeState.fingerprint = 'chunks:11';
    service.getSnapshot('project-a', 'model');
    expect(storeState.chunkTotalsCalls).toBe(2);
  });

  it('keeps each project on its own cache entry', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    service.getSnapshot('project-a', 'model');
    service.getSnapshot('project-b', 'model');
    service.getSnapshot('project-a', 'model');
    expect(storeState.chunkTotalsCalls).toBe(2);
  });

  it('reads the projection alone without touching coverage', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    expect(service.getProjection('project-a')).toBeNull();
    expect(storeState.chunkTotalsCalls).toBe(0);
  });

  it('reports every corpus, a missing one as zeros, and keeps the totals until the store moves', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const first = service.getSnapshot('project-a', 'model');
    expect(first.index.corpora).toEqual([
      { corpus: 'conversation', documents: 1, chunks: 4, embeddedChunks: 4, embeds: true },
      { corpus: 'task', documents: 2, chunks: 3, embeddedChunks: 1, embeds: true },
      // Kept as text only, so it has no embedded share to report.
      { corpus: 'change', documents: 0, chunks: 0, embeddedChunks: 0, embeds: false },
    ]);
    // No projection yet and no stored width: the size is the other corpora's text.
    expect(first.index.storageBytes).toBe(300);

    service.getSnapshot('project-a', 'model');
    expect(storeState.corpusTotalsCalls).toBe(1);
    storeState.corpusFingerprint = 'all:11';
    service.getSnapshot('project-a', 'model');
    expect(storeState.corpusTotalsCalls).toBe(2);
    // The corpus totals and conversation coverage are cached apart: a task
    // record moving the store does not recompute coverage.
    expect(storeState.chunkTotalsCalls).toBe(1);
  });

  it('says when the index last changed, and how many digests the scheduler passed over', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    expect(service.getSnapshot('project-a', 'model').index.digests).toEqual({ written: 5, finishedTasks: 6, skipped: 0 });
    service.setDigestsSkipped((projectId) => (projectId === 'project-a' ? 1 : 0));
    const snapshot = service.getSnapshot('project-a', 'model');
    expect(snapshot.index.digests).toEqual({ written: 5, finishedTasks: 6, skipped: 1 });
    expect(snapshot.index.lastIndexedAt).toBe('2026-09-28T10:00:00.000Z');
  });
});
