/**
 * Unit tests for carryUncommittedChanges -- carries tracked diffs and
 * untracked files from the main repo to a newly-created worktree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockProjectGit = {
  status: vi.fn(),
  diff: vi.fn(),
  raw: vi.fn(),
};
const mockWorktreeGit = {
  status: vi.fn(),
  diff: vi.fn(),
  raw: vi.fn(),
};

vi.mock('simple-git', () => ({
  simpleGit: vi.fn((cwd: string) =>
    cwd.includes('.kangentic\\worktrees') || cwd.includes('.kangentic/worktrees')
      ? mockWorktreeGit
      : mockProjectGit,
  ),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('node:os', () => ({
  default: {
    tmpdir: vi.fn(() => '/tmp'),
  },
}));

// Mock modules that tasks.ts imports but carryUncommittedChanges doesn't use
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '0.0.0'), isPackaged: false, getLocale: vi.fn(() => 'en') },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: vi.fn() }));
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: vi.fn() }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  buildAutoCommandVars: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskSession: vi.fn(),
  cleanupTaskResources: vi.fn(),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn() }));

import fs from 'node:fs';
import { carryUncommittedChanges } from '../../src/main/ipc/handlers/task-branch';

// ── Constants ──────────────────────────────────────────────────────────────

const PROJECT_PATH = '/home/dev/my-project';
const WORKTREE_PATH = '/home/dev/my-project/.kangentic/worktrees/fix-bug-abcd1234';
const TASK_SLUG = 'abcd1234';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeStatus(
  files: Array<{ path: string; index: string; working_dir: string }> = [],
  notAdded: string[] = [],
) {
  return {
    files,
    not_added: notAdded,
    created: [],
    deleted: [],
    modified: [],
    renamed: [],
    staged: [],
    ahead: 0,
    behind: 0,
    current: 'main',
    tracking: null,
    detached: false,
    isClean: () => files.length === 0 && notAdded.length === 0,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('carryUncommittedChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with no actions when the repo is clean', async () => {
    mockProjectGit.status.mockResolvedValue(makeStatus());

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.carriedTracked).toBe(false);
    expect(result.carriedUntracked).toEqual([]);
    expect(result.failedUntracked).toEqual([]);
    expect(result.applyFailed).toBe(false);
    expect(mockProjectGit.diff).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('generates diff, writes patch, applies, and cleans up for tracked changes only', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus([{ path: 'src/index.ts', index: ' ', working_dir: 'M' }]),
    );
    mockProjectGit.diff.mockResolvedValue('diff --git a/src/index.ts ...');
    mockWorktreeGit.raw.mockResolvedValue('');

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.carriedTracked).toBe(true);
    expect(result.applyFailed).toBe(false);
    expect(result.carriedUntracked).toEqual([]);

    // Patch file written and applied
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('kangentic-patch-abcd1234.patch'),
      'diff --git a/src/index.ts ...',
    );
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(
      'apply', '--3way', expect.stringContaining('kangentic-patch-abcd1234.patch'),
    );
    // Patch file cleaned up
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('kangentic-patch-abcd1234.patch'),
    );
  });

  it('copies untracked files only when no tracked changes exist', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus([], ['newfile.txt', 'docs/readme.md']),
    );
    mockProjectGit.diff.mockResolvedValue('');

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.carriedTracked).toBe(false);
    expect(result.applyFailed).toBe(false);
    expect(result.carriedUntracked).toEqual(['newfile.txt', 'docs/readme.md']);

    // No patch apply since diff was empty
    expect(mockWorktreeGit.raw).not.toHaveBeenCalled();

    // Both files copied
    expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
    expect(fs.mkdirSync).toHaveBeenCalledTimes(2);
  });

  it('handles mixed tracked and untracked changes', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus(
        [{ path: 'src/app.ts', index: 'M', working_dir: ' ' }],
        ['new-util.ts'],
      ),
    );
    mockProjectGit.diff.mockResolvedValue('diff --git a/src/app.ts ...');
    mockWorktreeGit.raw.mockResolvedValue('');

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.carriedTracked).toBe(true);
    expect(result.carriedUntracked).toEqual(['new-util.ts']);
    expect(result.applyFailed).toBe(false);
  });

  it('sets applyFailed when git apply throws, then continues to untracked files', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus(
        [{ path: 'conflict.ts', index: ' ', working_dir: 'M' }],
        ['safe.txt'],
      ),
    );
    mockProjectGit.diff.mockResolvedValue('diff --git a/conflict.ts ...');
    mockWorktreeGit.raw.mockRejectedValue(new Error('patch does not apply'));

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.applyFailed).toBe(true);
    expect(result.carriedTracked).toBe(false);
    // Untracked files should still be processed
    expect(result.carriedUntracked).toEqual(['safe.txt']);
  });

  it('reports failed untracked files while succeeding on others', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus([], ['good.txt', 'bad.txt', 'also-good.txt']),
    );
    mockProjectGit.diff.mockResolvedValue('');

    let copyCallCount = 0;
    vi.mocked(fs.copyFileSync).mockImplementation((_source, _dest) => {
      copyCallCount++;
      if (copyCallCount === 2) {
        throw new Error('EACCES: permission denied');
      }
    });

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.carriedUntracked).toEqual(['good.txt', 'also-good.txt']);
    expect(result.failedUntracked).toEqual(['bad.txt']);
  });

  it('skips apply when diff returns empty string but status.files is non-empty', async () => {
    // This can happen with files that only have permission changes or renames
    mockProjectGit.status.mockResolvedValue(
      makeStatus([{ path: 'perms.sh', index: ' ', working_dir: 'M' }]),
    );
    mockProjectGit.diff.mockResolvedValue('');

    const result = await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(result.carriedTracked).toBe(false);
    expect(result.applyFailed).toBe(false);
    // No patch written or applied
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(mockWorktreeGit.raw).not.toHaveBeenCalled();
  });

  it('cleans up temp file even when apply fails', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus([{ path: 'file.ts', index: ' ', working_dir: 'M' }]),
    );
    mockProjectGit.diff.mockResolvedValue('some diff content');
    mockWorktreeGit.raw.mockRejectedValue(new Error('apply failed'));

    await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('kangentic-patch-abcd1234.patch'),
    );
  });

  it('creates nested parent directories for untracked files', async () => {
    mockProjectGit.status.mockResolvedValue(
      makeStatus([], ['src/deep/nested/new.ts']),
    );
    mockProjectGit.diff.mockResolvedValue('');

    await carryUncommittedChanges(PROJECT_PATH, WORKTREE_PATH, TASK_SLUG);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('src'),
      { recursive: true },
    );
    // path.join uses OS-native separators, so match on the filename only
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('new.ts'),
      expect.stringContaining('new.ts'),
    );
    // Verify source is from project path and destination is from worktree path
    const copyCall = vi.mocked(fs.copyFileSync).mock.calls[0];
    expect(String(copyCall[0])).toContain('my-project');
    expect(String(copyCall[1])).toContain('.kangentic');
  });
});
