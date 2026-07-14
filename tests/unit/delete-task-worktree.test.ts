import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock WorktreeManager: the helper constructs `new WorktreeManager(projectPath)`
// and calls `withLock(fn)` + `removeWorktree(path)`. We capture the last-created
// instance so each test can configure its behavior and assert against it.
const {
  worktreeManagerInstances,
  mockRemoveWorktree,
  mockPrepareWorktreeForRemoval,
  mockPruneWorktrees,
  mockRemoveBranch,
  callOrder,
  withLockOptions,
} = vi.hoisted(() => ({
  worktreeManagerInstances: [] as Array<{ removeWorktree: ReturnType<typeof vi.fn>; withLock: ReturnType<typeof vi.fn> }>,
  mockRemoveWorktree: vi.fn<(path: string, options?: unknown) => Promise<boolean>>(),
  mockPrepareWorktreeForRemoval: vi.fn<(path: string, profile: string) => Promise<void>>(),
  mockPruneWorktrees: vi.fn<() => Promise<void>>(),
  mockRemoveBranch: vi.fn<(branch: string) => Promise<void>>(),
  callOrder: [] as string[],
  withLockOptions: [] as Array<{ label?: string; priority?: number } | undefined>,
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  GitQueuePriority: { USER: 0, BACKGROUND: 10 },
  prepareWorktreeForRemoval: (...args: [string, string]) => {
    callOrder.push('prepare');
    return mockPrepareWorktreeForRemoval(...args);
  },
  WorktreeManager: class {
    removeWorktree = mockRemoveWorktree;
    pruneWorktrees = mockPruneWorktrees;
    removeBranch = mockRemoveBranch;
    withLock = vi.fn(async (operation: () => Promise<unknown>, options?: { label?: string; priority?: number }) => {
      callOrder.push('withLock');
      withLockOptions.push(options);
      return operation();
    });
    constructor() {
      worktreeManagerInstances.push({ removeWorktree: this.removeWorktree, withLock: this.withLock });
    }
  },
}));

// Mock the live-HEAD reader so each test controls the branch/sha the helper
// captures before removal, without a real git repo.
const { mockReadWorktreeHead } = vi.hoisted(() => ({
  mockReadWorktreeHead: vi.fn<(path: string) => Promise<{ branch: string | null; sha: string | null }>>(),
}));

vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: mockReadWorktreeHead,
}));

// DB-layer mocks aren't exercised by deleteTaskWorktree (it doesn't touch the
// session repo or DB), but the module imports them at the top level.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));

import { deleteTaskWorktree, cleanupTaskResources } from '../../src/main/ipc/helpers/task-cleanup';

type MockTaskRepo = { update: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn> };
type MockContext = {
  currentProjectPath: string | null;
  sessionManager: Record<string, unknown>;
  configManager: Record<string, unknown>;
};

function createMockTaskRepo(): MockTaskRepo {
  // getById defaults to truthy so the branch write-back's concurrent-delete
  // guard passes; tests that exercise the guard override it.
  return { update: vi.fn(), getById: vi.fn(() => ({ id: 'task' })) };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectPath: '/mock/project',
    sessionManager: {},
    configManager: {},
    ...overrides,
  };
}

describe('deleteTaskWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worktreeManagerInstances.length = 0;
    callOrder.length = 0;
    withLockOptions.length = 0;
    mockRemoveWorktree.mockReset();
    mockPrepareWorktreeForRemoval.mockReset();
    mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
    mockPruneWorktrees.mockReset();
    mockPruneWorktrees.mockImplementation(async () => { callOrder.push('pruneWorktrees'); });
    mockRemoveBranch.mockReset();
    mockRemoveBranch.mockImplementation(async () => { callOrder.push('removeBranch'); });
    // Default: detached / unreadable HEAD (matches a worktree git can't probe).
    mockReadWorktreeHead.mockReset();
    mockReadWorktreeHead.mockResolvedValue({ branch: null, sha: null });
  });

  it('removes the worktree dir and nulls worktree_path, preserving branch_name', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-1',
      worktree_path: '/mock/project/.kangentic/worktrees/task-1-abcd',
      branch_name: 'feature-x-abcd',
    };

    mockRemoveWorktree.mockResolvedValue(true);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(true);
    expect(mockRemoveWorktree).toHaveBeenCalledWith(task.worktree_path, { removalProfile: 'moderate' });
    // The orphan reap + node_modules clear runs BEFORE the git lock is taken,
    // so the slow fs work does not hold the per-project queue.
    expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith(task.worktree_path, 'moderate');
    expect(callOrder).toEqual(['prepare', 'withLock']);
    // Removal runs at BACKGROUND priority on the per-project git queue so a
    // batch of Done-move removals never parks a fresh spawn waiting at USER.
    expect(withLockOptions[0]).toEqual({ label: 'remove-worktree:task-1', priority: 10 });
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-1', worktree_path: null });
    // Critical: branch_name is NOT cleared. Moving out of Done re-creates the
    // worktree from the preserved branch.
    const updateArgs = tasks.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArgs).not.toHaveProperty('branch_name');
    expect(updateArgs).not.toHaveProperty('session_id');
  });

  it('returns false and is a no-op when task has no worktree_path', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = { id: 'task-2', worktree_path: null, branch_name: 'something-else' };

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('returns false and is a no-op when no project path is available', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext({ currentProjectPath: null });
    const task = {
      id: 'task-3',
      worktree_path: '/some/path',
      branch_name: 'branch-3',
    };

    const result = await deleteTaskWorktree(context as never, task, tasks as never, null);

    expect(result).toBe(false);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('returns false and does not null worktree_path when the directory could not be removed', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-4',
      worktree_path: '/mock/project/.kangentic/worktrees/task-4-abcd',
      branch_name: 'branch-4',
    };

    mockRemoveWorktree.mockResolvedValue(false);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    expect(mockRemoveWorktree).toHaveBeenCalled();
    // worktree_path preserved so the next attempt retries the removal
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('swallows worktree manager errors, returns false, and leaves DB unchanged', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-5',
      worktree_path: '/mock/project/.kangentic/worktrees/task-5-abcd',
      branch_name: 'branch-5',
    };

    mockRemoveWorktree.mockRejectedValue(new Error('locked file'));

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('writes the renamed live branch back to branch_name before removal', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-6',
      worktree_path: '/mock/project/.kangentic/worktrees/task-6-abcd',
      branch_name: 'kangentic/task-6-abcd',
    };

    // Agent renamed the branch inside the worktree to a team convention.
    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/real-work', sha: 'deadbeef' });
    mockRemoveWorktree.mockResolvedValue(true);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(true);
    // First update is the branch write-back, ahead of removal.
    expect(tasks.update).toHaveBeenNthCalledWith(1, { id: 'task-6', branch_name: 'feat/real-work' });
    // Second update nulls worktree_path and persists the captured SHA.
    expect(tasks.update).toHaveBeenNthCalledWith(2, { id: 'task-6', worktree_path: null, head_sha: 'deadbeef' });
  });

  it('persists the branch write-back even when the removal fails', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-7',
      worktree_path: '/mock/project/.kangentic/worktrees/task-7-abcd',
      branch_name: 'kangentic/task-7-abcd',
    };

    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/kept', sha: 'cafe1234' });
    mockRemoveWorktree.mockResolvedValue(false);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    // The corrected name is persisted so the startup retry pass deletes the dir
    // with accurate DB state; worktree_path stays set for that retry.
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-7', branch_name: 'feat/kept' });
  });

  it('does not write branch_name back when the live branch matches the stored slug', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-8',
      worktree_path: '/mock/project/.kangentic/worktrees/task-8-abcd',
      branch_name: 'feat/unchanged',
    };

    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/unchanged', sha: 'beef5678' });
    mockRemoveWorktree.mockResolvedValue(true);

    await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    // Only the removal update, no redundant branch write-back.
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-8', worktree_path: null, head_sha: 'beef5678' });
  });

  it('skips the branch write-back when the task row is already gone (concurrent delete)', async () => {
    const tasks = createMockTaskRepo();
    tasks.getById.mockReturnValue(undefined);
    const context = createMockContext();
    const task = {
      id: 'task-9',
      worktree_path: '/mock/project/.kangentic/worktrees/task-9-abcd',
      branch_name: 'kangentic/task-9-abcd',
    };

    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/renamed', sha: 'face9999' });
    mockRemoveWorktree.mockResolvedValue(true);

    await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    // No branch write-back; only the removal-path update (which getById does not gate).
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-9', worktree_path: null, head_sha: 'face9999' });
  });
});

// ---------------------------------------------------------------------------
// cleanupTaskResources: the worktree-removal block's ordering + lock options.
//
// cleanupTaskResources first calls cleanupTaskSession (session/DB cleanup;
// forced to a clean no-op below via session_id: null and no currentProjectId,
// so resolvedProjectId is falsy and the DB-touching branch never runs), then
// runs the worktree-removal block under test:
//   prepareWorktreeForRemoval (BEFORE the lock) -> withLock(removeWorktree,
//   then conditionally pruneWorktrees + removeBranch) with
//   { label: 'cleanup-worktree:<id8>', priority: GitQueuePriority.BACKGROUND }.
// ---------------------------------------------------------------------------

describe('cleanupTaskResources', () => {
  type CleanupMockContext = MockContext & {
    sessionManager: { removeByTaskId: ReturnType<typeof vi.fn> };
    configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  };

  function createCleanupContext(autoCleanup: boolean): CleanupMockContext {
    return {
      currentProjectPath: '/mock/project',
      sessionManager: { removeByTaskId: vi.fn() },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup } })) },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    worktreeManagerInstances.length = 0;
    callOrder.length = 0;
    withLockOptions.length = 0;
    mockRemoveWorktree.mockReset();
    mockPrepareWorktreeForRemoval.mockReset();
    mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
    mockPruneWorktrees.mockReset();
    mockPruneWorktrees.mockImplementation(async () => { callOrder.push('pruneWorktrees'); });
    mockRemoveBranch.mockReset();
    mockRemoveBranch.mockImplementation(async () => { callOrder.push('removeBranch'); });
  });

  it('prepares before the git lock and removes at cleanup-worktree:<id8> BACKGROUND priority; session cleanup no-ops', async () => {
    const tasks = createMockTaskRepo();
    const context = createCleanupContext(false);
    const task = {
      id: 'task-10',
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-10-abcd',
      branch_name: 'feature-10',
    };

    mockRemoveWorktree.mockResolvedValue(true);

    await cleanupTaskResources(context as never, task, tasks as never, undefined, context.currentProjectPath);

    // Same ordering contract as deleteTaskWorktree: the orphan reap runs
    // BEFORE the git lock is taken.
    expect(callOrder).toEqual(['prepare', 'withLock']);
    expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith(task.worktree_path, 'moderate');
    // Distinct label from deleteTaskWorktree's remove-worktree:<id8>, and
    // BACKGROUND priority so a batch of cleanups never parks a fresh spawn
    // waiting at USER on the project's git queue.
    expect(withLockOptions[0]).toEqual({ label: 'cleanup-worktree:task-10', priority: 10 });
    expect(mockRemoveWorktree).toHaveBeenCalledWith(task.worktree_path, { removalProfile: 'moderate' });
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-10', worktree_path: null, branch_name: null });

    // autoCleanup is false: prune/removeBranch must NOT run even though the
    // task has a branch_name and the removal succeeded.
    expect(mockPruneWorktrees).not.toHaveBeenCalled();
    expect(mockRemoveBranch).not.toHaveBeenCalled();

    // cleanupTaskSession's no-op path was actually exercised (task.session_id
    // is null, so the kill/awaitExit/remove branch is skipped), not silently
    // short-circuited before reaching the worktree-removal block: the
    // unconditional safety-net call still fires.
    expect(context.sessionManager.removeByTaskId).toHaveBeenCalledWith('task-10');
  });

  it('with autoCleanup enabled, prunes and removes the branch INSIDE the lock, after removeWorktree succeeds', async () => {
    const tasks = createMockTaskRepo();
    const context = createCleanupContext(true);
    const task = {
      id: 'task-11',
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-11-abcd',
      branch_name: 'feature-11',
    };

    mockRemoveWorktree.mockResolvedValue(true);

    await cleanupTaskResources(context as never, task, tasks as never, undefined, context.currentProjectPath);

    // pruneWorktrees/removeBranch both fire, and only AFTER withLock has been
    // entered (i.e. as part of the locked operation, following removeWorktree
    // - they are gated on `removed` inside that same callback).
    expect(callOrder).toEqual(['prepare', 'withLock', 'pruneWorktrees', 'removeBranch']);
    expect(mockRemoveBranch).toHaveBeenCalledWith('feature-11');
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-11', worktree_path: null, branch_name: null });
  });

  it('does not prune or remove the branch when removeWorktree fails, even with autoCleanup enabled', async () => {
    const tasks = createMockTaskRepo();
    const context = createCleanupContext(true);
    const task = {
      id: 'task-12',
      session_id: null,
      worktree_path: '/mock/project/.kangentic/worktrees/task-12-abcd',
      branch_name: 'feature-12',
    };

    mockRemoveWorktree.mockResolvedValue(false);

    await cleanupTaskResources(context as never, task, tasks as never, undefined, context.currentProjectPath);

    expect(mockPruneWorktrees).not.toHaveBeenCalled();
    expect(mockRemoveBranch).not.toHaveBeenCalled();
    // worktree_path/branch_name preserved so a retry pass can pick it back up.
    expect(tasks.update).not.toHaveBeenCalled();
  });
});
