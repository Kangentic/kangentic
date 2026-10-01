/**
 * `markDirty` schedules one paced background pass per project, and a project
 * with a pass in flight reports `building`.
 *
 * The pass used to clear its own `running` entry from a `finally` inside the
 * async function. A pass that exits before its first await (no vec extension)
 * ran that cleanup synchronously, BEFORE `running.set`, so the entry it meant
 * to remove was not there yet, and the entry set a moment later was never
 * cleared. The project then read as building forever and every later
 * `markDirty` was refused. Cleanup now hangs off the pass's promise after the
 * entry is set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeState = {
  hasVec: true,
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
    get hasVec(): boolean {
      return storeState.hasVec;
    }
    coverageFingerprint(): string {
      return 'chunks:0';
    }
    listIndexState(): unknown[] {
      return [];
    }
    documentChunkTotals(): unknown[] {
      return [];
    }
    knownConversationDocIds(): string[] {
      return [];
    }
    storedEmbeddingSignature(): null {
      return null;
    }
    maxChunkId(): number {
      return 0;
    }
    corpusFingerprint(): string {
      return 'all:0';
    }
    corpusTotals(): unknown[] {
      return [];
    }
    corpusTextBytes(): number {
      return 0;
    }
    summaryCounts(): { written: number; finishedTasks: number } {
      return { written: 0, finishedTasks: 0 };
    }
    lastIndexedAt(): null {
      return null;
    }
  },
}));

import { runProjectionPass } from '../../src/main/retrieval/graph/projection-engine';
import { createGraphService } from '../../src/main/retrieval/graph/graph-service';

const mockRunProjectionPass = vi.mocked(runProjectionPass);

/** One turn of the event loop: every promise reaction already queued has run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeService() {
  return createGraphService({ getDb: () => ({}) as never });
}

describe('graph service markDirty', () => {
  beforeEach(() => {
    storeState.hasVec = true;
    mockRunProjectionPass.mockReset();
  });

  it('does not leave a project building when its pass exits before the first await', async () => {
    storeState.hasVec = false;
    const service = makeService();

    service.markDirty('project-a', 'model', 4);
    await settle();

    // No sqlite-vec, so the pass returned at once and nothing is running.
    expect(mockRunProjectionPass).not.toHaveBeenCalled();
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);
  });

  it('starts a new pass on a later markDirty after an early exit, rather than refusing it forever', async () => {
    storeState.hasVec = false;
    const service = makeService();
    service.markDirty('project-a', 'model', 4);
    await settle();

    // The extension loads later (or the store opens on a retry).
    storeState.hasVec = true;
    service.markDirty('project-a', 'model', 4);
    await settle();

    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);
  });

  it('reports building while a pass runs, refuses a second, and accepts one after it settles', async () => {
    let finishPass: (value: undefined) => void = () => undefined;
    mockRunProjectionPass.mockImplementationOnce(() => new Promise((resolve) => {
      finishPass = resolve as (value: undefined) => void;
    }));
    const service = makeService();

    service.markDirty('project-a', 'model', 4);
    await settle();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(true);

    // One pass at a time per project.
    service.markDirty('project-a', 'model', 4);
    await settle();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);

    finishPass(undefined);
    await settle();
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);

    service.markDirty('project-a', 'model', 4);
    await settle();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);
  });

  it('keeps each project on its own pass', async () => {
    let finishPass: (value: undefined) => void = () => undefined;
    mockRunProjectionPass.mockImplementationOnce(() => new Promise((resolve) => {
      finishPass = resolve as (value: undefined) => void;
    }));
    const service = makeService();

    service.markDirty('project-a', 'model', 4);
    await settle();

    expect(service.getSnapshotWire('project-a', 'model').building).toBe(true);
    expect(service.getSnapshotWire('project-b', 'model').building).toBe(false);

    finishPass(undefined);
    await settle();
  });
});
