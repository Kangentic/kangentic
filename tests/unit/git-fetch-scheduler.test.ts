/**
 * Unit tests for the per-project background remote-fetch scheduler
 * (src/main/git/git-fetch-scheduler.ts): an immediate (deferred) sweep on
 * start, a periodic timer at the configured interval, "Off" arming no timer,
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
}));
// The lock runs the operation inline; the priority it was asked for is recorded.
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: {
    withGitLock: vi.fn((_projectPath: string, operation: () => Promise<unknown>) => operation()),
  },
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
}));

import { fetchAllRemotesIfStale } from '../../src/main/git/fetch-throttle';
import { WorktreeManager, GitQueuePriority } from '../../src/main/git/worktree-manager';
import { gitFetchScheduler } from '../../src/main/git/git-fetch-scheduler';

const FIVE_MIN = 5 * 60_000;
const mockFetch = vi.mocked(fetchAllRemotesIfStale);
const mockWithGitLock = vi.mocked(WorktreeManager.withGitLock);

/** Minimal context: the scheduler only reads currentProjectId + the git interval. */
function makeContext(currentProjectId: string, minutes: number | null): IpcContext {
  return {
    currentProjectId,
    configManager: { getEffectiveConfig: () => ({ git: { autoFetchIntervalMinutes: minutes } }) },
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
  gitFetchScheduler.stop(); // reset the module singleton between tests
  vi.useRealTimers();
});

describe('gitFetchScheduler', () => {
  it('runs an immediate sweep and arms a periodic timer at the configured interval', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', 5), makeProject('p1'));

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // immediate sweep + first tick
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FIVE_MIN); // second tick
    expect(mockFetch).toHaveBeenCalledTimes(3);

    expect(mockFetch).toHaveBeenCalledWith('/mock/repo/p1', expect.anything());
  });

  it('sweeps through the git lock at BACKGROUND priority, and the fetch can never prompt', async () => {
    // Off: only the deferred immediate sweep exists, so exactly one lock call.
    gitFetchScheduler.startForProject(makeContext('p1', null), makeProject('p1'));
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
    gitFetchScheduler.startForProject(makeContext('p1', null), makeProject('p1'));

    // Without the tick's own .catch, vitest reports the rejection as unhandled
    // and fails this file; with it, the rejection is logged and swallowed.
    await vi.runAllTimersAsync();
    expect(errorSpy).toHaveBeenCalledWith('[auto-fetch] sweep failed:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('Off (null interval) runs the on-load sweep but arms no timer', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', null), makeProject('p1'));

    await vi.runAllTimersAsync(); // safe: no interval, only the deferred immediate sweep
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour later: still just the one sweep
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the periodic timer', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', 5), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    gitFetchScheduler.stop();
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stop(projectId) only stops when that project owns the active timer', async () => {
    gitFetchScheduler.startForProject(makeContext('p1', 5), makeProject('p1'));
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
    const context = makeContext('p1', 5);
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
    const context = makeContext('p1', 5);
    gitFetchScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // User switched away but the timer has not been re-armed yet: the guard skips.
    (context as { currentProjectId: string }).currentProjectId = 'somewhere-else';
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
