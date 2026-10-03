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

const storeState: {
  hasVec: boolean;
  cachedProjection: object | null;
  /** The cached map cannot be read. */
  readCachedThrows: boolean;
  /** The stored embedding signature cannot be read. */
  signatureThrows: boolean;
} = {
  hasVec: true,
  /** A map already built: a pass is then a refresh, not a first build. */
  cachedProjection: null,
  readCachedThrows: false,
  signatureThrows: false,
};

function resetStoreState(): void {
  storeState.hasVec = true;
  storeState.cachedProjection = null;
  storeState.readCachedThrows = false;
  storeState.signatureThrows = false;
}

vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));

vi.mock('../../src/main/retrieval/graph/projection-engine', () => ({
  runProjectionPass: vi.fn(),
  readCachedProjection: () => {
    if (storeState.readCachedThrows) throw new Error('cache unreadable');
    return storeState.cachedProjection;
  },
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
      if (storeState.signatureThrows) throw new Error('signature unreadable');
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
  },
}));

import { runProjectionPass, type ProjectionProgress } from '../../src/main/retrieval/graph/projection-engine';
import { buildPercent, createGraphService } from '../../src/main/retrieval/graph/graph-service';
import type { KnowledgeGraphBuildProgress } from '../../src/shared/types';

const mockRunProjectionPass = vi.mocked(runProjectionPass);

/** One turn of the event loop: every promise reaction already queued has run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeService() {
  return createGraphService({ getDb: () => ({}) as never });
}

describe('graph service markDirty', () => {
  beforeEach(() => {
    resetStoreState();
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

  // `forget` aborts a pass in flight, and lets go of it then rather than when
  // the aborted pass unwinds: until then the project read as building and a
  // markDirty for it was dropped. The old pass's own cleanup must not remove
  // the new pass's entry when it finally settles.
  //
  // Red-green: drop `running.delete(projectId)` from `forget` and the second
  // markDirty is refused, so `runProjectionPass` is called once, not twice.
  it('lets a forgotten project start a new pass at once, and the old pass\'s cleanup leaves the new one running', async () => {
    let finishFirstPass: (value: undefined) => void = () => undefined;
    let finishSecondPass: (value: undefined) => void = () => undefined;
    mockRunProjectionPass
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirstPass = resolve as (value: undefined) => void;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishSecondPass = resolve as (value: undefined) => void;
      }));
    const service = makeService();

    service.markDirty('project-a', 'model', 4);
    await settle();
    service.forget('project-a');
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);

    service.markDirty('project-a', 'model', 4);
    await settle();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);

    // The aborted first pass settles; the second is still the one running.
    finishFirstPass(undefined);
    await settle();
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(true);

    finishSecondPass(undefined);
    await settle();
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);
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

/**
 * A first build's progress: in the snapshot, in `markDirty`'s answer, and
 * pushed throttled. The renderer paints the building card from the answer, so
 * a first build never shows "No map yet" while it waits for a push.
 */
describe('graph service first build progress', () => {
  beforeEach(() => {
    resetStoreState();
    mockRunProjectionPass.mockReset();
    vi.useRealTimers();
  });

  const neverSettles = () => new Promise<null>(() => undefined);

  it('maps a stage and its share to one percent that never reads 100', () => {
    expect(buildPercent('reading', 0)).toBe(0);
    expect(buildPercent('reading', 0.5)).toBe(47);
    expect(buildPercent('reading', 1)).toBe(95);
    expect(buildPercent('placing', 0)).toBe(95);
    expect(buildPercent('placing', 1)).toBe(98);
    expect(buildPercent('naming', 1)).toBe(99);
    expect(buildPercent('reading', 7)).toBe(95);
  });

  it('answers a first build with its progress, shows it in the snapshot, and pushes it', () => {
    mockRunProjectionPass.mockImplementationOnce(neverSettles);
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const service = createGraphService({ getDb: () => ({}) as never, onBuildProgress: (_projectId, progress) => pushes.push(progress) });

    const answer = service.markDirty('project-a', 'model', 4);

    expect(answer).toMatchObject({ stage: 'reading', percent: 0 });
    expect(service.getSnapshotWire('project-a', 'model').buildProgress).toEqual(answer);
    expect(pushes).toEqual([answer]);
    // A second ask while it runs answers with the same build's figure.
    expect(service.markDirty('project-a', 'model', 4)).toEqual(answer);
  });

  // Red-green: drop the `entry.progressTimer` throttle in `setProgress` and every
  // figure is pushed, so the pushes read [0, 47, 57] instead of [0, 57].
  it('pushes at most every 250 ms within a stage, the latest figure last, and a new stage at once', () => {
    vi.useFakeTimers();
    let report: ((progress: ProjectionProgress) => void) | undefined;
    mockRunProjectionPass.mockImplementationOnce((deps) => {
      report = deps.onProgress;
      return neverSettles();
    });
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onBuildProgress: (_projectId, progress) => pushes.push(progress),
      now: () => Date.now(),
    });

    service.markDirty('project-a', 'model', 4);
    report!({ stage: 'reading', fraction: 0.5 });
    report!({ stage: 'reading', fraction: 0.6 });
    expect(pushes.map((progress) => progress.percent)).toEqual([0]);
    // The snapshot is not throttled: a read always gets the latest figure.
    expect(service.getSnapshotWire('project-a', 'model').buildProgress?.percent).toBe(57);

    vi.advanceTimersByTime(250);
    expect(pushes.map((progress) => progress.percent)).toEqual([0, 57]);

    report!({ stage: 'placing', fraction: 0 });
    expect(pushes.at(-1)).toMatchObject({ stage: 'placing', percent: 95 });
    vi.useRealTimers();
  });

  it('shows naming before the region names, and drops the figure when the pass ends', async () => {
    mockRunProjectionPass.mockResolvedValueOnce({
      projection: {} as never,
      counts: { documents: 1, documentsRead: 1, vectorsRead: 1 },
    });
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const changed: string[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onBuildProgress: (_projectId, progress) => pushes.push(progress),
      onChanged: (projectId) => changed.push(projectId),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    await settle();
    log.mockRestore();

    expect(pushes.at(-1)).toMatchObject({ stage: 'naming', percent: 99 });
    expect(changed).toEqual(['project-a']);
    const snapshot = service.getSnapshotWire('project-a', 'model');
    expect(snapshot.building).toBe(false);
    expect(snapshot.buildProgress).toBeNull();
  });

  it('reports nothing for a refresh, which leaves the old map on screen', () => {
    storeState.cachedProjection = {};
    let report: ((progress: ProjectionProgress) => void) | undefined;
    mockRunProjectionPass.mockImplementationOnce((deps) => {
      report = deps.onProgress;
      return neverSettles();
    });
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const service = createGraphService({ getDb: () => ({}) as never, onBuildProgress: (_projectId, progress) => pushes.push(progress) });

    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    report!({ stage: 'reading', fraction: 0.5 });
    expect(pushes).toEqual([]);
  });

  // Red-green: drop the `firstBuildFailedAt` check in `markDirty` and the second
  // ask starts a pass at once, so `runProjectionPass` is called twice.
  it('tells readers a failed first build ended, and holds off another for a minute', async () => {
    let clock = 1_000_000;
    mockRunProjectionPass.mockRejectedValueOnce(new Error('pass failed')).mockImplementation(neverSettles);
    const changed: string[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onChanged: (projectId) => changed.push(projectId),
      now: () => clock,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    await settle();
    error.mockRestore();
    expect(changed).toEqual(['project-a']);
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);

    clock += 1_000;
    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);

    clock += 60_000;
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);
  });

  it('pushes nothing for a first build that forget aborted', async () => {
    let report: ((progress: ProjectionProgress) => void) | undefined;
    let finishPass: (value: null) => void = () => undefined;
    mockRunProjectionPass.mockImplementationOnce((deps) => {
      report = deps.onProgress;
      return new Promise<null>((resolve) => { finishPass = resolve; });
    });
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const changed: string[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onBuildProgress: (_projectId, progress) => pushes.push(progress),
      onChanged: (projectId) => changed.push(projectId),
    });

    service.markDirty('project-a', 'model', 4);
    service.forget('project-a');
    report!({ stage: 'placing', fraction: 0.5 });
    finishPass(null);
    await settle();

    expect(pushes).toHaveLength(1);
    expect(changed).toEqual([]);
  });

  it('gives each pass an id a restarted worker cannot reuse', () => {
    mockRunProjectionPass.mockImplementation(neverSettles);
    const first = createGraphService({ getDb: () => ({}) as never, now: () => 1_000 }).markDirty('project-a', 'model', 4);
    const restarted = createGraphService({ getDb: () => ({}) as never, now: () => 2_000 }).markDirty('project-a', 'model', 4);
    expect(restarted!.pass).toBeGreaterThan(first!.pass);
  });

  // The throttle's other exit: with no timer pending and the last push over the
  // interval old, a figure that holds its stage is pushed on the spot.
  //
  // Red-green: drop the `waitMs === 0` branch in `createProgressReporter` and the
  // figure waits on a zero-delay timer, so the pushes read [0] and one timer is
  // pending.
  it('pushes a same-stage figure at once when the last push is over 250 ms old', () => {
    vi.useFakeTimers();
    let report: ((progress: ProjectionProgress) => void) | undefined;
    mockRunProjectionPass.mockImplementationOnce((deps) => {
      report = deps.onProgress;
      return neverSettles();
    });
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onBuildProgress: (_projectId, progress) => pushes.push(progress),
      now: () => Date.now(),
    });

    service.markDirty('project-a', 'model', 4);
    vi.advanceTimersByTime(300);
    report!({ stage: 'reading', fraction: 0.5 });

    // Asserted before any timer is advanced: a deferred push would still fire.
    expect(pushes.map((progress) => progress.percent)).toEqual([0, 47]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  // Red-green: drop `firstBuildFailedAt.delete(projectId)` from `forget` and the
  // ask after it is held off by the stamp, so the pass is called once, not twice.
  it('lets forget clear a failed first build\'s hold-off, so the next ask starts a pass at once', async () => {
    let clock = 1_000_000;
    mockRunProjectionPass.mockRejectedValueOnce(new Error('pass failed')).mockImplementation(neverSettles);
    const service = createGraphService({ getDb: () => ({}) as never, now: () => clock });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    await settle();
    error.mockRestore();

    // The stamp is live: inside the minute another first build is refused.
    clock += 1_000;
    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);

    service.forget('project-a');
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);
  });

  // The stamp holds off a FIRST build only: a project with a map is refreshing,
  // and its old map is on screen, so there is no building card to loop on.
  //
  // Red-green: check the stamp for a refresh too (drop the `isFirstBuild` guard
  // around it) and the refresh is refused, so the pass is called once, not twice.
  it('does not hold a refresh off with a first build\'s failure stamp', async () => {
    let clock = 1_000_000;
    mockRunProjectionPass.mockRejectedValueOnce(new Error('pass failed')).mockImplementation(neverSettles);
    const service = createGraphService({ getDb: () => ({}) as never, now: () => clock });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    await settle();
    error.mockRestore();

    // The stamp is live: inside the minute another first build is refused.
    clock += 1_000;
    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);

    // A map exists now, so the next pass is a refresh, still inside the minute.
    storeState.cachedProjection = {};
    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);
  });

  // The stamp is cleared by a pass that succeeds. A success cannot land inside
  // the minute for a first build (the stamp refuses it), so the route is a
  // refresh: it is the only pass the stamp lets through, and the line that
  // clears the stamp runs for any pass. The map is then dropped again, and the
  // first build that follows must not be held off by the old failure.
  //
  // Red-green: drop `firstBuildFailedAt.delete(projectId)` after
  // `writeProjectionCache` and the last ask is refused, so it answers null.
  it('clears a first build\'s failure stamp when a pass succeeds', async () => {
    let clock = 1_000_000;
    mockRunProjectionPass
      .mockRejectedValueOnce(new Error('pass failed'))
      .mockResolvedValueOnce({
        projection: {} as never,
        counts: { documents: 1, documentsRead: 1, vectorsRead: 1 },
      })
      .mockImplementation(neverSettles);
    const service = createGraphService({ getDb: () => ({}) as never, now: () => clock });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    await settle();
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);

    // A map exists for the ask, which makes this pass a refresh. It is dropped
    // before the pass runs on, so naming finds no map to name.
    clock += 1_000;
    storeState.cachedProjection = {};
    service.markDirty('project-a', 'model', 4);
    storeState.cachedProjection = null;
    await settle();
    error.mockRestore();
    log.mockRestore();
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);
    // The refresh is over, so a null answer below means refused, not running.
    expect(service.getSnapshotWire('project-a', 'model').building).toBe(false);

    clock += 1_000;
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(3);
  });

  // The catch of a pass that `forget` aborted must neither tell a reader nor
  // stamp a failure: the project is gone, and a stamp set after `forget` cleared
  // it would hold off the next build for a project that has no history. The
  // aborted-pass test above resolves null, so its catch is never reached.
  //
  // Red-green: drop `&& !signal.aborted` from the catch and `onChanged` is called
  // for the project, and the ask after it is held off by the new stamp.
  it('tells no reader and records no failure when a pass that forget aborted rejects', async () => {
    let clock = 1_000_000;
    let failPass: (reason: Error) => void = () => undefined;
    mockRunProjectionPass
      .mockImplementationOnce(() => new Promise<null>((_resolve, reject) => { failPass = reject; }))
      .mockImplementation(neverSettles);
    const changed: string[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onChanged: (projectId) => changed.push(projectId),
      now: () => clock,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    service.forget('project-a');
    failPass(new Error('stopped mid-read'));
    await settle();

    // The catch ran (it logs), and did nothing more.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('projection pass failed'), expect.any(Error));
    error.mockRestore();
    expect(changed).toEqual([]);

    clock += 1_000;
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(2);
  });

  // A figure the throttle is holding back is dropped when the pass ends. Left to
  // fire, its timer pushes the stale figure AFTER the failure was announced, and
  // the renderer reads a progress push as "a first build is running": the
  // building card would come back for a pass that is over, with nothing left to
  // take it down.
  //
  // Red-green: drop `clearProgressTimer(entry)` from the pass's `finally` and the
  // held figure is pushed after the failure, so the events read
  // ['progress 0', 'changed', 'progress 47'].
  it('drops a throttled figure when the pass fails, so no stale figure follows the failure', async () => {
    vi.useFakeTimers();
    let report: ((progress: ProjectionProgress) => void) | undefined;
    let failPass: (reason: Error) => void = () => undefined;
    mockRunProjectionPass.mockImplementationOnce((deps) => {
      report = deps.onProgress;
      return new Promise<null>((_resolve, reject) => { failPass = reject; });
    });
    const events: string[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onBuildProgress: (_projectId, progress) => events.push(`progress ${progress.percent}`),
      onChanged: () => events.push('changed'),
      now: () => Date.now(),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    service.markDirty('project-a', 'model', 4);
    // Inside the 250 ms window of the first push, so this one is held back.
    report!({ stage: 'reading', fraction: 0.5 });
    expect(vi.getTimerCount()).toBe(1);

    failPass(new Error('pass failed'));
    await vi.advanceTimersByTimeAsync(0);
    error.mockRestore();
    expect(events).toEqual(['progress 0', 'changed']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(['progress 0', 'changed']);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  // The aborted guard in the push already keeps a forgotten pass's held figure
  // from reaching a reader, so this pins what is left over: nothing stays
  // scheduled for a project that was forgotten.
  //
  // Red-green: drop `clearProgressTimer(pass)` from `forget` and the held
  // figure's timer is still pending, so the timer count reads 1.
  it('leaves no timer pending for a throttled figure once forget aborted the pass', () => {
    vi.useFakeTimers();
    let report: ((progress: ProjectionProgress) => void) | undefined;
    mockRunProjectionPass.mockImplementationOnce((deps) => {
      report = deps.onProgress;
      return neverSettles();
    });
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const service = createGraphService({
      getDb: () => ({}) as never,
      onBuildProgress: (_projectId, progress) => pushes.push(progress),
      now: () => Date.now(),
    });

    service.markDirty('project-a', 'model', 4);
    report!({ stage: 'reading', fraction: 0.5 });
    expect(vi.getTimerCount()).toBe(1);

    service.forget('project-a');
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(pushes.map((progress) => progress.percent)).toEqual([0]);
    vi.useRealTimers();
  });
});

/**
 * `markDirty` answers null and starts nothing when the store cannot be used: no
 * vec extension, or a store, a cached map or a stored signature that cannot be
 * read. It reads all of them before it reports a build, so a reader is never
 * told a build started that then fails to.
 */
describe('graph service markDirty when the store cannot be used', () => {
  const databaseState = { opens: true };

  beforeEach(() => {
    resetStoreState();
    databaseState.opens = true;
    mockRunProjectionPass.mockReset();
    vi.useRealTimers();
  });

  const neverSettles = () => new Promise<null>(() => undefined);

  function makeServiceWithPushes() {
    const pushes: KnowledgeGraphBuildProgress[] = [];
    const service = createGraphService({
      getDb: () => {
        if (!databaseState.opens) throw new Error('database closed');
        return {} as never;
      },
      onBuildProgress: (_projectId, progress) => pushes.push(progress),
    });
    return { service, pushes };
  }

  it('answers null, pushes nothing and starts no pass when the store has no vec extension', async () => {
    storeState.hasVec = false;
    const { service, pushes } = makeServiceWithPushes();

    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    await settle();

    expect(pushes).toEqual([]);
    expect(mockRunProjectionPass).not.toHaveBeenCalled();
  });

  it('answers null and logs when the store cannot be opened, then starts a pass once it can', async () => {
    databaseState.opens = false;
    const { service, pushes } = makeServiceWithPushes();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    await settle();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('projection pass failed'), expect.any(Error));
    error.mockRestore();
    expect(pushes).toEqual([]);
    expect(mockRunProjectionPass).not.toHaveBeenCalled();

    // Nothing was left marked running, so a later ask is not refused.
    databaseState.opens = true;
    mockRunProjectionPass.mockImplementationOnce(neverSettles);
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);
  });

  it('answers null and logs when the cached map cannot be read, then starts a pass once it can', async () => {
    storeState.readCachedThrows = true;
    const { service, pushes } = makeServiceWithPushes();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    await settle();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('projection pass failed'), expect.any(Error));
    error.mockRestore();
    expect(pushes).toEqual([]);
    expect(mockRunProjectionPass).not.toHaveBeenCalled();

    storeState.readCachedThrows = false;
    mockRunProjectionPass.mockImplementationOnce(neverSettles);
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);
  });

  // The signature is read inside the guarded block, before the first figure is
  // pushed. Read after it, a store that fails here would have pushed a figure
  // for a build that never starts, and the throw would escape `markDirty`.
  //
  // Red-green: move `embedding = resolveEmbedding(...)` below
  // `setProgress('reading', 0)` and `markDirty` throws the signature error
  // instead of answering null, after one figure was pushed.
  it('reads the stored signature before reporting a first build, so a failing store pushes nothing', async () => {
    storeState.signatureThrows = true;
    const { service, pushes } = makeServiceWithPushes();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(service.markDirty('project-a', 'model', 4)).toBeNull();
    await settle();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('projection pass failed'), expect.any(Error));
    error.mockRestore();
    expect(pushes).toEqual([]);
    expect(mockRunProjectionPass).not.toHaveBeenCalled();

    // Nothing was left marked running, so a later ask is not refused.
    storeState.signatureThrows = false;
    mockRunProjectionPass.mockImplementationOnce(neverSettles);
    expect(service.markDirty('project-a', 'model', 4)).toMatchObject({ stage: 'reading' });
    expect(mockRunProjectionPass).toHaveBeenCalledTimes(1);
    expect(pushes).toHaveLength(1);
  });
});
