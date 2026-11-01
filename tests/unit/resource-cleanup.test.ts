import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockExistsSync, mockRm, mockReaddir, mockStat, mockExecFile, mockReadLocalBranchSha } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => false),
  mockRm: vi.fn(async () => {}),
  mockReaddir: vi.fn(async () => []),
  // Default to an old mtime so orphan sweeps proceed. Computed at call time
  // because the relevant block uses fake timers.
  mockStat: vi.fn(async (_pathArg?: unknown) => ({ mtimeMs: Date.now() - 24 * 60 * 60 * 1000 })),
  mockExecFile: vi.fn(),
  // The Backlog sweep captures the stale branch's tip into head_sha before
  // dropping the name; null by default so the patch carries no head_sha key.
  mockReadLocalBranchSha: vi.fn(async (_repo?: string, _branch?: string): Promise<string | null> => null),
}));

vi.mock('../../src/main/git/worktree-head', () => ({
  readLocalBranchSha: mockReadLocalBranchSha,
}));

// The real removal, unless a test overrides it: with this file's fs mock the real
// one only logs a warning. A spy lets a test start a worktree creation from
// inside the slow node_modules step, which is the window the To Do sweep
// re-checks the registry after.
vi.mock('../../src/main/git/node-modules-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/node-modules-link')>();
  return { ...actual, removeNodeModulesPath: vi.fn(actual.removeNodeModulesPath) };
});

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    promises: {
      rm: mockRm,
      readdir: mockReaddir,
      stat: mockStat,
    },
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: (...segments: string[]) => segments.join('/'),
    // The worktree creation registry keys its paths through resolve.
    resolve: (...segments: string[]) => segments.join('/'),
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

import { cleanupStaleResources, cleanupStaleResourcesAsync, pruneOrphanedWorktreeTasks, pruneOrphanedDirectories, sweepAutomationRuns } from '../../src/main/transition-engine/resource-cleanup';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
// The REAL per-task lock, not mocked: the To Do sweep takes it for each task,
// so a test can hold it to stand in for a move that is still running.
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';
import { runWorktreeCreation, isWorktreeCreationInFlight } from '../../src/main/git/worktree-creation-registry';
import { removeNodeModulesPath } from '../../src/main/git/node-modules-link';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * How each task arrived in its column. Null by default, the answer for a task
 * whose arrival was never recorded, which the To Do sweep cleans like a reset.
 * A test that needs a restore answers once with `mockReturnValueOnce`.
 */
const taskMoveRepo = {
  currentVisit: vi.fn((_taskId?: string, _swimlaneId?: string): { at: string; origin: string } | null => null),
};

interface MockTask {
  id: string;
  title: string;
  display_id: number;
  worktree_path: string | null;
  worktree_folder: string | null;
  branch_name: string | null;
  session_id: string | null;
  swimlane_id?: string;
  // The PR identity a To Do move forgets. Absent reads as null, like a row
  // that never linked a PR.
  pr_url?: string | null;
  pr_number?: number | null;
  pr_state?: string | null;
  pr_merge_readiness?: string | null;
  pushed_branch?: string | null;
  head_sha?: string | null;
}

function createMockTask(overrides: Partial<MockTask> & { id: string; title: string }): MockTask {
  return {
    display_id: 7,
    worktree_path: null,
    worktree_folder: null,
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
    // The To Do sweep re-reads a restored task before it clears its session.
    // Every task here sits in the To Do lane unless the test says otherwise.
    getById: vi.fn((id: string) => {
      const found = backlogTasks.find((task) => task.id === id);
      return found ? { swimlane_id: 'lane-backlog', ...found } : undefined;
    }),
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

/**
 * Route the async existence probes (fs.promises.stat, used by
 * pruneOrphanedWorktreeTasks' pathExists) through the same path predicate as
 * mockExistsSync, so each test configures existence exactly once.
 */
function statDelegatesToExistsSync() {
  mockStat.mockImplementation(async (pathArg?: unknown) => {
    if (!mockExistsSync(String(pathArg))) {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, stat '${String(pathArg)}'`),
        { code: 'ENOENT' },
      );
    }
    return { mtimeMs: Date.now() - 24 * 60 * 60 * 1000 };
  });
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

/**
 * Every execFile call as `[file, args, cwd]`. The options also carry the
 * child's env, which is main's whole environment (child-env.ts), so an
 * assertion on the raw calls would print it when it fails.
 */
function execFileCalls(): Array<[string, string[], string | undefined]> {
  return mockExecFile.mock.calls.map(([file, args, options]) => [
    file as string,
    args as string[],
    (options as { cwd?: string } | undefined)?.cwd,
  ]);
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
    // clearAllMocks keeps implementations, so a tip one test set would reach
    // every later test in the file.
    mockReadLocalBranchSha.mockResolvedValue(null);
    // clearAllMocks also keeps a `mockReturnValueOnce` queue. `taskMoveRepo` is
    // shared across the file, so an answer one test queued and never consumed
    // would be handed to the next test's task. Reset it to its null default.
    taskMoveRepo.currentVisit.mockReset();
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Session killed
    expect(sessionManager.remove).toHaveBeenCalledWith('session-123');

    // Session records deleted
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('bbbb2222-0000-0000-0000-000000000000');

    // Directory removed via git worktree remove --force
    expect(execFileCalls()).toContainEqual(
      ['git', ['worktree', 'remove', '--force', '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222'], projectPath],
    );

    // DB fields cleared. `pushed_branch` is absent on purpose: a remote fact
    // and a PR anchor, it outlives the checkout (see pushed-branch-cleanup-parity).
    // The row holds no PR identity, so the leftover branch's tip is not read.
    expect(mockReadLocalBranchSha).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      worktree_path: null,
      branch_name: null,
      resolved_base_branch: null,
      session_id: null,
    });

    // git worktree prune called once (catch-all for metadata)
    expect(execFileCalls()).toContainEqual(['git', ['worktree', 'prune'], projectPath]);

    // Branch deleted
    expect(execFileCalls()).toContainEqual(['git', ['branch', '-D', 'fix-login-bug-bbbb2222'], projectPath]);
  });

  /**
   * Every other test in this file leaves `mockReadLocalBranchSha` at its
   * `null` default, so none of them can tell a real capture from a dropped
   * one - the patch looks identical either way. This test overrides it with a
   * real sha and pins the shape AND the ordering the source comment claims:
   * "the tip is captured ... into head_sha ... (still present: branches are
   * deleted after this loop)". If the capture line moved below the branch
   * delete pass, readLocalBranchSha would read an already-deleted ref and
   * silently return null again - the patch-shape assertion alone would not
   * catch that regression, only the ordering assertion does.
   *
   * The row keeps its PR, as an unarchive into To Do does, which is what lets
   * the sweep read the tip at all (see the PR identity tests below).
   */
  it('captures a real head_sha into the update patch, read BEFORE the branch is deleted', async () => {
    const staleTask = createMockTask({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      title: 'Fix login bug',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222',
      branch_name: 'fix-login-bug-bbbb2222',
      session_id: 'session-123',
      pr_number: 574,
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([staleTask]);

    mockExistsSync.mockImplementation((pathArg: string) =>
      pathArg === '/home/dev/my-project/.kangentic/worktrees/fix-login-bug-bbbb2222',
    );
    mockReadLocalBranchSha.mockResolvedValue('abc123def456');

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(mockReadLocalBranchSha).toHaveBeenCalledWith(projectPath, 'fix-login-bug-bbbb2222');
    expect(taskRepo.update).toHaveBeenCalledWith({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      worktree_path: null,
      branch_name: null,
      resolved_base_branch: null,
      session_id: null,
      head_sha: 'abc123def456',
    });

    const branchDeleteCallIndex = mockExecFile.mock.calls.findIndex(
      (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'branch' && call[1][1] === '-D',
    );
    expect(branchDeleteCallIndex).toBeGreaterThanOrEqual(0);
    const branchDeleteCallOrder = mockExecFile.mock.invocationCallOrder[branchDeleteCallIndex];
    expect(mockReadLocalBranchSha.mock.invocationCallOrder[0]).toBeLessThan(branchDeleteCallOrder);
  });

  /**
   * A To Do move forgets all six PR identity columns when it commits, then its
   * cleanup runs for seconds. A quit there, or a worktree removal that failed,
   * leaves the old checkout for this sweep. Reading that branch's tip into
   * head_sha would hand the task the old commit back, and Tier 3 resolves the
   * old PR from it on the first resolve with no worktree.
   */
  it('does not read the old tip back for a To Do row whose PR identity a reset forgot', async () => {
    const resetTask = createMockTask({
      id: 'cccc3333-0000-0000-0000-000000000000',
      title: 'Cut the release',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/7',
      branch_name: 'cut-the-release-cccc3333',
      session_id: 'session-456',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([resetTask]);

    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/7');
    mockReadLocalBranchSha.mockResolvedValue('old-work-sha');

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(mockReadLocalBranchSha).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledTimes(1);
    expect(taskRepo.update.mock.calls[0][0]).not.toHaveProperty('head_sha');
    // The checkout itself is still cleaned, branch included.
    expect(execFileCalls()).toContainEqual(['git', ['branch', '-D', 'cut-the-release-cccc3333'], projectPath]);
  });

  // One case per column, so a predicate that dropped any one of them would read
  // that row as forgotten and stop capturing for it.
  it.each([
    ['pr_url', { pr_url: 'https://github.com/owner/repo/pull/574' }],
    ['pr_number', { pr_number: 574 }],
    ['pr_state', { pr_state: 'open' }],
    ['pr_merge_readiness', { pr_merge_readiness: 'ready' }],
    ['pushed_branch', { pushed_branch: 'feature/cut-the-release' }],
    ['head_sha', { head_sha: 'earlier-sha' }],
  ] as Array<[string, Partial<MockTask>]>)('still captures the tip for a row that holds its %s', async (_columnName, identityColumns) => {
    const keptTask = createMockTask({
      id: 'dddd4444-0000-0000-0000-000000000000',
      title: 'Restore from Done',
      branch_name: 'restore-from-done-dddd4444',
      ...identityColumns,
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([keptTask]);
    mockReadLocalBranchSha.mockResolvedValue('kept-tip-sha');

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(mockReadLocalBranchSha).toHaveBeenCalledWith(projectPath, 'restore-from-done-dddd4444');
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dddd4444-0000-0000-0000-000000000000',
      branch_name: null,
      head_sha: 'kept-tip-sha',
    }));
  });

  /**
   * An unarchive into To Do resets only the session and keeps the worktree and
   * branch, so a restore never force-deletes committed work with no warning.
   * The sweep used to delete both on the next launch anyway.
   */
  it('keeps the worktree and branch of a task restored into To Do from Done', async () => {
    const restoredTask = createMockTask({
      id: 'eeee5555-0000-0000-0000-000000000000',
      title: 'Restored from Done',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/12',
      branch_name: 'restored-from-done-eeee5555',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([restoredTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/12');
    taskMoveRepo.currentVisit.mockReturnValueOnce({ at: '2026-10-15T12:00:00.000Z', origin: 'unarchive' });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskMoveRepo.currentVisit).toHaveBeenCalledWith('eeee5555-0000-0000-0000-000000000000', 'lane-backlog');
    const gitCalls = mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(gitCalls.filter((args) => args.startsWith('worktree remove') || args.startsWith('branch -D'))).toEqual([]);
    expect(mockRm).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('finishes the session reset of a restore cut short, and still keeps its checkout', async () => {
    const restoredTask = createMockTask({
      id: 'ffff6666-0000-0000-0000-000000000000',
      title: 'Restore cut short',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/13',
      branch_name: 'restore-cut-short-ffff6666',
      session_id: 'session-789',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([restoredTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/13');
    taskMoveRepo.currentVisit.mockReturnValueOnce({ at: '2026-10-15T12:00:00.000Z', origin: 'unarchive' });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(sessionManager.remove).toHaveBeenCalledWith('session-789');
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('ffff6666-0000-0000-0000-000000000000');
    expect(taskRepo.update).toHaveBeenCalledTimes(1);
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'ffff6666-0000-0000-0000-000000000000', session_id: null });
    const gitCalls = mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(gitCalls.filter((args) => args.startsWith('worktree remove') || args.startsWith('branch -D'))).toEqual([]);
  });

  /**
   * `currentVisit` names the task's last visit to To Do even after the task has
   * left, and the task list was taken before the loop's awaits. A restored task
   * the user dragged out to a spawning column while the sweep ran holds a NEW
   * session, which the sweep must not remove or clear, whichever of the lane
   * check and the arrival record it consults first. Guards a session reset that
   * trusts the snapshot instead of the row as it is now.
   */
  it('leaves the new session of a restored task that left To Do while the sweep ran', async () => {
    const restoredTask = createMockTask({
      id: 'f00d1111-0000-0000-0000-000000000000',
      title: 'Restored then dragged out',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/15',
      branch_name: 'restored-then-dragged-out-f00d1111',
      session_id: 'session-old',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([restoredTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/15');
    // The arrival record still says restore. The sweep may never ask for it,
    // since the lane check on the fresh row comes first; beforeEach resets the
    // queue, so an unasked answer does not reach the next test.
    taskMoveRepo.currentVisit.mockReturnValueOnce({ at: '2026-10-15T12:00:00.000Z', origin: 'unarchive' });
    // The row as it is now. A fresh object, so the snapshot above keeps its
    // old session id.
    taskRepo.getById.mockReturnValueOnce({ ...restoredTask, swimlane_id: 'lane-planning', session_id: 'session-new' });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // The queued row was consumed by the sweep's re-read.
    expect(taskRepo.getById).toHaveBeenCalledWith('f00d1111-0000-0000-0000-000000000000');
    expect(sessionManager.remove).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    const gitCalls = mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(gitCalls.filter((args) => args.startsWith('worktree remove') || args.startsWith('branch -D'))).toEqual([]);
  });

  /**
   * A task still in To Do whose session changed since the list was taken has
   * its CURRENT session removed, not the stale id from the snapshot. Guards a
   * half-revert that keeps the lane check but reads `task.session_id`.
   */
  it('removes the current session of a restored task still in To Do, not the snapshot id', async () => {
    const restoredTask = createMockTask({
      id: 'f00d2222-0000-0000-0000-000000000000',
      title: 'Restored with a newer session',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/16',
      branch_name: 'restored-with-a-newer-session-f00d2222',
      session_id: 'session-old',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([restoredTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/16');
    taskMoveRepo.currentVisit.mockReturnValueOnce({ at: '2026-10-15T12:00:00.000Z', origin: 'unarchive' });
    taskRepo.getById.mockReturnValueOnce({ ...restoredTask, swimlane_id: 'lane-backlog', session_id: 'session-new' });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskMoveRepo.currentVisit).toHaveBeenCalledWith('f00d2222-0000-0000-0000-000000000000', 'lane-backlog');
    expect(taskRepo.getById).toHaveBeenCalledWith('f00d2222-0000-0000-0000-000000000000');
    expect(sessionManager.remove).toHaveBeenCalledTimes(1);
    expect(sessionManager.remove).toHaveBeenCalledWith('session-new');
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('f00d2222-0000-0000-0000-000000000000');
    expect(taskRepo.update).toHaveBeenCalledTimes(1);
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'f00d2222-0000-0000-0000-000000000000', session_id: null });
    // The checkout is still kept.
    const gitCalls = mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(gitCalls.filter((args) => args.startsWith('worktree remove') || args.startsWith('branch -D'))).toEqual([]);
  });

  /**
   * The session was already cleared between the list and the re-read, so the
   * reset has nothing left to finish. Guards a check on the snapshot's session
   * id instead of the row's.
   */
  it('does nothing for a restored task whose session was already cleared when the sweep re-read it', async () => {
    const restoredTask = createMockTask({
      id: 'f00d3333-0000-0000-0000-000000000000',
      title: 'Restored and already reset',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/17',
      branch_name: 'restored-and-already-reset-f00d3333',
      session_id: 'session-old',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([restoredTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/17');
    taskMoveRepo.currentVisit.mockReturnValueOnce({ at: '2026-10-15T12:00:00.000Z', origin: 'unarchive' });
    taskRepo.getById.mockReturnValueOnce({ ...restoredTask, swimlane_id: 'lane-backlog', session_id: null });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskMoveRepo.currentVisit).toHaveBeenCalledWith('f00d3333-0000-0000-0000-000000000000', 'lane-backlog');
    expect(taskRepo.getById).toHaveBeenCalledWith('f00d3333-0000-0000-0000-000000000000');
    expect(sessionManager.remove).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it('cleans a task that was restored and then moved back into To Do, since that move is a reset', async () => {
    const resetTask = createMockTask({
      id: 'abab7777-0000-0000-0000-000000000000',
      title: 'Moved back in',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/14',
      branch_name: 'moved-back-in-abab7777',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([resetTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/14');
    // The visit's opening move is the drag back in, not the restore before it.
    taskMoveRepo.currentVisit.mockReturnValueOnce({ at: '2026-10-15T13:00:00.000Z', origin: 'renderer' });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(execFileCalls()).toContainEqual(['git', ['branch', '-D', 'moved-back-in-abab7777'], projectPath]);
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'abab7777-0000-0000-0000-000000000000',
      worktree_path: null,
      branch_name: null,
    }));
  });

  /**
   * The same hazard as the restore case above, on the reset path. The task list
   * was taken before the loop's awaits, and the sweep runs unawaited at project
   * open, so a task the user dragged out to a spawning column while it ran now
   * owns a NEW worktree and session. Cleaning from the listed row would remove
   * that worktree, delete the new session's records and null its session_id.
   * Guards a reset that trusts the snapshot instead of the row as it is now.
   */
  it('leaves the new worktree and session of a task that left To Do before the sweep reached it', async () => {
    const movedTask = createMockTask({
      id: 'f00d4444-0000-0000-0000-000000000000',
      title: 'Dragged out while sweeping',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/18',
      branch_name: 'dragged-out-while-sweeping-f00d4444',
      session_id: 'session-old',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([movedTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/18');
    // The row as it is now. A fresh object, so the snapshot above keeps its
    // old session id and its missing lane.
    taskRepo.getById.mockReturnValueOnce({ ...movedTask, swimlane_id: 'lane-planning', session_id: 'session-new' });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // The queued answer was consumed by the sweep's re-read.
    expect(taskRepo.getById).toHaveBeenCalledTimes(1);
    expect(taskRepo.getById).toHaveBeenCalledWith('f00d4444-0000-0000-0000-000000000000');
    expect(sessionManager.remove).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
    const gitCalls = mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(gitCalls.filter((args) => args.startsWith('worktree remove') || args.startsWith('branch -D'))).toEqual([]);
  });

  /**
   * A move of the same task may still be running when the sweep reaches it, and
   * it holds the task's lifecycle lock. The sweep has to wait for that lock and
   * read the row only after it has it, or it acts on a row the move is about to
   * change. The test holds the real lock, moves the row to Planning while the
   * sweep waits behind it, then releases: the sweep must see Planning and skip.
   * Guards dropping the `withTaskLock` wrapper, and reading the row outside it.
   */
  it('waits for the task lock before it reads the row, then skips a task that left To Do meanwhile', async () => {
    const taskId = 'f00d5555-0000-0000-0000-000000000000';
    const movingTask = createMockTask({
      id: taskId,
      title: 'Moving while sweeping',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/19',
      branch_name: 'moving-while-sweeping-f00d5555',
      session_id: 'session-old',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([movingTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === '/home/dev/my-project/.kangentic/worktrees/19');

    // Stand in for the move: hold the task's lock until the test lets go.
    let releaseTaskLock!: () => void;
    const taskLockHeld = new Promise<void>((resolve) => {
      releaseTaskLock = resolve;
    });
    const lockHolder = withTaskLock(taskId, () => taskLockHeld);

    // Not awaited: it must park behind the lock. The finally block below always
    // releases the lock and awaits both, so a failed assertion leaks nothing
    // into the next test.
    const sweep = cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    try {
      // The sweep lists To Do right before it asks for the lock, so this proves
      // it got that far and the checks below are not vacuous.
      await vi.waitFor(() => expect(taskRepo.list).toHaveBeenCalledWith('lane-backlog'));
      // Intentional fixed turns (a poll cannot prove something does NOT happen):
      // with no lock in the way the rest of the pass is microtasks over mocks,
      // so two macrotask turns is more than it needs to finish.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Still waiting: it has not read the row, let alone touched the task.
      expect(taskRepo.getById).not.toHaveBeenCalled();
      expect(sessionManager.remove).not.toHaveBeenCalled();
      expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
      expect(taskRepo.update).not.toHaveBeenCalled();

      // The move lands while the sweep waits. getById spreads the task object,
      // so the new lane wins over its To Do default.
      movingTask.swimlane_id = 'lane-planning';
    } finally {
      releaseTaskLock();
      await lockHolder;
      await sweep;
    }

    // It read the row once the lock freed, found Planning, and left it alone.
    expect(taskRepo.getById).toHaveBeenCalledTimes(1);
    expect(taskRepo.getById).toHaveBeenCalledWith(taskId);
    expect(sessionManager.remove).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
    const gitCalls = mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(gitCalls.filter((args) => args.startsWith('worktree remove') || args.startsWith('branch -D'))).toEqual([]);
  });

  it('skips a candidate directory a creation is still setting up', async () => {
    // This pass runs raw git with neither the task's creation registry hold nor
    // the git queue, so it must check the registry itself: the creation's setup
    // script may still be writing in the directory.
    const task = createMockTask({
      id: 'cccc3333-0000-0000-0000-000000000000',
      title: 'Add dark mode',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);
    const settingUpPath = '/home/dev/my-project/.kangentic/worktrees/add-dark-mode-cccc3333';
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === settingUpPath);
    setupExecFile(() => { throw new Error('not found'); });
    let finishCreation: () => void = () => undefined;
    const creation = runWorktreeCreation(settingUpPath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));

    try {
      await cleanupStaleResources(
        projectPath,
        taskRepo as never,
        taskMoveRepo as never,
        swimlaneRepo as never,
        sessionRepo as never,
        sessionManager as never,
      );

      expect(execFileCalls()).not.toContainEqual(['git', ['worktree', 'remove', '--force', settingUpPath], projectPath]);
    } finally {
      finishCreation();
      await creation;
    }
  });

  it('leaves the whole task alone when a creation holds one of its paths: session, records, row and branches included', async () => {
    // The worktree, branch and row a creation is about to record are its own, so
    // the skip covers the task, not just the directory. Reverting the early
    // `heldPath` skip narrows it to the directory (the per-path check after the
    // node_modules step still protects that): the session is removed, its records
    // deleted, the row's fields nulled and both branches dropped. The same
    // fixture with no hold is cleaned by 'cleans task with stale DB fields'.
    const heldPath = '/home/dev/my-project/.kangentic/worktrees/7';
    const task = createMockTask({
      id: 'cccc3333-0000-0000-0000-000000000000',
      title: 'Add dark mode',
      worktree_path: heldPath,
      branch_name: 'custom-branch-cccc3333',
      session_id: 'session-held',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === heldPath);
    let finishCreation: () => void = () => undefined;
    const creation = runWorktreeCreation(heldPath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));

    try {
      await cleanupStaleResources(
        projectPath,
        taskRepo as never,
        taskMoveRepo as never,
        swimlaneRepo as never,
        sessionRepo as never,
        sessionManager as never,
      );

      expect(sessionManager.remove).not.toHaveBeenCalled();
      expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
      expect(taskRepo.update).not.toHaveBeenCalled();
      // No directory removal, no prune, and neither the recorded branch nor the
      // title-derived one is deleted.
      const mutatingGitCalls = execFileCalls().filter(([, args]) => args[0] === 'worktree' || (args[0] === 'branch' && args[1] === '-D'));
      expect(mutatingGitCalls).toEqual([]);
      expect(mockRm).not.toHaveBeenCalled();
    } finally {
      finishCreation();
      await creation;
    }
  });

  it('stops cleaning the task when a creation claims a path during the slow node_modules step', async () => {
    // Nothing holds the path when the pass looks, so it goes on to clear
    // node_modules first. A creation that takes no task lock (a branch switch)
    // can start while that runs, so the pass asks the registry again before it
    // removes the directory, and stops there. Reverting the second ask removes
    // a worktree whose setup script has just started; turning its stop back
    // into a skip of that one directory still deletes the task's branch.
    const task = createMockTask({
      id: 'cccc3333-0000-0000-0000-000000000000',
      title: 'Add dark mode',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);
    const lateClaimedPath = '/home/dev/my-project/.kangentic/worktrees/7';
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === lateClaimedPath);
    setupExecFile(() => { throw new Error('not found'); });
    let finishCreation: () => void = () => undefined;
    let creation: Promise<void> = Promise.resolve();
    vi.mocked(removeNodeModulesPath).mockImplementationOnce(async (targetPath: string) => {
      if (targetPath !== `${lateClaimedPath}/node_modules`) return;
      creation = runWorktreeCreation(lateClaimedPath, undefined, () => new Promise<void>((resolve) => { finishCreation = resolve; }));
    });

    try {
      // Nothing holds the path when the pass starts.
      expect(isWorktreeCreationInFlight(lateClaimedPath)).toBe(false);
      await cleanupStaleResources(
        projectPath,
        taskRepo as never,
        taskMoveRepo as never,
        swimlaneRepo as never,
        sessionRepo as never,
        sessionManager as never,
      );

      // The pass reached the node_modules step for this directory, and the
      // creation is the one that started during it.
      expect(removeNodeModulesPath).toHaveBeenCalledWith(`${lateClaimedPath}/node_modules`);
      expect(isWorktreeCreationInFlight(lateClaimedPath)).toBe(true);
      expect(execFileCalls()).not.toContainEqual(['git', ['worktree', 'remove', '--force', lateClaimedPath], projectPath]);
      expect(mockRm).not.toHaveBeenCalledWith(lateClaimedPath, expect.anything());
      expect(execFileCalls().filter(([, args]) => args[0] === 'branch' && args[1] === '-D')).toEqual([]);
    } finally {
      finishCreation();
      await creation;
      // Back to the delegating implementation, in case the loop never ran.
      vi.mocked(removeNodeModulesPath).mockReset();
    }
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
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Directory removed via git worktree remove --force
    expect(execFileCalls()).toContainEqual(['git', ['worktree', 'remove', '--force', expectedPath], projectPath]);

    // Session records still cleaned (defensive)
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith('cccc3333-0000-0000-0000-000000000000');

    // Branch deleted
    expect(execFileCalls()).toContainEqual(['git', ['branch', '-D', 'add-dark-mode-cccc3333'], projectPath]);

    // DB update NOT called (no stale DB fields to clear)
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  /**
   * Worktree DIRECTORIES are named for the task's display_id, but BRANCHES stay
   * title-derived. This pass used to derive the branch from the folder name,
   * which after that split would have it hunting for a branch literally called
   * "460" and silently cleaning nothing - inside a best-effort try/catch, so no
   * error would ever surface.
   */
  it('cleans a numeric worktree directory while still targeting the title-derived branch', async () => {
    const task = createMockTask({
      id: 'eeee5555-0000-0000-0000-000000000000',
      title: 'Add dark mode',
      display_id: 460,
      worktree_folder: '460',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } = createMockRepos([task]);

    const numericPath = '/home/dev/my-project/.kangentic/worktrees/460';
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === numericPath);
    setupExecFile((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[2] === 'add-dark-mode-eeee5555') {
        return; // the title-derived branch exists
      }
      throw new Error('not found');
    });

    await cleanupStaleResources(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(execFileCalls()).toContainEqual(['git', ['worktree', 'remove', '--force', numericPath], projectPath]);
    expect(execFileCalls()).toContainEqual(['git', ['branch', '-D', 'add-dark-mode-eeee5555'], projectPath]);
    // Never the folder name.
    expect(execFileCalls()).not.toContainEqual(['git', ['branch', '-D', '460'], projectPath]);
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // git worktree remove --force attempted
    expect(execFileCalls()).toContainEqual(['git', ['worktree', 'remove', '--force', worktreePath], projectPath]);
    // Async rm fallback
    expect(mockRm).toHaveBeenCalledWith(worktreePath, expect.objectContaining({ recursive: true, force: true }));
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
      taskMoveRepo as never,
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
    // The prune re-reads a task's lane before it deletes it.
    getById: vi.fn((id: string) => allTasks.find((task) => task.id === id)),
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
    statDelegatesToExistsSync();
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
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
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(taskRepo.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ordering contract: startup callers MUST await pruneOrphanedWorktreeTasks
// before session recovery reads the DB, then fire cleanupStaleResourcesAsync
// without awaiting it. Startup code in projects.ts depends on this, and the
// prune re-reads the active-session set after its async existence checks so
// a spawn that interleaves cannot lose its task.
// ---------------------------------------------------------------------------

describe('pruneOrphanedWorktreeTasks ordering contract', () => {
  const projectPath = '/home/dev/my-project';
  const worktreesDir = '/home/dev/my-project/.kangentic/worktrees';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    statDelegatesToExistsSync();
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    setupExecFile(() => '');
  });

  it('the awaited prune completes its deletes before recovery would read the DB', async () => {
    const orphanTask = createMockTask({
      id: 'orphan11-0000-0000-0000-000000000000',
      title: 'Orphan task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/orphan-orphan11',
      branch_name: 'orphan-orphan11',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([orphanTask]);

    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    // Emulate the startup call pattern exactly: await the prune, THEN fire
    // the async tail without awaiting.
    await pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // At this point - the exact position session recovery occupies in the
    // real startup sequence - the orphan task must already be deleted.
    expect(taskRepo.delete).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );
    expect(sessionRepo.deleteByTaskId).toHaveBeenCalledWith(
      'orphan11-0000-0000-0000-000000000000',
    );

    await cleanupStaleResourcesAsync(
      projectPath,
      taskRepo as never,
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
      undefined as never,
      () => {},
      // The leftover sweep runs first and reads this; off, it skips the scan.
      { stoppingEnabled: () => false, onReport: () => {} },
    );
  });

  it('re-reads the active-session set after the async gap (an interleaving spawn keeps its task)', async () => {
    const racedTask = createMockTask({
      id: 'raced111-0000-0000-0000-000000000000',
      title: 'Raced task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/raced-raced111',
      branch_name: 'raced-raced111',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([racedTask]);

    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    // No session is active when the prune starts; one spawns for the task
    // while its existence check is in flight. Reading the active set before
    // the gap would miss it and wrongly prune the task.
    let liveSessions: Array<{ id: string; taskId: string; status: string }> = [];
    sessionManager.listSessions = vi.fn(() => liveSessions);
    mockStat.mockImplementation(async (pathArg?: unknown) => {
      if (String(pathArg) === racedTask.worktree_path) {
        liveSessions = [{ id: 'session-raced', taskId: racedTask.id, status: 'running' }];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (!mockExistsSync(String(pathArg))) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { mtimeMs: Date.now() - 24 * 60 * 60 * 1000 };
    });

    const pruned = await pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(pruned).toBe(0);
    expect(taskRepo.delete).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('re-probes synchronously right before delete: a worktree re-created after the async gap keeps its task', async () => {
    const recreatedTask = createMockTask({
      id: 'recreat-0000-0000-0000-000000000000',
      title: 'Recreated task',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/recreated-recreat',
      branch_name: 'recreated-recreat',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([recreatedTask]);

    // The async existence probe (fs.promises.stat) reports the worktrees
    // parent dir as present but the task's own worktree dir as MISSING -
    // this is the state captured during the async existence-check gap.
    mockStat.mockImplementation(async (pathArg?: unknown) => {
      if (String(pathArg) === recreatedTask.worktree_path) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { mtimeMs: Date.now() - 24 * 60 * 60 * 1000 };
    });

    // By the time the synchronous delete loop runs its last-look re-probe, a
    // spawn has re-created the worktree directory on disk.
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === recreatedTask.worktree_path);

    const pruned = await pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(pruned).toBe(0);
    expect(taskRepo.delete).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  /**
   * A To Do move removes the worktree and only then clears worktree_path, so a
   * quit between the two leaves a To Do task pointing at a directory that is
   * gone. That is the reset's own leftover, not a worktree deleted outside the
   * app, and the prune used to delete the whole task for it.
   */
  it('never deletes a To Do task whose worktree a reset already removed', async () => {
    const resetTask = createMockTask({
      id: 'todo1111-0000-0000-0000-000000000000',
      title: 'Reset cut short',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/reset-todo1111',
      branch_name: 'reset-todo1111',
      swimlane_id: 'lane-backlog',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([resetTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);

    const pruned = await pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(pruned).toBe(0);
    expect(taskRepo.delete).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
  });

  it('re-reads the lane after the async gap: a task moved into To Do while the probes ran keeps its row', async () => {
    const movingTask = createMockTask({
      id: 'moving11-0000-0000-0000-000000000000',
      title: 'Dragged to To Do at launch',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/moving-moving11',
      branch_name: 'moving-moving11',
      swimlane_id: 'lane-planning',
    });
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks([movingTask]);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);
    // The move lands while the existence probe is in flight, and its reset is
    // what removed the directory.
    mockStat.mockImplementation(async (pathArg?: unknown) => {
      if (String(pathArg) === movingTask.worktree_path) {
        movingTask.swimlane_id = 'lane-backlog';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { mtimeMs: Date.now() - 24 * 60 * 60 * 1000 };
    });

    const pruned = await pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    expect(pruned).toBe(0);
    expect(taskRepo.delete).not.toHaveBeenCalled();
  });

  /**
   * The other half of the re-read: the row can be gone, not just moved. A task
   * deleted while the probes ran has nothing left to prune, and running the
   * deletes for it anyway would clear session rows for an id that no longer
   * exists. Guards a re-read that lets an undefined row through to the deletes.
   */
  it('re-reads the row after the async gap: a task deleted while the probes ran is not deleted again', async () => {
    const vanishingTask = createMockTask({
      id: 'vanish11-0000-0000-0000-000000000000',
      title: 'Deleted at launch',
      worktree_path: '/home/dev/my-project/.kangentic/worktrees/vanishing-vanish11',
      branch_name: 'vanishing-vanish11',
      swimlane_id: 'lane-planning',
    });
    // One array reference. `list()` hands it out and `getById` searches it, so
    // emptying it in place is what makes the row disappear for the re-read.
    const allTasks: MockTask[] = [vanishingTask];
    const { swimlaneRepo, taskRepo, sessionRepo, sessionManager } =
      createMockReposWithAllTasks(allTasks);
    mockExistsSync.mockImplementation((pathArg: string) => pathArg === worktreesDir);
    // The delete lands while the existence probe is in flight. The candidate
    // list was already copied by then, so the task still reaches the loop.
    mockStat.mockImplementation(async (pathArg?: unknown) => {
      if (String(pathArg) === vanishingTask.worktree_path) {
        allTasks.splice(0, allTasks.length);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { mtimeMs: Date.now() - 24 * 60 * 60 * 1000 };
    });

    const pruned = await pruneOrphanedWorktreeTasks(
      projectPath,
      taskRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // The re-read ran and found nothing, which is the only reason for the skip.
    expect(taskRepo.getById).toHaveBeenCalledWith('vanish11-0000-0000-0000-000000000000');
    expect(pruned).toBe(0);
    expect(taskRepo.delete).not.toHaveBeenCalled();
    expect(sessionRepo.deleteByTaskId).not.toHaveBeenCalled();
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
    mockStat.mockImplementation(async () => ({ mtimeMs: Date.now() - 24 * 60 * 60 * 1000 }));
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
    // never releases). removeWithRetry retries over [0, 200, 500, 1000, 2000] ms.
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

    // Drive the full 0 + 200 + 500 + 1000 + 2000 = 3700 ms retry window for
    // bad-session. The retry loop for bad-session runs first; once exhausted,
    // the loop continues to good-session which resolves immediately.
    await vi.advanceTimersByTimeAsync(3700);
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
      taskMoveRepo as never,
      swimlaneRepo as never,
      sessionRepo as never,
      sessionManager as never,
    );

    // Drive the full 0 + 200 + 500 + 1000 + 2000 = 3700 ms retry window.
    await vi.advanceTimersByTimeAsync(3700);
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

// ---------------------------------------------------------------------------
// sweepAutomationRuns (task #952): a workflow's tasks keep every run until the
// workflow has been done a day, so the prune takes the keep list. A prune cannot
// be undone, so when the keep list cannot be read nothing is pruned that open.
//
// Red-green: calling `pruneTo` outside the `keepWorkflowIds !== null` guard
// (for example `pruneTo(undefined, keepWorkflowIds ?? [])`) makes the
// unreadable-keep-list test fail; dropping the second argument makes the
// keep-list test fail.
// ---------------------------------------------------------------------------

describe('sweepAutomationRuns: the prune takes the workflows that keep their runs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAutomationRunRepo(overrides: {
    interrupted?: number;
    workflowIdsKeepingRuns?: () => string[];
  } = {}) {
    return {
      markStaleRunsInterrupted: vi.fn(() => overrides.interrupted ?? 0),
      workflowIdsKeepingRuns: vi.fn(overrides.workflowIdsKeepingRuns ?? (() => [])),
      pruneTo: vi.fn(() => 0),
    };
  }

  it('hands the read keep list to the prune and returns the interrupted count', () => {
    const repo = makeAutomationRunRepo({
      interrupted: 3,
      workflowIdsKeepingRuns: () => ['workflow-active', 'workflow-finished-recently'],
    });

    const interrupted = sweepAutomationRuns(repo as unknown as AutomationRunRepository);

    expect(interrupted).toBe(3);
    // The keep list is read against the current time, with the home-project lookup
    // for a workflow homed in another project.
    expect(repo.workflowIdsKeepingRuns).toHaveBeenCalledWith(expect.any(Number), expect.any(Function));
    expect(repo.pruneTo).toHaveBeenCalledTimes(1);
    expect(repo.pruneTo).toHaveBeenCalledWith(undefined, ['workflow-active', 'workflow-finished-recently']);
  });

  it('still prunes, with an empty keep list, when no workflow keeps its runs', () => {
    const repo = makeAutomationRunRepo({ workflowIdsKeepingRuns: () => [] });

    sweepAutomationRuns(repo as unknown as AutomationRunRepository);

    expect(repo.pruneTo).toHaveBeenCalledTimes(1);
    expect(repo.pruneTo).toHaveBeenCalledWith(undefined, []);
  });

  it('prunes nothing when the keep list cannot be read, and still reports the interrupted runs', () => {
    const repo = makeAutomationRunRepo({
      interrupted: 2,
      workflowIdsKeepingRuns: () => { throw new Error('database is locked'); },
    });

    const interrupted = sweepAutomationRuns(repo as unknown as AutomationRunRepository);

    expect(repo.pruneTo).not.toHaveBeenCalled();
    // The honest `interrupted` marking is the other half of the sweep and does
    // not depend on the prune.
    expect(interrupted).toBe(2);
    expect(repo.markStaleRunsInterrupted).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not read which workflows keep their runs, so none were pruned'),
      expect.any(Error),
    );
  });

  it('returns 0 and prunes nothing when the stale runs cannot be marked', () => {
    const repo = makeAutomationRunRepo();
    repo.markStaleRunsInterrupted.mockImplementation(() => { throw new Error('no such table'); });

    expect(sweepAutomationRuns(repo as unknown as AutomationRunRepository)).toBe(0);
    expect(repo.pruneTo).not.toHaveBeenCalled();
  });
});
