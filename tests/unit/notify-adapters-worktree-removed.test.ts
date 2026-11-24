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

const mockAdapters = new Map<string, {
  name?: string;
  supportsWslCli?: boolean;
  onWorktreeRemoved?: (path: string, place?: CliPlace | null) => Promise<void>;
  sweepRemovedFolderTrust?: () => Promise<number>;
}>();

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => Array.from(mockAdapters.keys()),
    get: (name: string) => mockAdapters.get(name),
  },
}));

const distro = vi.hoisted(() => ({ running: true }));
const FACTS = vi.hoisted(() => ({
  distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as const,
}));
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  return { ...actual, isWslDistroRunning: async () => distro.running, resolveWslDistroFacts: async () => FACTS };
});

import path from 'node:path';
import { notifyAdaptersWorktreeRemoved, sweepAdaptersRemovedFolderTrust } from '../../src/main/ipc/helpers/task-cleanup';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const WORKTREE_PATH = '/mock/project/.kangentic/worktrees/7';
const realPlatform = process.platform;

describe('sweepAdaptersRemovedFolderTrust', () => {
  beforeEach(() => {
    mockAdapters.clear();
  });

  it('skips an adapter with no sweep, survives one that throws, and sums the rest', async () => {
    const throwingSweep = vi.fn(async (): Promise<number> => { throw new Error('config locked'); });
    const countingSweep = vi.fn(async () => 2);
    const laterSweep = vi.fn(async () => 3);
    mockAdapters.set('claude', {});
    mockAdapters.set('gemini', { sweepRemovedFolderTrust: throwingSweep });
    mockAdapters.set('codex', { sweepRemovedFolderTrust: countingSweep });
    mockAdapters.set('qwen', { sweepRemovedFolderTrust: laterSweep });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sweepAdaptersRemovedFolderTrust()).resolves.toBe(5);

    expect(throwingSweep).toHaveBeenCalledTimes(1);
    expect(countingSweep).toHaveBeenCalledTimes(1);
    expect(laterSweep).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('answers 0 with no adapters registered', async () => {
    await expect(sweepAdaptersRemovedFolderTrust()).resolves.toBe(0);
  });
});

describe('notifyAdaptersWorktreeRemoved', () => {
  beforeEach(() => {
    mockAdapters.clear();
    distro.running = true;
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
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
    // An adapter with no hook, as Cursor and Aider have none.
    mockAdapters.set('cursor', {});
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

  describe('an adapter whose CLI the project runs from a WSL distro (Windows)', () => {
    const DISTRO_CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\codex';

    function registerCodex(): ReturnType<typeof vi.fn> {
      const removed = vi.fn(async (_path: string, _place?: CliPlace | null) => {});
      mockAdapters.set('codex', { name: 'codex', supportsWslCli: true, onWorktreeRemoved: removed });
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      return removed;
    }

    it('is called again with the distro the project\'s CLI path names, read for the worktree\'s project', async () => {
      const removed = registerCodex();
      const cliPathsOf = vi.fn(() => ({ codex: DISTRO_CLI_PATH }));

      await notifyAdaptersWorktreeRemoved(WORKTREE_PATH, cliPathsOf);

      expect(cliPathsOf).toHaveBeenCalledWith(path.dirname(path.dirname(path.dirname(path.resolve(WORKTREE_PATH)))));
      expect(removed).toHaveBeenCalledTimes(2);
      expect(removed.mock.calls[0]).toEqual([WORKTREE_PATH]);
      expect(removed.mock.calls[1]).toEqual([WORKTREE_PATH, { kind: 'wsl', distro: 'Ubuntu', facts: FACTS }]);
    });

    it('is not called for the distro while the distro is stopped, so a removal never starts one', async () => {
      const removed = registerCodex();
      distro.running = false;
      await notifyAdaptersWorktreeRemoved(WORKTREE_PATH, () => ({ codex: DISTRO_CLI_PATH }));
      expect(removed).toHaveBeenCalledTimes(1);
    });

    it('is called once for a CLI on this machine, an adapter without WSL support, or a folder that is not a worktree', async () => {
      const removed = registerCodex();
      await notifyAdaptersWorktreeRemoved(WORKTREE_PATH, () => ({ codex: 'C:\\Tools\\codex.exe' }));
      expect(removed).toHaveBeenCalledTimes(1);

      await notifyAdaptersWorktreeRemoved('/mock/elsewhere/7', () => ({ codex: DISTRO_CLI_PATH }));
      expect(removed).toHaveBeenCalledTimes(2);

      const geminiRemoved = vi.fn(async () => {});
      mockAdapters.clear();
      mockAdapters.set('gemini', { name: 'gemini', onWorktreeRemoved: geminiRemoved });
      await notifyAdaptersWorktreeRemoved(WORKTREE_PATH, () => ({ gemini: DISTRO_CLI_PATH }));
      expect(geminiRemoved).toHaveBeenCalledTimes(1);
    });
  });
});
