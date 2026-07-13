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

function makeRepos(recordIds: string[] = ['record-001']) {
  const sessionSetTaskGitStats = vi.fn();
  const historySetTaskGitStats = vi.fn();
  const listForTaskNewestFirst = vi.fn(() => recordIds.map((id) => ({ id })));
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
});
