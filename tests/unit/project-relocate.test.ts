/**
 * Unit tests for project relocation (src/main/ipc/handlers/project-relocate.ts).
 *
 * better-sqlite3 cannot load under vitest's system Node, so the repositories
 * and filesystem are mocked; the tests exercise relocateProject's
 * orchestration contracts:
 *
 *   - replacePathPrefix: prefix matching via path.relative (no naive string
 *     prefixing - sibling folders sharing a name prefix must NOT match).
 *   - Validation: new path must exist and be a directory; another project
 *     registered at the same path is rejected; same path is a no-op.
 *   - Live sessions are suspended (abort-then-lock order) and transient
 *     sessions killed before any path rewriting.
 *   - tasks.worktree_path and sessions.cwd rows under the old prefix are
 *     rewritten; rows outside it are untouched.
 *   - git worktree repair runs best-effort for git projects only, with the
 *     rewritten worktree paths that exist on disk.
 *   - Runtime state fixups: worktree queue cleared, recoveredProjects entry
 *     dropped, currentProjectPath + board config watcher updated when the
 *     relocated project is the current one.
 *   - Agent adapters' onProjectRelocated hook is invoked best-effort for every
 *     registered adapter that implements it, with (oldPath, newPath); a hook
 *     that throws does not fail relocation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted state + mocks (factories are hoisted above imports)
// ---------------------------------------------------------------------------

const mockFs = vi.hoisted(() => ({
  /** Paths that exist on disk. */
  existing: new Set<string>(),
  /** Paths that are directories (subset of existing). */
  directories: new Set<string>(),
}));

const dbState = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; worktree_path: string | null }>,
  archivedTasks: [] as Array<{ id: string; worktree_path: string | null }>,
  sessions: [] as Array<{ id: string; cwd: string }>,
  taskUpdates: [] as Array<{ id: string; worktree_path: string }>,
  cwdUpdates: [] as Array<{ id: string; cwd: string }>,
}));

const runGitWithTimeoutMock = vi.hoisted(() => vi.fn(async () => ({ stdout: '', stderr: '' })));
const isGitRepoMock = vi.hoisted(() => vi.fn(() => false));
const applySuspendDbWritesMock = vi.hoisted(() => vi.fn());
const abortInFlightResumeMock = vi.hoisted(() => vi.fn());
const clearQueueMock = vi.hoisted(() => vi.fn());
const onProjectRelocatedMock = vi.hoisted(() => vi.fn(async () => {}));
const moveDirectoryMock = vi.hoisted(() => vi.fn(async () => ({ strategy: 'rename' as const })));
const removeDirectoryTreeMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => mockFs.existing.has(target)),
    statSync: vi.fn((target: string) => ({ isDirectory: () => mockFs.directories.has(target) })),
  },
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list() { return dbState.tasks; }
    listArchived() { return dbState.archivedTasks; }
    update(input: { id: string; worktree_path: string }) { dbState.taskUpdates.push(input); }
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    listAll() { return dbState.sessions; }
    updateCwd(id: string, cwd: string) { dbState.cwdUpdates.push({ id, cwd }); }
  },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static clearQueue = clearQueueMock;
  },
}));
vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: isGitRepoMock,
}));
vi.mock('../../src/main/git/git-spawn', () => ({
  runGitWithTimeout: runGitWithTimeoutMock,
}));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: applySuspendDbWritesMock,
}));
vi.mock('../../src/main/ipc/handlers/session-resume-controllers', () => ({
  abortInFlightResume: abortInFlightResumeMock,
}));
vi.mock('../../src/main/fs/directory-move', () => ({
  moveDirectory: moveDirectoryMock,
  removeDirectoryTree: removeDirectoryTreeMock,
}));
// The handler statically imports agentRegistry; mock it so vitest does not load
// every real adapter (better-sqlite3 / node-pty transitive deps cannot load
// here). One adapter implements the hook, one does not - exercising the skip.
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => ['claude', 'aider'],
    get: (name: string) =>
      name === 'claude'
        ? { name: 'claude', onProjectRelocated: onProjectRelocatedMock }
        : { name: 'aider' },
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { relocateProject } from '../../src/main/ipc/handlers/project-relocate';
import { replacePathPrefix } from '../../src/shared/paths';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project, Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers (generic paths only - never personal/machine-specific ones)
// ---------------------------------------------------------------------------

const OLD_PATH = path.resolve(path.join('/', 'projects', 'old-app'));
const NEW_PATH = path.resolve(path.join('/', 'projects', 'new-app'));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Old App',
    path: OLD_PATH,
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface ContextOptions {
  projects?: Project[];
  sessions?: Session[];
  currentProjectId?: string | null;
}

function makeContext(options: ContextOptions = {}) {
  const projects = options.projects ?? [makeProject()];
  // Records the order of the key relocation steps so move-mode ordering can be
  // asserted (suspend -> detach -> releaseUnder -> move -> updatePath -> ...).
  const callOrder: string[] = [];
  const sendMock = vi.fn();
  const context = {
    projectRepo: {
      getById: vi.fn((id: string) => projects.find((project) => project.id === id)),
      list: vi.fn(() => projects),
      updatePath: vi.fn((id: string, newPath: string) => {
        callOrder.push('updatePath');
        const project = projects.find((candidate) => candidate.id === id);
        if (!project) throw new Error('not found');
        project.path = newPath;
        return { ...project };
      }),
    },
    sessionManager: {
      listSessions: vi.fn(() => options.sessions ?? []),
      suspend: vi.fn(async () => { callOrder.push('suspend'); }),
      kill: vi.fn(() => { callOrder.push('kill'); }),
      awaitExit: vi.fn(async () => { callOrder.push('awaitExit'); }),
    },
    recoveredProjects: new Set<string>(['project-1']),
    snapshottedProjects: new Set<string>(['project-1']),
    currentProjectId: options.currentProjectId ?? null,
    currentProjectPath: options.currentProjectId ? OLD_PATH : null,
    boardConfigManager: { detach: vi.fn(() => { callOrder.push('detach'); }) },
    diffWatcher: { releaseUnder: vi.fn(() => { callOrder.push('releaseUnder'); }) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: sendMock } },
    callOrder,
    sendMock,
  };
  moveDirectoryMock.mockImplementation(async () => { callOrder.push('move'); return { strategy: 'rename' as const }; });
  removeDirectoryTreeMock.mockImplementation(async () => { callOrder.push('removeDirectoryTree'); });
  return context;
}

function asIpcContext(context: ReturnType<typeof makeContext>): IpcContext {
  return context as unknown as IpcContext;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existing.clear();
  mockFs.directories.clear();
  dbState.tasks = [];
  dbState.archivedTasks = [];
  dbState.sessions = [];
  dbState.taskUpdates = [];
  dbState.cwdUpdates = [];
  isGitRepoMock.mockReturnValue(false);
  moveDirectoryMock.mockReset();
  removeDirectoryTreeMock.mockReset();
  // New location exists as a directory in the common case (repoint mode).
  mockFs.existing.add(NEW_PATH);
  mockFs.directories.add(NEW_PATH);
});

// ---------------------------------------------------------------------------
// replacePathPrefix
// ---------------------------------------------------------------------------

describe('replacePathPrefix', () => {
  it('returns the new prefix when the target IS the old prefix', () => {
    expect(replacePathPrefix(OLD_PATH, OLD_PATH, NEW_PATH)).toBe(NEW_PATH);
  });

  it('rewrites a nested path under the old prefix', () => {
    const nested = path.join(OLD_PATH, '.kangentic', 'worktrees', 'feat-x');
    expect(replacePathPrefix(nested, OLD_PATH, NEW_PATH))
      .toBe(path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x'));
  });

  it('returns null for an unrelated path', () => {
    const unrelated = path.resolve(path.join('/', 'somewhere', 'else'));
    expect(replacePathPrefix(unrelated, OLD_PATH, NEW_PATH)).toBeNull();
  });

  it('returns null for a sibling that merely shares a string prefix', () => {
    // A naive startsWith() check would wrongly match /projects/old-app2.
    const sibling = `${OLD_PATH}2`;
    expect(replacePathPrefix(sibling, OLD_PATH, NEW_PATH)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('matches Windows paths case-insensitively', () => {
    const nested = path.join(OLD_PATH.toUpperCase(), 'sub');
    expect(replacePathPrefix(nested, OLD_PATH, NEW_PATH)).toBe(path.join(NEW_PATH, 'sub'));
  });
});

// ---------------------------------------------------------------------------
// relocateProject
// ---------------------------------------------------------------------------

describe('relocateProject', () => {
  it('rejects a new path that does not exist', async () => {
    const context = makeContext();
    const missing = path.resolve(path.join('/', 'projects', 'nope'));
    await expect(relocateProject(asIpcContext(context), 'project-1', missing))
      .rejects.toThrow('not a directory');
    expect(context.projectRepo.updatePath).not.toHaveBeenCalled();
  });

  it('rejects a path already registered to another project', async () => {
    const other = makeProject({ id: 'project-2', name: 'Other', path: NEW_PATH });
    const context = makeContext({ projects: [makeProject(), other] });
    await expect(relocateProject(asIpcContext(context), 'project-1', NEW_PATH))
      .rejects.toThrow('Other');
    expect(context.projectRepo.updatePath).not.toHaveBeenCalled();
  });

  it('is a no-op when the path is unchanged', async () => {
    const context = makeContext();
    mockFs.existing.add(OLD_PATH);
    mockFs.directories.add(OLD_PATH);
    const result = await relocateProject(asIpcContext(context), 'project-1', OLD_PATH);
    expect(result.project.path).toBe(OLD_PATH);
    expect(context.projectRepo.updatePath).not.toHaveBeenCalled();
  });

  it('updates the path and rewrites only rows under the old prefix', async () => {
    const context = makeContext();
    const insideWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', 'feat-x');
    const outsideWorktree = path.resolve(path.join('/', 'elsewhere', 'worktree'));
    dbState.tasks = [
      { id: 'task-1', worktree_path: insideWorktree },
      { id: 'task-2', worktree_path: outsideWorktree },
      { id: 'task-3', worktree_path: null },
    ];
    dbState.archivedTasks = [
      { id: 'task-4', worktree_path: path.join(OLD_PATH, '.kangentic', 'worktrees', 'old-feat') },
    ];
    dbState.sessions = [
      { id: 'session-1', cwd: OLD_PATH },
      { id: 'session-2', cwd: insideWorktree },
      { id: 'session-3', cwd: outsideWorktree },
    ];

    const result = await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);

    expect(result.project.path).toBe(NEW_PATH);
    expect(context.projectRepo.updatePath).toHaveBeenCalledWith('project-1', NEW_PATH);
    expect(dbState.taskUpdates).toEqual([
      { id: 'task-1', worktree_path: path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x') },
      { id: 'task-4', worktree_path: path.join(NEW_PATH, '.kangentic', 'worktrees', 'old-feat') },
    ]);
    expect(dbState.cwdUpdates).toEqual([
      { id: 'session-1', cwd: NEW_PATH },
      { id: 'session-2', cwd: path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x') },
    ]);
    expect(clearQueueMock).toHaveBeenCalledWith(OLD_PATH);
    expect(context.recoveredProjects.has('project-1')).toBe(false);
  });

  it('suspends live task sessions and kills transient ones before rewriting', async () => {
    const taskSession = {
      id: 'pty-1', taskId: 'task-1', projectId: 'project-1', status: 'running',
    } as unknown as Session;
    const transientSession = {
      id: 'pty-2', taskId: '', projectId: 'project-1', status: 'running', transient: true,
    } as unknown as Session;
    const otherProjectSession = {
      id: 'pty-3', taskId: 'task-9', projectId: 'project-2', status: 'running',
    } as unknown as Session;
    const exitedSession = {
      id: 'pty-4', taskId: 'task-2', projectId: 'project-1', status: 'exited',
    } as unknown as Session;
    const context = makeContext({
      sessions: [taskSession, transientSession, otherProjectSession, exitedSession],
    });

    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);

    expect(abortInFlightResumeMock).toHaveBeenCalledWith('task-1');
    expect(applySuspendDbWritesMock).toHaveBeenCalledTimes(1);
    expect(applySuspendDbWritesMock).toHaveBeenCalledWith(expect.anything(), 'project-1', 'task-1', 'system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('pty-1');
    expect(context.sessionManager.kill).toHaveBeenCalledWith('pty-2');
    // Other projects' and already-exited sessions are untouched.
    expect(context.sessionManager.suspend).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.kill).toHaveBeenCalledTimes(1);
  });

  it('kills and captures awaitExit for every transient session before suspending any task session, waiting for both exits', async () => {
    const timeline: string[] = [];
    const exitDeferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();

    const transientSessionA = {
      id: 'pty-transient-a', taskId: '', projectId: 'project-1', status: 'running', transient: true,
    } as unknown as Session;
    const transientSessionB = {
      id: 'pty-transient-b', taskId: '', projectId: 'project-1', status: 'running', transient: true,
    } as unknown as Session;
    const taskSession = {
      id: 'pty-task', taskId: 'task-1', projectId: 'project-1', status: 'running',
    } as unknown as Session;

    const context = makeContext({
      sessions: [transientSessionA, transientSessionB, taskSession],
    });
    context.sessionManager.kill.mockImplementation((sessionId: string) => {
      timeline.push(`kill:${sessionId}`);
    });
    context.sessionManager.awaitExit.mockImplementation((sessionId: string) => {
      timeline.push(`awaitExit:${sessionId}`);
      const deferred = createDeferred();
      exitDeferreds.set(sessionId, deferred);
      return deferred.promise;
    });
    context.sessionManager.suspend.mockImplementation(async (sessionId: string) => {
      timeline.push(`suspend:${sessionId}`);
    });

    const relocatePromise = relocateProject(asIpcContext(context), 'project-1', NEW_PATH);

    // The kill/awaitExit loop over every transient session is fully
    // synchronous (no await inside it), so both entries are already on the
    // timeline before the code ever reaches `await Promise.all(transientExits)`.
    expect(timeline).toEqual([
      'kill:pty-transient-a', 'awaitExit:pty-transient-a',
      'kill:pty-transient-b', 'awaitExit:pty-transient-b',
    ]);
    // The task-session suspend loop follows the awaited Promise.all and must
    // not have run while both exits are still pending.
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();

    exitDeferreds.get('pty-transient-a')!.resolve();
    exitDeferreds.get('pty-transient-b')!.resolve();
    await relocatePromise;

    expect(timeline).toEqual([
      'kill:pty-transient-a', 'awaitExit:pty-transient-a',
      'kill:pty-transient-b', 'awaitExit:pty-transient-b',
      'suspend:pty-task',
    ]);
  });

  it('updates currentProjectPath and detaches the board watcher for the current project', async () => {
    const context = makeContext({ currentProjectId: 'project-1' });
    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(context.currentProjectPath).toBe(NEW_PATH);
    expect(context.boardConfigManager.detach).toHaveBeenCalled();
  });

  it('does not detach the board watcher when the project is not current', async () => {
    const context = makeContext({ currentProjectId: null });
    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(context.boardConfigManager.detach).not.toHaveBeenCalled();
  });

  it('releases the diff watchers under the old path before any rewrite', async () => {
    const context = makeContext();
    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(context.diffWatcher.releaseUnder).toHaveBeenCalledWith(OLD_PATH);
    expect(context.callOrder.indexOf('releaseUnder')).toBeLessThan(context.callOrder.indexOf('updatePath'));
  });

  it('returns an empty warnings array in repoint mode', async () => {
    const context = makeContext();
    const result = await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(result.warnings).toEqual([]);
    expect(moveDirectoryMock).not.toHaveBeenCalled();
  });

  it('runs git worktree repair with rewritten worktree paths that exist', async () => {
    isGitRepoMock.mockReturnValue(true);
    const context = makeContext();
    const insideWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', 'feat-x');
    const goneWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', 'deleted');
    dbState.tasks = [
      { id: 'task-1', worktree_path: insideWorktree },
      { id: 'task-2', worktree_path: goneWorktree },
    ];
    const rewrittenExisting = path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x');
    mockFs.existing.add(rewrittenExisting);

    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);

    expect(runGitWithTimeoutMock).toHaveBeenCalledWith(
      NEW_PATH,
      ['worktree', 'repair', rewrittenExisting],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('treats a git worktree repair failure as non-fatal', async () => {
    isGitRepoMock.mockReturnValue(true);
    runGitWithTimeoutMock.mockRejectedValueOnce(new Error('repair exploded'));
    const context = makeContext();
    const result = await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(result.project.path).toBe(NEW_PATH);
  });

  it('skips git worktree repair for non-git folders', async () => {
    isGitRepoMock.mockReturnValue(false);
    const context = makeContext();
    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(runGitWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('invokes each adapter onProjectRelocated hook once with (oldPath, newPath)', async () => {
    const context = makeContext();
    await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(onProjectRelocatedMock).toHaveBeenCalledTimes(1);
    expect(onProjectRelocatedMock).toHaveBeenCalledWith(OLD_PATH, NEW_PATH);
  });

  it('does not fail relocation when an adapter hook throws', async () => {
    onProjectRelocatedMock.mockRejectedValueOnce(new Error('migration exploded'));
    const context = makeContext();
    const result = await relocateProject(asIpcContext(context), 'project-1', NEW_PATH);
    expect(result.project.path).toBe(NEW_PATH);
  });
});

// ---------------------------------------------------------------------------
// relocateProject - move mode (one-step move)
// ---------------------------------------------------------------------------

describe('relocateProject (move mode)', () => {
  // A destination that does NOT yet exist, whose parent (OLD_PATH's parent)
  // does exist as a directory.
  const PARENT = path.dirname(OLD_PATH);
  const MOVE_DEST = path.resolve(path.join(PARENT, 'moved-app'));

  beforeEach(() => {
    // Move mode requires the source to exist and the destination NOT to exist;
    // override the repoint-friendly defaults from the outer beforeEach.
    mockFs.existing.clear();
    mockFs.directories.clear();
    mockFs.existing.add(OLD_PATH);
    mockFs.directories.add(OLD_PATH);
    mockFs.existing.add(PARENT);
    mockFs.directories.add(PARENT);
  });

  it('rejects when the destination already exists', async () => {
    const context = makeContext();
    mockFs.existing.add(MOVE_DEST);
    mockFs.directories.add(MOVE_DEST);
    await expect(relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' }))
      .rejects.toThrow('Destination already exists');
    expect(moveDirectoryMock).not.toHaveBeenCalled();
  });

  it('rejects when the destination parent does not exist', async () => {
    const context = makeContext();
    const orphanDest = path.resolve(path.join('/', 'no-such-parent', 'moved-app'));
    await expect(relocateProject(asIpcContext(context), 'project-1', orphanDest, { mode: 'move' }))
      .rejects.toThrow('Destination folder does not exist');
    expect(moveDirectoryMock).not.toHaveBeenCalled();
  });

  it('rejects when the destination is inside the project folder', async () => {
    const context = makeContext();
    const insideDest = path.join(OLD_PATH, 'sub', 'nested');
    await expect(relocateProject(asIpcContext(context), 'project-1', insideDest, { mode: 'move' }))
      .rejects.toThrow('inside the project folder');
    expect(moveDirectoryMock).not.toHaveBeenCalled();
  });

  it('rejects when the source folder no longer exists', async () => {
    const context = makeContext();
    mockFs.existing.delete(OLD_PATH);
    mockFs.directories.delete(OLD_PATH);
    await expect(relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' }))
      .rejects.toThrow('no longer exists');
    expect(moveDirectoryMock).not.toHaveBeenCalled();
  });

  it('moves the folder and relocates in the correct order', async () => {
    const context = makeContext({ currentProjectId: 'project-1' });
    context.currentProjectPath = OLD_PATH;
    const taskSession = {
      id: 'pty-1', taskId: 'task-1', projectId: 'project-1', status: 'running',
    } as unknown as Session;
    (context.sessionManager.listSessions as ReturnType<typeof vi.fn>).mockReturnValue([taskSession]);

    const result = await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });

    expect(result.project.path).toBe(MOVE_DEST);
    expect(moveDirectoryMock).toHaveBeenCalledWith(OLD_PATH, MOVE_DEST, expect.anything());
    // suspend -> detach -> releaseUnder -> move -> updatePath
    const order = context.callOrder;
    expect(order.indexOf('suspend')).toBeLessThan(order.indexOf('detach'));
    expect(order.indexOf('detach')).toBeLessThan(order.indexOf('releaseUnder'));
    expect(order.indexOf('releaseUnder')).toBeLessThan(order.indexOf('move'));
    expect(order.indexOf('move')).toBeLessThan(order.indexOf('updatePath'));
  });

  it('does not delete the source for a same-volume rename', async () => {
    const context = makeContext();
    moveDirectoryMock.mockImplementation(async () => {
      context.callOrder.push('move');
      return { strategy: 'rename' as const };
    });
    await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });
    expect(removeDirectoryTreeMock).not.toHaveBeenCalled();
  });

  it('deletes the source after a cross-volume copy succeeds', async () => {
    const context = makeContext();
    moveDirectoryMock.mockImplementation(async () => {
      context.callOrder.push('move');
      return { strategy: 'copy' as const, totalEntries: 42 };
    });
    await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });
    expect(removeDirectoryTreeMock).toHaveBeenCalledWith(OLD_PATH);
    // Source delete happens AFTER the relocation work (updatePath).
    expect(context.callOrder.indexOf('updatePath'))
      .toBeLessThan(context.callOrder.indexOf('removeDirectoryTree'));
  });

  it('reports a source-delete-failed warning when the cross-volume cleanup fails', async () => {
    const context = makeContext();
    moveDirectoryMock.mockImplementation(async () => {
      context.callOrder.push('move');
      return { strategy: 'copy' as const, totalEntries: 1 };
    });
    removeDirectoryTreeMock.mockRejectedValueOnce(new Error('still locked'));
    const result = await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });
    expect(result.warnings).toEqual(['source-delete-failed']);
  });

  it('propagates a move failure without changing the project', async () => {
    const context = makeContext();
    moveDirectoryMock.mockRejectedValueOnce(new Error('rename exploded'));
    await expect(relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' }))
      .rejects.toThrow('rename exploded');
    expect(context.projectRepo.updatePath).not.toHaveBeenCalled();
    expect(removeDirectoryTreeMock).not.toHaveBeenCalled();
  });

  it('pushes move progress events carrying the projectId', async () => {
    const context = makeContext();
    await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });
    expect(context.sendMock).toHaveBeenCalledWith(
      'project:moveProgress',
      expect.objectContaining({ projectId: 'project-1', phase: 'moving' }),
    );
  });

  it('skips progress send when mainWindow is destroyed, but the move still completes', async () => {
    // The sendProgress guard `if (context.mainWindow.isDestroyed()) return` must
    // not skip the move itself - only the IPC push to the renderer.
    const context = makeContext();
    context.mainWindow.isDestroyed.mockReturnValue(true);

    const result = await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });

    expect(result.project.path).toBe(MOVE_DEST);
    // The progress send must NOT have been called (window is destroyed).
    expect(context.sendMock).not.toHaveBeenCalledWith(
      'project:moveProgress',
      expect.anything(),
    );
  });

  it('relocation still completes when a transient session kill throws', async () => {
    // A transient session kill failure is caught and logged, and must not
    // propagate to the caller.
    const transientSession = {
      id: 'pty-transient-throw', taskId: '', projectId: 'project-1',
      status: 'running', transient: true,
    } as unknown as Session;
    const context = makeContext({ sessions: [transientSession] });
    context.sessionManager.kill.mockRejectedValueOnce(new Error('PTY already gone'));

    const result = await relocateProject(asIpcContext(context), 'project-1', MOVE_DEST, { mode: 'move' });

    // The kill was attempted.
    expect(context.sessionManager.kill).toHaveBeenCalledWith('pty-transient-throw');
    // Relocation completed despite the kill failure.
    expect(result.project.path).toBe(MOVE_DEST);
  });
});
