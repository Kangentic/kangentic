/**
 * Unit tests for the per-project PR refresh: the pure due-PR picker, and the
 * scheduler around it (an immediate deferred sweep on start, then one check at
 * a time as each PR falls due, at least the minimum gap apart; "Off" starting
 * no queue; teardown via stop(); the projectId-scoped stop() no-op; the guard
 * that skips a check once the project is no longer current).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project, Task } from '../../src/shared/types';

// Run the tagged work inline so a check is observable.
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: <T>(_name: string, fn: () => T): T => fn(),
}));

/** The eligible task ids the fake repo reports, per test. */
let eligibleIds: string[] = [];
/** The fake linker's check stamps, standing in for pr-linking's map. */
const checkStamps = new Map<string, number>();

vi.mock('../../src/main/pr/pr-refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pr/pr-refresh')>();
  return {
    ...actual,
    refreshProjectPRs: vi.fn(async () => {
      for (const taskId of eligibleIds) checkStamps.set(taskId, Date.now());
    }),
    listRefreshEligibleTasks: vi.fn(() => eligibleIds.map((id) => ({ id }) as Task)),
  };
});
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async (_context: unknown, options: { taskId: string }) => {
    checkStamps.set(options.taskId, Date.now());
    return { status: 'unchanged', task: null };
  }),
  cancelPendingVerdictRepolls: vi.fn(),
  lastPRCheckAt: (taskId: string) => checkStamps.get(taskId),
  prunePRCheckStamps: (keep: ReadonlySet<string>) => {
    for (const taskId of checkStamps.keys()) if (!keep.has(taskId)) checkStamps.delete(taskId);
  },
  clearPRCheckStamps: () => checkStamps.clear(),
}));

import { refreshProjectPRs, pickNextDuePR, nextPRDueAt } from '../../src/main/pr/pr-refresh';
import { linkPR, cancelPendingVerdictRepolls } from '../../src/main/pr/pr-linking';
import { prRefreshScheduler, PR_REFRESH_INTERVAL_MS, PR_REFRESH_MIN_GAP_MS } from '../../src/main/pr/pr-refresh-scheduler';

const mockSweep = vi.mocked(refreshProjectPRs);
const mockLinkPR = vi.mocked(linkPR);
const mockCancelPendingVerdictRepolls = vi.mocked(cancelPendingVerdictRepolls);

/** Minimal context: the scheduler reads currentProjectId + the git.prAutoRefresh switch. */
function makeContext(currentProjectId: string, prAutoRefresh: boolean): IpcContext {
  return {
    currentProjectId,
    configManager: { getEffectiveConfig: () => ({ git: { prAutoRefresh } }) },
  } as unknown as IpcContext;
}

function makeProject(id: string): Project {
  return { id, path: `/mock/repo/${id}`, name: id } as Project;
}

/** The task ids linkPR checked, in order. */
function checkedIds(): string[] {
  return mockLinkPR.mock.calls.map((call) => (call[1] as { taskId: string }).taskId);
}

describe('pickNextDuePR', () => {
  const INTERVAL = 120_000;

  it('picks nothing while every PR was checked inside the interval', () => {
    const stamps = new Map([['a', 1000], ['b', 2000]]);
    expect(pickNextDuePR(['a', 'b'], (id) => stamps.get(id), 1000 + INTERVAL - 1, INTERVAL)).toBeNull();
  });

  it('picks the longest-unchecked due PR first', () => {
    const stamps = new Map([['a', 5000], ['b', 1000], ['c', 3000]]);
    expect(pickNextDuePR(['a', 'b', 'c'], (id) => stamps.get(id), 5000 + INTERVAL, INTERVAL)).toBe('b');
  });

  it('puts a PR never checked this session ahead of every checked one', () => {
    const stamps = new Map([['a', 0]]);
    expect(pickNextDuePR(['a', 'new'], (id) => stamps.get(id), INTERVAL * 10, INTERVAL)).toBe('new');
  });

  it('reports when the next PR falls due, and null with nothing eligible', () => {
    const stamps = new Map([['a', 10_000], ['b', 4000]]);
    expect(nextPRDueAt(['a', 'b'], (id) => stamps.get(id), 20_000, INTERVAL)).toBe(4000 + INTERVAL);
    expect(nextPRDueAt([], (id) => stamps.get(id), 20_000, INTERVAL)).toBeNull();
  });
});

describe('prRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    checkStamps.clear();
    eligibleIds = ['a', 'b', 'c'];
  });

  afterEach(() => {
    prRefreshScheduler.stop(); // reset the module singleton between tests
    vi.useRealTimers();
  });

  it('checks every eligible PR on open, then each again once it falls due, one at a time', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockSweep).toHaveBeenCalledWith(expect.anything(), 'p1');

    // Nothing is due until 2 minutes after the open sweep.
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS - 1000);
    expect(mockLinkPR).not.toHaveBeenCalled();

    // All three fall due together; the queue spaces them by the minimum gap.
    await vi.advanceTimersByTimeAsync(1000 + PR_REFRESH_MIN_GAP_MS * 3);
    expect(checkedIds()).toEqual(['a', 'b', 'c']);
  });

  it('never starts two checks less than the minimum gap apart', async () => {
    const callTimes: number[] = [];
    mockLinkPR.mockImplementation(async (_context, options) => {
      callTimes.push(Date.now());
      checkStamps.set((options as { taskId: string }).taskId, Date.now());
      return { status: 'unchanged', task: null } as never;
    });
    eligibleIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS * 3);

    expect(callTimes.length).toBeGreaterThan(6);
    for (let index = 1; index < callTimes.length; index += 1) {
      expect(callTimes[index] - callTimes[index - 1]).toBeGreaterThanOrEqual(PR_REFRESH_MIN_GAP_MS);
    }
  });

  // Any check resets a PR's clock, not only the queue's own: a PR the 30 s CI
  // re-poll just checked is not checked again until 2 minutes after that.
  it('counts each PR from its last check, whoever made it', async () => {
    eligibleIds = ['a'];
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_000);
    checkStamps.set('a', Date.now()); // an outside check at 1:00
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS - 1000); // 2:59: not yet due
    expect(mockLinkPR).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000 + PR_REFRESH_MIN_GAP_MS);
    expect(checkedIds()).toEqual(['a']);
  });

  it('Off runs the on-open sweep but starts no queue', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', false), makeProject('p1'));
    await vi.runAllTimersAsync();
    expect(mockSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour later: nothing queued
    expect(mockLinkPR).not.toHaveBeenCalled();
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it('stop() ends the queue', async () => {
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0);

    prRefreshScheduler.stop();
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS * 3);
    expect(mockLinkPR).not.toHaveBeenCalled();
  });

  it('stop(projectId) only stops when that project owns the active queue', async () => {
    eligibleIds = ['a'];
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0);

    prRefreshScheduler.stop('other-project'); // no-op: not the active project
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS + PR_REFRESH_MIN_GAP_MS);
    expect(mockLinkPR).toHaveBeenCalledTimes(1); // still running

    prRefreshScheduler.stop('p1'); // now matches
    mockLinkPR.mockClear();
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS * 2);
    expect(mockLinkPR).not.toHaveBeenCalled();
  });

  it('stop() cancels this project\'s pending merge-verdict re-polls', () => {
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    // startForProject's own internal stop() already called this once (tearing
    // down any prior project's queue); clear before the assertion below.
    mockCancelPendingVerdictRepolls.mockClear();

    prRefreshScheduler.stop();

    expect(mockCancelPendingVerdictRepolls).toHaveBeenCalledTimes(1);
  });

  it('stop(projectId) does not cancel merge-verdict re-polls when a different project owns the queue', () => {
    prRefreshScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    mockCancelPendingVerdictRepolls.mockClear();

    prRefreshScheduler.stop('other-project');

    expect(mockCancelPendingVerdictRepolls).not.toHaveBeenCalled();
  });

  it('switching projects tears down the prior queue and starts the new one', async () => {
    const context = makeContext('p1', true);
    prRefreshScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0);

    (context as { currentProjectId: string }).currentProjectId = 'p2';
    prRefreshScheduler.startForProject(context, makeProject('p2'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSweep).toHaveBeenCalledTimes(2);
    expect(mockSweep).toHaveBeenLastCalledWith(expect.anything(), 'p2');
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS + PR_REFRESH_MIN_GAP_MS);
    for (const call of mockLinkPR.mock.calls) {
      expect((call[1] as { projectId: string }).projectId).toBe('p2');
    }
  });

  it('skips a check when the project is no longer the current one', async () => {
    const context = makeContext('p1', true);
    prRefreshScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0);

    // User switched away but the queue has not been restarted yet: the guard skips.
    (context as { currentProjectId: string }).currentProjectId = 'somewhere-else';
    await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS * 2);
    expect(mockLinkPR).not.toHaveBeenCalled();
  });

  describe('a config save that restarts the SAME project', () => {
    // A save restarts the project the user is already on. The project id and the
    // current-project check both still match afterwards, and the timer is null
    // while a check or a sweep runs, so those guards alone cannot tell work the
    // restart started from work that outlived it. The generation counter can.

    /** A context whose switch can be flipped between two starts of one project. */
    function makeFlippableContext(): { context: IpcContext; git: { prAutoRefresh: boolean } } {
      const git = { prAutoRefresh: true };
      const context = {
        currentProjectId: 'p1',
        configManager: { getEffectiveConfig: () => ({ git }) },
      } as unknown as IpcContext;
      return { context, git };
    }

    it('does not re-arm the queue from a check that was in flight when the switch went off', async () => {
      eligibleIds = ['a'];
      const { context, git } = makeFlippableContext();
      let finishCheck: () => void = () => undefined;
      mockLinkPR.mockImplementationOnce(async (_context, options) => {
        await new Promise<void>((resolve) => { finishCheck = resolve; });
        checkStamps.set((options as { taskId: string }).taskId, Date.now());
        return { status: 'unchanged', task: null } as never;
      });

      prRefreshScheduler.startForProject(context, makeProject('p1'));
      await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS + PR_REFRESH_MIN_GAP_MS);
      // The queue reached its first check and it is still running.
      expect(mockLinkPR).toHaveBeenCalledTimes(1);

      git.prAutoRefresh = false;
      prRefreshScheduler.startForProject(context, makeProject('p1'));
      finishCheck();
      await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS * 3);

      // Off runs the restart's own on-open sweep and no queue: the check that
      // outlived the restart must not have armed one.
      expect(mockLinkPR).toHaveBeenCalledTimes(1);
      expect(mockSweep).toHaveBeenCalledTimes(2);
    });

    it('does not hand over to the queue from a sweep that was in flight when the switch went off', async () => {
      eligibleIds = ['a'];
      const { context, git } = makeFlippableContext();
      let finishSweep: () => void = () => undefined;
      mockSweep.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { finishSweep = resolve; });
        checkStamps.set('a', Date.now());
      });

      prRefreshScheduler.startForProject(context, makeProject('p1'));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSweep).toHaveBeenCalledTimes(1);

      git.prAutoRefresh = false;
      prRefreshScheduler.startForProject(context, makeProject('p1'));
      finishSweep();
      await vi.advanceTimersByTimeAsync(PR_REFRESH_INTERVAL_MS * 3);

      expect(mockSweep).toHaveBeenCalledTimes(2);
      expect(mockLinkPR).not.toHaveBeenCalled();
    });

    it('sweeps once, not twice, when the restart lands before the deferred on-open sweep runs', async () => {
      const { context, git } = makeFlippableContext();

      prRefreshScheduler.startForProject(context, makeProject('p1'));
      git.prAutoRefresh = false;
      prRefreshScheduler.startForProject(context, makeProject('p1'));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSweep).toHaveBeenCalledTimes(1);
    });
  });
});
