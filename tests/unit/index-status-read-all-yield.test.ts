/**
 * The status read yields an event-loop turn between projects, but only once a
 * slice of synchronous work has run for READ_SLICE_MS (8 ms), not once per
 * project (`readAll` in `worker/index-status.ts`).
 *
 * The slice clock is `performance.now`, which the reader does not take as a
 * parameter, so these tests spy on it. Every project read advances one fake
 * clock by a fixed step (inside `getDb`), so the numbers hold however many
 * times the code under test reads the clock. `yieldTurn` is the reader's
 * injected seam. The check runs after every project, the last one included, so
 * a read that ends past the threshold yields once before it returns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));

vi.mock('../../src/main/retrieval/retrieval-store', async (importOriginal) => ({
  // Its constants stay real, as in retrieval-service-source-totals.test.ts.
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-store')>()),
  RetrievalStore: class {
    /** Its vector tables exist, so what waits is read. */
    readonly hasVec = true;
    corpusTotals(): Array<{ corpus: string; documents: number; chunks: number; embeddedChunks: number }> {
      return [{ corpus: 'conversation', documents: 1, chunks: 1, embeddedChunks: 1 }];
    }
    countChunksNeedingEmbedding(): Map<string, number> {
      return new Map();
    }
    summaryCounts(): { written: number; finishedTasks: number } {
      return { written: 0, finishedTasks: 0 };
    }
  },
}));

import { createIndexStatusReader, READ_BUDGET_MS, type IndexAllParams } from '../../src/main/retrieval/worker/index-status';

/** The fake clock, in whole milliseconds, behind `performance.now`. */
let fakeNowMs = 0;
/** What happened, in order: each project read, and each yield's start and end. */
let events: string[] = [];

function params(projectIds: string[]): IndexAllParams {
  return { projectIds, modelTag: 'bge@1', semantic: false, summaries: false };
}

/**
 * A yield with a real async gap, so a dropped `await` shows up as the next
 * project's read landing between `yield:start` and `yield:end`.
 */
function makeYieldTurn() {
  return vi.fn(async () => {
    events.push('yield:start');
    await Promise.resolve();
    events.push('yield:end');
  });
}

/** Reads `projectIds` with every project's read costing `stepMs` on the clock. */
async function readWithStep(projectIds: string[], stepMs: number) {
  const yieldTurn = makeYieldTurn();
  const reader = createIndexStatusReader(Date.now, yieldTurn);
  const getDb = (projectId: string): Database.Database => {
    events.push(`read:${projectId}`);
    fakeNowMs += stepMs;
    return { projectId } as unknown as Database.Database;
  };
  const status = await reader.readAll(getDb, params(projectIds));
  return { status, yieldTurn };
}

beforeEach(() => {
  fakeNowMs = 0;
  events = [];
  vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the status read\'s yield between projects', () => {
  // Red-green: deleting the `if (performance.now() - sliceStartedAt >= READ_SLICE_MS)`
  // block in `readAll` leaves 0 yields here; changing `>=` to `>` also leaves 0,
  // because each project costs exactly the 8 ms threshold.
  it('yields a turn after each project when every read takes the whole 8 ms slice', async () => {
    const { status, yieldTurn } = await readWithStep(['proj-a', 'proj-b', 'proj-c'], 8);

    expect(yieldTurn).toHaveBeenCalledTimes(3);
    // Each yield starts and ends before the next project is read, and the last
    // project's yield runs before the read returns.
    expect(events).toEqual([
      'read:proj-a', 'yield:start', 'yield:end',
      'read:proj-b', 'yield:start', 'yield:end',
      'read:proj-c', 'yield:start', 'yield:end',
    ]);
    expect(status.projects.map((project) => project.projectId)).toEqual(['proj-a', 'proj-b', 'proj-c']);
  });

  // Red-green: yielding unconditionally after every project (the per-project
  // yield the READ_SLICE_MS comment rules out) makes this 3 yields, not 0.
  it('never yields when the whole read stays under the 8 ms slice', async () => {
    const { status, yieldTurn } = await readWithStep(['proj-a', 'proj-b', 'proj-c'], 2);

    // 2 + 2 + 2 = 6 ms in one slice.
    expect(yieldTurn).not.toHaveBeenCalled();
    expect(events).toEqual(['read:proj-a', 'read:proj-b', 'read:proj-c']);
    expect(status.projects.map((project) => project.projectId)).toEqual(['proj-a', 'proj-b', 'proj-c']);
  });

  // Red-green: deleting `sliceStartedAt = performance.now()` after the yield
  // makes proj-d (12 ms since the start of the read) yield again, so 2 yields,
  // not 1. The all-8 ms case above cannot catch that: every project is past the
  // threshold from the original start as well.
  it('yields once the slice adds up past 8 ms, then starts a fresh slice', async () => {
    const { yieldTurn } = await readWithStep(['proj-a', 'proj-b', 'proj-c', 'proj-d'], 3);

    // 3 ms, 6 ms, then 9 ms after proj-c: the first yield. The slice restarts
    // at 9 ms, so proj-d ends 3 ms into a new one and does not yield.
    expect(yieldTurn).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'read:proj-a', 'read:proj-b', 'read:proj-c', 'yield:start', 'yield:end', 'read:proj-d',
    ]);
  });
});

describe('the status read\'s budget', () => {
  // A read right after a worker restart opens every database cold and yields
  // a dozen times, and each yield can wait behind a background job's step. The
  // interactive call restarts the worker after 15 s, so the read stops reading
  // once READ_BUDGET_MS has passed, however many projects are left.
  //
  // Red-green: without the budget check all six projects are read on the first
  // call, and the first assertion fails.
  it('stops reading at the budget, serves no read for a project never reached, and reaches it first on the next poll', async () => {
    const stepMs = 600;
    const reader = createIndexStatusReader(Date.now, async () => undefined);
    const reads: string[] = [];
    const getDb = (projectId: string): Database.Database => {
      reads.push(projectId);
      fakeNowMs += stepMs;
      return { projectId } as unknown as Database.Database;
    };
    const projectIds = ['proj-a', 'proj-b', 'proj-c', 'proj-d', 'proj-e', 'proj-f'];

    const first = await reader.readAll(getDb, params(projectIds));
    // 0, 600, 1200 and 1800 ms are inside the 2 s budget; 2400 is not.
    expect(READ_BUDGET_MS).toBe(2_000);
    expect(reads).toEqual(['proj-a', 'proj-b', 'proj-c', 'proj-d']);
    expect(first.projects.map((project) => project.projectId)).toEqual(['proj-a', 'proj-b', 'proj-c', 'proj-d']);

    // The next poll starts with the two never read, then the stalest of the rest.
    reads.length = 0;
    const second = await reader.readAll(getDb, params(projectIds));
    expect(reads).toEqual(['proj-e', 'proj-f', 'proj-a', 'proj-b']);
    // Every project counts now: c and d as they last read, in the order asked.
    expect(second.projects.map((project) => project.projectId)).toEqual(projectIds);
  });

  // Red-green: `lastReads.delete(projectId)` in `forget`.
  // Without it b keeps the last read it had before the index was cleared. The
  // second read stops after c, so b is not reached, and b is served from that
  // stale read: the list is c, b, a and not c, a.
  it('forgets a project\'s last read with its totals, so a cleared index is not served from it', async () => {
    let clock = 0;
    let stepMs = 1_500;
    const reader = createIndexStatusReader(() => clock, async () => undefined);
    const getDb = (projectId: string): Database.Database => {
      fakeNowMs += stepMs;
      clock += 1;
      return { projectId } as unknown as Database.Database;
    };
    // Reads a and b (0 and 1500 ms), not c.
    await reader.readAll(getDb, params(['proj-a', 'proj-b', 'proj-c']));
    reader.forget('proj-b');
    // Each read now takes the whole budget, so the read stops after one project.
    // c and b have no last read (c never had one, b's was forgotten), so they
    // sort first, in the order asked: c is read and b is not reached. a is not
    // reached either, and is served from its last read.
    stepMs = READ_BUDGET_MS;
    const status = await reader.readAll(getDb, params(['proj-c', 'proj-b', 'proj-a']));
    // b is left out, as a project never read is, rather than served as it read
    // before it was forgotten.
    expect(status.projects.map((project) => project.projectId)).toEqual(['proj-c', 'proj-a']);
  });

  // Red-green: `lastReads.delete(projectId)` in the catch of `readAll`.
  // Without it a keeps its read from before the failure.
  // The third read stops after q, so a is not reached, and a is served from that
  // read: the list is q, a and not q.
  it('does not serve a project that stopped being readable from the read it had before', async () => {
    let clock = 0;
    let stepMs = 1;
    const unreadable = new Set<string>();
    const reader = createIndexStatusReader(() => clock, async () => undefined);
    const getDb = (projectId: string): Database.Database => {
      fakeNowMs += stepMs;
      clock += 1;
      if (unreadable.has(projectId)) throw new Error('unable to open database file');
      return { projectId } as unknown as Database.Database;
    };

    const readable = await reader.readAll(getDb, params(['proj-a']));
    expect(readable.projects.map((project) => project.projectId)).toEqual(['proj-a']);

    // The read that fails leaves a out, though a read of it succeeded a poll ago.
    unreadable.add('proj-a');
    const failing = await reader.readAll(getDb, params(['proj-a']));
    expect(failing.projects).toEqual([]);

    // A later read that stops before a. q has never been read, so it sorts
    // first and takes the whole budget. a must still read as left out.
    stepMs = READ_BUDGET_MS;
    const later = await reader.readAll(getDb, params(['proj-q', 'proj-a']));
    expect(later.projects.map((project) => project.projectId)).toEqual(['proj-q']);
  });
});
