import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock functions we need to control and assert on
const { mockList, mockDelete, mockExistsSync, mockCloseProjectDb, mockIsKangenticWorktree } = vi.hoisted(() => ({
  mockList: vi.fn((): unknown[] => []),
  mockDelete: vi.fn(),
  mockExistsSync: vi.fn((): boolean => true),
  mockCloseProjectDb: vi.fn(),
  mockIsKangenticWorktree: vi.fn((): boolean => false),
}));

// --- Mock only the modules that pruneStaleWorktreeProjects actually uses ---
vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    unlinkSync: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  closeProjectDb: mockCloseProjectDb,
  // pruneStaleWorktreeProjects transitively imports retrieval-service.ts, whose
  // module-scope defaultDeps destructures getProjectDb from this module at
  // import time - the mock must export it even though this test never calls it.
  getProjectDb: vi.fn(),
}));

vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    projectDb: (id: string) => `/tmp/kangentic/projects/${id}.db`,
  },
}));

// pruneStaleWorktreeProjects now imports isKangenticWorktree from git-checks
// (moved out of worktree-manager in the git-module-split refactor).
vi.mock('../../src/main/git/git-checks', () => ({
  isKangenticWorktree: mockIsKangenticWorktree,
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

// The retrieval worker holds its own handle on each project database; Windows
// will not unlink a file another process has open.
const { steps } = vi.hoisted(() => ({ steps: [] as string[] }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: {
    closeProject: vi.fn(async (projectId: string) => {
      await Promise.resolve();
      steps.push(`worker closed ${projectId}`);
    }),
  },
}));

// --- Import the impl directly (bypasses requireContext() guard in register-all.ts) ---
import { pruneStaleWorktreeProjects } from '../../src/main/ipc/handlers/projects';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';

// Minimal mock context -- pruneStaleWorktreeProjects only uses context.projectRepo and
// (for the PROJECT_LIST_CHANGED broadcast) context.mainWindow.
function createMockContext(): IpcContext {
  return {
    projectRepo: { list: mockList, delete: mockDelete },
    // The pty host holds its own handle on each project database too.
    sessionManager: {
      closeProjectInPtyHost: vi.fn(async (projectId: string) => {
        await Promise.resolve();
        steps.push(`pty host closed ${projectId}`);
      }),
    },
    mainWindow: {
      webContents: { send: vi.fn() },
      isDestroyed: vi.fn(() => false),
    },
  } as unknown as IpcContext;
}

/** Typed accessor for the mainWindow mock built by createMockContext(). */
function mainWindowOf(context: IpcContext): { webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed: ReturnType<typeof vi.fn> } {
  return context.mainWindow as unknown as { webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed: ReturnType<typeof vi.fn> };
}

describe('pruneStaleWorktreeProjects', () => {
  let mockContext: IpcContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockList.mockReturnValue([]);
    mockContext = createMockContext();
  });

  it('prunes Kangentic worktree projects (preview instances)', async () => {
    mockList.mockReturnValue([
      { id: 'proj-1', name: 'stale-preview', path: '/home/dev/my-app/.kangentic/worktrees/fix-bug-abc123' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(true);

    await pruneStaleWorktreeProjects(mockContext);

    expect(mockCloseProjectDb).toHaveBeenCalledWith('proj-1');
    expect(mockDelete).toHaveBeenCalledWith('proj-1');
  });

  it('has the retrieval worker and the pty host let go of the database before its files are deleted', async () => {
    steps.length = 0;
    mockList.mockReturnValue([
      { id: 'proj-1', name: 'stale-preview', path: '/home/dev/my-app/.kangentic/worktrees/fix-bug-abc123' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(true);
    const fs = (await import('node:fs')).default;
    vi.mocked(fs.unlinkSync).mockImplementation((target) => { steps.push(`unlink ${String(target)}`); });
    try {
      await pruneStaleWorktreeProjects(mockContext);

      expect(steps.slice(0, 2)).toEqual(['worker closed proj-1', 'pty host closed proj-1']);
      expect(steps.slice(2).every((step) => step.startsWith('unlink '))).toBe(true);
      expect(steps).toHaveLength(5);
    } finally {
      // `clearAllMocks` in the beforeEach keeps an implementation, so without
      // this every later test would unlink through the recorder.
      vi.mocked(fs.unlinkSync).mockReset();
    }
  });

  it('skips non-worktree projects', async () => {
    mockList.mockReturnValue([
      { id: 'proj-3', name: 'normal-project', path: '/home/dev/my-app' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(false);

    await pruneStaleWorktreeProjects(mockContext);

    expect(mockCloseProjectDb).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does NOT prune external git worktrees or submodules', async () => {
    // Regression: kangentic.com was incorrectly pruned because it was a git
    // worktree/submodule -- isInsideWorktree returned true. The new check uses
    // isKangenticWorktree which only matches .kangentic/worktrees/ paths.
    mockList.mockReturnValue([
      { id: 'ext-wt', name: 'kangentic.com', path: '/home/dev/kangentic.com' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(false);

    await pruneStaleWorktreeProjects(mockContext);

    expect(mockCloseProjectDb).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('handles empty project list without errors', async () => {
    mockList.mockReturnValue([]);

    await pruneStaleWorktreeProjects(mockContext);

    expect(mockCloseProjectDb).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('prunes all Kangentic worktree projects but preserves normal projects', async () => {
    mockList.mockReturnValue([
      { id: 'normal', name: 'normal', path: '/home/dev/project' },
      { id: 'stale', name: 'stale', path: '/home/dev/project/.kangentic/worktrees/task-a-abc123' },
      { id: 'alive', name: 'alive', path: '/home/dev/project/.kangentic/worktrees/task-b-def456' },
    ]);
    mockIsKangenticWorktree.mockImplementation((projectPath: string) =>
      projectPath.includes('/.kangentic/worktrees/')
    );

    await pruneStaleWorktreeProjects(mockContext);

    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith('stale');
    expect(mockDelete).toHaveBeenCalledWith('alive');
    expect(mockCloseProjectDb).toHaveBeenCalledWith('stale');
    expect(mockCloseProjectDb).toHaveBeenCalledWith('alive');
  });
});

describe('pruneStaleWorktreeProjects PROJECT_LIST_CHANGED broadcast', () => {
  let mockContext: IpcContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockList.mockReturnValue([]);
    mockContext = createMockContext();
  });

  it('sends PROJECT_LIST_CHANGED exactly once after pruning two or more projects', async () => {
    // The send sits AFTER the loop, gated on a `prunedAny` flag set inside it --
    // not a per-row send. Two prunable rows must still produce exactly one
    // broadcast, not two.
    mockList.mockReturnValue([
      { id: 'stale-1', name: 'stale-1', path: '/home/dev/project/.kangentic/worktrees/task-a-abc123' },
      { id: 'stale-2', name: 'stale-2', path: '/home/dev/project/.kangentic/worktrees/task-b-def456' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(true);

    await pruneStaleWorktreeProjects(mockContext);

    const { webContents } = mainWindowOf(mockContext);
    expect(webContents.send).toHaveBeenCalledTimes(1);
    expect(webContents.send).toHaveBeenCalledWith(IPC.PROJECT_LIST_CHANGED);
  });

  it('does not send PROJECT_LIST_CHANGED when nothing was pruned', async () => {
    mockList.mockReturnValue([
      { id: 'normal', name: 'normal-project', path: '/home/dev/my-app' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(false);

    await pruneStaleWorktreeProjects(mockContext);

    const { webContents } = mainWindowOf(mockContext);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it('does not send PROJECT_LIST_CHANGED when the main window is destroyed', async () => {
    mockList.mockReturnValue([
      { id: 'stale-1', name: 'stale-1', path: '/home/dev/project/.kangentic/worktrees/task-a-abc123' },
    ]);
    mockIsKangenticWorktree.mockReturnValue(true);
    const { webContents, isDestroyed } = mainWindowOf(mockContext);
    isDestroyed.mockReturnValue(true);

    await pruneStaleWorktreeProjects(mockContext);

    expect(webContents.send).not.toHaveBeenCalled();
  });
});
