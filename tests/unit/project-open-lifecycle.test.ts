/**
 * Unit tests for the PROJECT_OPEN cold-open recovery pipeline in
 * src/main/ipc/handlers/projects.ts.
 *
 * Covers three contracts:
 *
 *   1. pruneOrphanedTasksAndNotify (module-private): pushes
 *      IPC.TASK_SESSION_RESYNC with the project id only when the awaited
 *      pruneOrphanedWorktreeTasks resolves > 0; guards on
 *      `mainWindow && !mainWindow.isDestroyed()`; swallows a prune rejection
 *      (logs, treats as 0) and never rejects itself, so it never blocks
 *      session recovery. Exercised via its caller activateAllProjects, which
 *      awaits it directly (no setImmediate indirection).
 *
 *   2. registerProjectHandlers' PROJECT_OPEN cold-open block: runs inside a
 *      setImmediate callback, in order - await prune -> fire
 *      cleanupStaleResourcesAsync WITHOUT awaiting -> await
 *      resumeSuspendedSessions -> await autoSpawnTasks.
 *      `context.recoveredProjects.add(id)` happens SYNCHRONOUSLY before the
 *      deferred block is even scheduled (the rapid-double-open guard). The
 *      block deliberately carries NO `currentProjectId !== id` guard:
 *      recovery for a project the user immediately switched away from must
 *      still run.
 *
 *   3. openProjectByPath's deferred board-config block: the
 *      `context.currentProjectId !== openedProjectId` guard skips
 *      applyConfigOnOpen()/exportFromDb() when the current project changed
 *      before the setImmediate callback fires, and runs both when it hasn't.
 *
 * Pattern: capture ipcMain.handle registrations (board-swimlane-update-restart
 * pattern) to invoke the real PROJECT_OPEN handler for #2; call the exported
 * activateAllProjects/openProjectByPath functions directly for #1/#3. Every
 * heavy dependency (git, DB, session lifecycle, PR/retrieval schedulers) is
 * mocked; TaskRepository/SessionRepository/SwimlaneRepository/
 * TranscriptRepository are left as their REAL trivial-constructor classes
 * (safe: every consumer that would call their query methods is itself
 * mocked, so no real db.prepare ever gets invoked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mutable test state (must be defined before vi.mock factories)
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  callOrder: [] as string[],
  pruneResult: 0 as number | Error,
  cleanupError: null as Error | null,
  cleanupGate: null as { promise: Promise<void>; resolve: () => void } | null,
  resumeError: null as Error | null,
  autoSpawnError: null as Error | null,
}));

// ---------------------------------------------------------------------------
// Module mocks (declared before any imports)
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => state.existingPaths.has(target)),
    unlinkSync: vi.fn(() => {
      // syncProjectMcpConfig's "no handle" branch always attempts an unlink;
      // ENOENT (no pre-existing file) is the common, silently-swallowed case.
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
}));

vi.mock('../../src/main/ipc/handlers/project-relocate', () => ({
  relocateProject: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('resumeSuspendedSessions');
    if (state.resumeError) throw state.resumeError;
  }),
  autoSpawnTasks: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('autoSpawnTasks');
    if (state.autoSpawnError) throw state.autoSpawnError;
  }),
}));

vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('cleanupStaleResourcesAsync');
    if (state.cleanupGate) await state.cleanupGate.promise;
    if (state.cleanupError) throw state.cleanupError;
  }),
  pruneOrphanedWorktreeTasks: vi.fn(async (...args: unknown[]) => {
    state.callOrder.push('pruneOrphanedWorktreeTasks');
    if (state.pruneResult instanceof Error) throw state.pruneResult;
    return state.pruneResult;
  }),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static clearQueue = vi.fn();
  },
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
  isInsideWorktree: vi.fn(() => false),
  isKangenticWorktree: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(),
    getOrThrow: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));

vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(async () => {}),
}));

vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({
  prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/git/git-fetch-scheduler', () => ({
  gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

// The board_snapshot analytics callback (scheduleBoardSnapshot, reached from
// openProjectByPath and the PROJECT_OPEN handler) is the ONE place in this
// file's exercised code paths that calls swimlaneRepo.list() /
// taskRepo.countAll() directly rather than merely passing the repo instance
// to an already-mocked function - every other consumer
// (pruneOrphanedWorktreeTasks, cleanupStaleResourcesAsync,
// resumeSuspendedSessions, autoSpawnTasks) is itself mocked and never invokes
// a method on the repo it's handed. Left as the REAL trivial-constructor
// class (per the file header's rationale), swimlaneRepo.list()/
// taskRepo.countAll() would call `db.prepare(...)` against the fake `{}` db
// object from the database mock above and throw, caught by the snapshot's
// own try/catch (which warns rather than swallowing) - which is exactly why
// trackEvent has never been asserted to receive a 'board_snapshot' call in
// this file until now.
const mockSwimlaneList = vi.fn(() => [] as Array<{ name: string }>);
const mockTaskCountAll = vi.fn(() => 0);

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = (...args: unknown[]) => mockSwimlaneList(...args);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    countAll = (...args: unknown[]) => mockTaskCountAll(...args);
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock declarations)
// ---------------------------------------------------------------------------

import { trackEvent } from '../../src/main/analytics/analytics';
import { isShuttingDown } from '../../src/main/shutdown-state';
import { gitFetchScheduler } from '../../src/main/git/git-fetch-scheduler';
import { DEFAULT_SWIMLANES } from '../../src/main/db/migrations/default-data';
import {
  registerProjectHandlers,
  openProjectByPath,
  activateAllProjects,
  cleanupProject,
} from '../../src/main/ipc/handlers/projects';
import { ensureGitignore } from '../../src/main/ipc/helpers';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'project-open-lifecycle'));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Test Project',
    path: PROJECT_PATH,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MockContext {
  projectRepo: {
    list: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateLastOpened: ReturnType<typeof vi.fn>;
  };
  sessionManager: { setTranscriptRepository: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: {
    attach: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    applyConfigOnOpen: ReturnType<typeof vi.fn>;
    exportFromDb: ReturnType<typeof vi.fn>;
    getBoardProfiles: ReturnType<typeof vi.fn>;
  };
  currentProjectId: string | null;
  currentProjectPath: string | null;
  recoveredProjects: Set<string>;
  snapshottedProjects: Set<string>;
  mainWindow: { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } };
  mcpServerHandle: null;
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    projectRepo: {
      list: vi.fn(() => []),
      getById: vi.fn(),
      create: vi.fn(),
      updateLastOpened: vi.fn(),
    },
    sessionManager: { setTranscriptRepository: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn(() => ({ mcpServer: { enabled: false } })) },
    boardConfigManager: {
      attach: vi.fn(),
      exists: vi.fn(() => false),
      applyConfigOnOpen: vi.fn(() => []),
      exportFromDb: vi.fn(),
      getBoardProfiles: vi.fn(() => []),
    },
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
    snapshottedProjects: new Set<string>(),
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    mcpServerHandle: null,
    ...overrides,
  };
}

function asIpcContext(context: MockContext): IpcContext {
  return context as unknown as IpcContext;
}

/** Deterministically flush ONE round of the setImmediate ("check") phase.
 *  Any setImmediate scheduled strictly before this call is guaranteed (FIFO)
 *  to have already run by the time this promise resolves. */
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  state.existingPaths.clear();
  state.callOrder = [];
  state.pruneResult = 0;
  state.cleanupError = null;
  state.cleanupGate = null;
  state.resumeError = null;
  state.autoSpawnError = null;
  // mockReturnValue persists across tests (vi.clearAllMocks() resets call
  // history, not implementation), so reset both to their neutral defaults
  // here rather than letting one test's override leak into the next.
  mockSwimlaneList.mockReturnValue([]);
  mockTaskCountAll.mockReturnValue(0);
});

// ---------------------------------------------------------------------------
// 1. pruneOrphanedTasksAndNotify (exercised via activateAllProjects)
// ---------------------------------------------------------------------------

describe('pruneOrphanedTasksAndNotify (via activateAllProjects)', () => {
  it('pushes TASK_SESSION_RESYNC with the project id when the prune deletes rows', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);
    state.pruneResult = 3;

    await activateAllProjects(asIpcContext(context));

    expect(context.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.TASK_SESSION_RESYNC, project.id);
  });

  it('does not push TASK_SESSION_RESYNC when the prune deletes nothing', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);
    state.pruneResult = 0;

    await activateAllProjects(asIpcContext(context));

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('swallows a prune rejection as 0, never pushes, and never blocks session recovery', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);
    state.pruneResult = new Error('prune exploded');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must resolve, not reject: a prune failure never propagates.
    await expect(activateAllProjects(asIpcContext(context))).resolves.toBeUndefined();

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
    // Recovery continued past the failed prune: cleanup/resume/autoSpawn all ran.
    expect(state.callOrder).toEqual([
      'pruneOrphanedWorktreeTasks',
      'cleanupStaleResourcesAsync',
      'resumeSuspendedSessions',
      'autoSpawnTasks',
    ]);
    errorSpy.mockRestore();
  });

  it('does not push when mainWindow is destroyed, even though the prune deleted rows', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.mainWindow.isDestroyed.mockReturnValue(true);
    state.existingPaths.add(project.path);
    state.pruneResult = 5;

    await activateAllProjects(asIpcContext(context));

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. PROJECT_OPEN cold-open block (registerProjectHandlers)
// ---------------------------------------------------------------------------

describe('PROJECT_OPEN cold-open block (registerProjectHandlers)', () => {
  async function registerAndOpen(context: MockContext, project: Project) {
    context.projectRepo.getById.mockReturnValue(project);
    state.existingPaths.add(project.path);
    registerProjectHandlers(asIpcContext(context));
    const handler = capturedHandlers.get(IPC.PROJECT_OPEN);
    if (!handler) throw new Error('PROJECT_OPEN handler was not registered');
    await handler(null, project.id);
  }

  it('starts the git-fetch scheduler for the opened project', async () => {
    const context = createMockContext();
    const project = makeProject();

    await registerAndOpen(context, project);

    expect(vi.mocked(gitFetchScheduler.startForProject)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitFetchScheduler.startForProject)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: project.id, path: project.path }),
    );

    // Let the deferred cold-open block finish so it does not leak into the
    // next test.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('adds recoveredProjects synchronously, before the deferred cold-open block runs', async () => {
    const context = createMockContext();
    const project = makeProject();

    await registerAndOpen(context, project);

    // The handler's synchronous body has completed; setImmediate has only
    // SCHEDULED the deferred work, so recoveredProjects must already carry
    // the id while none of the deferred calls have fired yet.
    expect(context.recoveredProjects.has(project.id)).toBe(true);
    expect(state.callOrder).toEqual([]);

    // Let the deferred block finish so it doesn't leak into the next test.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('fires cleanupStaleResourcesAsync WITHOUT awaiting it before resuming sessions', async () => {
    const context = createMockContext();
    const project = makeProject();
    state.cleanupGate = createDeferred();

    await registerAndOpen(context, project);

    // resumeSuspendedSessions/autoSpawnTasks run to completion while
    // cleanupStaleResourcesAsync's own promise is still gated (unresolved) -
    // possible ONLY if the code does not await it.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(state.callOrder).toContain('cleanupStaleResourcesAsync');

    state.cleanupGate.resolve();
  });

  it('has no currentProjectId guard: cold-open recovery still runs after an immediate switch away', async () => {
    const context = createMockContext();
    const project = makeProject();

    await registerAndOpen(context, project);
    // Simulate the user switching to a different project before the
    // deferred setImmediate callback runs.
    context.currentProjectId = 'a-different-project';

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    // Full ordering held despite the switch: prune -> cleanup (fired) ->
    // resume -> autoSpawn, none skipped.
    expect(state.callOrder).toEqual([
      'pruneOrphanedWorktreeTasks',
      'cleanupStaleResourcesAsync',
      'resumeSuspendedSessions',
      'autoSpawnTasks',
    ]);
  });

  // -------------------------------------------------------------------------
  // 2b. board_snapshot analytics (fired once per project per run from its own
  //     deferred setImmediate callback, queued BEFORE the recovery block's, so
  //     it has run by the time recovery reaches autoSpawnTasks).
  // -------------------------------------------------------------------------

  function getBoardSnapshotProps(): Record<string, string | number | boolean> {
    const call = vi.mocked(trackEvent).mock.calls.find((args) => args[0] === 'board_snapshot');
    if (!call) throw new Error('board_snapshot was never tracked');
    return call[1] as Record<string, string | number | boolean>;
  }

  function countEvents(eventName: string): number {
    return vi.mocked(trackEvent).mock.calls.filter((args) => args[0] === eventName).length;
  }

  function countBoardSnapshots(): number {
    return countEvents('board_snapshot');
  }

  it('reports customColumns:false for the exact default 7-lane board', async () => {
    mockSwimlaneList.mockReturnValue(DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name })));

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(getBoardSnapshotProps().customColumns).toBe(false);
  });

  it('reports customColumns:true when a default-named lane was renamed', async () => {
    const renamedLanes = DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name }));
    renamedLanes[0] = { name: 'Backlog' }; // 'To Do' renamed
    mockSwimlaneList.mockReturnValue(renamedLanes);

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(getBoardSnapshotProps().customColumns).toBe(true);
  });

  it('reports customColumns:true when an 8th lane was added, even if it duplicates a default name', async () => {
    // Duplicating an existing default name (rather than adding a novel one)
    // isolates the LENGTH half of the customColumns check: every lane's name
    // is still present in the default-name Set, so a name-only comparison
    // would read this board as non-custom. Only the `lanes.length !==
    // DEFAULT_SWIMLANES.length` half catches the extra lane.
    const extraLanes = [
      ...DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name })),
      { name: DEFAULT_SWIMLANES[0].name },
    ];
    mockSwimlaneList.mockReturnValue(extraLanes);

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(getBoardSnapshotProps().customColumns).toBe(true);
  });

  it('buckets taskCount from TaskRepository.countAll() into taskBucket', async () => {
    mockSwimlaneList.mockReturnValue(DEFAULT_SWIMLANES.map((lane) => ({ name: lane.name })));
    mockTaskCountAll.mockReturnValue(12);

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    // Red: reverting to a stale count source (e.g. `tasks.list().length`, the
    // full-row scan countAll replaced) or dropping the countAll() call
    // entirely would leave taskCount at 0 and this at '0' instead of '10-49'.
    expect(getBoardSnapshotProps().taskBucket).toBe('10-49');
  });

  // -------------------------------------------------------------------------
  // 2c. board_snapshot fires the first time a project is VIEWED, keyed on its
  //     own set. Before this, it was keyed on recoveredProjects, which the boot
  //     auto-open and the background activation of every other project also
  //     mark, so the boot project never snapshotted and a later sidebar switch
  //     to any other project never did either. Each case below is red on that
  //     code.
  // -------------------------------------------------------------------------

  it('snapshots a project that recovery already marked warm (the production gap: warm from activateAllProjects, then clicked)', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.recoveredProjects.add(project.id);

    await registerAndOpen(context, project);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);
    // Warm: the recovery block itself did not run.
    expect(state.callOrder).toEqual([]);
  });

  it('openProjectByPath (the boot auto-open) snapshots an existing project', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);
    expect(context.snapshottedProjects.has(project.id)).toBe(true);

    // Let the cold-open recovery chain settle so it does not leak.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('the boot auto-open followed by a sidebar open of the same project snapshots exactly once', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await registerAndOpen(context, project);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('activateAllProjects never snapshots: background activation is not the user viewing a board', async () => {
    const context = createMockContext();
    const projectA = makeProject({ id: 'project-A', path: path.join(PROJECT_PATH, 'a') });
    const projectB = makeProject({ id: 'project-B', path: path.join(PROJECT_PATH, 'b') });
    context.projectRepo.list.mockReturnValue([projectA, projectB]);
    state.existingPaths.add(projectA.path);
    state.existingPaths.add(projectB.path);

    await activateAllProjects(asIpcContext(context));
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(0);
    expect(context.snapshottedProjects.size).toBe(0);
    // Both were recovered, which is what used to poison the later click.
    expect(context.recoveredProjects.has(projectA.id)).toBe(true);
    expect(context.recoveredProjects.has(projectB.id)).toBe(true);
  });

  it('a just-created project is neither snapshotted nor marked, so its first real view sends it', async () => {
    const context = createMockContext();
    const project = makeProject();
    // No registered project at this path: openProjectByPath creates one.
    context.projectRepo.list.mockReturnValue([]);
    context.projectRepo.create.mockReturnValue(project);
    Object.assign(context.configManager, {
      loadProjectOverrides: vi.fn(() => null),
      getProjectOverridableDefaults: vi.fn(() => ({})),
      saveProjectOverrides: vi.fn(),
    });
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path, { defaultAgent: 'claude' });
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(0);
    expect(context.snapshottedProjects.has(project.id)).toBe(false);
    // The creation itself is counted here: adding a folder is the common way
    // to create a project and it never reaches PROJECT_CREATE.
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('project_create');

    // The next open (the same id, now registered) is the first real view.
    context.projectRepo.list.mockReturnValue([project]);
    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);
    // Exactly once across BOTH opens. The creation branch is the only place
    // that counts, and it is gated on the path lookup above missing, so
    // reopening the same folder must not count a second project.
    expect(countEvents('project_create')).toBe(1);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('a failing lane read warns, sends nothing, stays marked, and leaves the recovery order unchanged', async () => {
    mockSwimlaneList.mockImplementation(() => {
      throw new Error('SQLITE_IOERR');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const context = createMockContext();
    const project = makeProject();
    await registerAndOpen(context, project);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });

    expect(countBoardSnapshots()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith('[ANALYTICS] board_snapshot failed:', expect.any(Error));
    // One attempt per run: a broken DB is not retried on every switch.
    expect(context.snapshottedProjects.has(project.id)).toBe(true);
    expect(state.callOrder).toEqual([
      'pruneOrphanedWorktreeTasks',
      'cleanupStaleResourcesAsync',
      'resumeSuspendedSessions',
      'autoSpawnTasks',
    ]);
    warnSpy.mockRestore();
  });

  it('a snapshot scheduled just before quit is skipped rather than reopening a database', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.recoveredProjects.add(project.id);

    await registerAndOpen(context, project);
    vi.mocked(isShuttingDown).mockReturnValue(true);
    await flushSetImmediate();
    vi.mocked(isShuttingDown).mockReturnValue(false);

    expect(countBoardSnapshots()).toBe(0);
  });

  it('opening two different projects as real views in the same run snapshots each exactly once, keyed by id', async () => {
    // The closest existing case ("the boot auto-open followed by a sidebar
    // open of the same project snapshots exactly once") only ever exercises
    // one project id, so it would still pass if snapshottedProjects were
    // collapsed to a single run-wide boolean instead of a per-project Set.
    // This case is red on that collapse: project B's open would find the
    // guard already tripped by project A and never snapshot.
    const context = createMockContext();
    const projectA = makeProject({ id: 'project-A', path: path.join(PROJECT_PATH, 'a') });
    const projectB = makeProject({ id: 'project-B', path: path.join(PROJECT_PATH, 'b') });

    await registerAndOpen(context, projectA);
    await registerAndOpen(context, projectB);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(2);
    expect(context.snapshottedProjects.has(projectA.id)).toBe(true);
    expect(context.snapshottedProjects.has(projectB.id)).toBe(true);

    // Drain both projects' deferred recovery chains so they do not leak into
    // the next test.
    await vi.waitFor(() => {
      expect(state.callOrder.filter((call) => call === 'autoSpawnTasks').length).toBe(2);
    }, { timeout: 2000 });
  });

  it('cleanupProject clears the id from snapshottedProjects, so a project closed and reopened in the same run snapshots again', async () => {
    const context = createMockContext();
    const project = makeProject();
    // cleanupProject calls boardConfigManager.detach() unconditionally; the
    // shared mock context does not define it.
    Object.assign(context.boardConfigManager, { detach: vi.fn() });
    context.snapshottedProjects.add(project.id);
    state.existingPaths.add(project.path);
    // The mocked TaskRepository only defines countAll (see the module mock
    // above), so cleanupProject's own taskRepo.list() read throws and is
    // caught internally, logging an error this test does not care about.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cleanupProject(asIpcContext(context), project.id, project.path);

    expect(context.snapshottedProjects.has(project.id)).toBe(false);
    errorSpy.mockRestore();

    // The behavior that actually matters to a user: closing a project and
    // reopening it in the same run snapshots it a second time.
    await registerAndOpen(context, project);
    await flushSetImmediate();

    expect(countBoardSnapshots()).toBe(1);

    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
  });

  it('cleanupProject stops the git-fetch scheduler even when the project path no longer exists on disk', async () => {
    const context = createMockContext();
    const project = makeProject();
    // cleanupProject calls boardConfigManager.detach() unconditionally; the
    // shared mock context does not define it.
    Object.assign(context.boardConfigManager, { detach: vi.fn() });
    // Deliberately NOT added to state.existingPaths: simulates a project
    // whose folder was moved or deleted, driving the path-exists guard's
    // early return branch. gitFetchScheduler.stop must still run - it sits
    // BEFORE that guard in cleanupProject, alongside prRefreshScheduler.stop.

    await cleanupProject(asIpcContext(context), project.id, project.path);

    expect(vi.mocked(gitFetchScheduler.stop)).toHaveBeenCalledWith(project.id);
  });

  it('kills and captures awaitExit for every task session before removing any, and removes wait for both exits', async () => {
    const context = createMockContext();
    const project = makeProject();
    // cleanupProject calls boardConfigManager.detach() unconditionally; the
    // shared mock context does not define it.
    Object.assign(context.boardConfigManager, { detach: vi.fn() });
    state.existingPaths.add(project.path);

    const timeline: string[] = [];
    const exitDeferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    Object.assign(context.sessionManager, {
      kill: vi.fn((sessionId: string) => { timeline.push(`kill:${sessionId}`); }),
      awaitExit: vi.fn((sessionId: string) => {
        timeline.push(`awaitExit:${sessionId}`);
        const deferred = createDeferred();
        exitDeferreds.set(sessionId, deferred);
        return deferred.promise;
      }),
      remove: vi.fn((sessionId: string) => { timeline.push(`remove:${sessionId}`); }),
    });

    // The mocked TaskRepository class only defines countAll (see the module
    // mock above); patch `list` on its prototype for this test only so
    // cleanupProject sees two tasks with live sessions, then remove the patch
    // so later tests keep relying on taskRepo.list() throwing (see the two
    // cleanupProject tests above).
    const tasks = [
      { id: 'task-1', session_id: 'session-1', worktree_path: null },
      { id: 'task-2', session_id: 'session-2', worktree_path: null },
    ];
    (TaskRepository.prototype as unknown as { list: () => typeof tasks }).list = () => tasks;

    try {
      const cleanupPromise = cleanupProject(asIpcContext(context), project.id, project.path);

      // The kill-then-capture loop has no await inside it, so by the time the
      // call above returns control, both sessions have already been killed
      // and their exits captured - before the code ever reaches
      // `await Promise.all(sessionExits)`.
      expect(timeline).toEqual([
        'kill:session-1', 'awaitExit:session-1',
        'kill:session-2', 'awaitExit:session-2',
      ]);
      expect(context.sessionManager.remove).not.toHaveBeenCalled();

      exitDeferreds.get('session-1')!.resolve();
      exitDeferreds.get('session-2')!.resolve();
      await cleanupPromise;

      expect(timeline).toEqual([
        'kill:session-1', 'awaitExit:session-1',
        'kill:session-2', 'awaitExit:session-2',
        'remove:session-1', 'remove:session-2',
      ]);
    } finally {
      delete (TaskRepository.prototype as unknown as { list?: unknown }).list;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. openProjectByPath's deferred board-config block
// ---------------------------------------------------------------------------

describe("openProjectByPath's deferred board-config block", () => {
  it('runs applyConfigOnOpen and exportFromDb when currentProjectId is unchanged when the deferred callback runs', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    // Warm reopen: isolates this test to the board-config block, skipping
    // the (separately tested) cold-open recovery block entirely.
    context.recoveredProjects.add(project.id);
    context.boardConfigManager.exists.mockReturnValue(true);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    await flushSetImmediate();

    expect(context.boardConfigManager.applyConfigOnOpen).toHaveBeenCalledTimes(1);
    expect(context.boardConfigManager.exportFromDb).toHaveBeenCalledTimes(1);
  });

  it('skips applyConfigOnOpen and exportFromDb when currentProjectId changed before the deferred callback runs', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    context.recoveredProjects.add(project.id);
    context.boardConfigManager.exists.mockReturnValue(true);
    state.existingPaths.add(project.path);

    await openProjectByPath(asIpcContext(context), project.path);
    // Simulate an immediate project switch before the deferred setImmediate
    // fires. This mutation happens synchronously right after
    // openProjectByPath resolves, strictly before the setImmediate ("check"
    // phase) callback runs.
    context.currentProjectId = 'a-different-project';
    await flushSetImmediate();

    expect(context.boardConfigManager.applyConfigOnOpen).not.toHaveBeenCalled();
    expect(context.boardConfigManager.exportFromDb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. ensureGitignore fire-and-forget: its git tracked-file probe must not
//    block the open/switch critical path in either call site.
// ---------------------------------------------------------------------------

describe('ensureGitignore fire-and-forget on the open critical path', () => {
  afterEach(() => {
    // Restore the default no-op implementation so a per-test gate never
    // leaks into the next test (the top-level beforeEach's
    // vi.clearAllMocks() resets call history but not a custom
    // mockImplementation).
    vi.mocked(ensureGitignore).mockImplementation(async () => {});
  });

  it('openProjectByPath resolves before a gated ensureGitignore settles', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.list.mockReturnValue([project]);
    // Warm reopen: isolates this test to the open body itself (matching the
    // board-config-block tests' pattern), so no unrelated deferred recovery
    // work needs draining afterwards.
    context.recoveredProjects.add(project.id);
    state.existingPaths.add(project.path);

    const gate = createDeferred();
    vi.mocked(ensureGitignore).mockImplementation(() => gate.promise);

    let resolved = false;
    const openPromise = openProjectByPath(asIpcContext(context), project.path).then((openedProject) => {
      resolved = true;
      return openedProject;
    });

    // Drain a few microtask ticks: fire-and-forget must not make
    // openProjectByPath wait on the gate to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);

    const openedProject = await openPromise;
    expect(openedProject.id).toBe(project.id);

    // Release the gate so its dangling promise doesn't leak into later
    // tests, and let the deferred board-config block (unrelated to the
    // gate) settle.
    gate.resolve();
    await flushSetImmediate();
  });

  it('the PROJECT_OPEN handler resolves before a gated ensureGitignore settles', async () => {
    const context = createMockContext();
    const project = makeProject();
    context.projectRepo.getById.mockReturnValue(project);
    state.existingPaths.add(project.path);

    const gate = createDeferred();
    vi.mocked(ensureGitignore).mockImplementation(() => gate.promise);

    registerProjectHandlers(asIpcContext(context));
    const handler = capturedHandlers.get(IPC.PROJECT_OPEN);
    if (!handler) throw new Error('PROJECT_OPEN handler was not registered');

    let resolved = false;
    const handlerPromise = (async () => {
      await handler(null, project.id);
    })();
    void handlerPromise.then(() => { resolved = true; });

    // Drain a few microtask ticks: fire-and-forget must not make the handler
    // wait on the gate to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);

    await handlerPromise;

    // Let the deferred cold-open block finish so it doesn't leak into the
    // next test, then release the gate.
    await vi.waitFor(() => {
      expect(state.callOrder).toContain('autoSpawnTasks');
    }, { timeout: 2000 });
    gate.resolve();
  });
});
