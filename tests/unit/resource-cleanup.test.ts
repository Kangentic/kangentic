import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockExistsSync, mockRm, mockReaddir, mockExecFile } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => false),
  mockRm: vi.fn(async () => {}),
  mockReaddir: vi.fn(async () => []),
  mockExecFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    promises: {
      rm: mockRm,
      readdir: mockReaddir,
    },
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: (...segments: string[]) => segments.join('/'),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: typeof mockExecFile) => (...args: unknown[]) => new Promise((resolve, reject) => {
    fn(...args, (error: Error | null, stdout: string, stderr: string) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  }),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { cleanupStaleResources, cleanupStaleResourcesAsync, pruneOrphanedWorktreeTasks, pruneOrphanedDirectories } from '../../src/main/engine/resource-cleanup';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  title: string;
  worktree_path: string | null;
  branch_name: string | null;
  session_id: string | null;
}

function createMockTask(overrides: Partial<MockTask> & { id: string; title: string }): MockTask {
  return {
    worktree_path: null,
    branch_name: null,
    session_id: null,
    ...overrides,
  };
}

function createMockRepos(backlogTasks: MockTask[] = []) {
  const swimlaneRepo = {
    list: vi.fn(() => [
      { id: 'lane-backlog', role: 'todo', name: 'To Do' },
      { id: 'lane-planning', role: null, name: 'Planning' },
    ]),
  };

  const taskRepo = {
    list: vi.fn((laneId?: string) => {
      if (laneId === 'lane-backlog') return backlogTasks;
      return [];
    }),
    listArchived: vi.fn(() => []),
    update: vi.fn(),
  };

  const sessionRepo = {
    deleteByTaskId: vi.fn(),
    listAllSessionIds: vi.fn(() => []),
  };

  const sessionManager = {
    remove: vi.fn(),
    listSessions: vi.fn(() => []),
  };

  return { swimlaneRepo, taskRepo, sessionRepo, sessionManager };
}

/** Helper: configure mockExecFile to call back with success or error */
function setupExecFile(handler: (cmd: string, args: string[]) => void) {
  mockExecFile.mockImplementation((cmd: string, args: string[], options: unknown, callback?: Function) => {
    // execFile can be called with or without options
    const actualCallback = typeof options === 'function' ? options : callback;
    try {
      handler(cmd, args);
      actualCallback?.(null, '', '');
    } catch (error) {
      actualCallback?.(error, '', '');
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupStaleResources', () => {
  const projectPath = '/home/dev/my-project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    setupExecFile(() => '');
  });

  it('completes without errors when no backlog lane exists', async () => {
    const swimlaneRepo = { list: vi.fn(() => [{ id: 'lane-1', role: null }]) };
    const taskRepo = { list: vi.fn(() => []), listArchived: vi.fn(() => []), update: vi.fn() };
    const sessionRepo = { deleteByTaskId: vi.fn(), listAllSessionIds: vi.fn(() => []) };
    const sessionManager = { remove: vi.fn(), listSessions: vi.fn(() => []) };

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // No cleanup actions taken
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('skips tasks with no stale resources', async () => {
    const cleanTask = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'Clean task',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([cleanTask]);

    // No stale directory, no stale branch
    mockExistsSync.mockReturnValue(false);
    // branchExists: git rev-parse --verify throws -> branch does not exist
    setupExecFile(() => { throw new Error('not found'); });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('cleans task with stale DB fields (worktree_path, branch_name, session_id)', async () => {
    const staleTask = createMockTask({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      title: 'Fix login bug',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222',
      branch_name: 'fix-login-bug-bbbb2222',
      session_id: 'session-123',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([staleTask]);

    // DB-recorded worktree path exists on disk
    mockExistsSync.mockImplementation((pathArg: string) =>
      pathArg === '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222',
    );

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Session killed
    expect(sessionManager.remove).toHaveBeenCalledWith('session-123');

    // Session records deleted
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('bbbb2222-0000-0000-0000-000000000000');

    // Directory removed via git worktree remove --force
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222'],
      { cwd: projectPath },
      expect.any(Function),
    );

    // DB fields cleared
    expect(taskRepo.update).toHaveBeenCalledWith({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      worktree_path: null,
      branch_name: null,
      session_id: null,
    });

    // git worktree prune called once (catch-all for metadata)
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['worktree', 'prune'], { cwd: projectPath }, expect.any(Function),
    );

    // Branch deleted
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'fix-login-bug-bbbb2222'], { cwd: projectPath }, expect.any(Function),
    );
  });

  it('cleans task with null DB fields but stale directory on disk (core bug fix)', async () => {
    const task = createMockTask({
      id: 'cccc3333-0000-0000-0000-000000000000',
      title: 'Add dark mode',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    const expectedPath = '/home/dev/my-project/.kangentic/worktrees/add-dark-mode-cccc3333';
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === expectedPath);

    // Branch exists on disk (git rev-parse succeeds for the expected branch)
    setupExecFile((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[2] === 'add-dark-mode-cccc3333') {
        return; // branch exists
      }
      throw new Error('not found');
    });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Directory removed via git worktree remove --force
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', expectedPath],
      { cwd: projectPath },
      expect.any(Function),
    );

    // Session records still cleaned (defensive)
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('cccc3333-0000-0000-0000-000000000000');

    // Branch deleted
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'add-dark-mode-cccc3333'], { cwd: projectPath }, expect.any(Function),
    );

    // DB update NOT called (no stale DB fields to clear)
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it('handles session removal failure gracefully', async () => {
    const task = createMockTask({
      id: 'dddd4444-0000-0000-0000-000000000000',
      title: 'Refactor auth',
      session_id: 'dead-session',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);
    sessionManager.remove.mockImplementation(() => { throw new Error('session already dead'); });
    // branchExists: no branch
    setupExecFile(() => { throw new Error('not found'); });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Should still clean up despite session removal failure
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dddd4444-0000-0000-0000-000000000000',
      session_id: null,
    }));
  });

  it('runs git worktree prune once after all directories, not per-task', async () => {
    const tasks = [
      createMockTask({ id: 'eeee5555-0000-0000-0000-000000000000', title: 'Task one', branch_name: 'task-one-eeee5555' }),
      createMockTask({ id: 'ffff6666-0000-0000-0000-000000000000', title: 'Task two', branch_name: 'task-two-ffff6666' }),
    ];
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos(tasks);
    // branchExists: no branches on disk
    setupExecFile(() => { throw new Error('not found'); });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Prune called exactly once (not once per task)
    const pruneCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])[0] === 'worktree' && (call[1] as string[])[1] === 'prune',
    );
    expect(pruneCalls).toHaveLength(1);
  });

  it('falls back to fs.promises.rm when git worktree remove fails', async () => {
    const worktreePath = '/home/dev/my-project/.kangentic/worktrees/retry-test-aaaa1111';
    const task = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'Retry test',
      worktree_path: worktreePath,
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreePath);

    // git worktree remove fails
    setupExecFile((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('failed to remove');
      }
      // branchExists: no branch on disk
      throw new Error('not found');
    });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // git worktree remove --force attempted
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: projectPath },
      expect.any(Function),
    );
    // Async rm fallback
    expect(mockRm).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
  });

  it('cleans both DB-recorded and expected paths when they differ (renamed task)', async () => {
    const task = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'New title',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/old-title-aaaa1111',
      branch_name: 'old-title-aaaa1111',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    // Both old and new paths exist
    mockExistsSync.mockReturnValue(true);

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Both paths attempted for removal via git worktree remove --force
    const worktreeRemoveCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])[0] === 'worktree' && (call[1] as string[])[1] === 'remove',
    );
    const removedPaths = worktreeRemoveCalls.map(call => (call[1] as string[])[3]);
    expect(removedPaths).toContain('/home/dev/my-project/.kangentic/worktrees/old-title-aaaa1111');
    expect(removedPaths).toContain('/home/dev/my-project/.kangentic/worktrees/new-title-aaaa1111');

    // Both branches queued for deletion
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'old-title-aaaa1111'], expect.anything(), expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'new-title-aaaa1111'], expect.anything(), expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanedWorktreeTasks -- runs as pass 1 of cleanupStaleResources
// ---------------------------------------------------------------------------

/**
 * Factory for tests that need `taskRepo.list()` (unfiltered) to return a
 * populated list. The existing `createMockRepos` only returns tasks when
 * filtered by the backlog lane ID, which doesn't exercise the orphan-prune
 * path.
 */
function createMockReposWithAllTasks(allTasks: MockTask[]) {
  const swimlaneRepo = {
    list: vi.fn(() => [
      { id: 'lane-backlog', role: 'todo', name: 'To Do' },
      { id: 'lane-planning', role: null, name: 'Planning' },
    ]),
  };

  const taskRepo = {
    list: vi.fn((laneId?: string) => {
      // Backlog cleanup pass filters by lane - return nothing so we do not
      // accidentally exercise that path in these tests.
      if (laneId === 'lane-backlog') return [];
      return allTasks;
    }),
    listArchived: vi.fn(() => []),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const sessionRepo = {
    deleteByTaskId: vi.fn(),
    listAllSessionIds: vi.fn(() => []),
  };

  const sessionManager = {
    remove: vi.fn(),
    listSessions: vi.fn(() => []),
  };

  return { swimlaneRepo, taskRepo, sessionRepo, sessionManager };
}

describe('cleanupStaleResources -- pruneOrphanedWorktreeTasks pass', () => {
  const projectPath = '/home/dev/my-project';
  const worktreesDir = '/home/dev/my-project/.kangentic/worktrees';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    setupExecFile(() => '');
  });

  it('deletes a task whose worktree directory has been removed externally', async () => {
    const orphanTask = createMockTask({
      id: 'orphan11-0000-0000-0000-000000000000',
      title: 'Orphan task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/orphan-task-orphan11',
      branch_name: 'orphan-task-orphan11',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([orphanTask]);

    // Worktrees parent dir exists; orphan task's specific dir does NOT.
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );
    expect(taskRepo.delete).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );
  });

  it('preserves a task whose worktree directory still exists', async () => {
    const keepTask = createMockTask({
      id: 'keep1111-0000-0000-0000-000000000000',
      title: 'Keep task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/keep-task-keep1111',
      branch_name: 'keep-task-keep1111',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([keepTask]);

    // Both the worktrees parent dir and the task's worktree dir exist.
    mockExistsSync.mockReturnValue(true);

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.delete).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('prunes the orphan but keeps the sibling task that still exists', async () => {
    const orphanTask = createMockTask({
      id: 'orphan11-0000-0000-0000-000000000000',
      title: 'Orphan task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/orphan-orphan11',
      branch_name: 'orphan-orphan11',
    });
    const keepTask = createMockTask({
      id: 'keep1111-0000-0000-0000-000000000000',
      title: 'Keep task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/keep-keep1111',
      branch_name: 'keep-keep1111',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([orphanTask, keepTask]);

    // worktrees dir + keepTask's dir exist; orphanTask's dir does not.
    mockExistsSync.mockImplementation((pathArg: string) =>
      pathArg === worktreesDir || pathArg === keepTask.worktree_path,
    );

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.delete).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );
    expect(taskRepo.delete).not.toHaveBeenCalledWith(
      'keep1111-0000-0000-0000-000000000000',
    );
  });

  it('does not prune a task with an active session even if its worktree dir is missing', async () => {
    const activeTask = createMockTask({
      id: 'active11-0000-0000-0000-000000000000',
      title: 'Active task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/active-active11',
      branch_name: 'active-active11',
      session_id: 'session-abc',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([activeTask]);

    // Worktrees dir exists; task's worktree dir does NOT.
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    // Active session running for this task.
    sessionManager.listSessions = vi.fn(() => [
      { id: 'session-abc', taskId: 'active11-0000-0000-0000-000000000000', status: 'running' },
    ]);

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.delete).not.toHaveBeenCalled();
  });

  it('skips pruning entirely when the worktrees parent directory does not exist', async () => {
    const orphanTask = createMockTask({
      id: 'orphan11-0000-0000-0000-000000000000',
      title: 'Orphan task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/orphan-orphan11',
      branch_name: 'orphan-orphan11',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([orphanTask]);

    // Worktrees dir missing - possibly an unmounted drive. Do not prune.
    mockExistsSync.mockReturnValue(false);

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.delete).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('does not prune tasks that have no worktree_path recorded', async () => {
    const backlogTask = createMockTask({
      id: 'noworkt1-0000-0000-0000-000000000000',
      title: 'Backlog task',
      worktree_path: null,
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([backlogTask]);

    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sync-ordering contract: pruneOrphanedWorktreeTasks must complete before
// any microtask yields, so session recovery can read a clean DB after the
// call without awaiting. Startup code in projects.ts depends on this.
// ---------------------------------------------------------------------------

describe('pruneOrphanedWorktreeTasks sync contract', () => {
  const projectPath = '/home/dev/my-project';
  const worktreesDir = '/home/dev/my-project/.kangentic/worktrees';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('is a synchronous function (does not return a Promise)', () => {
    const { taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([]);

    const result: unknown = pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { then?: unknown }).then).toBeUndefined();
  });

  it('completes pruning before cleanupStaleResourcesAsync yields', async () => {
    const orphanTask = createMockTask({
      id: 'orphan11-0000-0000-0000-000000000000',
      title: 'Orphan task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/orphan-orphan11',
      branch_name: 'orphan-orphan11',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([orphanTask]);

    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    // Emulate the startup call pattern exactly: sync prune, then fire the
    // async tail without awaiting.
    pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );
    const asyncTail = cleanupStaleResourcesAsync(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // At this synchronous point - before any await - the orphan task must
    // already be deleted. Session recovery reads the DB in exactly this
    // position in the real startup sequence.
    expect(taskRepo.delete).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );

    await asyncTail;
  });
});

// ---------------------------------------------------------------------------
// pruneDirectory warn-and-continue path
// When removeWithRetry exhausts its retries for one orphan, a warn is emitted
// AND processing continues for subsequent orphans.
// ---------------------------------------------------------------------------

describe('pruneOrphanedDirectories -- pruneDirectory warn-and-continue', () => {
  const projectPath = '/home/dev/my-project';

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    setupExecFile(() => '');
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('warns on the failing orphan and still removes the subsequent orphan', async () => {
    vi.useFakeTimers();

    // Two orphaned session directories. Neither is referenced by any task.
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (String(dirPath).includes('sessions')) {
        return [
          { name: 'bad-session', isDirectory: () => true },
          { name: 'good-session', isDirectory: () => true },
        ];
      }
      return [];
    });

    // bad-session: fs.promises.rm always rejects (simulates a locked handle that
    // never releases). removeWithRetry retries over [0, 100, 500, 2000] ms.
    // good-session: fs.promises.rm succeeds.
    mockRm.mockImplementation(async (_path: string) => {
      if (String(_path).includes('bad-session')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
    });

    const taskRepo = {
      list: vi.fn(() => []),
      listArchived: vi.fn(() => []),
    };
    const sessionRepo = { listAllSessionIds: vi.fn(() => []) };
    const sessionManager = { listSessions: vi.fn(() => []) };

    const resultPromise = pruneOrphanedDirectories(
      projectPath,
      taskRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Drive the full 0 + 100 + 500 + 2000 = 2600 ms retry window for bad-session.
    // The retry loop for bad-session runs first; once exhausted, the loop
    // continues to good-session which resolves immediately.
    await vi.advanceTimersByTimeAsync(2600);
    await resultPromise;

    // A warning must be emitted for the failing orphan.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[RESOURCE_CLEANUP] Could not remove orphaned session directory: bad-session'),
    );

    // The second orphan (good-session) must still be removed despite the earlier failure.
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('good-session'),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// removeWorktreeDirectory exhaustion path
// When git worktree remove fails AND removeWithRetry exhausts all retries,
// a warning is emitted and the function returns false (does not throw).
// ---------------------------------------------------------------------------

describe('cleanupStaleResources -- removeWorktreeDirectory exhaustion path', () => {
  const projectPath = '/home/dev/my-project';

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    setupExecFile(() => '');
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('warns and continues when both git worktree remove and removeWithRetry fail for a backlog task', async () => {
    vi.useFakeTimers();

    const worktreePath = '/home/dev/my-project/.kangentic/worktrees/locked-task-aaaa1111';
    const task = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'Locked task',
      worktree_path: worktreePath,
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    // The worktree directory exists on disk.
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreePath);

    // git worktree remove --force fails.
    setupExecFile((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('fatal: failed to remove worktree');
      }
      throw new Error('not found');
    });

    // fs.promises.rm persistently fails (simulates a process still holding handles).
    mockRm.mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
    );

    const resultPromise = cleanupStaleResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Drive the full 0 + 100 + 500 + 2000 = 2600 ms retry window.
    await vi.advanceTimersByTimeAsync(2600);
    await resultPromise;

    // A warning must be emitted - the exhaustion path in removeWorktreeDirectory
    // calls console.warn, not console.error, so cleanup keeps running.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[RESOURCE_CLEANUP] Could not remove worktree directory:'),
    );

    // The task's DB fields must still be cleared (cleanup continues past the failure).
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      worktree_path: null,
    }));
  });
});
