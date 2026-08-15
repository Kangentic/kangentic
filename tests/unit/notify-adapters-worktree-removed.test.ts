/**
 * Unit tests for notifyAdaptersWorktreeRemoved (src/main/ipc/helpers/task-cleanup.ts).
 *
 * This is the fan-out from the single worktree-removed chokepoint
 * (WorktreeManager.removeWorktree, see worktree-manager.ts) to every agent
 * adapter that wants to drop per-directory state it recorded for a worktree
 * Kangentic has just deleted. Codex is the motivating case: its directory
 * trust lives in ~/.codex/config.toml keyed by path, and without cleanup
 * accumulates one dead entry per task forever.
 *
 * Best-effort by contract: a single adapter's onWorktreeRemoved rejecting
 * must not stop the remaining adapters from being notified, and must not
 * throw out of notifyAdaptersWorktreeRemoved itself (the caller is the
 * worktree-manager listener, which is also best-effort - see
 * remove-worktree.test.ts's "a listener that throws does not fail the
 * removal").
 *
 * Import-time safety: task-cleanup.ts also imports simple-git, better-sqlite3,
 * WorktreeManager, and the db repositories for its other exports
 * (cleanupTaskSession, cleanupTaskResources, deleteTaskWorktree). Mirrors
 * task-cleanup-live-guard.test.ts's defensive mocks so importing the module
 * never touches a native binding or real git.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('simple-git', () => ({ simpleGit: vi.fn(() => ({ revparse: vi.fn() })) }));
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));

const mockAdapters = new Map<string, { onWorktreeRemoved?: (path: string) => Promise<void> }>();

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => Array.from(mockAdapters.keys()),
    get: (name: string) => mockAdapters.get(name),
  },
}));

import { notifyAdaptersWorktreeRemoved } from '../../src/main/ipc/helpers/task-cleanup';

const WORKTREE_PATH = '/mock/project/.kangentic/worktrees/7';

describe('notifyAdaptersWorktreeRemoved', () => {
  beforeEach(() => {
    mockAdapters.clear();
  });

  it('calls onWorktreeRemoved on every adapter that implements it', async () => {
    const codexRemoved = vi.fn(async () => {});
    const geminiRemoved = vi.fn(async () => {});
    mockAdapters.set('codex', { onWorktreeRemoved: codexRemoved });
    mockAdapters.set('gemini', { onWorktreeRemoved: geminiRemoved });

    await notifyAdaptersWorktreeRemoved(WORKTREE_PATH);

    expect(codexRemoved).toHaveBeenCalledWith(WORKTREE_PATH);
    expect(geminiRemoved).toHaveBeenCalledWith(WORKTREE_PATH);
  });

  it('skips adapters that do not implement onWorktreeRemoved', async () => {
    // Claude has no onWorktreeRemoved (no per-directory global state to drop).
    mockAdapters.set('claude', {});
    const codexRemoved = vi.fn(async () => {});
    mockAdapters.set('codex', { onWorktreeRemoved: codexRemoved });

    await expect(notifyAdaptersWorktreeRemoved(WORKTREE_PATH)).resolves.toBeUndefined();
    expect(codexRemoved).toHaveBeenCalledTimes(1);
  });

  it('an adapter whose onWorktreeRemoved rejects does not stop the remaining adapters from being notified', async () => {
    const failingRemoved = vi.fn(async () => {
      throw new Error('config.toml locked by another process');
    });
    const succeedingRemoved = vi.fn(async () => {});
    // Registry iteration order follows insertion order (Map), so the
    // failing adapter goes FIRST - the case that would short-circuit a
    // naive for-of loop without a try/catch per adapter.
    mockAdapters.set('codex', { onWorktreeRemoved: failingRemoved });
    mockAdapters.set('gemini', { onWorktreeRemoved: succeedingRemoved });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(notifyAdaptersWorktreeRemoved(WORKTREE_PATH)).resolves.toBeUndefined();

    expect(failingRemoved).toHaveBeenCalledTimes(1);
    expect(succeedingRemoved).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[WORKTREE] codex onWorktreeRemoved failed (non-fatal):',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('is a no-op when no adapters are registered', async () => {
    await expect(notifyAdaptersWorktreeRemoved(WORKTREE_PATH)).resolves.toBeUndefined();
  });
});
