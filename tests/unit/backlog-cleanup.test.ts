import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockExistsSync, mockRmSync, mockExecFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => false),
  mockRmSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    rmSync: mockRmSync,
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: (...segments: string[]) => segments.join('/'),
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { cleanBacklogTaskResources } from '../../src/main/engine/backlog-cleanup';

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
      { id: 'lane-backlog', role: 'backlog', name: 'Backlog' },
      { id: 'lane-planning', role: null, name: 'Planning' },
    ]),
  };

  const taskRepo = {
    list: vi.fn((laneId?: string) => {
      if (laneId === 'lane-backlog') return backlogTasks;
      return [];
    }),
    update: vi.fn(),
  };

  const sessionRepo = {
    deleteByTaskId: vi.fn(),
  };

  const sessionManager = {
    remove: vi.fn(),
  };

  return { swimlaneRepo, taskRepo, sessionRepo, sessionManager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanBacklogTaskResources', () => {
  const projectPath = '/home/dev/my-project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRmSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => '');
  });

  it('returns 0 when no backlog lane exists', () => {
    const swimlaneRepo = { list: vi.fn(() => [{ id: 'lane-1', role: null }]) };
    const taskRepo = { list: vi.fn(), update: vi.fn() };
    const sessionRepo = { deleteByTaskId: vi.fn() };
    const sessionManager = { remove: vi.fn() };

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).toBe(0);
    expect(taskRepo.list).not.toHaveBeenCalled();
  });

  it('skips tasks with no stale resources', () => {
    const cleanTask = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'Clean task',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([cleanTask]);

    // No stale directory, no stale branch
    mockExistsSync.mockReturnValue(false);
    // branchExistsSync: git rev-parse --verify throws -> branch does not exist
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).toBe(0);
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('cleans task with stale DB fields (worktree_path, branch_name, session_id)', () => {
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

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).toBe(1);

    // Session killed
    expect(sessionManager.remove).toHaveBeenCalledWith('session-123');

    // Session records deleted
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('bbbb2222-0000-0000-0000-000000000000');

    // Directory removed
    expect(mockRmSync).toHaveBeenCalledWith(
      '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222',
      { recursive: true, force: true },
    );

    // DB fields cleared
    expect(taskRepo.update).toHaveBeenCalledWith({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      worktree_path: null,
      branch_name: null,
      session_id: null,
    });

    // git worktree prune called once
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['worktree', 'prune'], { cwd: projectPath, stdio: 'ignore' },
    );

    // Branch deleted
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'fix-login-bug-bbbb2222'], { cwd: projectPath, stdio: 'ignore' },
    );
  });

  it('cleans task with null DB fields but stale directory on disk (core bug fix)', () => {
    // This is the key scenario: DB fields were cleared when the task reverted
    // to backlog, but the directory and branch remain on disk.
    const task = createMockTask({
      id: 'cccc3333-0000-0000-0000-000000000000',
      title: 'Add dark mode',
      // All DB fields are null - already cleared by previous revert
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    // Expected path (derived from slug): add-dark-mode-cccc3333
    const expectedPath = '/home/dev/my-project/.kangentic/worktrees/add-dark-mode-cccc3333';
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === expectedPath);

    // Branch exists on disk (git rev-parse succeeds for the expected branch)
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[2] === 'add-dark-mode-cccc3333') {
        return 'abc123'; // branch exists
      }
      return '';
    });

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).toBe(1);

    // Directory removed via expected path
    expect(mockRmSync).toHaveBeenCalledWith(expectedPath, { recursive: true, force: true });

    // Session records still cleaned (defensive)
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('cccc3333-0000-0000-0000-000000000000');

    // Branch deleted
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'add-dark-mode-cccc3333'], { cwd: projectPath, stdio: 'ignore' },
    );

    // DB update NOT called (no stale DB fields to clear)
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it('handles session removal failure gracefully', () => {
    const task = createMockTask({
      id: 'dddd4444-0000-0000-0000-000000000000',
      title: 'Refactor auth',
      session_id: 'dead-session',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);
    sessionManager.remove.mockImplementation(() => { throw new Error('session already dead'); });
    // branchExistsSync: no branch
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Should still clean up despite session removal failure
    expect(result).toBe(1);
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dddd4444-0000-0000-0000-000000000000',
      session_id: null,
    }));
  });

  it('runs git worktree prune once after all directories, not per-task', () => {
    const tasks = [
      createMockTask({ id: 'eeee5555-0000-0000-0000-000000000000', title: 'Task one', branch_name: 'task-one-eeee5555' }),
      createMockTask({ id: 'ffff6666-0000-0000-0000-000000000000', title: 'Task two', branch_name: 'task-two-ffff6666' }),
    ];
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos(tasks);
    // branchExistsSync: no branches on disk
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Prune called exactly once (not once per task)
    const pruneCalls = mockExecFileSync.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])[0] === 'worktree',
    );
    expect(pruneCalls).toHaveLength(1);
  });

  it('retries directory removal on EPERM (Windows file handle timing)', () => {
    const task = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'Retry test',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/retry-test-aaaa1111',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    mockExistsSync.mockImplementation((pathArg: string) =>
      pathArg === '/home/dev/my-project/.kangentic/worktrees/retry-test-aaaa1111',
    );

    // Fail first two times, succeed on third
    let callCount = 0;
    mockRmSync.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) throw new Error('EPERM');
    });

    // branchExistsSync: no branch on disk
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).toBe(1);
    // rmSync called 3 times (2 failures + 1 success)
    expect(mockRmSync).toHaveBeenCalledTimes(3);
  });

  it('cleans both DB-recorded and expected paths when they differ (renamed task)', () => {
    // Task was renamed: DB has old path, expected slug gives new path
    const task = createMockTask({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'New title',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/old-title-aaaa1111',
      branch_name: 'old-title-aaaa1111',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    // Both old and new paths exist
    mockExistsSync.mockReturnValue(true);

    const result = cleanBacklogTaskResources(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(result).toBe(1);

    // Both paths attempted for removal
    const removedPaths = mockRmSync.mock.calls.map(call => call[0]);
    expect(removedPaths).toContain('/home/dev/my-project/.kangentic/worktrees/old-title-aaaa1111');
    expect(removedPaths).toContain('/home/dev/my-project/.kangentic/worktrees/new-title-aaaa1111');

    // Both branches queued for deletion
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'old-title-aaaa1111'], expect.anything(),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'new-title-aaaa1111'], expect.anything(),
    );
  });
});
