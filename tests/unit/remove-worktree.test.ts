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
  mockRemoveWithRetry,
  mockSpawn,
  recordedSpawnCalls,
  spawnOverrides,
} = vi.hoisted(() => {
  // Controllable spawn mock for the new runGitWithTimeout helper. Per-test
  // tweaks live in spawnOverrides - a list of predicates + behaviors that
  // decide how each call resolves. Default: close(code=0).
  type SpawnBehavior = {
    exitCode?: number;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
    error?: Error;
  };
  const recordedSpawnCalls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const spawnOverrides: Array<{
    match: (args: readonly string[]) => boolean;
    behavior: SpawnBehavior;
  }> = [];

  return {
    mockExistsSync: vi.fn((): boolean => false),
    mockFsRm: vi.fn(async () => {}),
    mockRemoveNodeModulesPath: vi.fn(),
    mockRemoveWithRetry: vi.fn(async (_target: string): Promise<void> => {}),
    mockSpawn: vi.fn((command: string, args: readonly string[], options: { cwd: string }) => {
      recordedSpawnCalls.push({ command, args, cwd: options.cwd });
      const override = spawnOverrides.find((entry) => entry.match(args));
      const behavior = override?.behavior ?? { exitCode: 0 };

      // Minimal ChildProcess surface: EventEmitter for stdout/stderr/close/error
      const EventEmitter = require('node:events').EventEmitter;
      const child: {
        stdout: typeof EventEmitter.prototype;
        stderr: typeof EventEmitter.prototype;
        on: (event: string, handler: (...args: unknown[]) => void) => void;
        emit: (event: string, ...args: unknown[]) => boolean;
        kill: (signal?: string) => void;
      } = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });

      // queueMicrotask (not setImmediate) so the mock still works when
      // vi.useFakeTimers() is active anywhere up the stack - fake timers
      // don't affect microtasks. Also settles async so runGitWithTimeout
      // can attach its listeners first.
      queueMicrotask(() => {
        if (behavior.error) {
          child.emit('error', behavior.error);
          return;
        }
        if (behavior.stdout) child.stdout.emit('data', Buffer.from(behavior.stdout, 'utf8'));
        if (behavior.stderr) child.stderr.emit('data', Buffer.from(behavior.stderr, 'utf8'));
        child.emit('close', behavior.exitCode ?? 0, behavior.signal ?? null);
      });

      return child;
    }),
    recordedSpawnCalls,
    spawnOverrides,
  };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
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

vi.mock('../../src/main/git/rm-with-retry', () => ({
  removeWithRetry: (target: string) => mockRemoveWithRetry(target),
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
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
    manager = new WorktreeManager(PROJECT_PATH);
  });

  // Branch 1: path does not exist - short-circuit
  it('returns true immediately when the worktree path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(true);
    // No git commands or fs operations should be attempted
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockFsRm).not.toHaveBeenCalled();
    // node_modules junction cleanup is also skipped (path not present)
    expect(mockRemoveNodeModulesPath).not.toHaveBeenCalled();
  });

  // Branch 2: git worktree remove succeeds (spawn resolves with exit 0)
  it('returns true when git worktree remove succeeds', async () => {
    mockExistsSync.mockReturnValue(true);

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(true);
    // node_modules junction must be removed BEFORE any recursive operation
    expect(mockRemoveNodeModulesPath).toHaveBeenCalledWith(`${WORKTREE_PATH}/node_modules`);
    const worktreeRemoveCall = recordedSpawnCalls.find(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'remove',
    );
    expect(worktreeRemoveCall).toBeDefined();
    // removeWithRetry should NOT be called when git succeeded
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
  });

  // Branch 3: git worktree remove fails, robust fallback succeeds
  it('falls back to removeWithRetry when git worktree remove fails, returns true', async () => {
    mockExistsSync.mockReturnValue(true);
    spawnOverrides.push({
      match: (args) => args[0] === 'worktree' && args[1] === 'remove',
      behavior: { exitCode: 1, stderr: 'fatal: git worktree remove failed' },
    });
    mockRemoveWithRetry.mockResolvedValue(undefined);

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(true);
    expect(mockRemoveWithRetry).toHaveBeenCalledWith(WORKTREE_PATH);
    // worktree prune should also be called after the manual rm
    const pruneCall = recordedSpawnCalls.find(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    );
    expect(pruneCall).toBeDefined();
  });

  // Branch 4: both git and robust fallback fail - returns false.
  // The startup retry pass in resource-cleanup will try again later; this
  // unit doesn't enqueue, and task.worktree_path stays set so the retry
  // pass can find it.
  it('returns false when both git and robust fallback fail', async () => {
    mockExistsSync.mockReturnValue(true);
    spawnOverrides.push({
      match: (args) => args[0] === 'worktree' && args[1] === 'remove',
      behavior: { exitCode: 1, stderr: 'fatal: unable to remove worktree' },
    });
    mockRemoveWithRetry.mockRejectedValue(new Error('EPERM: operation not permitted'));

    const result = await manager.removeWorktree(WORKTREE_PATH);

    expect(result).toBe(false);
  });

  // Branch 5: EISDIR thrown by the robust fallback also returns false.
  it('returns false when removeWithRetry throws EISDIR after exhausting retries', async () => {
    mockExistsSync.mockReturnValue(true);
    spawnOverrides.push({
      match: (args) => args[0] === 'worktree' && args[1] === 'remove',
      behavior: { exitCode: 1, stderr: 'fatal: unable to remove worktree' },
    });
    const eisdir = Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' });
    mockRemoveWithRetry.mockRejectedValue(eisdir);

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
    // Record the first spawn call's order
    const originalSpawn = mockSpawn.getMockImplementation();
    mockSpawn.mockImplementation((command: string, args: readonly string[], options: { cwd: string }) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('gitWorktreeRemove');
      }
      return originalSpawn!(command, args, options);
    });

    await manager.removeWorktree(WORKTREE_PATH);

    expect(callOrder[0]).toBe('removeNodeModulesPath');
    expect(callOrder[1]).toBe('gitWorktreeRemove');
  });
});
