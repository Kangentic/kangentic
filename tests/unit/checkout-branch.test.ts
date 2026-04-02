/**
 * Unit tests for WorktreeManager.checkoutBranch() and the
 * ensureTaskBranchCheckout / guardActiveNonWorktreeSessions helpers.
 *
 * These functions handle branch checkout for non-worktree tasks,
 * with guards for dirty repos and concurrent non-worktree sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGit = {
  revparse: vi.fn(),
  status: vi.fn(),
  checkout: vi.fn(),
  raw: vi.fn(),
};

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(), // required by transitive import of claude-detector
  execFileSync: vi.fn(),
}));

import fs from 'node:fs';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { ensureTaskBranchCheckout } from '../../src/main/ipc/helpers';
import type { Task } from '../../src/shared/types';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1234',
    title: 'Test task',
    description: '',
    swimlane_id: 'lane-1',
    position: 0,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    agent: null,
    pr_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

// ── checkoutBranch tests ───────────────────────────────────────────────────

describe('WorktreeManager.checkoutBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when already on the target branch', async () => {
    mockGit.revparse.mockResolvedValue('feature/my-branch\n');

    const manager = new WorktreeManager('/project');
    await manager.checkoutBranch('feature/my-branch');

    expect(mockGit.status).not.toHaveBeenCalled();
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });

  it('checks out the branch when repo is clean', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.checkout.mockResolvedValue(undefined);

    const manager = new WorktreeManager('/project');
    await manager.checkoutBranch('develop');

    expect(mockGit.checkout).toHaveBeenCalledWith('develop');
  });

  it('throws when repo has tracked modifications', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({
      files: [
        { path: 'src/index.ts', index: 'M', working_dir: ' ' },
      ],
    });

    const manager = new WorktreeManager('/project');
    await expect(manager.checkoutBranch('develop')).rejects.toThrow(
      /uncommitted changes/,
    );
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });

  it('throws when repo has staged changes', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({
      files: [
        { path: 'src/app.ts', index: 'A', working_dir: ' ' },
      ],
    });

    const manager = new WorktreeManager('/project');
    await expect(manager.checkoutBranch('develop')).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it('allows checkout when repo only has untracked files', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({
      files: [
        { path: 'scratch.txt', index: '?', working_dir: '?' },
        { path: 'notes.md', index: '?', working_dir: '?' },
      ],
    });
    mockGit.checkout.mockResolvedValue(undefined);

    const manager = new WorktreeManager('/project');
    await manager.checkoutBranch('develop');

    expect(mockGit.checkout).toHaveBeenCalledWith('develop');
  });

  it('allows checkout when repo has mix of untracked and clean tracked', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({
      files: [
        { path: 'scratch.txt', index: '?', working_dir: '?' },
      ],
    });
    mockGit.checkout.mockResolvedValue(undefined);

    const manager = new WorktreeManager('/project');
    await manager.checkoutBranch('feature/test');

    expect(mockGit.checkout).toHaveBeenCalledWith('feature/test');
  });

  it('propagates git error when branch does not exist', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.checkout.mockRejectedValue(new Error("pathspec 'nonexistent' did not match any file(s) known to git"));

    const manager = new WorktreeManager('/project');
    await expect(manager.checkoutBranch('nonexistent')).rejects.toThrow(/pathspec/);
  });

  it('error message suggests worktree mode', async () => {
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({
      files: [{ path: 'dirty.ts', index: 'M', working_dir: ' ' }],
    });

    const manager = new WorktreeManager('/project');
    await expect(manager.checkoutBranch('develop')).rejects.toThrow(
      /worktree mode/,
    );
  });

  it('handles detached HEAD (revparse returns "HEAD")', async () => {
    mockGit.revparse.mockResolvedValue('HEAD\n');
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.checkout.mockResolvedValue(undefined);

    const manager = new WorktreeManager('/project');
    await manager.checkoutBranch('main');

    expect(mockGit.checkout).toHaveBeenCalledWith('main');
  });
});

// ── ensureTaskBranchCheckout tests ─────────────────────────────────────────

describe('ensureTaskBranchCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when projectPath is null', async () => {
    const task = makeTask({ base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, null);

    expect(mockGit.revparse).not.toHaveBeenCalled();
  });

  it('skips when task has a worktree_path', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const task = makeTask({ base_branch: 'develop', worktree_path: '/project/.kangentic/worktrees/test' });
    await ensureTaskBranchCheckout(task, '/project');

    expect(mockGit.revparse).not.toHaveBeenCalled();
  });

  it('skips when task has no base_branch', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const task = makeTask({ base_branch: null });
    await ensureTaskBranchCheckout(task, '/project');

    expect(mockGit.revparse).not.toHaveBeenCalled();
  });

  it('skips when project is not a git repo', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const task = makeTask({ base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    expect(mockGit.revparse).not.toHaveBeenCalled();
  });

  it('calls checkoutBranch when all guards pass', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.checkout.mockResolvedValue(undefined);

    const task = makeTask({ base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    expect(mockGit.checkout).toHaveBeenCalledWith('develop');
  });

  it('skips custom branch path for auto-generated branches', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // checkoutBranch needs revparse (current branch) + status + checkout
    mockGit.revparse.mockResolvedValue('develop\n');
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.checkout.mockResolvedValue(undefined);

    // Auto-generated branch matches the pattern: slugify('Test task') + '-' + taskId.slice(0,8)
    // slugify('Test task') = 'test-task', taskId starts with 'task-123' so shortId = 'task-123'
    const task = makeTask({ branch_name: 'test-task-task-123', base_branch: 'main' });
    await ensureTaskBranchCheckout(task, '/project');

    // Should NOT call raw (custom branch path), should fall through to base_branch checkout
    expect(mockGit.raw).not.toHaveBeenCalled();
    expect(mockGit.checkout).toHaveBeenCalledWith('main');
  });
});

// ── Custom branch checkout tests ──────────────────────────────────────────

describe('ensureTaskBranchCheckout - custom branch name', () => {
  /** Set up mocks so isGitRepo returns true and checkoutBranch succeeds. */
  function setupCheckoutMocks() {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockGit.revparse.mockResolvedValue('main\n');
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.checkout.mockResolvedValue(undefined);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches from origin before checking branch existence', async () => {
    setupCheckoutMocks();
    // Branch exists locally
    mockGit.raw.mockResolvedValue('');

    const task = makeTask({ branch_name: 'maint/59294', base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    // First raw call should be the fetch
    expect(mockGit.raw).toHaveBeenCalledWith(['fetch', 'origin', 'maint/59294']);
  });

  it('checks out local branch when it already exists', async () => {
    setupCheckoutMocks();
    // All raw calls succeed (fetch, rev-parse for local)
    mockGit.raw.mockResolvedValue('');

    const task = makeTask({ branch_name: 'maint/59294', base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    // Should checkout the custom branch, not base_branch
    expect(mockGit.checkout).toHaveBeenCalledWith('maint/59294');
    // Should NOT have tried to create a branch (no 'branch' raw call)
    const branchCreateCalls = mockGit.raw.mock.calls.filter(
      (call: string[][]) => call[0]?.[0] === 'branch',
    );
    expect(branchCreateCalls).toHaveLength(0);
  });

  it('creates local branch from remote when branch only exists on origin', async () => {
    setupCheckoutMocks();
    mockGit.raw.mockImplementation((args: string[]) => {
      // fetch succeeds
      if (args[0] === 'fetch') return Promise.resolve('');
      // local rev-parse fails (branch not local)
      if (args[0] === 'rev-parse' && args[2] === 'maint/59294') {
        return Promise.reject(new Error('fatal: not a valid object name'));
      }
      // remote rev-parse succeeds (branch exists on origin)
      if (args[0] === 'rev-parse' && args[2] === 'origin/maint/59294') {
        return Promise.resolve('abc123');
      }
      // branch creation succeeds
      if (args[0] === 'branch') return Promise.resolve('');
      return Promise.resolve('');
    });

    const task = makeTask({ branch_name: 'maint/59294', base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    // Should create from remote tracking branch
    expect(mockGit.raw).toHaveBeenCalledWith(['branch', 'maint/59294', 'origin/maint/59294']);
    expect(mockGit.checkout).toHaveBeenCalledWith('maint/59294');
  });

  it('creates branch from base_branch when it does not exist anywhere', async () => {
    setupCheckoutMocks();
    mockGit.raw.mockImplementation((args: string[]) => {
      // fetch fails (branch not on remote)
      if (args[0] === 'fetch') return Promise.reject(new Error('fatal: could not read'));
      // local rev-parse fails
      if (args[0] === 'rev-parse' && args[2] === 'maint/59294') {
        return Promise.reject(new Error('fatal: not a valid object name'));
      }
      // remote rev-parse also fails
      if (args[0] === 'rev-parse' && args[2] === 'origin/maint/59294') {
        return Promise.reject(new Error('fatal: not a valid object name'));
      }
      // branch creation succeeds
      if (args[0] === 'branch') return Promise.resolve('');
      return Promise.resolve('');
    });

    const task = makeTask({ branch_name: 'maint/59294', base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    // Should create from base_branch
    expect(mockGit.raw).toHaveBeenCalledWith(['branch', 'maint/59294', 'develop']);
    expect(mockGit.checkout).toHaveBeenCalledWith('maint/59294');
  });

  it('defaults to main when creating from base_branch and base_branch is null', async () => {
    setupCheckoutMocks();
    mockGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'fetch') return Promise.reject(new Error('no remote'));
      if (args[0] === 'rev-parse') return Promise.reject(new Error('not found'));
      if (args[0] === 'branch') return Promise.resolve('');
      return Promise.resolve('');
    });

    const task = makeTask({ branch_name: 'hotfix/urgent', base_branch: null });
    await ensureTaskBranchCheckout(task, '/project');

    // Should default to 'main' as the base
    expect(mockGit.raw).toHaveBeenCalledWith(['branch', 'hotfix/urgent', 'main']);
  });

  it('fetch failure is silent and does not block checkout', async () => {
    setupCheckoutMocks();
    let fetchCalled = false;
    mockGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'fetch') {
        fetchCalled = true;
        return Promise.reject(new Error('network timeout'));
      }
      // local rev-parse fails, remote rev-parse fails, branch create succeeds
      if (args[0] === 'rev-parse') return Promise.reject(new Error('not found'));
      if (args[0] === 'branch') return Promise.resolve('');
      return Promise.resolve('');
    });

    const task = makeTask({ branch_name: 'feature/offline', base_branch: 'main' });
    await ensureTaskBranchCheckout(task, '/project');

    expect(fetchCalled).toBe(true);
    // Should still proceed to create and checkout
    expect(mockGit.checkout).toHaveBeenCalledWith('feature/offline');
  });

  it('skips custom branch path when task has no branch_name', async () => {
    setupCheckoutMocks();
    const task = makeTask({ branch_name: null, base_branch: 'develop' });
    await ensureTaskBranchCheckout(task, '/project');

    // Should use base_branch checkout path, not custom branch path
    expect(mockGit.raw).not.toHaveBeenCalled();
    expect(mockGit.checkout).toHaveBeenCalledWith('develop');
  });

  it('skips entirely when task has no branch_name and no base_branch', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const task = makeTask({ branch_name: null, base_branch: null });
    await ensureTaskBranchCheckout(task, '/project');

    expect(mockGit.raw).not.toHaveBeenCalled();
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });
});
