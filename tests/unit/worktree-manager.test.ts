/**
 * Unit tests for WorktreeManager — sparse-checkout logic that excludes
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
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

import fs from 'node:fs';
import { WorktreeManager } from '../../src/main/git/worktree-manager';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Set up mocks so createWorktree succeeds and reaches sparse-checkout / copyFiles. */
function setupCreateWorktreeMocks() {
  // fs.existsSync: always true (worktrees dir, copy sources)
  vi.mocked(fs.existsSync).mockReturnValue(true);

  // Project-level git: fetch + worktree add
  mockProjectGit.raw.mockResolvedValue('');

  // Worktree-level git: config, sparse-checkout
  mockWorktreeGit.raw.mockResolvedValue('');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WorktreeManager — sparse-checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes sparse-checkout with --no-cone and excludes .claude/', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // Verify sparse-checkout init was called
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'sparse-checkout', 'init', '--no-cone',
    ]);

    // Verify sparse-checkout set was called to exclude .claude/
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'sparse-checkout', 'set', '/*', '!/.claude/',
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

describe('WorktreeManager — fetch and base branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches from origin and uses origin/<baseBranch> as start point when fetch succeeds', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockResolvedValue('');
    mockWorktreeGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Fetch test', 'develop');

    // First call: fetch origin develop
    expect(mockProjectGit.raw).toHaveBeenCalledWith(['fetch', 'origin', 'develop']);

    // Second call: worktree add with origin/develop as start point
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (c: string[][]) => c[0]?.[0] === 'worktree' && c[0]?.[1] === 'add',
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0][worktreeAddCall![0].length - 1]).toBe('origin/develop');
  });

  it('falls back to local branch when fetch fails (no remote)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockWorktreeGit.raw.mockResolvedValue('');

    // Fetch rejects, worktree add resolves
    let callCount = 0;
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      callCount++;
      if (args[0] === 'fetch') {
        return Promise.reject(new Error('fatal: no remote'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'No remote test', 'main');

    // worktree add should use local 'main' (not 'origin/main')
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (c: string[][]) => c[0]?.[0] === 'worktree' && c[0]?.[1] === 'add',
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0][worktreeAddCall![0].length - 1]).toBe('main');
  });

  it('stores kangentic.baseBranch in worktree git config', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockResolvedValue('');
    mockWorktreeGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Config test', 'develop');

    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'config', 'kangentic.baseBranch', 'develop',
    ]);
  });

  it('kangentic.baseBranch config failure is non-fatal', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockResolvedValue('');

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

describe('WorktreeManager — removal', () => {
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
    await runWithTimers(mgr.removeWorktree('/project/.kangentic/worktrees/test-abcd1234'));

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

    // rmSync fails twice (EPERM), then succeeds on third attempt
    let rmSyncCount = 0;
    vi.mocked(fs.rmSync).mockImplementation(() => {
      rmSyncCount++;
      if (rmSyncCount < 3) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
    });

    const mgr = new WorktreeManager('/project');
    await runWithTimers(mgr.removeWorktree('/project/.kangentic/worktrees/test-abcd1234'));

    // rmSync called 3 times (2 failures + 1 success)
    expect(fs.rmSync).toHaveBeenCalledTimes(3);
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

    // Should not throw — logs warning instead
    await runWithTimers(mgr.removeWorktree(wtPath));

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

// ── listWorktrees tests ───────────────────────────────────────────────────

describe('WorktreeManager — listWorktrees', () => {
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
