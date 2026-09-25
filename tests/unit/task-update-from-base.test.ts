/**
 * Unit tests for the TASK_UPDATE_FROM_BASE IPC handler (task-branch.ts).
 *
 * The one-click "Update from base" action: fetch the task's effective base,
 * verify origin/<base> actually resolves, then fast-forward the task's
 * WORKTREE from it. Every non-throw outcome is a discriminated
 * TaskUpdateFromBaseResult; the guards (running session, no worktree) throw.
 *
 * Pattern mirrors task-runtime-override-handler.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly. The real
 * task-lifecycle-lock is used; the per-project git lock is pass-through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const {
  mockFetchIfStale,
  mockRefResolvesLocally,
  mockResolveEffectiveBaseBranch,
  mockFindLiveSessionInDirectory,
  mockGetProjectRepos,
  mockResolveProjectContext,
  mockProjectGit,
  mockWorktreeGit,
} = vi.hoisted(() => ({
  mockFetchIfStale: vi.fn(),
  mockRefResolvesLocally: vi.fn(async () => true),
  mockResolveEffectiveBaseBranch: vi.fn(),
  mockFindLiveSessionInDirectory: vi.fn((..._args: unknown[]): { taskId: string } | undefined => undefined),
  mockGetProjectRepos: vi.fn(),
  mockResolveProjectContext: vi.fn(),
  mockProjectGit: { status: vi.fn(), raw: vi.fn(), revparse: vi.fn() },
  mockWorktreeGit: { status: vi.fn(), raw: vi.fn(), revparse: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

const WORKTREE_PATH = '/project/.kangentic/worktrees/7';

vi.mock('simple-git', () => {
  const gitFactory = vi.fn((cwd: string) => (cwd === WORKTREE_PATH ? mockWorktreeGit : mockProjectGit));
  return { simpleGit: gitFactory, default: gitFactory };
});

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: (...args: unknown[]) => mockResolveProjectContext(...args),
}));

// The effective-base fallback chain (task > board default > config default >
// 'main') is pinned by checkout-branch.test.ts against the real
// resolveEffectiveBaseBranch; here it is stubbed so these tests pin the
// handler's own flow around it. Likewise the cwd-keyed occupancy predicate's
// real matching is pinned through branch-checkout-occupancy.test.ts (the
// checkout guard shares it); here it is stubbed to steer the handler's flow.
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  resolveEffectiveBaseBranch: (...args: unknown[]) => mockResolveEffectiveBaseBranch(...args),
  findLiveSessionInDirectory: (...args: unknown[]) => mockFindLiveSessionInDirectory(...args),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static withGitLock<T>(_projectPath: string, operation: () => Promise<T>): Promise<T> {
      return operation();
    }
  },
}));

vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: mockFetchIfStale,
}));

vi.mock('../../src/main/git/base-branch', () => ({
  refResolvesLocally: mockRefResolvesLocally,
}));

import fs from 'node:fs';
import { registerTaskBranchHandlers } from '../../src/main/ipc/handlers/task-branch';
import { IPC } from '../../src/shared/ipc-channels';
import type { FetchIfStaleOutcome } from '../../src/main/git/fetch-throttle';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskUpdateFromBaseResult } from '../../src/shared/types';

interface MockTask {
  id: string;
  title: string;
  session_id: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  branch_name: string | null;
}

function makeTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-1',
    title: 'A task',
    session_id: null,
    worktree_path: WORKTREE_PATH,
    base_branch: null,
    branch_name: null,
    ...overrides,
  };
}

function makeContext(sessions: Array<{ id: string; status: string }> = []): IpcContext {
  return {
    currentProjectId: 'ambient-project',
    currentProjectPath: '/project',
    sessionManager: { listSessions: () => sessions },
  } as unknown as IpcContext;
}

function fetchSucceeds(): void {
  mockFetchIfStale.mockImplementation(async (
    _git: unknown, _path: string, branch: string,
    options?: { onOutcome?: (outcome: FetchIfStaleOutcome) => void },
  ) => {
    options?.onOutcome?.({ kind: 'fetched' });
    return `origin/${branch}`;
  });
}

function fetchFails(reason: 'no-remote' | 'network' | 'timeout' | 'branch-missing', message: string): void {
  mockFetchIfStale.mockImplementation(async (
    _git: unknown, _path: string, branch: string,
    options?: { onOutcome?: (outcome: FetchIfStaleOutcome) => void },
  ) => {
    options?.onOutcome?.({ kind: 'failed', reason, message });
    return branch;
  });
}

async function invoke(
  context: IpcContext,
  taskId = 'task-1',
  projectId: string | null = 'explicit-project',
): Promise<TaskUpdateFromBaseResult> {
  capturedHandlers.clear();
  registerTaskBranchHandlers(context);
  const handler = capturedHandlers.get(IPC.TASK_UPDATE_FROM_BASE);
  expect(handler).toBeDefined();
  return handler!(null, { taskId }, projectId) as Promise<TaskUpdateFromBaseResult>;
}

describe('TASK_UPDATE_FROM_BASE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockResolveProjectContext.mockImplementation((context: IpcContext, projectId?: string | null) => ({
      projectId: projectId ?? context.currentProjectId,
      projectPath: '/project',
    }));
    mockResolveEffectiveBaseBranch.mockReturnValue('main');
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => makeTask()) } });
    mockRefResolvesLocally.mockResolvedValue(true);
    mockFindLiveSessionInDirectory.mockReturnValue(undefined);
    fetchSucceeds();
    mockWorktreeGit.status.mockResolvedValue({ files: [] });
    mockWorktreeGit.raw.mockResolvedValue('0\t0\n');
    mockWorktreeGit.revparse.mockResolvedValue('task-branch\n');
  });

  it('routes by the explicit projectId (resolveProjectContext + getProjectRepos)', async () => {
    const context = makeContext();
    await invoke(context, 'task-1', 'explicit-project');

    expect(mockResolveProjectContext).toHaveBeenCalledWith(context, 'explicit-project');
    expect(mockGetProjectRepos).toHaveBeenCalledWith(context, 'explicit-project');
  });

  it('throws while the task has a running session (the tree belongs to the agent)', async () => {
    const context = makeContext([{ id: 'sess-1', status: 'running' }]);
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => makeTask({ session_id: 'sess-1' })) } });

    await expect(invoke(context)).rejects.toThrow(/Cannot update from base while a session is running/);
    expect(mockFetchIfStale).not.toHaveBeenCalled();
  });

  it('a suspended session record does not block the update', async () => {
    // task.session_id set, but no running/queued PTY: the guard passes.
    const context = makeContext([]);
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => makeTask({ session_id: 'sess-1' })) } });
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '0\t0\n' : ''));

    await expect(invoke(context)).resolves.toEqual({ status: 'already-up-to-date', baseBranch: 'main' });
  });

  it('throws for a task with no worktree', async () => {
    const context = makeContext();
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => makeTask({ worktree_path: null })) } });

    await expect(invoke(context)).rejects.toThrow(/no worktree to update/);
  });

  it('returns no-remote when the fetch reports the repo has no origin', async () => {
    const context = makeContext();
    fetchFails('no-remote', "fatal: 'origin' does not appear to be a git repository");

    await expect(invoke(context)).resolves.toEqual({ status: 'no-remote', baseBranch: 'main' });
    expect(mockWorktreeGit.raw).not.toHaveBeenCalled();
  });

  it('returns fetch-failed with the classifier message on a network failure', async () => {
    const context = makeContext();
    fetchFails('network', 'fatal: Could not resolve host: github.com');

    await expect(invoke(context)).resolves.toEqual({
      status: 'fetch-failed',
      baseBranch: 'main',
      reason: 'fatal: Could not resolve host: github.com',
    });
  });

  it('returns fetch-failed when the fetch "succeeds" but origin/<base> does not resolve', async () => {
    // A narrowed refspec or FETCH_HEAD-only fetch exits 0 without landing the
    // tracking ref; merging would then fail on a ref that is not there.
    const context = makeContext();
    mockRefResolvesLocally.mockResolvedValue(false);

    const result = await invoke(context);
    expect(result.status).toBe('fetch-failed');
    if (result.status === 'fetch-failed') {
      expect(result.reason).toContain("'origin/main' did not resolve after fetch");
    }
  });

  it('returns dirty-tree when the worktree has tracked changes, without merging', async () => {
    const context = makeContext();
    mockWorktreeGit.status.mockResolvedValue({
      files: [{ path: 'src/index.ts', index: 'M', working_dir: ' ' }],
    });

    await expect(invoke(context)).resolves.toEqual({ status: 'dirty-tree', baseBranch: 'main' });
    expect(mockWorktreeGit.raw).not.toHaveBeenCalledWith(['merge', '--ff-only', 'origin/main']);
  });

  it('untracked files do not count as dirty', async () => {
    const context = makeContext();
    mockWorktreeGit.status.mockResolvedValue({
      files: [{ path: 'scratch.txt', index: '?', working_dir: '?' }],
    });
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '2\t0\n' : ''));

    await expect(invoke(context)).resolves.toEqual({ status: 'updated', baseBranch: 'main', commitCount: 2 });
  });

  it('returns already-up-to-date at behind 0, without merging', async () => {
    const context = makeContext();
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '0\t3\n' : ''));

    await expect(invoke(context)).resolves.toEqual({ status: 'already-up-to-date', baseBranch: 'main' });
    expect(mockWorktreeGit.raw).not.toHaveBeenCalledWith(['merge', '--ff-only', 'origin/main']);
  });

  it('fast-forwards the WORKTREE from origin/<effective base> and reports the commit count', async () => {
    const context = makeContext();
    mockResolveEffectiveBaseBranch.mockReturnValue('release/2.0');
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '3\t0\n' : ''));

    await expect(invoke(context)).resolves.toEqual({ status: 'updated', baseBranch: 'release/2.0', commitCount: 3 });
    // The rev-list and the merge both run in the WORKTREE (mockWorktreeGit),
    // never the shared project checkout.
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(['rev-list', '--left-right', '--count', 'origin/release/2.0...HEAD']);
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(['merge', '--ff-only', 'origin/release/2.0']);
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('returns cannot-ff with ahead/behind when the merge refuses', async () => {
    const context = makeContext();
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '2\t1\n';
      throw new Error('fatal: Not possible to fast-forward, aborting.');
    });

    await expect(invoke(context)).resolves.toEqual({
      status: 'cannot-ff',
      baseBranch: 'main',
      ahead: 1,
      behind: 2,
    });
  });

  it('throws for an unknown task', async () => {
    const context = makeContext();
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => undefined) } });

    await expect(invoke(context)).rejects.toThrow(/not found/);
  });

  it('a live session whose cwd is the worktree blocks the merge even with no session_id on the task', async () => {
    // The row-keyed guard passes (session_id null), but a cwd-keyed occupant
    // exists - the run_script `<id>-script` / mid-recovery-spawn shape. The
    // merge must not run under it.
    const context = makeContext();
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '3\t0\n' : ''));
    mockFindLiveSessionInDirectory.mockReturnValue({ taskId: 'task-1-script' });

    await expect(invoke(context)).rejects.toThrow(/an agent is running in this worktree/);
    expect(mockFindLiveSessionInDirectory).toHaveBeenCalledWith(context, WORKTREE_PATH);
    expect(mockWorktreeGit.raw).not.toHaveBeenCalledWith(['merge', '--ff-only', 'origin/main']);
  });

  it('throws when the worktree is checked out to a different branch than the task\'s', async () => {
    // Nothing stops a user or agent from checking out another branch inside
    // the tree; merging would then advance the WRONG ref while the success
    // toast claims the task's branch moved.
    const context = makeContext();
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => makeTask({ branch_name: 'task-branch' })) } });
    mockWorktreeGit.revparse.mockResolvedValue('some-other-branch\n');

    await expect(invoke(context)).rejects.toThrow(/checked out to 'some-other-branch', not the task's branch 'task-branch'/);
    expect(mockWorktreeGit.raw).not.toHaveBeenCalledWith(['merge', '--ff-only', 'origin/main']);
  });

  it('proceeds when the worktree HEAD matches the task\'s branch', async () => {
    const context = makeContext();
    mockGetProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => makeTask({ branch_name: 'task-branch' })) } });
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '2\t0\n' : ''));

    await expect(invoke(context)).resolves.toEqual({ status: 'updated', baseBranch: 'main', commitCount: 2 });
    expect(mockWorktreeGit.revparse).toHaveBeenCalledWith(['--abbrev-ref', 'HEAD']);
  });

  it('an untracked-file collision reports dirty-tree, not a bogus cannot-ff', async () => {
    // The dirty-tree check deliberately ignores untracked files, so this
    // failure arrives as a merge refusal with ahead 0 - reporting cannot-ff
    // would toast "this branch has its own commits" when it has none.
    const context = makeContext();
    mockWorktreeGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '2\t0\n';
      throw new Error('error: The following untracked working tree files would be overwritten by merge:\n\tscratch.txt');
    });

    await expect(invoke(context)).resolves.toEqual({ status: 'dirty-tree', baseBranch: 'main' });
  });
});
