/**
 * Tests for `captureGitChurn` (src/main/ipc/handlers/git-stats-capture.ts).
 *
 * The function is fire-and-forget: it reads the task's session-record ids
 * synchronously, then calls `void new DiffService(...).getChurnSummary(...).then(...)`
 * without blocking the caller. Each test awaits a `setImmediate`-based tick
 * (same pattern as session-metrics-refine-tokens.test.ts) so the promise
 * chain can settle before asserting on the repo writes.
 *
 * Pins two regression risks:
 *   1. The no-clobber guard: an all-zero diff result (a git error, or a
 *      capture that runs after the branch is already merged) must write to
 *      NEITHER repo, so it can never wipe a real capture made earlier in the
 *      task's life.
 *   2. One-row-per-task consolidation: `setTaskGitStats` is called with the
 *      full record-id list and the canonical id, so exactly one record ends
 *      up non-zero (never every `--resume` record, which would double-count
 *      under the dashboard's flat SUM).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../src/main/db/repositories/usage-history-repository';

// ---------------------------------------------------------------------------
// Mock DiffService BEFORE importing the module under test (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const { mockGetChurnSummary, mockDiffServiceCtor } = vi.hoisted(() => ({
  mockGetChurnSummary: vi.fn(async () => ({ linesAdded: 42, linesRemoved: 7, filesChanged: 3 })),
  mockDiffServiceCtor: vi.fn(),
}));

vi.mock('../../src/main/git/diff-service', () => ({
  DiffService: class {
    constructor(gitDirectory: string) {
      mockDiffServiceCtor(gitDirectory);
    }
    getChurnSummary(baseBranch: string) {
      return mockGetChurnSummary(baseBranch);
    }
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after the mock is registered)
// ---------------------------------------------------------------------------

import { captureGitChurn } from '../../src/main/ipc/handlers/git-stats-capture';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Await one setImmediate so the fire-and-forget promise chain inside
 *  captureGitChurn can settle before assertions run. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Git Task',
    description: '',
    swimlane_id: 'lane-doing',
    position: 0,
    agent: 'claude',
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/my-git-task',
    branch_name: 'my-git-task',
    pr_number: null,
    pr_url: null,
    base_branch: 'main',
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRepos(recordIds: string[] = ['record-001'], storedChurn: { lines_added: number; lines_removed: number; files_changed: number } | null = null) {
  const sessionSetTaskGitStats = vi.fn();
  const historySetTaskGitStats = vi.fn();
  const listForTaskNewestFirst = vi.fn(() => recordIds.map((id, index) => ({
    id,
    ...(index === 0 && storedChurn ? storedChurn : { lines_added: 0, lines_removed: 0, files_changed: 0 }),
  })));
  const sessionRepo = {
    setTaskGitStats: sessionSetTaskGitStats,
    listForTaskNewestFirst,
  } as unknown as SessionRepository;
  const usageHistoryRepo = { setTaskGitStats: historySetTaskGitStats } as unknown as UsageHistoryRepository;
  return { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats, historySetTaskGitStats, listForTaskNewestFirst };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureGitChurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChurnSummary.mockResolvedValue({ linesAdded: 42, linesRemoved: 7, filesChanged: 3 });
  });

  it('writes churn to BOTH repos, keyed by the full record-id list and the canonical id', async () => {
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats, historySetTaskGitStats } =
      makeRepos(['record-001', 'record-000']);
    const task = makeTask();

    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();

    const expectedStats = { linesAdded: 42, linesRemoved: 7, filesChanged: 3 };
    expect(sessionSetTaskGitStats).toHaveBeenCalledTimes(1);
    expect(historySetTaskGitStats).toHaveBeenCalledTimes(1);
    expect(sessionSetTaskGitStats).toHaveBeenCalledWith(['record-001', 'record-000'], 'record-001', expectedStats);
    expect(historySetTaskGitStats).toHaveBeenCalledWith(['record-001', 'record-000'], 'record-001', expectedStats);
  });

  it('no-clobber guard: an all-zero diff result writes to NEITHER repo', async () => {
    mockGetChurnSummary.mockResolvedValueOnce({ linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats, historySetTaskGitStats } = makeRepos();
    const task = makeTask();

    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();

    expect(sessionSetTaskGitStats).not.toHaveBeenCalled();
    expect(historySetTaskGitStats).not.toHaveBeenCalled();
  });

  it('keeps the stored capture once the task\'s PR is merged: no read, no write', async () => {
    // #732: after its PR merged, the branch was reset onto main and a release
    // commit landed on top, so a later capture read +38 / -1 over the real
    // +52,801 / -2,054. Red-green: without the guard the read runs and writes over it.
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats, historySetTaskGitStats } =
      makeRepos(['record-001'], { lines_added: 52_801, lines_removed: 2_054, files_changed: 489 });

    captureGitChurn(makeTask({ pr_state: 'merged' }), sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();

    expect(mockGetChurnSummary).not.toHaveBeenCalled();
    expect(sessionSetTaskGitStats).not.toHaveBeenCalled();
    expect(historySetTaskGitStats).not.toHaveBeenCalled();
  });

  it('keeps the stored capture once the task is archived (in Done) and a capture exists', async () => {
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats } =
      makeRepos(['record-001'], { lines_added: 789, lines_removed: 103, files_changed: 13 });

    captureGitChurn(makeTask({ archived_at: '2026-10-13T05:03:47.329Z' }), sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();

    expect(mockGetChurnSummary).not.toHaveBeenCalled();
    expect(sessionSetTaskGitStats).not.toHaveBeenCalled();
  });

  it('still captures for an archived task that has no capture yet, and mid-work captures still update', async () => {
    const archived = makeRepos(['record-001']);
    captureGitChurn(makeTask({ archived_at: '2026-10-13T05:03:47.329Z' }), archived.sessionRepo, archived.usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();
    expect(archived.sessionSetTaskGitStats).toHaveBeenCalledTimes(1);

    const midWork = makeRepos(['record-001'], { lines_added: 10, lines_removed: 1, files_changed: 2 });
    captureGitChurn(makeTask({ pr_state: 'open' }), midWork.sessionRepo, midWork.usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();
    expect(midWork.sessionSetTaskGitStats).toHaveBeenCalledWith(['record-001'], 'record-001', { linesAdded: 42, linesRemoved: 7, filesChanged: 3 });
  });

  it('returns early without touching DiffService or either repo when there is no git directory', async () => {
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats, historySetTaskGitStats, listForTaskNewestFirst } =
      makeRepos();
    // No worktree_path AND no projectPath argument.
    const task = makeTask({ worktree_path: null });

    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-001', null, 'main');
    await flushAsync();

    expect(mockDiffServiceCtor).not.toHaveBeenCalled();
    expect(listForTaskNewestFirst).not.toHaveBeenCalled();
    expect(sessionSetTaskGitStats).not.toHaveBeenCalled();
    expect(historySetTaskGitStats).not.toHaveBeenCalled();
  });

  it('uses the task worktree path when present, falling back to project path', async () => {
    const { sessionRepo, usageHistoryRepo } = makeRepos();

    const taskWithWorktree = makeTask({ worktree_path: '/mock/worktree-A' });
    captureGitChurn(taskWithWorktree, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();
    expect(mockDiffServiceCtor).toHaveBeenLastCalledWith('/mock/worktree-A');

    mockDiffServiceCtor.mockClear();

    const taskWithoutWorktree = makeTask({ worktree_path: null });
    captureGitChurn(taskWithoutWorktree, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await flushAsync();
    expect(mockDiffServiceCtor).toHaveBeenLastCalledWith('/mock/project');
  });

  it('uses the task base_branch when set, falling back to defaultBaseBranch then "main"', async () => {
    const { sessionRepo, usageHistoryRepo } = makeRepos();

    // task.base_branch wins over defaultBaseBranch.
    const taskWithBase = makeTask({ base_branch: 'develop' });
    captureGitChurn(taskWithBase, sessionRepo, usageHistoryRepo, 'r1', '/mock/project', 'master');
    await flushAsync();
    expect(mockGetChurnSummary).toHaveBeenLastCalledWith('develop');

    // Falls back to defaultBaseBranch when task.base_branch is null.
    mockGetChurnSummary.mockClear();
    const taskNoBase = makeTask({ base_branch: null });
    captureGitChurn(taskNoBase, sessionRepo, usageHistoryRepo, 'r1', '/mock/project', 'release');
    await flushAsync();
    expect(mockGetChurnSummary).toHaveBeenLastCalledWith('release');

    // Falls back to "main" when both are null/undefined.
    mockGetChurnSummary.mockClear();
    captureGitChurn(taskNoBase, sessionRepo, usageHistoryRepo, 'r1', '/mock/project', undefined);
    await flushAsync();
    expect(mockGetChurnSummary).toHaveBeenLastCalledWith('main');
  });

  it('passes the diff numbers through unchanged (no rounding/coercion)', async () => {
    mockGetChurnSummary.mockResolvedValueOnce({ linesAdded: 1, linesRemoved: 0, filesChanged: 1 });
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats, historySetTaskGitStats } = makeRepos();

    captureGitChurn(makeTask(), sessionRepo, usageHistoryRepo, 'record-x', '/mock/project', 'main');
    await flushAsync();

    const expectedStats = { linesAdded: 1, linesRemoved: 0, filesChanged: 1 };
    expect(sessionSetTaskGitStats).toHaveBeenCalledWith(['record-001'], 'record-x', expectedStats);
    expect(historySetTaskGitStats).toHaveBeenCalledWith(['record-001'], 'record-x', expectedStats);
  });

  it('caps concurrent churn captures via the global git read queue', async () => {
    // Six simultaneous finalizations (the live-profiled worst case) must not
    // fan out six concurrent DiffService churn reads: the shared viaGitRead
    // queue admits at most GIT_READ_CONCURRENCY (2) at a time. Red-green: this
    // test fails when captureGitChurn bypasses the queue.
    const gates: Array<() => void> = [];
    mockGetChurnSummary.mockImplementation(() =>
      new Promise<void>((resolve) => {
        gates.push(resolve);
      }).then(() => ({ linesAdded: 1, linesRemoved: 1, filesChanged: 1 })),
    );

    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats } = makeRepos();
    for (let taskIndex = 0; taskIndex < 6; taskIndex += 1) {
      captureGitChurn(
        // Six tasks, six worktrees: two captures of ONE worktree share a read.
        makeTask({ id: `task-${taskIndex}`, worktree_path: `/mock/project/.kangentic/worktrees/${taskIndex}` }),
        sessionRepo,
        usageHistoryRepo,
        `record-${taskIndex}`,
        '/mock/project',
        'main',
      );
    }

    // Only the first 2 jobs may start; the other 4 wait in the queue.
    await expect.poll(() => gates.length).toBe(2);
    await flushAsync();
    expect(gates.length).toBe(2);

    // Releasing slots admits the rest, never exceeding the cap in flight.
    while (gates.length > 0) {
      const admittedBeforeRelease = gates.length;
      gates.shift()!();
      await flushAsync();
      expect(gates.length).toBeLessThanOrEqual(admittedBeforeRelease + 1);
      if (sessionSetTaskGitStats.mock.calls.length === 6) break;
    }
    await expect.poll(() => sessionSetTaskGitStats.mock.calls.length).toBe(6);
  });

  it('shares one churn read between two captures of the same worktree that overlap, and each writes its own record', async () => {
    // A suspend fires two captures for the same stopped agent: the move's (or
    // the Done branch's) and the session exit handler's. Each read is six git
    // processes. Red-green: without the shared read, the DiffService is built
    // twice and getChurnSummary runs twice.
    let releaseRead: () => void = () => undefined;
    mockGetChurnSummary.mockImplementation(() =>
      new Promise<void>((resolve) => { releaseRead = resolve; })
        .then(() => ({ linesAdded: 5, linesRemoved: 2, filesChanged: 1 })),
    );
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats } = makeRepos(['record-exit', 'record-move']);
    const task = makeTask();

    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-exit', '/mock/project', 'main');
    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-move', '/mock/project', 'main');
    await expect.poll(() => mockGetChurnSummary.mock.calls.length).toBe(1);
    releaseRead();
    await expect.poll(() => sessionSetTaskGitStats.mock.calls.length).toBe(2);

    expect(mockDiffServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockGetChurnSummary).toHaveBeenCalledTimes(1);
    const stats = { linesAdded: 5, linesRemoved: 2, filesChanged: 1 };
    expect(sessionSetTaskGitStats).toHaveBeenNthCalledWith(1, ['record-exit', 'record-move'], 'record-exit', stats);
    expect(sessionSetTaskGitStats).toHaveBeenNthCalledWith(2, ['record-exit', 'record-move'], 'record-move', stats);
  });

  it('runs the read again for a capture asked for after the shared read settled', async () => {
    // The share covers the overlap only, so a later capture never reuses an
    // answer the worktree may have moved past.
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats } = makeRepos();
    const task = makeTask();

    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await expect.poll(() => sessionSetTaskGitStats.mock.calls.length).toBe(1);
    captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await expect.poll(() => sessionSetTaskGitStats.mock.calls.length).toBe(2);

    expect(mockGetChurnSummary).toHaveBeenCalledTimes(2);
  });

  it('does not share a read between two bases of the same worktree', async () => {
    const { sessionRepo, usageHistoryRepo, sessionSetTaskGitStats } = makeRepos();

    captureGitChurn(makeTask({ base_branch: 'main' }), sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    captureGitChurn(makeTask({ base_branch: 'develop' }), sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    await expect.poll(() => sessionSetTaskGitStats.mock.calls.length).toBe(2);

    expect(mockGetChurnSummary).toHaveBeenCalledTimes(2);
    expect(mockGetChurnSummary).toHaveBeenNthCalledWith(1, 'main');
    expect(mockGetChurnSummary).toHaveBeenNthCalledWith(2, 'develop');
  });

  it('queues its churn read at BACKGROUND priority: a USER-priority read enqueued later still runs first', async () => {
    // captureGitChurn's viaGitRead call passes { priority: GitReadPriority.BACKGROUND }
    // (0) so it yields to user-action reads (readWorktreeHead, PR linking),
    // which default to USER (1). p-queue treats higher numbers as higher
    // priority. Red-green: this fails if that priority option were ever
    // dropped (both jobs would then tie at the USER default, and FIFO order
    // - captureGitChurn's job enqueued first - would win instead), or if the
    // priority convention were inverted.
    const { viaGitRead } = await import('../../src/main/git/git-read-queue');
    const order: string[] = [];

    // Saturate both concurrency slots with real queue jobs so captureGitChurn's
    // subsequently-queued churn read must wait for a slot alongside the USER job.
    const blockerGates: Array<() => void> = [];
    const blockerJobs = Array.from({ length: 2 }, () =>
      viaGitRead(() => new Promise<void>((resolve) => { blockerGates.push(resolve); })),
    );
    await expect.poll(() => blockerGates.length).toBe(2);

    mockGetChurnSummary.mockImplementation(() => {
      order.push('background');
      return Promise.resolve({ linesAdded: 1, linesRemoved: 1, filesChanged: 1 });
    });

    const { sessionRepo, usageHistoryRepo } = makeRepos();
    // captureGitChurn's internal viaGitRead call queues at BACKGROUND priority,
    // enqueued FIRST (before the userJob below).
    captureGitChurn(makeTask(), sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');

    // A plain (USER-priority, the default) read enqueued AFTER captureGitChurn's
    // job must still run first once a slot frees.
    const userJob = viaGitRead(async () => {
      order.push('user');
    });

    for (const release of blockerGates) release();
    await Promise.all([...blockerJobs, userJob]);
    await flushAsync();

    expect(order).toEqual(['user', 'background']);
  });
});
