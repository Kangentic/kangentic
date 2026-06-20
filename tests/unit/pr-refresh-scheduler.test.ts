/**
 * Unit tests for the per-project PR-refresh scheduler: an immediate (deferred)
 * sweep on start, a periodic timer at the configured interval, "Off" arming no
 * timer, teardown via stop(), the projectId-scoped stop() no-op, and the
 * per-tick guard that skips a sweep once the project is no longer current.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

// Run the tagged work inline so a sweep's refreshProjectPRs call is observable.
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: (_name: string, fn: () => void) => fn(),
}));
vi.mock('../../src/main/pr/pr-refresh', () => ({ refreshProjectPRs: vi.fn(async () => {}) }));

import { refreshProjectPRs } from '../../src/main/pr/pr-refresh';
import { prRefreshScheduler } from '../../src/main/pr/pr-refresh-scheduler';

const FIVE_MIN = 5 * 60_000;
const mockRefresh = vi.mocked(refreshProjectPRs);

/** Minimal context: the scheduler only reads currentProjectId + the git interval. */
function makeContext(currentProjectId: string, minutes: number | null): IpcContext {
  return {
    currentProjectId,
    configManager: { getEffectiveConfig: () => ({ git: { prRefreshIntervalMinutes: minutes } }) },
  } as unknown as IpcContext;
}

function makeProject(id: string): Project {
  return { id, path: `/mock/repo/${id}`, name: id } as Project;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  prRefreshScheduler.stop(); // reset the module singleton between tests
  vi.useRealTimers();
});

describe('prRefreshScheduler', () => {
  it('runs an immediate sweep and arms a periodic timer at the configured interval', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', 5), makeProject('p1'));

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // immediate sweep + first tick
    expect(mockRefresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // second tick
    expect(mockRefresh).toHaveBeenCalledTimes(3);

    expect(mockRefresh).toHaveBeenCalledWith(expect.anything(), 'p1');
  });

  it('Off (null interval) runs the on-load sweep but arms no timer', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', null), makeProject('p1'));

    await vi.runAllTimersAsync(); // safe: no interval, only the deferred immediate sweep
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour later: still just the one sweep
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the periodic timer', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', 5), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockRefresh).toHaveBeenCalledTimes(2);

    prRefreshScheduler.stop();
    mockRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('stop(projectId) only stops when that project owns the active timer', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', 5), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);

    prRefreshScheduler.stop('other-project'); // no-op: not the active project
    mockRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockRefresh).toHaveBeenCalledTimes(1); // still ticking

    prRefreshScheduler.stop('p1'); // now matches
    mockRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('switching projects tears down the prior timer and arms the new one', async () => {
    const context = makeContext('p1', 5);
    prRefreshScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);

    // Switch: currentProjectId moves to p2, scheduler re-armed for p2.
    (context as { currentProjectId: string }).currentProjectId = 'p2';
    prRefreshScheduler.startForProject(context, makeProject('p2'));
    mockRefresh.mockClear();

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // p2 immediate + tick; no p1 ticks
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledWith(expect.anything(), 'p2');
    expect(mockRefresh).not.toHaveBeenCalledWith(expect.anything(), 'p1');
  });

  it('skips a tick when the project is no longer the current one', async () => {
    const context = makeContext('p1', 5);
    prRefreshScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockRefresh).toHaveBeenCalledTimes(2);

    // User switched away but the timer has not been re-armed yet: the guard skips.
    (context as { currentProjectId: string }).currentProjectId = 'somewhere-else';
    mockRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
