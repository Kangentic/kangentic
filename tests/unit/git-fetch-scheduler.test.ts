/**
 * Unit tests for the per-project background remote-fetch scheduler
 * (src/main/git/git-fetch-scheduler.ts): an immediate (deferred) sweep on
 * start, a sweep 5 minutes after the repo's last full fetch, "Off" arming no timer,
 * teardown via stop(), the projectId-scoped stop() no-op, the per-tick guard
 * that skips a sweep once the project is no longer current, and the sweep's
 * shape: through the git lock at BACKGROUND priority, non-interactive.
 *
 * Mirrors tests/unit/pr-refresh-scheduler.test.ts, which the scheduler itself
 * mirrors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

// Run the tagged work inline so a sweep's fetch call is observable.
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: (_name: string, fn: () => void) => fn(),
}));
vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchAllRemotesIfStale: vi.fn(async () => {}),
  lastAllRemotesFetchAt: vi.fn(async () => null),
}));
// The lock runs the operation inline; the priority it was asked for is recorded.
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: {
    withGitLock: vi.fn((_projectPath: string, operation: () => Promise<unknown>) => operation()),
  },
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
}));

import { fetchAllRemotesIfStale, lastAllRemotesFetchAt } from '../../src/main/git/fetch-throttle';
import { WorktreeManager, GitQueuePriority } from '../../src/main/git/worktree-manager';
import { gitFetchScheduler } from '../../src/main/git/git-fetch-scheduler';

const FIVE_MIN = 5 * 60_000;
const mockFetch = vi.mocked(fetchAllRemotesIfStale);
const mockLastFetchAt = vi.mocked(lastAllRemotesFetchAt);
const mockWithGitLock = vi.mocked(WorktreeManager.withGitLock);

/** Minimal context: the scheduler only reads currentProjectId + the git.autoFetch switch. */
function makeContext(currentProjectId: string, autoFetch: boolean): IpcContext {
  return {
    currentProjectId,
    configManager: { getEffectiveConfig: () => ({ git: { autoFetch } }) },
  } as unknown as IpcContext;
}

function makeProject(id: string): Project {
  return { id, path: `/mock/repo/${id}`, name: id } as Project;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so a stamp one test set, or a queued
  // reply it never consumed, would leak into the next. Every test starts from a
  // repo that has never had a full fetch.
  mockLastFetchAt.mockReset();
  mockLastFetchAt.mockResolvedValue(null);
});

afterEach(() => {
  gitFetchScheduler.stop(); // reset the module singleton between tests
  vi.useRealTimers();
});

describe('gitFetchScheduler', () => {
  it('runs an immediate sweep and sweeps again 5 minutes after the last fetch', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', true), makeProject('p1'));

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // immediate sweep + first tick
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // second tick
    expect(mockFetch).toHaveBeenCalledTimes(3);

    expect(mockFetch).toHaveBeenCalledWith('/mock/repo/p1', expect.anything());
  });

  it('sweeps through the git lock at BACKGROUND priority, and the fetch can never prompt', async () => {
    // Off: only the deferred immediate sweep exists, so exactly one lock call.
    gitFetchScheduler.startForProject(makeContext('p1', false), makeProject('p1'));
    await vi.runAllTimersAsync();

    expect(mockWithGitLock).toHaveBeenCalledTimes(1);
    expect(mockWithGitLock).toHaveBeenCalledWith(
      '/mock/repo/p1',
      expect.any(Function),
      expect.objectContaining({ priority: GitQueuePriority.BACKGROUND, label: 'auto-fetch' }),
    );
    // A fetch on a timer has no user gesture behind it: a credential prompt,
    // terminal or GUI, must be impossible by construction.
    expect(mockFetch).toHaveBeenCalledWith('/mock/repo/p1', { nonInteractive: true });
  });

  it('a rejected lock never escapes the tick as an unhandled rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWithGitLock.mockRejectedValueOnce(new Error('queue cleared'));
    gitFetchScheduler.startForProject(makeContext('p1', false), makeProject('p1'));

    // Without the tick's own .catch, vitest reports the rejection as unhandled
    // and fails this file; with it, the rejection is logged and swallowed.
    await vi.runAllTimersAsync();
    expect(errorSpy).toHaveBeenCalledWith('[auto-fetch] sweep failed:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('Off runs the on-load sweep but arms no timer', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', false), makeProject('p1'));

    await vi.runAllTimersAsync(); // safe: no interval, only the deferred immediate sweep
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour later: still just the one sweep
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the periodic timer', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    gitFetchScheduler.stop();
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stop(projectId) only stops when that project owns the active timer', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);

    gitFetchScheduler.stop('other-project'); // no-op: not the active project
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).toHaveBeenCalledTimes(1); // still ticking

    gitFetchScheduler.stop('p1'); // now matches
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('switching projects tears down the prior timer and arms the new one', async () => {
    const context = makeContext('p1', true);
    gitFetchScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);

    // Switch: currentProjectId moves to p2, scheduler re-armed for p2.
    (context as { currentProjectId: string }).currentProjectId = 'p2';
    gitFetchScheduler.startForProject(context, makeProject('p2'));
    mockFetch.mockClear();

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // p2 immediate + tick; no p1 ticks
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith('/mock/repo/p2', expect.anything());
    expect(mockFetch).not.toHaveBeenCalledWith('/mock/repo/p1', expect.anything());
  });

  it('skips a tick when the project is no longer the current one', async () => {
    const context = makeContext('p1', true);
    gitFetchScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // User switched away but the timer has not been re-armed yet: the guard skips.
    (context as { currentProjectId: string }).currentProjectId = 'somewhere-else';
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The 5 minutes run from the repo's last full fetch, whoever made it: a
  // Changes panel opened 3 minutes in pushes the next sweep to 8 minutes.
  it('counts from the last fetch anyone made, not from its own last sweep', async () => {
    const startedAt = Date.now();
    gitFetchScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0); // the deferred on-open sweep
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockLastFetchAt.mockResolvedValue(startedAt + 3 * 60_000);
    await vi.advanceTimersByTimeAsync(FIVE_MIN); // the 5-minute wake finds a newer fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000); // 8 minutes: due now
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // A config save restarts the project the user is already on. The project id
  // still matches afterwards, and the timer is null while a tick reads the
  // clock, so neither guard can tell a tick the restart started from one that
  // outlived it. The generation counter can.
  it('a tick reading the clock when the same project restarts with auto-fetch off neither sweeps nor re-arms', async () => {
    const git = { autoFetch: true };
    const context = {
      currentProjectId: 'p1',
      configManager: { getEffectiveConfig: () => ({ git }) },
    } as unknown as IpcContext;
    let releaseClock: (lastFetchAt: number | null) => void = () => undefined;
    mockLastFetchAt.mockImplementationOnce(() => new Promise<number | null>((resolve) => { releaseClock = resolve; }));

    gitFetchScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    // The 5-minute wake is waiting on the clock, and only the on-load sweep ran.
    expect(mockLastFetchAt).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    git.autoFetch = false;
    gitFetchScheduler.startForProject(context, makeProject('p1'));
    // An old stamp: were the stale tick still live, the repo would read as due.
    releaseClock(Date.now() - 10 * FIVE_MIN);
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);

    // The on-load sweep of the first start, and the restart's own. Nothing from
    // the tick that outlived the restart, and no timer it could have re-armed.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual(['/mock/repo/p1', '/mock/repo/p1']);
    expect(mockLastFetchAt).toHaveBeenCalledTimes(1);
  });

  // A failed fetch stamps nothing, so its repo reads as never fetched. Each
  // sweep re-arms the timer a full interval out, which is what keeps an offline
  // repo to one retry per interval. This pins that re-arm; the test after it
  // pins the scheduler's own attempt clock, which is separate.
  it('re-arms a full interval after each sweep, so a fetch that left no stamp is retried once per interval', async () => {
    mockLastFetchAt.mockResolvedValue(null);
    gitFetchScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FIVE_MIN - 1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  // The scheduler counts from its own last attempt as well as from the repo's
  // last stamp. The re-arm above cannot show it, because a wake normally comes
  // a full interval after a sweep. A wake that comes short of one, with no
  // stamp to push it back, is the case only the attempt clock covers.
  it('goes back to sleep for the rest of the interval when it wakes short of one after its own last sweep', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', true), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(0); // the on-open sweep is the attempt
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The 5-minute wake finds the wall clock a second short of the interval, as
    // when a timer fires early or the clock is stepped back.
    const attemptedAt = Date.now();
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(attemptedAt + FIVE_MIN - 1000);
    try {
      await vi.advanceTimersByTimeAsync(FIVE_MIN);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      wallClock.mockReturnValue(attemptedAt + FIVE_MIN);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      wallClock.mockRestore();
    }
  });
});
