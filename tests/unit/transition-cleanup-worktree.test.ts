/**
 * Unit tests for the `cleanup_worktree` transition action
 * (TransitionEngine.executeCleanupWorktree).
 *
 * Pins the two batch-cleanup guarantees that keep the per-project git queue
 * responsive under a multi-card Done drag:
 *   1. `prepareWorktreeForRemoval` (the slow node_modules fs reap) runs
 *      BEFORE the git lock is taken, mirroring task-cleanup.ts - so it never
 *      head-of-line-blocks a spawn waiting on the same project queue.
 *   2. The lock itself is taken at BACKGROUND priority, so a queued spawn
 *      (USER) jumps ahead of a batch of removals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';

const { mockPrepareWorktreeForRemoval, mockRemoveWorktree, mockRemoveBranch, callOrder, withLockOptions } = vi.hoisted(() => ({
  mockPrepareWorktreeForRemoval: vi.fn<(path: string, profile: string) => Promise<void>>(),
  mockRemoveWorktree: vi.fn<(path: string, options?: unknown) => Promise<boolean>>(),
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
    constructor(_projectPath: string) {}
    async withLock<T>(job: () => Promise<T> | T, options?: { label?: string; priority?: number }): Promise<T> {
      callOrder.push('withLock');
      withLockOptions.push(options);
      return job();
    }
    removeWorktree = mockRemoveWorktree;
    removeBranch = mockRemoveBranch;
  },
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: vi.fn(),
    list: vi.fn(() => []),
  },
}));

function makeEngine(options: { autoCleanup?: boolean } = {}) {
  const taskRepo = { update: vi.fn() };
  const actionRepo = {
    getTransitionsFor: vi.fn(() => [{ action_id: 'action-cleanup' }]),
    getById: vi.fn(() => ({ id: 'action-cleanup', type: 'cleanup_worktree', config_json: '{}' })),
  };
  const sessionManager = {
    kill: vi.fn(),
    awaitExit: vi.fn(async () => {}),
  };
  const getConfig = vi.fn(() => ({
    permissionMode: 'default',
    projectPath: '/mock/project',
    projectId: 'proj-1',
    gitConfig: {
      worktreesEnabled: true,
      defaultBaseBranch: 'main',
      autoCleanup: options.autoCleanup ?? false,
      copyFiles: [],
    },
    mcpServerEnabled: false,
    mcpServerUrl: undefined,
    mcpServerToken: undefined,
    defaultAgent: 'claude',
    cliPathOverrides: {},
  }));

  type EngineArgs = ConstructorParameters<typeof TransitionEngine>;
  const engine = new TransitionEngine(
    sessionManager as unknown as EngineArgs[0],
    { submitKeystrokes: vi.fn() } as unknown as EngineArgs[1],
    actionRepo as unknown as EngineArgs[2],
    taskRepo as unknown as EngineArgs[3],
    getConfig as unknown as EngineArgs[4],
    { getLatestForTask: vi.fn(() => null) } as unknown as EngineArgs[5],
    { getPathsForTask: vi.fn(() => []) } as unknown as EngineArgs[6],
  );

  return { engine, taskRepo, sessionManager };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-cleanup-1',
    title: 'Done task',
    description: '',
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/done-task',
    branch_name: 'kangentic/done-task',
    pr_url: null,
    pr_number: null,
    agent: null,
    ...overrides,
  } as never;
}

describe('executeCleanupWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    withLockOptions.length = 0;
    mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
    mockRemoveWorktree.mockResolvedValue(true);
    mockRemoveBranch.mockResolvedValue(undefined);
  });

  it('runs prepareWorktreeForRemoval BEFORE the git lock, at BACKGROUND priority', async () => {
    const { engine, taskRepo } = makeEngine();

    await engine.executeTransition(makeTask(), 'lane-doing', 'lane-done');

    expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith(
      '/mock/project/.kangentic/worktrees/done-task',
      'moderate',
    );
    // The slow fs reap must NOT run inside the per-project git lock.
    expect(callOrder).toEqual(['prepare', 'withLock']);
    expect(withLockOptions[0]).toEqual({
      label: 'transition-cleanup:task-cle',
      priority: 10,
    });
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/mock/project/.kangentic/worktrees/done-task',
      { removalProfile: 'moderate' },
    );
    expect(taskRepo.update).toHaveBeenCalledWith({
      id: 'task-cleanup-1',
      worktree_path: null,
      branch_name: null,
    });
  });

  it('removes the branch inside the lock when autoCleanup is on', async () => {
    const { engine } = makeEngine({ autoCleanup: true });

    await engine.executeTransition(makeTask(), 'lane-doing', 'lane-done');

    expect(mockRemoveBranch).toHaveBeenCalledWith('kangentic/done-task');
  });

  it('preserves DB fields when the removal fails (startup retry relies on them)', async () => {
    mockRemoveWorktree.mockResolvedValue(false);
    const { engine, taskRepo } = makeEngine();

    await engine.executeTransition(makeTask(), 'lane-doing', 'lane-done');

    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(mockRemoveBranch).not.toHaveBeenCalled();
  });

  it('is a no-op when the task has no worktree', async () => {
    const { engine } = makeEngine();

    await engine.executeTransition(makeTask({ worktree_path: null }), 'lane-doing', 'lane-done');

    expect(mockPrepareWorktreeForRemoval).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});
