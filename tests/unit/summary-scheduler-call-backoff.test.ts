/**
 * The summary scheduler's app-wide call backoff. A failed agent call holds every
 * project back until the failed project's retry timer fires, or until something
 * ends the backoff early. Two behaviors of that backoff were not pinned by
 * `task-summaries.test.ts`, which covers the timer path with one queued request
 * and `endBackoff` called with the failed project's own id:
 *
 * - the retry runs the failed project once, even when it asked again while its
 *   failing pass was still running;
 * - `invalidate` of any other project ends the backoff too, which is what a
 *   rebuild of the whole index relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SummaryPassResult, SummaryWriter } from '../../src/main/retrieval/summary/summary-pass';
import { createSummaryScheduler } from '../../src/main/retrieval/summary/summary-scheduler';

/** The scheduler's wait after a failed agent call. */
const CALL_BACKOFF_MS = 5 * 60_000;
/** A fixed clock: the backoff ends only when its timer is fired by hand. */
const CLOCK_MS = 1_000;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeTimer {
  delayMs: number;
  fire: () => void;
  cancelled: boolean;
}

/** A scheduler whose passes and timers the test finishes and fires by hand. */
function createHarness() {
  const writer: SummaryWriter = { agent: 'test-agent', model: null, effort: null, write: async () => '' };
  const startedProjectIds: string[] = [];
  const finishers: Array<(result: SummaryPassResult) => void> = [];
  const timers: FakeTimer[] = [];
  /** Summaries are wanted until a test switches them off. */
  let enabled = true;

  const runPass = vi.fn((projectId: string) => new Promise<SummaryPassResult>((resolve) => {
    startedProjectIds.push(projectId);
    finishers.push(resolve);
  }));
  const resolveWriter = vi.fn(async () => writer);

  const scheduler = createSummaryScheduler<string>({
    isEnabled: () => enabled,
    resolveWriter,
    onWritten: () => undefined,
    runPass,
    setTimer: (fire, delayMs) => {
      const timer: FakeTimer = { delayMs, fire, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    now: () => CLOCK_MS,
  });

  /** Resolve the oldest running pass, then let the scheduler act on its result. */
  const finishNext = async (outcome: Partial<SummaryPassResult> = {}): Promise<void> => {
    const finisher = finishers.shift();
    if (!finisher) throw new Error('No pass is running to finish');
    finisher({ written: 0, remaining: 0, unanswered: [], failed: false, callFailed: false, ...outcome });
    await settle();
    await settle();
  };

  const setEnabled = (value: boolean): void => {
    enabled = value;
  };

  return { scheduler, runPass, resolveWriter, setEnabled, startedProjectIds, timers, finishNext };
}

describe('summary scheduler call backoff', () => {
  beforeEach(() => {
    // The scheduler logs one line a pass.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the failed project once when its backoff ends, though it asked again while the failing pass ran', async () => {
    const { scheduler, runPass, startedProjectIds, timers, finishNext } = createHarness();
    scheduler.request('context', 'project-a');
    await settle();
    expect(runPass).toHaveBeenCalledTimes(1);

    // A board change while the pass runs queues the project behind its own pass.
    scheduler.request('context', 'project-a');
    await settle();
    expect(runPass).toHaveBeenCalledTimes(1);

    await finishNext({ written: 0, remaining: 4, failed: true, callFailed: true });
    // The queued request waits out the backoff instead of running the failed
    // call again at once.
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.delayMs)).toEqual([CALL_BACKOFF_MS]);
    expect(scheduler.status('project-a')).toEqual({ state: 'retrying', retryAtMs: CLOCK_MS + CALL_BACKOFF_MS });

    // The retry stands in for the queued request. It must not also run from
    // the queue once the retry's own pass ends.
    timers[0].fire();
    await settle();
    expect(runPass).toHaveBeenCalledTimes(2);

    await finishNext({ written: 4, remaining: 0 });
    expect(startedProjectIds).toEqual(['project-a', 'project-a']);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(scheduler.busy).toBe(false);
    expect(scheduler.status('project-a')).toEqual({ state: 'idle', retryAtMs: null });
    // Caught up: no gap timer was scheduled for a third pass.
    expect(timers).toHaveLength(1);
  });

  it('ends the app-wide call backoff when another project is invalidated, without waiting for its timer', async () => {
    const { scheduler, runPass, startedProjectIds, timers, finishNext } = createHarness();
    scheduler.request('context', 'project-a');
    await settle();
    await finishNext({ written: 0, remaining: 10, failed: true, callFailed: true });
    expect(runPass).toHaveBeenCalledTimes(1);

    // The agent is shared, so project-b waits behind the failed call too.
    scheduler.request('context', 'project-b');
    await settle();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(scheduler.status('project-a')).toEqual({ state: 'retrying', retryAtMs: CLOCK_MS + CALL_BACKOFF_MS });
    expect(scheduler.status('project-b')).toEqual({ state: 'retrying', retryAtMs: CLOCK_MS + CALL_BACKOFF_MS });
    expect(timers).toHaveLength(1);
    expect(timers[0].cancelled).toBe(false);

    // A rebuild invalidates a project that never failed. It still ends the
    // wait for the project that did, and starts the queue.
    scheduler.invalidate('project-b');
    await settle();
    expect(timers[0].cancelled).toBe(true);
    expect(runPass).toHaveBeenCalledTimes(2);
    // One of the two runs and the other is queued: neither waits out a backoff.
    expect(scheduler.status('project-a')).toEqual({ state: 'writing', retryAtMs: null });
    expect(scheduler.status('project-b')).toEqual({ state: 'writing', retryAtMs: null });

    // The failed project is back in the queue with the rest: each runs.
    await finishNext();
    await finishNext();
    expect(startedProjectIds.filter((projectId) => projectId === 'project-a')).toHaveLength(2);
    expect(startedProjectIds.filter((projectId) => projectId === 'project-b')).toHaveLength(1);
    expect(runPass).toHaveBeenCalledTimes(3);
    expect(scheduler.busy).toBe(false);
    expect(scheduler.status('project-a')).toEqual({ state: 'idle', retryAtMs: null });
    expect(scheduler.status('project-b')).toEqual({ state: 'idle', retryAtMs: null });
  });

  // Summaries switched off while a project waited out the call backoff: the
  // failed project's timer finds nothing to run, so the queue must be settled
  // right there, or the projects in it read as writing with no pass ever coming.
  //
  // Red-green: `if (!running) runNextPending();` in `startCallBackoff`'s
  // timer. Without it both projects stay in `pending` after the timer fires,
  // `callBackoff` is already null, and status reads `writing`. A `runNextPending`
  // that did not drop a disabled entry (its `!deps.isEnabled(nextContext)`
  // check) would instead start project-b's run, which
  // resolves a writer: the `resolveWriter` count below fails.
  it('drops a project queued behind the backoff when summaries were switched off during the wait', async () => {
    const { scheduler, runPass, resolveWriter, setEnabled, timers, finishNext } = createHarness();
    scheduler.request('context', 'project-a');
    await settle();
    await finishNext({ written: 0, remaining: 10, failed: true, callFailed: true });
    expect(resolveWriter).toHaveBeenCalledTimes(1);

    // project-b waits behind the failed call, and reads as retrying.
    scheduler.request('context', 'project-b');
    await settle();
    expect(scheduler.status('project-b')).toEqual({ state: 'retrying', retryAtMs: CLOCK_MS + CALL_BACKOFF_MS });

    setEnabled(false);
    expect(timers).toHaveLength(1);
    timers[0].fire();
    await settle();

    // Nothing is queued and nothing ran: no writer was resolved and no pass
    // started for either project.
    expect(scheduler.status('project-b')).toEqual({ state: 'idle', retryAtMs: null });
    expect(scheduler.status('project-a')).toEqual({ state: 'idle', retryAtMs: null });
    expect(resolveWriter).toHaveBeenCalledTimes(1);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(scheduler.busy).toBe(false);
  });

  // A project whose only batch fails every time must not starve the projects
  // queued behind it. When the app-wide backoff ends, the project that failed
  // goes to the BACK of the queue and the head of the queue runs first.
  //
  // Red-green: the re-queue in `startCallBackoff`'s timer,
  // `pending.delete(projectId); pending.set(projectId, queuedContext);`, then
  // `runNextPending()`. With the old timer body (`pending.delete(projectId);
  // request(context, projectId);` and no re-queue), step 3 starts project-a
  // again and project-b never starts, so the `startedProjectIds` assertion
  // right after the first timer fires fails.
  it('starts the project queued behind a failed call first when the backoff ends, and the failed project after it', async () => {
    const { scheduler, runPass, startedProjectIds, timers, finishNext } = createHarness();

    // 1. project-a runs and its call fails: the app-wide backoff starts.
    scheduler.request('context', 'project-a');
    await settle();
    await finishNext({ written: 0, remaining: 5, failed: true, callFailed: true });
    expect(startedProjectIds).toEqual(['project-a']);
    expect(timers.map((timer) => timer.delayMs)).toEqual([CALL_BACKOFF_MS]);

    // 2. project-b asks during the wait: it queues and does not run.
    scheduler.request('context', 'project-b');
    await settle();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(scheduler.status('project-b')).toEqual({ state: 'retrying', retryAtMs: CLOCK_MS + CALL_BACKOFF_MS });

    // 3. The backoff ends: project-b starts next, not the project that failed.
    timers[0].fire();
    await settle();
    expect(startedProjectIds).toEqual(['project-a', 'project-b']);
    expect(scheduler.status('project-b')).toEqual({ state: 'writing', retryAtMs: null });
    // project-a is queued at the back, no longer waiting out a backoff.
    expect(scheduler.status('project-a')).toEqual({ state: 'writing', retryAtMs: null });

    // 4. project-b finishes healthy: project-a runs from the back of the queue.
    await finishNext({ written: 3, remaining: 0 });
    expect(startedProjectIds).toEqual(['project-a', 'project-b', 'project-a']);
    expect(scheduler.status('project-b')).toEqual({ state: 'idle', retryAtMs: null });
    expect(scheduler.status('project-a')).toEqual({ state: 'writing', retryAtMs: null });

    // 5. project-a fails again. A project that arrives during this new wait
    // still runs before it when the backoff ends: a batch that fails every
    // time no longer starves the others.
    await finishNext({ written: 0, remaining: 5, failed: true, callFailed: true });
    expect(timers.map((timer) => timer.delayMs)).toEqual([CALL_BACKOFF_MS, CALL_BACKOFF_MS]);
    scheduler.request('context', 'project-c');
    await settle();
    expect(runPass).toHaveBeenCalledTimes(3);
    expect(scheduler.status('project-c')).toEqual({ state: 'retrying', retryAtMs: CLOCK_MS + CALL_BACKOFF_MS });

    timers[1].fire();
    await settle();
    expect(startedProjectIds).toEqual(['project-a', 'project-b', 'project-a', 'project-c']);

    await finishNext({ written: 2, remaining: 0 });
    expect(startedProjectIds).toEqual(['project-a', 'project-b', 'project-a', 'project-c', 'project-a']);

    await finishNext({ written: 5, remaining: 0 });
    expect(runPass).toHaveBeenCalledTimes(5);
    expect(scheduler.busy).toBe(false);
    expect(scheduler.status('project-a')).toEqual({ state: 'idle', retryAtMs: null });
    expect(scheduler.status('project-b')).toEqual({ state: 'idle', retryAtMs: null });
    expect(scheduler.status('project-c')).toEqual({ state: 'idle', retryAtMs: null });
  });
});
