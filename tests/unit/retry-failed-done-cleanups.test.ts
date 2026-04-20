/**
 * Unit tests for `retryFailedDoneCleanups`.
 *
 * The pass runs on project open / activate-all startup. For every task in
 * the Done column whose `worktree_path` is still populated (meaning the
 * original TASK_MOVE -> Done cleanup failed, typically because orphaned
 * subprocesses held file handles on Windows), it reuses the full
 * WorktreeManager removal flow to try again. On success the DB field is
 * cleared, which also unsticks `ensureWorktree` if the user later drags
 * the task back out of Done.
 *
 * Covers:
 *   - No-op when no Done lane exists
 *   - No-op when no Done task has a worktree_path set
 *   - Successful retry clears worktree_path
 *   - Failed retry leaves worktree_path set for the next startup
 *   - Multiple tasks: mix of successes and failures are handled independently
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRemoveWorktree, mockWithLock } = vi.hoisted(() => ({
  mockRemoveWorktree: vi.fn(async (_path: string): Promise<boolean> => true),
  mockWithLock: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    removeWorktree(path: string) { return mockRemoveWorktree(path); }
    withLock<T>(fn: () => Promise<T>) { return mockWithLock(fn); }
  },
}));

// resource-cleanup imports node:fs, node:path, node:child_process, and
// a few sibling git modules; mock the ones it actually hits during the
// retry pass so imports don't explode.
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    promises: {
      rm: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
    },
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: (...segments: string[]) => segments.join('/'),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('../../src/main/git/node-modules-link', () => ({
  removeNodeModulesPath: vi.fn(async () => {}),
}));

vi.mock('../../src/main/git/rm-with-retry', () => ({
  removeWithRetry: vi.fn(async () => {}),
}));

// withTaskLock: pass-through in tests so the lock contract doesn't affect
// the assertions (production behavior is exercised in the lock's own tests).
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: <T,>(_taskId: string, fn: () => Promise<T>) => fn(),
}));

import { retryFailedDoneCleanups } from '../../src/main/engine/resource-cleanup';

interface MockTask {
  id: string;
  title: string;
  worktree_path: string | null;
}

function makeSwimlaneRepo(lanes: Array<{ id: string; role: string | null; name: string }>) {
  return { list: vi.fn(() => lanes) };
}

function makeTaskRepo(tasksByLane: Record<string, MockTask[]>) {
  const allTasks = Object.values(tasksByLane).flat();
  const update = vi.fn((patch: Partial<MockTask> & { id: string }) => {
    const target = allTasks.find((task) => task.id === patch.id);
    if (target) Object.assign(target, patch);
  });
  return {
    update,
    list: vi.fn((laneId?: string) => (laneId ? tasksByLane[laneId] ?? [] : [])),
    listArchived: vi.fn(() => []),
    // retryFailedDoneCleanups uses listAllInSwimlane so it sees archived
    // Done tasks (which is the entire reason this pass exists). The mock
    // returns the same set as `list` because the test fixtures don't
    // distinguish active from archived - the production query difference
    // (`archived_at IS NULL` vs no filter) is what matters at the SQL layer.
    listAllInSwimlane: vi.fn((laneId: string) => tasksByLane[laneId] ?? []),
    // retryFailedDoneCleanups re-reads the task inside withTaskLock to avoid
    // racing with concurrent TASK_MOVEs. Mock getById to return the current
    // (mutable) task object so `update` effects are visible.
    getById: vi.fn((id: string) => allTasks.find((task) => task.id === id)),
  };
}

const PROJECT_PATH = '/home/dev/my-project';

describe('retryFailedDoneCleanups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveWorktree.mockResolvedValue(true);
    mockWithLock.mockImplementation(async (fn) => fn());
  });

  it('returns 0 when no Done lane exists', async () => {
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-todo', role: 'todo', name: 'To Do' },
    ]);
    const taskRepo = makeTaskRepo({});

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    expect(result).toBe(0);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('returns 0 when no Done task has a worktree_path set', async () => {
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-done', role: 'done', name: 'Done' },
    ]);
    const taskRepo = makeTaskRepo({
      'lane-done': [
        { id: 'aaaa1111', title: 'Already cleaned', worktree_path: null },
      ],
    });

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    expect(result).toBe(0);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('clears worktree_path when the retry succeeds', async () => {
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-done', role: 'done', name: 'Done' },
    ]);
    const taskRepo = makeTaskRepo({
      'lane-done': [
        { id: 'bbbb2222', title: 'Stuck task', worktree_path: '/home/dev/my-project/.kangentic/worktrees/stuck-bbbb2222' },
      ],
    });
    mockRemoveWorktree.mockResolvedValue(true);

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    expect(result).toBe(1);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/home/dev/my-project/.kangentic/worktrees/stuck-bbbb2222');
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'bbbb2222', worktree_path: null });
  });

  it('leaves worktree_path set when the retry fails, so the next startup can try again', async () => {
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-done', role: 'done', name: 'Done' },
    ]);
    const taskRepo = makeTaskRepo({
      'lane-done': [
        { id: 'cccc3333', title: 'Still locked', worktree_path: '/home/dev/my-project/.kangentic/worktrees/locked-cccc3333' },
      ],
    });
    mockRemoveWorktree.mockResolvedValue(false);

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    expect(result).toBe(0);
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it('does not remove worktree when a concurrent TASK_MOVE clears worktree_path before the lock is acquired', async () => {
    // Simulates the race condition where `taskRepo.list(doneLaneId)` returns a
    // task with worktree_path set, but by the time `withTaskLock` runs and
    // `getById` re-reads it, a concurrent TASK_MOVE has already cleared the
    // field (e.g. user dragged the task back to In Progress).
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-done', role: 'done', name: 'Done' },
    ]);
    const taskRepo = makeTaskRepo({
      'lane-done': [
        { id: 'dddd4444', title: 'Concurrent move task', worktree_path: '/home/dev/my-project/.kangentic/worktrees/concurrent-dddd4444' },
      ],
    });

    // Override getById to simulate the concurrent TASK_MOVE having cleared
    // worktree_path by the time the lock block re-reads the task.
    taskRepo.getById.mockImplementation((_id: string) => ({
      id: 'dddd4444',
      title: 'Concurrent move task',
      worktree_path: null, // already cleared by the concurrent move
    }));

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    // The concurrent TASK_MOVE already handled this task - we must not remove
    // the worktree or write to the DB again.
    expect(result).toBe(0);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it('uses listAllInSwimlane (not list) so archived Done tasks are picked up', async () => {
    // Regression guard: tasks moved to Done are archived synchronously in
    // task-move.ts, which means `taskRepo.list(doneLaneId)` filters them out
    // (via WHERE archived_at IS NULL). If retryFailedDoneCleanups uses `list`,
    // every failed Done-cleanup becomes permanent because the retry pass
    // never sees the task again. The fix is to use `listAllInSwimlane`,
    // which ignores `archived_at`.
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-done', role: 'done', name: 'Done' },
    ]);
    const taskRepo = makeTaskRepo({
      'lane-done': [
        { id: 'eeee5555', title: 'Archived stuck task', worktree_path: '/home/dev/my-project/.kangentic/worktrees/archived-eeee5555' },
      ],
    });
    // Simulate the production behavior precisely: `list` (active-only) returns
    // nothing because the Done task is archived. `listAllInSwimlane` is the
    // only path that returns it.
    taskRepo.list.mockReturnValue([]);

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    expect(taskRepo.listAllInSwimlane).toHaveBeenCalledWith('lane-done');
    expect(taskRepo.list).not.toHaveBeenCalled();
    expect(result).toBe(1);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/home/dev/my-project/.kangentic/worktrees/archived-eeee5555');
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'eeee5555', worktree_path: null });
  });

  it('handles a mix of successes and failures across multiple Done tasks', async () => {
    const swimlaneRepo = makeSwimlaneRepo([
      { id: 'lane-done', role: 'done', name: 'Done' },
    ]);
    const taskRepo = makeTaskRepo({
      'lane-done': [
        { id: 'aaaa1111', title: 'Will clean', worktree_path: '/home/dev/my-project/.kangentic/worktrees/clean-aaaa1111' },
        { id: 'bbbb2222', title: 'Still stuck', worktree_path: '/home/dev/my-project/.kangentic/worktrees/stuck-bbbb2222' },
        { id: 'cccc3333', title: 'Will clean too', worktree_path: '/home/dev/my-project/.kangentic/worktrees/clean-cccc3333' },
      ],
    });
    mockRemoveWorktree.mockImplementation(async (path: string) => !path.includes('stuck'));

    const result = await retryFailedDoneCleanups(PROJECT_PATH, taskRepo as never, swimlaneRepo as never);

    expect(result).toBe(2);
    expect(taskRepo.update).toHaveBeenCalledTimes(2);
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'aaaa1111', worktree_path: null });
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'cccc3333', worktree_path: null });
    expect(taskRepo.update).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'bbbb2222' }));
  });
});
