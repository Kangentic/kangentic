/**
 * Unit tests for WorktreeManager -- sparse-checkout logic that excludes
 * .claude/ from worktrees to prevent git contamination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockProjectGit = { raw: vi.fn() };
const mockWorktreeGit = { raw: vi.fn() };

vi.mock('simple-git', () => ({
  default: vi.fn((cwd: string) =>
    // path.join uses backslashes on Windows, forward slashes elsewhere
    cwd.includes('.kangentic\\worktrees') || cwd.includes('.kangentic/worktrees')
      ? mockWorktreeGit
      : mockProjectGit,
  ),
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
  execFileSync: vi.fn(),
}));

import fs from 'node:fs';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { isGitRepo, isInsideWorktree, isKangenticWorktree } from '../../src/main/git/git-checks';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Set up mocks so createWorktree succeeds and reaches sparse-checkout / copyFiles. */
function setupCreateWorktreeMocks() {
  // fs.existsSync: true for .git check and worktrees dir, false for stale worktree path check
  vi.mocked(fs.existsSync).mockImplementation((checkPath: fs.PathLike) => {
    // Stale worktree directory check: return false (no stale directory)
    if (String(checkPath).includes('.kangentic') && String(checkPath).includes('worktrees') &&
        !String(checkPath).endsWith('worktrees')) {
      return false;
    }
    return true;
  });

  // Project-level git: rev-parse --verify should fail (branch doesn't exist yet)
  mockProjectGit.raw.mockImplementation((args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return Promise.reject(new Error('fatal: not a valid object name'));
    }
    return Promise.resolve('');
  });

  // Worktree-level git: config, sparse-checkout
  mockWorktreeGit.raw.mockResolvedValue('');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WorktreeManager -- sparse-checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes sparse-checkout with --no-cone and excludes .claude/commands/', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // Verify sparse-checkout init was called
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'sparse-checkout', 'init', '--no-cone',
    ]);

    // Verify sparse-checkout set was called to exclude .claude/commands/ only
    // (skills and agents do NOT walk up the directory tree, so they must stay in worktrees)
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'sparse-checkout', 'set', '/*', '!/.claude/commands/',
    ]);
  });

  it('sparse-checkout runs before copyFiles', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task', 'main', ['README.md']);

    // Find the call order indices
    const calls = mockWorktreeGit.raw.mock.calls;
    const sparseInitIdx = calls.findIndex(
      (c: string[][]) => c[0]?.[0] === 'sparse-checkout' && c[0]?.[1] === 'init',
    );
    const sparseSetIdx = calls.findIndex(
      (c: string[][]) => c[0]?.[0] === 'sparse-checkout' && c[0]?.[1] === 'set',
    );

    // sparse-checkout should have been called
    expect(sparseInitIdx).toBeGreaterThanOrEqual(0);
    expect(sparseSetIdx).toBeGreaterThan(sparseInitIdx);

    // copyFileSync should have been called (for README.md)
    expect(fs.copyFileSync).toHaveBeenCalled();
  });

  it('skips .claude/ entries in copyFiles', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task', 'main', [
      '.claude/settings.local.json',
      '.claude\\commands\\review.md',
      'README.md',
    ]);

    // Only README.md should be copied (2 .claude/ entries skipped)
    expect(fs.copyFileSync).toHaveBeenCalledTimes(1);
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('README.md'),
      expect.stringContaining('README.md'),
    );
  });

  it('no skip-worktree or update-index calls', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task', 'main', [
      '.claude/settings.local.json',
    ]);

    // No update-index, ls-files, or skip-worktree calls
    const forbiddenCalls = mockWorktreeGit.raw.mock.calls.filter(
      (c: string[][]) =>
        c[0]?.[0] === 'update-index' || c[0]?.[0] === 'ls-files',
    );
    expect(forbiddenCalls).toHaveLength(0);
  });

  it('does not call rmSync for .claude directories', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // rmSync should not be called for .claude dirs (sparse-checkout handles exclusion)
    const rmCalls = vi.mocked(fs.rmSync).mock.calls.filter(
      (c) => String(c[0]).includes('.claude'),
    );
    expect(rmCalls).toHaveLength(0);
  });
});

// ── Fetch & base branch tests ─────────────────────────────────────────────

describe('WorktreeManager -- fetch and base branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
  });

  it('fetches from origin and uses origin/<baseBranch> as start point when fetch succeeds', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });
    mockWorktreeGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Fetch test', 'develop');

    // First call: fetch origin develop
    expect(mockProjectGit.raw).toHaveBeenCalledWith(['fetch', 'origin', 'develop']);

    // Second call: worktree add with origin/develop as start point
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (c: string[][]) => c[0]?.includes('worktree') && c[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0][worktreeAddCall![0].length - 1]).toBe('origin/develop');
  });

  it('falls back to local branch when fetch fails (no remote)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockWorktreeGit.raw.mockResolvedValue('');

    // Fetch rejects, rev-parse rejects (no existing branch), worktree add resolves
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'fetch') {
        return Promise.reject(new Error('fatal: no remote'));
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'No remote test', 'main');

    // worktree add should use local 'main' (not 'origin/main')
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (c: string[][]) => c[0]?.includes('worktree') && c[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0][worktreeAddCall![0].length - 1]).toBe('main');
  });

  it('stores kangentic.baseBranch in worktree git config', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });
    mockWorktreeGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Config test', 'develop');

    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'config', 'kangentic.baseBranch', 'develop',
    ]);
  });

  it('kangentic.baseBranch config failure is non-fatal', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    // Config call fails, sparse-checkout calls succeed
    mockWorktreeGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'config') {
        return Promise.reject(new Error('config write failed'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');

    // Should not throw
    const result = await mgr.createWorktree('abcd1234-0000', 'Config fail test');
    expect(result.worktreePath).toBeDefined();
    expect(result.branchName).toBeDefined();
  });
});

// ── Removal tests ─────────────────────────────────────────────────────────

describe('WorktreeManager -- removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance fake timers while the promise is pending so setTimeout resolves. */
  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    let result: T | undefined;
    let done = false;
    const p = promise.then(r => { result = r; done = true; });
    while (!done) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await p;
    return result as T;
  }

  it('removeWorktree calls git worktree remove --force', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    const result = await runWithTimers(mgr.removeWorktree('/project/.kangentic/worktrees/test-abcd1234'));

    expect(result).toBe(true);
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'worktree', 'remove', '/project/.kangentic/worktrees/test-abcd1234', '--force',
    ]);
  });

  it('removeWorktree falls back to rmSync + prune on failure with retry', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return Promise.reject(new Error('worktree remove failed'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    const wtPath = '/project/.kangentic/worktrees/test-abcd1234';
    await runWithTimers(mgr.removeWorktree(wtPath));

    // Should have called rmSync (first retry succeeds)
    expect(fs.rmSync).toHaveBeenCalledWith(wtPath, { recursive: true, force: true });

    // Should have called git worktree prune
    expect(mockProjectGit.raw).toHaveBeenCalledWith(['worktree', 'prune']);
  });

  it('removeWorktree retries rmSync on EPERM then succeeds', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return Promise.reject(new Error('worktree remove failed'));
      }
      return Promise.resolve('');
    });

    // rmSync fails once (EPERM), then succeeds on second attempt
    let rmSyncCount = 0;
    vi.mocked(fs.rmSync).mockImplementation(() => {
      rmSyncCount++;
      if (rmSyncCount < 2) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
    });

    const mgr = new WorktreeManager('/project');
    await runWithTimers(mgr.removeWorktree('/project/.kangentic/worktrees/test-abcd1234'));

    // rmSync called 2 times (1 failure + 1 success)
    expect(fs.rmSync).toHaveBeenCalledTimes(2);
    expect(mockProjectGit.raw).toHaveBeenCalledWith(['worktree', 'prune']);
  });

  it('removeWorktree logs warning when all retries exhausted', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return Promise.reject(new Error('worktree remove failed'));
      }
      return Promise.resolve('');
    });

    // rmSync always fails
    vi.mocked(fs.rmSync).mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const mgr = new WorktreeManager('/project');
    const wtPath = '/project/.kangentic/worktrees/test-abcd1234';

    // Should not throw -- logs warning and returns false
    const result = await runWithTimers(mgr.removeWorktree(wtPath));

    expect(result).toBe(false);
    // 2 attempts (immediate + one 500ms retry)
    expect(fs.rmSync).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove worktree after retries'),
    );
    warnSpy.mockRestore();
  });

  it('removeWorktree no-ops when path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const mgr = new WorktreeManager('/project');
    await mgr.removeWorktree('/project/.kangentic/worktrees/nonexistent');

    // git should not be called at all
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('removeBranch calls git branch -D', async () => {
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.removeBranch('kanban/fix-bug-abcd1234');

    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-D', 'kanban/fix-bug-abcd1234',
    ]);
  });

  it('removeBranch silently handles missing branch', async () => {
    mockProjectGit.raw.mockRejectedValue(new Error('error: branch not found'));

    const mgr = new WorktreeManager('/project');

    // Should not throw
    await expect(mgr.removeBranch('kanban/nonexistent')).resolves.toBeUndefined();
  });
});

// ── renameBranch tests ────────────────────────────────────────────────────

describe('WorktreeManager -- renameBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectGit.raw.mockResolvedValue('');
  });

  it('calls git branch -m with old and new slug when title changes', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = 'abcd1234-0000-0000-0000-000000000000';
    const oldBranchName = 'old-title-abcd1234';

    const result = await mgr.renameBranch(taskId, oldBranchName, 'New Title');

    expect(result).toBe('new-title-abcd1234');
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-m', 'old-title-abcd1234', 'new-title-abcd1234',
    ]);
  });

  it('uses taskId first 8 chars as the branch suffix', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = 'deadbeef-face-0000-0000-000000000000';

    const result = await mgr.renameBranch(taskId, 'irrelevant-deadbeef', 'Fix Login Bug');

    expect(result).toBe('fix-login-bug-deadbeef');
  });

  it('returns null without calling git when slug is unchanged', async () => {
    const mgr = new WorktreeManager('/project');
    // Only punctuation changes - slugify collapses them, so slug stays identical.
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'fix-login-abcd1234',
      'Fix  login!!',
    );

    expect(result).toBeNull();
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('returns null and logs error when git branch -m fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProjectGit.raw.mockRejectedValue(new Error('fatal: branch already exists'));

    const mgr = new WorktreeManager('/project');
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'old-slug-abcd1234',
      'New Title',
    );

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[WORKTREE] Branch rename failed:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('preserves the base-branch namespace prefix when renaming', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'bugfix-inacc-adjustments/old-title-abcd1234',
      'New Title',
      { baseBranch: 'bugfix/inacc-adjustments', defaultBaseBranch: 'main' },
    );

    expect(result).toBe('bugfix-inacc-adjustments/new-title-abcd1234');
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-m',
      'bugfix-inacc-adjustments/old-title-abcd1234',
      'bugfix-inacc-adjustments/new-title-abcd1234',
    ]);
  });

  it('drops the prefix when base equals the default', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'old-title-abcd1234',
      'New Title',
      { baseBranch: 'main', defaultBaseBranch: 'main' },
    );

    expect(result).toBe('new-title-abcd1234');
  });

  it('falls back to "task" slug when the title produces an empty slug', async () => {
    const mgr = new WorktreeManager('/project');
    // A title of only punctuation produces an empty slug string before the
    // fallback -- renameBranch must substitute 'task' so the branch name is
    // still valid.
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'old-abcd1234',
      '!!!',
    );

    expect(result).toBe('task-abcd1234');
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-m', 'old-abcd1234', 'task-abcd1234',
    ]);
  });
});

// ── listWorktrees tests ───────────────────────────────────────────────────

describe('WorktreeManager -- listWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses git worktree list --porcelain output correctly', async () => {
    mockProjectGit.raw.mockResolvedValue(
      'worktree /project\n' +
      'HEAD abc1234\n' +
      'branch refs/heads/main\n' +
      '\n' +
      'worktree /project/.kangentic/worktrees/fix-bug-abcd1234\n' +
      'HEAD def5678\n' +
      'branch refs/heads/kanban/fix-bug-abcd1234\n' +
      '\n',
    );

    const mgr = new WorktreeManager('/project');
    const result = await mgr.listWorktrees();

    expect(result).toEqual([
      '/project',
      '/project/.kangentic/worktrees/fix-bug-abcd1234',
    ]);
  });

  it('returns empty array for bare output', async () => {
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    const result = await mgr.listWorktrees();

    expect(result).toEqual([]);
  });
});

// ── ensureWorktree guard tests ─────────────────────────────────────────────

describe('WorktreeManager -- ensureWorktree', () => {
  const gitConfig = { worktreesEnabled: true, defaultBaseBranch: 'main', copyFiles: [] as string[] };

  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    // Default: isGitRepo returns true, isInsideWorktree returns false
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('not a file'); });
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });
    mockWorktreeGit.raw.mockResolvedValue('');
  });

  it('returns null when task already has a worktree_path', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', worktree_path: '/existing' },
      gitConfig,
    );
    expect(result).toBeNull();
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('returns null when worktreesEnabled is false', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', worktree_path: null },
      { ...gitConfig, worktreesEnabled: false },
    );
    expect(result).toBeNull();
  });

  it('returns null when project is not a git repo', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', worktree_path: null },
      gitConfig,
    );
    expect(result).toBeNull();
    expect(isGitRepo('/project')).toBe(false);
  });

  it('returns null when project is inside a worktree', async () => {
    // existsSync true (for .git check) + statSync returns isFile=true (worktree)
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);

    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', worktree_path: null },
      gitConfig,
    );
    expect(result).toBeNull();
    expect(isInsideWorktree('/project')).toBe(true);
  });

  it('delegates to createWorktree with resolved base branch on success', async () => {
    // statSync throws (not a worktree file), existsSync true (is git repo)
    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', worktree_path: null, base_branch: 'develop' },
      gitConfig,
    );

    expect(result).not.toBeNull();
    // Branch name encodes the non-default base as a namespace prefix so the
    // worktree's origin is visible at-a-glance in git log / GitHub branch lists.
    expect(result!.branchName).toBe('develop/test-abcd1234');
    // Should have used 'develop' (task override) not 'main' (config default)
    expect(mockProjectGit.raw).toHaveBeenCalledWith(['fetch', 'origin', 'develop']);
  });
});

describe('isKangenticWorktree', () => {
  it('returns true for paths inside .kangentic/worktrees/', () => {
    expect(isKangenticWorktree('/home/dev/project/.kangentic/worktrees/fix-bug-abc123')).toBe(true);
  });

  it('returns true for Windows backslash paths', () => {
    expect(isKangenticWorktree('C:\\Users\\dev\\project\\.kangentic\\worktrees\\fix-bug-abc123')).toBe(true);
  });

  it('returns false for normal project paths', () => {
    expect(isKangenticWorktree('/home/dev/my-app')).toBe(false);
  });

  it('returns false for external git worktrees', () => {
    expect(isKangenticWorktree('/home/dev/kangentic.com')).toBe(false);
  });

  it('returns false for path containing worktrees without .kangentic parent', () => {
    expect(isKangenticWorktree('/home/dev/worktrees/some-branch')).toBe(false);
  });

  it('returns false for path ending at .kangentic/worktrees with no trailing slash', () => {
    expect(isKangenticWorktree('/home/dev/project/.kangentic/worktrees')).toBe(false);
  });

  it('returns true for mixed-slash paths (cross-platform edge case)', () => {
    expect(isKangenticWorktree('C:/Users/dev/project/.kangentic/worktrees/fix-bug')).toBe(true);
    expect(isKangenticWorktree('/home/dev/project\\.kangentic\\worktrees\\fix-bug')).toBe(true);
  });

  it('returns false for path nested INSIDE a worktree checkout (regression)', () => {
    expect(isKangenticWorktree(
      'C:\\Users\\dev\\kangentic\\.kangentic\\worktrees\\my-branch\\tests\\.tmp\\test-project',
    )).toBe(false);
    expect(isKangenticWorktree(
      '/home/dev/kangentic/.kangentic/worktrees/my-branch/tests/.tmp/test-project',
    )).toBe(false);
  });
});

// ── Stale branch recovery tests ───────────────────────────────────────────

describe('WorktreeManager -- stale branch recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    mockWorktreeGit.raw.mockResolvedValue('');
  });

  it('createWorktree reuses auto-generated branch that already exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    // rev-parse succeeds (branch exists from failed cleanup), all others succeed
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    const result = await mgr.createWorktree('abcd1234-0000', 'Test task');

    expect(result.branchName).toBe('test-task-abcd1234');

    // Should use 'worktree add <path> <branch>' (no -b flag)
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (call: string[][]) => call[0]?.includes('worktree') && call[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    const worktreeAddArgs = worktreeAddCall![0];
    const worktreeIndex = worktreeAddArgs.indexOf('worktree');
    expect(worktreeAddArgs.slice(worktreeIndex)).toEqual([
      'worktree', 'add',
      expect.stringContaining('test-task-abcd1234'),
      'test-task-abcd1234',
    ]);
    // Should NOT contain -b flag
    expect(worktreeAddArgs).not.toContain('-b');
  });

  it('createWorktree does not inline prune (moved to background)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // Prune should NOT be called inline during createWorktree
    // (it's been moved to background via scheduleBackgroundPrune)
    const calls = mockProjectGit.raw.mock.calls.map((call: string[][]) => call[0]);
    const pruneCall = calls.find(
      (args: string[]) => args.includes('worktree') && args.includes('prune'),
    );
    expect(pruneCall).toBeUndefined();
  });

  it('createWorktree cleans up stale directory before git worktree add', async () => {
    const stalePath = expect.stringContaining('test-task-abcd1234');

    // existsSync: true for stale worktree path
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // removeWorktree should have been called via git worktree remove --force
    expect(mockProjectGit.raw).toHaveBeenCalledWith(['worktree', 'remove', stalePath, '--force']);
  });

  it('pruneWorktrees calls git worktree prune', async () => {
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.pruneWorktrees();

    expect(mockProjectGit.raw).toHaveBeenCalledWith(['worktree', 'prune']);
  });
});

// ── Serial queue tests ────────────────────────────────────────────────────

describe('WorktreeManager -- serial queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WorktreeManager.clearQueue('/project');
    WorktreeManager.clearQueue('/other-project');
  });

  it('concurrent operations on same project execute sequentially', async () => {
    const executionOrder: number[] = [];
    let resolveFirst: () => void;
    const firstBlocked = new Promise<void>(resolve => { resolveFirst = resolve; });

    const operation1 = WorktreeManager.withGitLock('/project', async () => {
      executionOrder.push(1);
      await firstBlocked;
      executionOrder.push(2);
      return 'first';
    });

    const operation2 = WorktreeManager.withGitLock('/project', async () => {
      executionOrder.push(3);
      return 'second';
    });

    // operation2 should not start until operation1 finishes
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(executionOrder).toEqual([1]);

    resolveFirst!();
    const [result1, result2] = await Promise.all([operation1, operation2]);

    expect(result1).toBe('first');
    expect(result2).toBe('second');
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it('concurrent operations on different projects execute in parallel', async () => {
    const executionOrder: string[] = [];
    let resolveA: () => void;
    let resolveB: () => void;
    const blockedA = new Promise<void>(resolve => { resolveA = resolve; });
    const blockedB = new Promise<void>(resolve => { resolveB = resolve; });

    const operationA = WorktreeManager.withGitLock('/project', async () => {
      executionOrder.push('A-start');
      await blockedA;
      executionOrder.push('A-end');
    });

    const operationB = WorktreeManager.withGitLock('/other-project', async () => {
      executionOrder.push('B-start');
      await blockedB;
      executionOrder.push('B-end');
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    // Both should have started (different projects run independently)
    expect(executionOrder).toContain('A-start');
    expect(executionOrder).toContain('B-start');

    resolveA!();
    resolveB!();
    await Promise.all([operationA, operationB]);
  });

  it('failed operation does not block subsequent operations', async () => {
    const failingOperation = WorktreeManager.withGitLock('/project', async () => {
      throw new Error('git failed');
    });

    await expect(failingOperation).rejects.toThrow('git failed');

    // Next operation should still run
    const result = await WorktreeManager.withGitLock('/project', async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('clearQueue removes the project entry', async () => {
    // Queue an operation to ensure the key exists
    await WorktreeManager.withGitLock('/project', async () => 'done');

    // clearQueue should not throw and subsequent operations should work
    WorktreeManager.clearQueue('/project');

    const result = await WorktreeManager.withGitLock('/project', async () => 'after-clear');
    expect(result).toBe('after-clear');
  });

  it('withLock instance method uses the project path', async () => {
    const manager = new WorktreeManager('/project');
    const executionOrder: number[] = [];

    const operation1 = manager.withLock(async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, 10));
      executionOrder.push(2);
      return 'first';
    });

    const operation2 = manager.withLock(async () => {
      executionOrder.push(3);
      return 'second';
    });

    await Promise.all([operation1, operation2]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });
});
