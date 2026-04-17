/**
 * Unit tests for WorktreeManager.removeWorktree.
 *
 * Covers the four internal branches:
 *   1. Non-existent path: short-circuit, returns true immediately
 *   2. git worktree remove success: returns true
 *   3. git worktree remove fails, fs.promises.rm fallback success: returns true
 *   4. Both git and fs.rm fail: returns false (best-effort prune still attempted)
 *
 * Also verifies that node_modules junction cleanup happens before any recursive
 * operation (prevents accidental deletion of main repo node_modules on Windows).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockFsRm,
  mockRemoveNodeModulesPath,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => false),
  mockFsRm: vi.fn(async () => {}),
  mockRemoveNodeModulesPath: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    promises: {
      rm: mockFsRm,
    },
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: (...segments: string[]) => segments.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  },
}));

vi.mock('../../src/main/git/node-modules-link', () => ({
  linkNodeModules: vi.fn(),
  removeNodeModulesPath: (...args: unknown[]) => mockRemoveNodeModulesPath(...args),
}));

vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: vi.fn(async () => 'main'),
}));

vi.mock('../../src/shared/slugify', () => ({
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)),
  computeSlugBudget: vi.fn(() => 20),
  computeAutoBranchName: vi.fn(
    (_base: string, _default: string, slug: string, shortId: string) => `${slug}-${shortId}`,
  ),
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => true),
  isInsideWorktree: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// simple-git mock: captures the last git.raw() call per WorktreeManager instance
// ---------------------------------------------------------------------------

type GitRawFn = (args: string[]) => Promise<string>;

const mockGitRaw = vi.fn<GitRawFn>(async () => '');
const mockGitInstances: Array<{ raw: typeof mockGitRaw }> = [];

vi.mock('simple-git', () => ({
  default: vi.fn(() => {
    const instance = { raw: mockGitRaw };
    mockGitInstances.push(instance);
    return instance;
  }),
  simpleGit: vi.fn(() => {
    const instance = { raw: mockGitRaw };
    mockGitInstances.push(instance);
    return instance;
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { WorktreeManager } from '../../src/main/git/worktree-manager';

const WORKTREE_PATH = '/mock/project/.kangentic/worktrees/my-task-abcd1234';
const PROJECT_PATH = '/mock/project';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorktreeManager.removeWorktree', () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitInstances.length = 0;
    manager = new WorktreeManager(PROJECT_PATH);
  });

  // Branch 1: path does not exist - short-circuit
  it('returns true immediately when the worktree path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(true);
    // No git commands or fs operations should be attempted
    expect(mockGitRaw).not.toHaveBeenCalled();
    expect(mockFsRm).not.toHaveBeenCalled();
    // node_modules junction cleanup is also skipped (path not present)
    expect(mockRemoveNodeModulesPath).not.toHaveBeenCalled();
  });

  // Branch 2: git worktree remove succeeds
  it('returns true when git worktree remove succeeds', async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitRaw.mockResolvedValue('');

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(true);
    // node_modules junction must be removed BEFORE any recursive operation
    expect(mockRemoveNodeModulesPath).toHaveBeenCalledWith(`${WORKTREE_PATH}/node_modules`);
    const calls = mockGitRaw.mock.calls.map((call) => call[0]);
    const worktreeRemoveCall = calls.find(
      (args) => args[0] === 'worktree' && args[1] === 'remove',
    );
    expect(worktreeRemoveCall).toBeDefined();
    // fs.promises.rm should NOT be called when git succeeded
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  // Branch 3: git worktree remove fails, fs.promises.rm fallback succeeds
  it('falls back to fs.promises.rm when git worktree remove fails, returns true', async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitRaw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('fatal: git worktree remove failed');
      }
      // worktree prune and any other git calls succeed
      return '';
    });
    mockFsRm.mockResolvedValue(undefined);

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(true);
    // fs.rm should be called with the worktree path
    expect(mockFsRm).toHaveBeenCalledWith(
      WORKTREE_PATH,
      expect.objectContaining({ recursive: true, force: true }),
    );
    // worktree prune should also be called after the manual rm
    const calls = mockGitRaw.mock.calls.map((call) => call[0]);
    const pruneCall = calls.find(
      (args) => args[0] === 'worktree' && args[1] === 'prune',
    );
    expect(pruneCall).toBeDefined();
  });

  // Branch 4: both git worktree remove and fs.promises.rm fail - returns false
  it('returns false when both git and fs.rm fail', async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitRaw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('fatal: unable to remove worktree');
      }
      // prune call is best-effort and may succeed
      return '';
    });
    mockFsRm.mockRejectedValue(new Error('EPERM: operation not permitted'));

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(false);
  });

  // Guard: node_modules junction cleaned up BEFORE git/fs recursive operations
  it('removes node_modules junction before attempting git worktree remove', async () => {
    mockExistsSync.mockReturnValue(true);
    const callOrder: string[] = [];

    mockRemoveNodeModulesPath.mockImplementation(() => {
      callOrder.push('removeNodeModulesPath');
    });
    mockGitRaw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('gitWorktreeRemove');
      }
      return '';
    });

    await manager.removeWorktree(WORKTREE_PATH);

    expect(callOrder[0]).toBe('removeNodeModulesPath');
    expect(callOrder[1]).toBe('gitWorktreeRemove');
  });
});
